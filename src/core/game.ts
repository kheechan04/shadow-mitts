// Mitt-timing game rules (M2, DESIGN §5). Pure: no DOM, no clock — callers pass `now`.
//
// Judgement is event-based and works like real pad work: a mitt arrives at tHit and is HELD
// there for holdMs — or, inside a combo, until the next mitt arrives, whichever is first (a pad
// holder switches pads on the beat; play-test: waiting for the late hit made later mitts pile up
// and snap in). A punch from the right hand whose (peak time − latency offset) lands anywhere
// from earlyMs before arrival until the hold ends hits it — Perfect near the arrival, Good later.
// (Play-test: a single ±160 ms instant felt nothing like hitting mitts.) Where the hand is on
// screen is never compared to where the mitt is drawn (webcam depth is too unreliable).
//
// Every number below is a placeholder to be tuned by play-testing.

import type { PunchEvent, PunchKind } from './punch';
import { leadSide, type Side, type Stance } from './pose';

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface DifficultySpec {
  label: string;
  /** a punch this long before the mitt arrives still counts (as Perfect) */
  earlyMs: number;
  /** up to this long after arrival → Perfect */
  perfectMs: number;
  /** the mitt stays presented this long after arriving; a hit until then → Good */
  holdMs: number;
  /** how long a mitt is visible before it arrives */
  approachMs: number;
  /** punches per combo, inclusive range */
  comboLen: [number, number];
  /** time between punches inside a combo */
  inComboGapMs: number;
  /** time from a combo's last punch to the next combo's first */
  betweenCombosMs: number;
  /** punch numbers this difficulty may ask for */
  numbers: number[];
}

export const DIFFICULTIES: Record<Difficulty, DifficultySpec> = {
  easy: {
    label: '쉬움', earlyMs: 300, perfectMs: 250, holdMs: 1000, approachMs: 2600,
    comboLen: [1, 2], inComboGapMs: 750, betweenCombosMs: 2400, numbers: [1, 2, 3, 4],
  },
  normal: {
    label: '보통', earlyMs: 250, perfectMs: 200, holdMs: 750, approachMs: 2200,
    comboLen: [1, 3], inComboGapMs: 600, betweenCombosMs: 2000, numbers: [1, 2, 3, 4, 5, 6],
  },
  hard: {
    label: '어려움', earlyMs: 200, perfectMs: 150, holdMs: 550, approachMs: 1700,
    comboLen: [2, 4], inComboGapMs: 450, betweenCombosMs: 1500, numbers: [1, 2, 3, 4, 5, 6],
  },
};

export const SCORING = {
  perfect: 100,
  good: 60,
  /** right hand, wrong punch type, with lenientKind on */
  partial: 30,
  /** extra fraction when the other hand was guarding the chin at the hit */
  guardBonus: 0.2,
  /** multiplier grows by comboStepBonus every comboStep hits in a row, up to comboMaxMult */
  comboStep: 10,
  comboStepBonus: 0.1,
  comboMaxMult: 2,
};

/** Punch events are emitted after their peak is confirmed (M1 eval: up to ~200 ms later). */
export const EMIT_GRACE_MS = 300;
export const COUNTDOWN_MS = 3000;
/** first mitt of a round arrives this long after the round starts */
export const FIRST_HIT_DELAY_MS = 2000;

export interface GameConfig {
  stance: Stance;
  difficulty: Difficulty;
  /** DESIGN §5 "쉬움" option: right hand but wrong type still scores partially */
  lenientKind: boolean;
  rounds: number;
  roundMs: number;
  restMs: number;
  /** subtracted from punch times: camera + inference + filter + display delay */
  latencyOffsetMs: number;
  seed: number;
  /** optional per-number weights for choosing punches (M4 adaptive), index 1..6 */
  weights?: number[];
}

export type Grade = 'perfect' | 'good' | 'partial' | 'miss';

export interface Judgement {
  mittId: number;
  grade: Grade;
  /** corrected punch time − tHit, ms (NaN for a miss with no punch) */
  dtMs: number;
  points: number;
  /** the other hand was up at the hit (null for a miss) */
  guardOk: boolean | null;
  /** the punch type that was seen, when it didn't match */
  seenKind?: PunchKind;
  /** clock time the judgement was made */
  at: number;
}

export interface Mitt {
  id: number;
  n: number;
  side: Side;
  kind: PunchKind;
  tHit: number;
  round: number;
  /** position inside its combo, 0-based, and the combo length */
  comboIndex: number;
  comboSize: number;
  /** end of the hit window: tHit + holdMs, cut short when the next mitt arrives sooner */
  holdUntil: number;
  judgement: Judgement | null;
}

export interface NumberStats {
  attempts: number;
  perfect: number;
  good: number;
  partial: number;
  miss: number;
}

export type Phase = 'countdown' | 'round' | 'rest' | 'done';

export function numberKind(n: number): PunchKind {
  return n <= 2 ? 'straight' : n <= 4 ? 'hook' : 'uppercut';
}

