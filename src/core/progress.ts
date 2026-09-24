// M4 growth: per-punch skill (a moving average of recent accuracy), adaptive weights for the
// mitt generator, and the local game history. Pure — storage lives in app/records.ts.
//
// Every number here is a placeholder to be tuned by play-testing (DESIGN §5 "적응형 출제").

import type { NumberStats } from './game';
import type { Difficulty } from './game';

export const ADAPT = {
  /** weight of one attempt in the moving average: after n attempts in a game, α = 1 − (1 − this)^n */
  perAttemptAlpha: 0.12,
  /** accuracy we aim for; punches below it get more mitts */
  target: 0.85,
  /** extra weight per 1.0 of accuracy below the target */
  gain: 5,
  /** weight range (1 = normal) */
  minWeight: 0.6,
  maxWeight: 3,
  /** below this many attempts ever, a punch counts as unknown (weight 1) */
  minAttempts: 3,
  /** kept history length */
  historyMax: 50,
};

export interface PunchSkill {
  /** moving average of accuracy (partial = half), 0..1 */
  acc: number;
  /** attempts ever */
  attempts: number;
}

/** index 1..6 (boxing numbers); index 0 unused */
export type Skills = (PunchSkill | null)[];

export interface GameRecord {
  /** ISO time */
  at: string;
  difficulty: Difficulty;
  score: number;
  maxCombo: number;
  /** 0..1 */
  accuracy: number;
  /** per number 1..6: [hits (perfect+good), partial, attempts] */
  perNumber: [number, number, number][];
}

export interface Progress {
  version: 1;
  skills: Skills;
  history: GameRecord[];
  best: Partial<Record<Difficulty, number>>;
}

export const emptyProgress = (): Progress => ({ version: 1, skills: [null, null, null, null, null, null, null], history: [], best: {} });

export const statAccuracy = (s: NumberStats): number =>
  s.attempts ? (s.perfect + s.good + s.partial * 0.5) / s.attempts : NaN;

/** Blend one game's per-punch results into the moving averages. */
export function updateSkills(skills: Skills, stats: NumberStats[]): Skills {
  const out = skills.slice();
  for (let n = 1; n <= 6; n++) {
    const s = stats[n];
    if (!s || s.attempts === 0) continue;
    const acc = statAccuracy(s);
    const prev = out[n];
    if (!prev) {
      out[n] = { acc, attempts: s.attempts };
      continue;
    }
    const alpha = 1 - (1 - ADAPT.perAttemptAlpha) ** s.attempts;
    out[n] = { acc: prev.acc + alpha * (acc - prev.acc), attempts: prev.attempts + s.attempts };
  }
  return out;
}

/** Generator weights (index 1..6): weak punches come up more, strong ones a bit less. */
export function adaptiveWeights(skills: Skills): number[] {
  const w = [0, 1, 1, 1, 1, 1, 1];
  for (let n = 1; n <= 6; n++) {
    const s = skills[n];
    if (!s || s.attempts < ADAPT.minAttempts) continue;
    w[n] = Math.min(ADAPT.maxWeight, Math.max(ADAPT.minWeight, 1 + ADAPT.gain * (ADAPT.target - s.acc)));
  }
  return w;
}

/** The punch that most needs work, if one clearly does (for the report and the menu). */
export function weakestPunch(skills: Skills): { n: number; acc: number } | null {
  let best: { n: number; acc: number } | null = null;
  const known = skills.map((s, n) => ({ s, n })).filter((x) => x.n > 0 && x.s && x.s.attempts >= ADAPT.minAttempts);
  if (known.length < 2) return null;
  for (const { s, n } of known) if (!best || s!.acc < best.acc) best = { n, acc: s!.acc };
  const others = known.filter((x) => x.n !== best!.n).map((x) => x.s!.acc);
  const mean = others.reduce((a, b) => a + b, 0) / others.length;
  return best && best.acc < ADAPT.target && mean - best.acc >= 0.1 ? best : null;
}

export function recordGame(p: Progress, rec: GameRecord, stats: NumberStats[]): { progress: Progress; newBest: boolean; prevBest: number | undefined } {
  const prevBest = p.best[rec.difficulty];
  const newBest = prevBest === undefined || rec.score > prevBest;
  return {
    progress: {
      version: 1,
      skills: updateSkills(p.skills, stats),
      history: [rec, ...p.history].slice(0, ADAPT.historyMax),
      best: { ...p.best, [rec.difficulty]: newBest ? rec.score : prevBest },
    },
    newBest,
    prevBest,
  };
}

/** Accepts whatever was stored and returns a valid Progress (bad parts dropped). */
export function sanitizeProgress(raw: unknown): Progress {
  const p = emptyProgress();
  if (!raw || typeof raw !== 'object') return p;
  const r = raw as Partial<Progress>;
  if (Array.isArray(r.skills)) {
    for (let n = 1; n <= 6; n++) {
      const s = r.skills[n] as PunchSkill | null | undefined;
      if (s && Number.isFinite(s.acc) && Number.isFinite(s.attempts) && s.attempts >= 0) {
        p.skills[n] = { acc: Math.min(1, Math.max(0, s.acc)), attempts: Math.floor(s.attempts) };
      }
    }
  }
  if (Array.isArray(r.history)) {
    p.history = r.history
      .filter((h): h is GameRecord => !!h && typeof h === 'object' && Number.isFinite((h as GameRecord).score) && typeof (h as GameRecord).at === 'string')
      .slice(0, ADAPT.historyMax);
  }
  if (r.best && typeof r.best === 'object') {
    for (const d of ['easy', 'normal', 'hard'] as Difficulty[]) {
      const v = (r.best as Record<string, unknown>)[d];
      if (typeof v === 'number' && Number.isFinite(v)) p.best[d] = v;
    }
  }
  return p;
}
