// Punch detection (M1): "a punch happened, with this hand, at this time".
//
// Driven by the M0/M1 recordings: depth (z) and the 3D elbow angle are unreliable for punches
// thrown at the camera, so detection uses only the 2D wrist position relative to the shoulder
// midpoint (FeatureExtractor's [inward, up], in torso lengths T).
//
// Per arm, independently:
//   idle ──(fast AND moving away from guard AND guard was up)──▶ extending
//   extending: track the farthest point from the start ('peak' ≈ impact moment)
//     ──(pulled back by retractFrac of the peak, or slowed down)──▶
//         punch  (far enough, inward/up, fast enough, quick enough) → emit event → retracting
//         dip    (went down first: uppercut wind-up) → re-measure from the dip bottom, keep extending
//         else   → idle
//   retracting ──(back near the start, or timeout)──▶ idle
// The guard reference is a slow average of the wrist position while the arm is still.

import type { ArmFeatures, FrameFeatures } from './features';
import type { Params } from './params';
import { SIDES, type Side } from './pose';

export type PunchKind = 'straight' | 'hook' | 'uppercut';

export interface PunchFeatures {
  /** wrist displacement from the start at the peak, [inward, up] in torso lengths */
  delta: [number, number];
  /** |delta| */
  extent: number;
  peakSpeed: number;
  /** start of motion → peak, ms */
  riseMs: number;
  elbow2dAtPeak: number;
  elbow3dAtPeak: number;
  /** the movement started with a downward dip (uppercut wind-up) */
  dipped: boolean;
  /**
   * Arm posture at the peak (M2 play-test: classify by form, not by where the fist ends up).
   * forearmAngle: elbow→wrist direction in degrees, 0 = pointing inward (flat, hook-like),
   * 90 = pointing straight up (uppercut-like). forearmLen: its 2D length in T (short = pointing
   * at the camera, straight-like). elbowUp: elbow height above the shoulder midpoint in T.
   */
  forearmAngle: number;
  forearmLen: number;
  elbowUp: number;
  /**
   * How much the OTHER wrist moved the same way on screen during the punch, as a fraction of this
   * wrist's motion (1 = moved together). Torso turns move both hands together; punches don't.
   */
  common: number;
}

export interface PunchEvent {
  /** time of the peak (≈ impact), ms, same clock as the frames */
  t: number;
  /** time the detector was able to emit the event (t + detection delay) */
  emittedAt: number;
  side: Side;
  /** null until classification runs */
  kind: PunchKind | null;
  confidence: number;
  features: PunchFeatures;
}

type State = 'idle' | 'extending' | 'retracting';

function forearm(wrist: [number, number], elbow: [number, number]) {
  const fx = wrist[0] - elbow[0];
  const fy = wrist[1] - elbow[1];
  return { forearmAngle: (Math.atan2(fy, fx) * 180) / Math.PI, forearmLen: Math.hypot(fx, fy), elbowUp: elbow[1] };
}
type V2 = [number, number];

class ArmDetector {
  private state: State = 'idle';
  private guard: V2 | null = null;
  private prevT = 0;
  private prevDisp = 0;
  private origin: V2 = [0, 0];
  private startT = 0;
  private peak = { disp: 0, t: 0, pos: [0, 0] as V2, el: [0, 0] as V2, e2: NaN, e3: NaN };
  private peakSpeed = 0;
  private lastEventT = -Infinity;
  /** already re-measured from an uppercut dip during this movement */
  private dipped = false;
  /** lowest wrist point of the current movement (uppercut dip bottom candidate) */
  private low = { pos: [0, 0] as V2, t: 0 };
  /** fastest speed since the lowest point */
  private speedSinceLow = 0;

  constructor(private side: Side, private params: () => Params) {}

  reset(): void {
    this.lost();
    this.guard = null;
  }

  /** Tracking lost for a moment: abandon any punch in progress, keep the guard reference. */
  lost(): void {
    this.state = 'idle';
    this.prevT = 0;
  }

