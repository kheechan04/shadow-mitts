// Per-frame arm features used by the debug panel and the punch detector.
//
// Coordinate spaces
// - "img": normalized landmarks made isotropic: X = x*aspect, Y = y, Z = z*aspect.
//   (x,y in [0,1] are scaled by width/height separately, so x must be multiplied by aspect
//   before distances mean anything.)
// - Arm vectors ("rel") are the wrist relative to the SHOULDER MIDPOINT, in image axes:
//     in = image horizontal, signed per arm so positive = toward the other side of the body
//          (left arm: −X, right arm: +X — the person's left is +X in the un-mirrored image)
//     up = image up (−Y)
//     z  = raw Z difference — negative = toward the camera
//   divided by a smoothed torso length (shoulder midpoint → hip midpoint) so camera distance
//   cancels out. Unit "T" = one torso length.
//
// Why not the per-arm shoulder and shoulder width (the M0 version): in a bladed boxing guard the two
// shoulders overlap in the image and MediaPipe swaps/jitters them frame to frame (M0 guard recording:
// a shoulder's x jumped ~0.2 between frames while the wrists barely moved). The shoulder midpoint and
// the torso length are ~5× steadier (measured on the M0 recordings).
//
// - "world": raw MediaPipe world landmarks in meters.
//
// Axis conventions, verified on real recordings in M0 (tests/recordings.test.ts):
//   world origin = hip midpoint; +x = person's LEFT (same as un-mirrored image x);
//   +y = DOWN (same as image y); −z = toward the camera (world and image z).
// Caveat measured in M0: when a straight punch is thrown AT the camera, both world z and image z
// move the wrong way (backward) and the 3D elbow angle barely opens (~75° → ~100°). Depth and
// the elbow angles must not be trusted for straight punches.

import { OneEuroFilter } from './oneEuro';
import type { Params } from './params';
import { ARM, LM, SIDES, USED_LANDMARKS, type P4, type PoseFrame, type Side } from './pose';

export type Vec3 = [number, number, number];

export interface ArmFeatures {
  side: Side;
  /** min visibility over shoulder/elbow/wrist */
  vis: number;
  /** vis >= minVisibility */
  valid: boolean;
  /** wrist − shoulder midpoint, torso-length units: [in, up, z] */
  rel: Vec3;
  /** elbow − shoulder midpoint, torso-length units: [in, up] (arm posture for classification) */
  elbowRel: [number, number];
  /** wrist velocity, torso lengths per second: [in, up, z] */
  vel: Vec3;
  /** |vel| using in/up only */
  speed2d: number;
  /** |vel| including z */
  speed3d: number;
  /** wrist − same-side shoulder in raw world coordinates (m) */
  worldRel: Vec3;
  /** world wrist speed (m/s) */
  worldSpeed: number;
  /** elbow angle from world landmarks, degrees (180 = straight) */
  elbowAngle3d: number;
  /** elbow angle from image landmarks, degrees */
  elbowAngle2d: number;
}

export interface FrameFeatures {
  t: number;
  /** smoothed torso length in img units */
  scale: number;
  /** shoulders/elbows/wrists all visible and inside the image */
  upperBodyInFrame: boolean;
  missing: string[];
  arms: Record<Side, ArmFeatures>;
  /** mouth midpoint relative to the shoulder midpoint, T units: [image x (+ = image right), up] */
  mouth: [number, number];
  /** raw world coordinates for axis verification */
  probe: { nose: Vec3; hipMid: Vec3; wristL: Vec3; wristR: Vec3 };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.sqrt(dot(a, a));
const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

export function angleDeg(a: Vec3, vertex: Vec3, c: Vec3): number {
  const u = sub(a, vertex);
  const v = sub(c, vertex);
  const d = len(u) * len(v);
  if (d === 0) return NaN;
  return (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / d))) * 180) / Math.PI;
}

const LANDMARK_NAMES: Record<number, string> = {
  [LM.SHOULDER_L]: '왼어깨', [LM.SHOULDER_R]: '오른어깨',
  [LM.ELBOW_L]: '왼팔꿈치', [LM.ELBOW_R]: '오른팔꿈치',
  [LM.WRIST_L]: '왼손목', [LM.WRIST_R]: '오른손목',
};

/** +1 if "inward" for this arm is +X in the un-mirrored image. */
const IN_SIGN: Record<Side, number> = { left: -1, right: 1 };

interface Prev {
  t: number;
  rel: Record<Side, Vec3>;
  wristWorld: Record<Side, Vec3>;
}

/**
 * Stateful: filters landmarks over time and differentiates wrist position.
 * Feed frames in time order; call reset() when the stream jumps (replay seek, camera restart).
 */
export class FeatureExtractor {
  private imgFilters = new Map<number, OneEuroFilter>();
  private worldFilters = new Map<number, OneEuroFilter>();
  private scale: number | null = null;
  private prev: Prev | null = null;

  constructor(private params: () => Params, private aspect: number) {
    const fp = () => {
      const p = this.params();
      return { minCutoff: p.filterMinCutoff, beta: p.filterBeta, dCutoff: p.filterDCutoff };
    };
    for (const i of USED_LANDMARKS) {
      for (let axis = 0; axis < 3; axis++) {
        this.imgFilters.set(i * 3 + axis, new OneEuroFilter(fp));
        this.worldFilters.set(i * 3 + axis, new OneEuroFilter(fp));
      }
    }
  }

  reset(): void {
    for (const f of this.imgFilters.values()) f.reset();
    for (const f of this.worldFilters.values()) f.reset();
    this.scale = null;
    this.prev = null;
  }

