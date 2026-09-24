// Offline pipeline + recording-note parsing, shared by scripts/eval.ts and the tests.

import type { FrameFeatures } from './features';
import type { Params } from './params';
import { punchNumber } from './classify';
import { SIDES, leadSide, type Side, type Stance } from './pose';
import { RecognitionPipeline } from './pipeline';
import type { PunchEvent } from './punch';
import type { Recording } from './recording';

export interface PipelineResult {
  events: PunchEvent[];
  features: (FrameFeatures | null)[];
}

export function runPipeline(rec: Recording, params: Params): PipelineResult {
  const pipe = new RecognitionPipeline(() => params, rec.meta.aspect);
  const events: PunchEvent[] = [];
  const features: (FrameFeatures | null)[] = [];
  for (const fr of rec.frames) {
    const r = pipe.update(fr);
    features.push(r.features);
    events.push(...r.events);
  }
  return { events, features };
}

/** Expected punches per boxing number (index 1..6; index 0 unused). */
export type NumberCounts = number[];

export interface Expectation {
  stance: Stance;
  /** null = free-form recording (not scored); all zeros = no punches at all (guard, torso turns) */
  counts: NumberCounts | null;
}

const SINGLE: [RegExp, number][] = [
  [/잽/, 1], [/크로스/, 2], [/리드\s*훅/, 3], [/리어\s*훅/, 4], [/리드\s*어퍼/, 5], [/리어\s*어퍼/, 6],
];

/**
 * Reads notes like "사우스포, 리드 잽 10회", "사우스포, 콤보 1-1-2 5회", "사우스포, 가드 10초",
 * "사우스포, 몸통 회전 10초", with an optional " (mirrored)" suffix. A mirrored southpaw
 * recording is an orthodox one — the numbers stay the same, the hands swap.
 */
export function expectationFromNote(note: string): Expectation | null {
  let stance: Stance | null = note.includes('사우스포') ? 'southpaw' : note.includes('오소독스') ? 'orthodox' : null;
  if (!stance) return null;
  if (note.includes('(mirrored)')) stance = stance === 'southpaw' ? 'orthodox' : 'southpaw';
  const counts: NumberCounts = [0, 0, 0, 0, 0, 0, 0];
  if (/가드|회전/.test(note) && !/\d+\s*회/.test(note)) return { stance, counts };
  const reps = note.match(/(\d+)\s*회/);
  if (!reps) return { stance, counts: null };
  const n = Number(reps[1]);
  const combo = note.match(/콤보\s*([1-6](?:-[1-6])*)/);
  if (combo) {
    for (const d of combo[1].split('-')) counts[Number(d)] += n;
    return { stance, counts };
  }
  const single = SINGLE.find(([re]) => re.test(note));
  if (!single) return { stance, counts: null };
  counts[single[1]] = n;
  return { stance, counts };
}

export interface Score {
  /** punches expected in scored recordings */
  expected: number;
  /** per recording and hand: min(events, expected) */
  detected: number;
  /** per recording and hand: events beyond what was expected (wrong hand, double counts, body turns) */
  extra: number;
  /** events in recordings where no punch was thrown (guard, torso turns) */
  noPunchFalse: number;
  /** per recording and number: min(events with that number, expected) */
  kindCorrect: number;
}

/** Aggregate score over labeled recordings (free-form ones are skipped). */
export function scoreRecordings(recs: Recording[], params: Params): Score {
  const s: Score = { expected: 0, detected: 0, extra: 0, noPunchFalse: 0, kindCorrect: 0 };
  for (const rec of recs) {
    const exp = expectationFromNote(rec.meta.note);
    if (!exp?.counts) continue;
    const { events } = runPipeline(rec, params);
    const total = exp.counts.reduce((a, b) => a + b, 0);
    if (total === 0) {
      s.noPunchFalse += events.length;
      continue;
    }
    const lead = leadSide(exp.stance);
    const sideOf = (num: number): Side => (num % 2 === 1 ? lead : lead === 'left' ? 'right' : 'left');
    const got: NumberCounts = [0, 0, 0, 0, 0, 0, 0];
    for (const e of events) if (e.kind) got[punchNumber(e.side, e.kind, exp.stance)]++;
    for (const side of SIDES) {
      const want = [1, 2, 3, 4, 5, 6].filter((n) => sideOf(n) === side).reduce((a, n) => a + exp.counts![n], 0);
      const have = events.filter((e) => e.side === side).length;
      s.detected += Math.min(have, want);
      s.extra += Math.max(0, have - want);
    }
    s.expected += total;
    for (let n = 1; n <= 6; n++) s.kindCorrect += Math.min(got[n], exp.counts[n]);
  }
  return s;
}