  update(a: ArmFeatures, t: number): PunchEvent | null {
    const p = this.params();
    if (!a.valid) {
      this.lost();
      return null;
    }
    const pos: V2 = [a.rel[0], a.rel[1]];
    const dt = this.prevT ? (t - this.prevT) / 1000 : 0;
    if (!this.guard) this.guard = [...pos];

    const ref = this.state === 'idle' ? this.guard : this.origin;
    const disp = Math.hypot(pos[0] - ref[0], pos[1] - ref[1]);
    const radial = dt > 0 ? (disp - this.prevDisp) / dt : 0;
    let event: PunchEvent | null = null;

    switch (this.state) {
      case 'idle': {
        if (a.speed2d < p.guardRestSpeed && dt > 0) {
          const k = p.guardTau > 0 ? 1 - Math.exp(-dt / p.guardTau) : 1;
          this.guard[0] += k * (pos[0] - this.guard[0]);
          this.guard[1] += k * (pos[1] - this.guard[1]);
        }
        const guardUp = this.guard[1] >= p.guardMinUp;
        const cooled = t - this.lastEventT >= p.punchCooldownMs;
        if (dt > 0 && guardUp && cooled && a.speed2d >= p.punchStartSpeed && radial > 0) {
          this.state = 'extending';
          this.dipped = false;
          this.low = { pos: [...pos], t };
          this.speedSinceLow = a.speed2d;
          this.origin = [...this.guard];
          this.startT = this.prevT; // motion began before the threshold frame
          const d0 = Math.hypot(pos[0] - this.origin[0], pos[1] - this.origin[1]);
          this.peak = { disp: d0, t, pos: [...pos], el: [...a.elbowRel], e2: a.elbowAngle2d, e3: a.elbowAngle3d };
          this.peakSpeed = a.speed2d;
        }
        break;
      }
      case 'extending': {
        this.peakSpeed = Math.max(this.peakSpeed, a.speed2d);
        if (!this.dipped) {
          // Still dipping only while going down more than inward; a slightly sinking inward sweep
          // is already the drive (filter lag makes the wrist keep sinking a little as it turns in).
          const down = this.low.pos[1] - pos[1];
          const inward = pos[0] - this.low.pos[0];
          if (down > 0 && down >= inward) {
            this.low = { pos: [...pos], t };
            this.speedSinceLow = 0;
          }
          this.speedSinceLow = Math.max(this.speedSinceLow, a.speed2d);
          // Uppercut drive seen as it happens: the wrist went down (a dip) and is now moving
          // back up and/or inward from its lowest point. Small rear uppercuts drive INWARD at low
          // height rather than up (recording "리어 어퍼컷 10회 작게"), so the old "dip turns around
          // and comes back" test never fired for them. Re-measure from the bottom.
          const depth = this.origin[1] - this.low.pos[1];
          const fromLow: V2 = [pos[0] - this.low.pos[0], pos[1] - this.low.pos[1]];
          const drive = Math.hypot(fromLow[0], fromLow[1]);
          if (depth > p.punchMaxDown && depth <= p.punchMaxDipDepth && t > this.low.t &&
              fromLow[0] + fromLow[1] > 0 && drive >= p.punchMinExtent * 0.5) {
            this.dipped = true;
            this.origin = [...this.low.pos];
            this.startT = this.low.t;
            this.peak = { disp: drive, t, pos: [...pos], el: [...a.elbowRel], e2: a.elbowAngle2d, e3: a.elbowAngle3d };
            this.peakSpeed = this.speedSinceLow;
            break;
          }
        }
        if (disp > this.peak.disp) {
          this.peak = { disp, t, pos: [...pos], el: [...a.elbowRel], e2: a.elbowAngle2d, e3: a.elbowAngle3d };
        }
        const retracted = disp < this.peak.disp * (1 - p.punchRetractFrac);
        // Right after re-measuring from a dip bottom the wrist may still be paused there; wait for
        // the drive up (or the max-duration timeout) instead of treating the pause as the end.
        const waitingAfterDip = this.dipped && this.peak.disp < p.punchMinExtent;
        const stopped = a.speed2d < p.punchEndSpeed && !waitingAfterDip;
        if (retracted || stopped) {
          const delta: V2 = [this.peak.pos[0] - this.origin[0], this.peak.pos[1] - this.origin[1]];
          const riseMs = this.peak.t - this.startT;
          // Every punch travels toward the target in front of the body: inward and/or up.
          // Outward or downward peaks are wind-ups (hook), dips (uppercut) or the guard hand
          // being dragged by body rotation — all observed in the M1 recordings.
          // Punches with a downward component (crosses, hooks) were all fast; the dragged guard
          // hand drifts inward-and-down slowly, so going down demands a higher speed.
          // After a dip (uppercut drive) the slow-drift rule doesn't apply: drifting guard hands
          // don't dip first, and small uppercuts at ~15 fps peaked at only 1.4–3 T/s.
          const minSpeed = this.dipped ? p.dipDriveMinSpeed : delta[1] < 0 ? p.punchDownMinSpeed : p.punchMinPeakSpeed;
          const isPunch =
            this.peak.disp >= p.punchMinExtent &&
            delta[1] >= -p.punchMaxDown &&
            delta[0] >= -p.punchMaxOutward &&
            this.peakSpeed >= minSpeed &&
            riseMs <= p.punchMaxRiseMs;
          // Uppercut wind-up: the wrist dips first, then drives up — often only back to guard
          // height in 2D, so measured from the guard it never "leaves". When a dip turns around,
          // re-measure from the bottom of the dip (once per movement).
          const dipDepth = -delta[1];
          const isDip =
            !isPunch && !this.dipped &&
            dipDepth > p.punchMaxDown && dipDepth <= p.punchMaxDipDepth && Math.abs(delta[0]) < dipDepth;
          if (isDip) {
            this.dipped = true;
            this.origin = [...this.peak.pos];
            this.startT = this.peak.t;
            const d0 = Math.hypot(pos[0] - this.origin[0], pos[1] - this.origin[1]);
            this.peak = { disp: d0, t, pos: [...pos], el: [...a.elbowRel], e2: a.elbowAngle2d, e3: a.elbowAngle3d };
            this.peakSpeed = a.speed2d;
          } else if (isPunch) {
            event = {
              t: this.peak.t,
              emittedAt: t,
              side: this.side,
              kind: null,
              confidence: 1,
              features: {
                delta,
                extent: this.peak.disp,
                peakSpeed: this.peakSpeed,
                riseMs,
                elbow2dAtPeak: this.peak.e2,
                elbow3dAtPeak: this.peak.e3,
                dipped: this.dipped,
                ...forearm(this.peak.pos, this.peak.el),
                common: NaN, // filled in by PunchDetector, which sees both arms
              },
            };
            this.lastEventT = t;
            this.state = 'retracting';
          } else {
            this.state = 'idle';
          }
        } else if (t - this.startT > p.punchMaxDurationMs) {
          this.state = 'idle';
        }
        break;
      }
      case 'retracting': {
        // Wait until the wrist is back near where the punch started. Going idle on "slowed down"
        // instead would let the guard reference drift to a held-out arm, and the return motion
        // would then look like a new punch (seen in the M1 jab recording).
        if (disp < this.peak.disp * p.punchReturnFrac) {
          this.state = 'idle';
        } else if (t - this.peak.t > p.punchReturnTimeoutMs) {
          // Never came back (changed stance, dropped hands): adopt the current position as guard.
          this.state = 'idle';
          this.guard = [...pos];
        }
        break;
      }
    }
    this.prevT = t;
    // prevDisp must be measured against the reference the NEXT frame will use.
    const nextRef = this.state === 'idle' ? this.guard : this.origin;
    this.prevDisp = Math.hypot(pos[0] - nextRef[0], pos[1] - nextRef[1]);
    return event;
  }