  private filtered(pts: P4[], i: number, tSec: number, filters: Map<number, OneEuroFilter>, img: boolean): Vec3 {
    const p = pts[i];
    const raw: Vec3 = img ? [p[0] * this.aspect, p[1], p[2] * this.aspect] : [p[0], p[1], p[2]];
    return [
      filters.get(i * 3)!.filter(raw[0], tSec),
      filters.get(i * 3 + 1)!.filter(raw[1], tSec),
      filters.get(i * 3 + 2)!.filter(raw[2], tSec),
    ];
  }

  /** Returns null when the frame has no pose. The filter state is kept across short gaps. */
  update(frame: PoseFrame): FrameFeatures | null {
    const { lm, wl } = frame;
    if (!lm || !wl || lm.length < 33 || wl.length < 33) {
      this.prev = null; // velocity across a gap is meaningless
      return null;
    }
    const p = this.params();
    const tSec = frame.t / 1000;

    const img = new Map<number, Vec3>();
    const world = new Map<number, Vec3>();
    for (const i of USED_LANDMARKS) {
      img.set(i, this.filtered(lm, i, tSec, this.imgFilters, true));
      world.set(i, this.filtered(wl, i, tSec, this.worldFilters, false));
    }

    const shoulderMid = mid(img.get(LM.SHOULDER_L)!, img.get(LM.SHOULDER_R)!);
    const hipMid = mid(img.get(LM.HIP_L)!, img.get(LM.HIP_R)!);
    const hipsSeen = Math.min(lm[LM.HIP_L][3], lm[LM.HIP_R][3]) >= p.minVisibility;
    const torsoNow = Math.hypot(shoulderMid[0] - hipMid[0], shoulderMid[1] - hipMid[1]);
    const dtPrev = this.prev ? tSec - this.prev.t : 0;
    if (this.scale === null) {
      // Before the hips have been seen once, fall back to 2 × shoulder width (≈ torso length).
      const sL = img.get(LM.SHOULDER_L)!;
      const sR = img.get(LM.SHOULDER_R)!;
      this.scale = hipsSeen ? torsoNow : 2 * Math.hypot(sL[0] - sR[0], sL[1] - sR[1]);
    } else if (hipsSeen) {
      if (p.scaleTau <= 0) this.scale = torsoNow;
      else if (dtPrev > 0) this.scale += (1 - Math.exp(-dtPrev / p.scaleTau)) * (torsoNow - this.scale);
    }
    const scale = Math.max(this.scale, 1e-6);

    const missing: string[] = [];
    for (const idx of [LM.SHOULDER_L, LM.SHOULDER_R, LM.ELBOW_L, LM.ELBOW_R, LM.WRIST_L, LM.WRIST_R]) {
      const q = lm[idx];
      const inside = q[0] >= 0 && q[0] <= 1 && q[1] >= 0 && q[1] <= 1;
      if (q[3] < p.minVisibility || !inside) missing.push(LANDMARK_NAMES[idx]);
    }

    const arms = {} as Record<Side, ArmFeatures>;
    const relNow = {} as Record<Side, Vec3>;
    const wristWorld = {} as Record<Side, Vec3>;
    for (const side of SIDES) {
      const a = ARM[side];
      const s = img.get(a.shoulder)!;
      const e = img.get(a.elbow)!;
      const w = img.get(a.wrist)!;
      const d = sub(w, shoulderMid);
      const rel: Vec3 = [(IN_SIGN[side] * d[0]) / scale, -d[1] / scale, d[2] / scale];
      relNow[side] = rel;
      const de = sub(e, shoulderMid);
      const elbowRel: [number, number] = [(IN_SIGN[side] * de[0]) / scale, -de[1] / scale];

      const ws = world.get(a.shoulder)!;
      const we = world.get(a.elbow)!;
      const ww = world.get(a.wrist)!;
      wristWorld[side] = ww;

      let vel: Vec3 = [0, 0, 0];
      let worldSpeed = 0;
      if (this.prev && dtPrev > 0 && dtPrev < 0.25) {
        const pr = this.prev.rel[side];
        vel = [(rel[0] - pr[0]) / dtPrev, (rel[1] - pr[1]) / dtPrev, (rel[2] - pr[2]) / dtPrev];
        worldSpeed = len(sub(ww, this.prev.wristWorld[side])) / dtPrev;
      }

      const vis = Math.min(lm[a.shoulder][3], lm[a.elbow][3], lm[a.wrist][3]);
      arms[side] = {
        side,
        vis,
        valid: vis >= p.minVisibility,
        rel,
        elbowRel,
        vel,
        speed2d: Math.hypot(vel[0], vel[1]),
        speed3d: len(vel),
        worldRel: sub(ww, ws),
        worldSpeed,
        elbowAngle3d: angleDeg(ws, we, ww),
        elbowAngle2d: angleDeg([s[0], s[1], 0], [e[0], e[1], 0], [w[0], w[1], 0]),
      };
    }

    this.prev = { t: tSec, rel: relNow, wristWorld };

    const mouth = mid(img.get(LM.MOUTH_L)!, img.get(LM.MOUTH_R)!);
    const hL = world.get(LM.HIP_L)!;
    const hR = world.get(LM.HIP_R)!;
    return {
      t: frame.t,
      scale,
      upperBodyInFrame: missing.length === 0,
      missing,
      arms,
      mouth: [(mouth[0] - shoulderMid[0]) / scale, -(mouth[1] - shoulderMid[1]) / scale],
      probe: {
        nose: world.get(LM.NOSE)!,
        hipMid: mid(hL, hR),
        wristL: world.get(LM.WRIST_L)!,
        wristR: world.get(LM.WRIST_R)!,
      },
    };
  }
}