/** Odd numbers are thrown with the lead hand, even with the rear. */
export function numberSide(n: number, stance: Stance): Side {
  const lead = leadSide(stance);
  return n % 2 === 1 ? lead : lead === 'left' ? 'right' : 'left';
}

/** Small seeded PRNG (mulberry32) so a seed reproduces a session exactly. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted(options: number[], weights: number[] | undefined, rng: () => number): number {
  const w = options.map((n) => Math.max(0, weights?.[n] ?? 1));
  const total = w.reduce((a, b) => a + b, 0);
  if (total <= 0) return options[Math.floor(rng() * options.length)];
  let r = rng() * total;
  for (let i = 0; i < options.length; i++) {
    r -= w[i];
    if (r < 0) return options[i];
  }
  return options[options.length - 1];
}

/**
 * One combo. Hands alternate (lead/rear), as in real boxing combinations; the one allowed
 * same-hand repeat is the double jab (1-1).
 */
export function generateCombo(spec: DifficultySpec, rng: () => number, weights?: number[]): number[] {
  const [lo, hi] = spec.comboLen;
  const len = lo + Math.floor(rng() * (hi - lo + 1));
  const combo = [pickWeighted(spec.numbers, weights, rng)];
  while (combo.length < len) {
    const prev = combo[combo.length - 1];
    const doubleJab = prev === 1 && spec.numbers.includes(1) && rng() < 0.2;
    const other = spec.numbers.filter((n) => n % 2 !== prev % 2);
    combo.push(doubleJab || other.length === 0 ? 1 : pickWeighted(other, weights, rng));
  }
  return combo;
}

export class GameSession {
  readonly mitts: Mitt[] = [];
  readonly spec: DifficultySpec;
  score = 0;
  combo = 0;
  maxCombo = 0;
  /** punches that matched no mitt */
  stray = 0;
  readonly stats: NumberStats[] = Array.from({ length: 7 }, () => ({ attempts: 0, perfect: 0, good: 0, partial: 0, miss: 0 }));
  readonly judgements: Judgement[] = [];

  constructor(readonly cfg: GameConfig, readonly startAt: number) {
    this.spec = DIFFICULTIES[cfg.difficulty];
    const rng = makeRng(cfg.seed);
    let id = 0;
    for (let r = 0; r < cfg.rounds; r++) {
      const start = this.roundStart(r);
      const lastHit = start + cfg.roundMs - 500;
      let t = start + FIRST_HIT_DELAY_MS;
      while (t <= lastHit) {
        const combo = generateCombo(this.spec, rng, cfg.weights);
        if (t + (combo.length - 1) * this.spec.inComboGapMs > lastHit) break;
        combo.forEach((n, i) => {
          this.mitts.push({
            id: id++, n, side: numberSide(n, cfg.stance), kind: numberKind(n),
            tHit: t + i * this.spec.inComboGapMs, round: r, comboIndex: i, comboSize: combo.length,
            holdUntil: t + i * this.spec.inComboGapMs + this.spec.holdMs,
            judgement: null,
          });
        });
        t += (combo.length - 1) * this.spec.inComboGapMs + this.spec.betweenCombosMs;
      }
    }
    for (let i = 0; i + 1 < this.mitts.length; i++) {
      this.mitts[i].holdUntil = Math.min(this.mitts[i].holdUntil, this.mitts[i + 1].tHit);
    }
  }

  roundStart(r: number): number {
    return this.startAt + COUNTDOWN_MS + r * (this.cfg.roundMs + this.cfg.restMs);
  }

  /**
   * How long after tHit a punch for it can still arrive: the window, plus the latency offset
   * (the detector's clock runs that much behind the player), plus the detector's emit delay.
   */
  get settleMs(): number {
    return this.spec.holdMs + Math.max(0, this.cfg.latencyOffsetMs) + EMIT_GRACE_MS;
  }

  get endAt(): number {
    return this.roundStart(this.cfg.rounds - 1) + this.cfg.roundMs + this.settleMs;
  }

  phaseAt(now: number): { phase: Phase; round: number; msLeft: number } {
    if (now < this.startAt + COUNTDOWN_MS) return { phase: 'countdown', round: 0, msLeft: this.startAt + COUNTDOWN_MS - now };
    for (let r = 0; r < this.cfg.rounds; r++) {
      const s = this.roundStart(r);
      if (now < s + this.cfg.roundMs) return { phase: 'round', round: r, msLeft: s + this.cfg.roundMs - now };
      if (r < this.cfg.rounds - 1 && now < s + this.cfg.roundMs + this.cfg.restMs) {
        return { phase: 'rest', round: r, msLeft: s + this.cfg.roundMs + this.cfg.restMs - now };
      }
    }
    return now < this.endAt
      ? { phase: 'round', round: this.cfg.rounds - 1, msLeft: 0 }
      : { phase: 'done', round: this.cfg.rounds - 1, msLeft: 0 };
  }