  debugState(): { state: State; guard: V2 | null } {
    return { state: this.state, guard: this.guard };
  }
}

/** +1 if "inward" for this arm is +X in the un-mirrored image (same as features.ts). */
const IN_SIGN: Record<Side, number> = { left: -1, right: 1 };
const HISTORY_MS = 1500;

interface HistoryEntry {
  t: number;
  /** wrist [image x, up] in T; image x so both arms share one direction */
  pos: Record<Side, V2>;
}

export class PunchDetector {
  private arms: Record<Side, ArmDetector>;
  private history: HistoryEntry[] = [];

  constructor(private params: () => Params) {
    this.arms = { left: new ArmDetector('left', params), right: new ArmDetector('right', params) };
  }

  reset(): void {
    for (const s of SIDES) this.arms[s].reset();
    this.history = [];
  }

  private at(t: number): HistoryEntry | null {
    let best: HistoryEntry | null = null;
    for (const h of this.history) if (!best || Math.abs(h.t - t) < Math.abs(best.t - t)) best = h;
    return best;
  }

  /**
   * Torso turn (M1 recording): both hands swing sideways together, slowly (≤2.6 T/s seen).
   * Hooks also drag the other hand along (common up to ~0.6) but were all ≥4.4 T/s, and
   * uppercuts move mostly up — so all three conditions must hold.
   */
  private isTorsoTurn(e: PunchEvent): boolean {
    const p = this.params();
    const [inward, up] = e.features.delta;
    // A dip first means an uppercut wind-up; torso turns never dip (small uppercuts were being dropped here).
    if (e.features.dipped) return false;
    return e.features.common > p.punchMaxCommon && Math.abs(up) < Math.abs(inward) && e.features.peakSpeed < p.torsoTurnMaxSpeed;
  }

  /** Projection of the other wrist's motion onto this wrist's motion, over the punch's rise. */
  private commonMotion(e: PunchEvent): number {
    const a = this.at(e.t - e.features.riseMs);
    const b = this.at(e.t);
    if (!a || !b || a === b) return 0;
    const other: Side = e.side === 'left' ? 'right' : 'left';
    const d = (s: Side): V2 => [b.pos[s][0] - a.pos[s][0], b.pos[s][1] - a.pos[s][1]];
    const mine = d(e.side);
    const theirs = d(other);
    const n2 = mine[0] * mine[0] + mine[1] * mine[1];
    return n2 > 0 ? (mine[0] * theirs[0] + mine[1] * theirs[1]) / n2 : 0;
  }

  /** Feed every frame (null = no pose). Returns events whose peak was just confirmed. */
  update(f: FrameFeatures | null): PunchEvent[] {
    if (!f) {
      for (const s of SIDES) this.arms[s].lost();
      return [];
    }
    const pos = {} as Record<Side, V2>;
    for (const s of SIDES) pos[s] = [IN_SIGN[s] * f.arms[s].rel[0], f.arms[s].rel[1]];
    this.history.push({ t: f.t, pos });
    while (this.history.length && this.history[0].t < f.t - HISTORY_MS) this.history.shift();

    const out: PunchEvent[] = [];
    for (const s of SIDES) {
      const e = this.arms[s].update(f.arms[s], f.t);
      if (!e) continue;
      e.features.common = this.commonMotion(e);
      if (!this.isTorsoTurn(e)) out.push(e);
    }
    return out;
  }

  debugState(side: Side) {
    return this.arms[side].debugState();
  }
}