  private comboMultiplier(): number {
    return Math.min(SCORING.comboMaxMult, 1 + Math.floor(this.combo / SCORING.comboStep) * SCORING.comboStepBonus);
  }

  private record(m: Mitt, j: Judgement): Judgement {
    m.judgement = j;
    this.judgements.push(j);
    const s = this.stats[m.n];
    s.attempts++;
    s[j.grade]++;
    this.score += j.points;
    return j;
  }

  /** Expire mitts whose window (plus the detector's emit delay) has passed. Call every frame. */
  update(now: number): Judgement[] {
    const out: Judgement[] = [];
    for (const m of this.mitts) {
      if (m.judgement || now <= m.holdUntil + Math.max(0, this.cfg.latencyOffsetMs) + EMIT_GRACE_MS) continue;
      this.combo = 0;
      out.push(this.record(m, { mittId: m.id, grade: 'miss', dtMs: NaN, points: 0, guardOk: null, at: now }));
    }
    return out;
  }

  /**
   * A detected punch. `guardOk` = the other hand was guarding at the punch time.
   * Punches with the wrong hand are ignored rather than penalized: M1 showed the off hand
   * occasionally triggers on body rotation, and a stray event should not cost the player.
   */
  onPunch(ev: PunchEvent, guardOk: boolean, now: number): Judgement | null {
    const t = ev.t - this.cfg.latencyOffsetMs;
    // The mitt that has been waiting longest wins (mitts are in time order), like hitting
    // whichever pad is being held up right now.
    let best: Mitt | null = null;
    for (const m of this.mitts) {
      if (m.judgement || m.side !== ev.side) continue;
      if (t >= m.tHit - this.spec.earlyMs && t <= m.holdUntil) {
        best = m;
        break;
      }
    }
    if (!best) {
      this.stray++;
      return null;
    }
    const dt = t - best.tHit;
    const kindOk = ev.kind === best.kind;
    let grade: Grade;
    if (kindOk) grade = dt <= this.spec.perfectMs ? 'perfect' : 'good';
    else grade = this.cfg.lenientKind ? 'partial' : 'miss';

    const mult = this.comboMultiplier();
    const base = grade === 'perfect' ? SCORING.perfect : grade === 'good' ? SCORING.good : grade === 'partial' ? SCORING.partial : 0;
    const points = Math.round(base * mult * (guardOk && grade !== 'miss' ? 1 + SCORING.guardBonus : 1));
    if (grade === 'perfect' || grade === 'good') {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
    } else if (grade === 'miss') {
      this.combo = 0;
    } // partial keeps the streak but doesn't extend it

    return this.record(best, {
      mittId: best.id, grade, dtMs: dt, points, guardOk, at: now,
      ...(kindOk ? {} : { seenKind: ev.kind ?? undefined }),
    });
  }

  /** Hits / attempts for judged mitts; partial counts as half. */
  accuracy(): number {
    let a = 0;
    let h = 0;
    for (const s of this.stats) {
      a += s.attempts;
      h += s.perfect + s.good + s.partial * 0.5;
    }
    return a ? h / a : 0;
  }
}

// ---------------------------------------------------------------- latency calibration

export const CALIBRATION = { beats: 8, intervalMs: 1200, leadInMs: 2500, windowMs: 450 };

/**
 * Punch (any hand, any type) as each ring closes. The median of (punch peak − beat) is the
 * delay between what the player sees/does and what the detector timestamps.
 */
export class Calibration {
  readonly beats: number[];
  private offsets: (number | null)[];

  constructor(readonly startAt: number) {
    this.beats = Array.from({ length: CALIBRATION.beats }, (_, i) => startAt + CALIBRATION.leadInMs + i * CALIBRATION.intervalMs);
    this.offsets = this.beats.map(() => null);
  }

  get endAt(): number {
    return this.beats[this.beats.length - 1] + CALIBRATION.windowMs + EMIT_GRACE_MS;
  }

  onPunch(ev: PunchEvent): number | null {
    let best = -1;
    for (let i = 0; i < this.beats.length; i++) {
      if (this.offsets[i] !== null) continue;
      const d = Math.abs(ev.t - this.beats[i]);
      if (d <= CALIBRATION.windowMs && (best < 0 || d < Math.abs(ev.t - this.beats[best]))) best = i;
    }
    if (best < 0) return null;
    this.offsets[best] = ev.t - this.beats[best];
    return best;
  }

  hitBeats(): boolean[] {
    return this.offsets.map((o) => o !== null);
  }

  /** Median offset in ms, or null with fewer than half the beats hit. */
  result(): { offsetMs: number; hits: number; spreadMs: number } | null {
    const got = this.offsets.filter((o): o is number => o !== null).sort((a, b) => a - b);
    if (got.length < Math.ceil(this.beats.length / 2)) return null;
    const med = got[Math.floor(got.length / 2)];
    const spread = got[Math.floor(got.length * 0.75)] - got[Math.floor(got.length * 0.25)];
    return { offsetMs: Math.round(med), hits: got.length, spreadMs: Math.round(spread) };
  }
}
