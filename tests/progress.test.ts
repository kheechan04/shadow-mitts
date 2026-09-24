import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, GameSession, generateCombo, makeRng, type NumberStats } from '../src/core/game';
import {
  ADAPT, adaptiveWeights, emptyProgress, recordGame, sanitizeProgress, updateSkills, weakestPunch, type GameRecord,
} from '../src/core/progress';

const stats = (per: Record<number, [number, number, number, number]>): NumberStats[] =>
  Array.from({ length: 7 }, (_, n) => {
    const [perfect, good, partial, miss] = per[n] ?? [0, 0, 0, 0];
    return { attempts: perfect + good + partial + miss, perfect, good, partial, miss };
  });

const rec = (score: number, difficulty: GameRecord['difficulty'] = 'normal'): GameRecord =>
  ({ at: new Date(0).toISOString(), difficulty, score, maxCombo: 3, accuracy: 0.5, perNumber: [] });

describe('per-punch skill (moving average)', () => {
  it('first game sets it, later games move it toward the new accuracy', () => {
    let s = updateSkills(emptyProgress().skills, stats({ 5: [1, 0, 0, 3] })); // 25 %
    expect(s[5]!.acc).toBeCloseTo(0.25);
    s = updateSkills(s, stats({ 5: [4, 0, 0, 0] })); // 100 % over 4 attempts
    const alpha = 1 - (1 - ADAPT.perAttemptAlpha) ** 4;
    expect(s[5]!.acc).toBeCloseTo(0.25 + alpha * 0.75);
    expect(s[5]!.attempts).toBe(8);
    expect(s[1]).toBeNull(); // untouched punches stay unknown
  });

  it('partial hits count half', () => {
    const s = updateSkills(emptyProgress().skills, stats({ 2: [0, 0, 2, 0] }));
    expect(s[2]!.acc).toBeCloseTo(0.5);
  });
});

describe('adaptive weights', () => {
  it('weak punches get more mitts, strong ones slightly fewer, unknown stay at 1, all clamped', () => {
    const s = updateSkills(emptyProgress().skills, stats({ 1: [10, 0, 0, 0], 5: [1, 0, 0, 9], 6: [0, 0, 0, 10], 3: [1, 0, 0, 0] }));
    const w = adaptiveWeights(s);
    expect(w[5]).toBeGreaterThan(2);
    expect(w[6]).toBe(ADAPT.maxWeight);
    expect(w[1]).toBeLessThan(1);
    expect(w[1]).toBeGreaterThanOrEqual(ADAPT.minWeight);
    expect(w[3]).toBe(1); // only 1 attempt → not enough to judge
    expect(w[2]).toBe(1);
  });

  it('the generator actually serves the weak punch more often', () => {
    const s = updateSkills(emptyProgress().skills, stats({ 1: [9, 0, 0, 1], 2: [9, 0, 0, 1], 3: [9, 0, 0, 1], 4: [9, 0, 0, 1], 5: [1, 0, 0, 9], 6: [9, 0, 0, 1] }));
    const w = adaptiveWeights(s);
    const count = (weights?: number[]) => {
      const rng = makeRng(3);
      let five = 0, total = 0;
      for (let k = 0; k < 2000; k++) for (const n of generateCombo(DIFFICULTIES.normal, rng, weights)) { total++; if (n === 5) five++; }
      return five / total;
    };
    expect(count(w)).toBeGreaterThan(count(undefined) * 1.8);
  });

  it('a session built with weights uses them', () => {
    const cfg = { stance: 'southpaw' as const, difficulty: 'normal' as const, lenientKind: false, rounds: 1, roundMs: 120000, restMs: 0, latencyOffsetMs: 0, seed: 9 };
    const plain = new GameSession(cfg, 0).mitts.filter((m) => m.n === 5).length;
    const w = [0, 0.6, 0.6, 0.6, 0.6, 3, 0.6];
    const weighted = new GameSession({ ...cfg, weights: w }, 0).mitts.filter((m) => m.n === 5).length;
    expect(weighted).toBeGreaterThan(plain);
  });
});

describe('weakest punch report', () => {
  it('names a punch only when it clearly lags', () => {
    const even = updateSkills(emptyProgress().skills, stats({ 1: [8, 0, 0, 2], 2: [8, 0, 0, 2] }));
    expect(weakestPunch(even)).toBeNull();
    const lag = updateSkills(emptyProgress().skills, stats({ 1: [9, 0, 0, 1], 2: [9, 0, 0, 1], 4: [3, 0, 0, 7] }));
    expect(weakestPunch(lag)?.n).toBe(4);
  });
});

describe('history and best scores', () => {
  it('keeps the newest first, caps the length and tracks a best per difficulty', () => {
    let p = emptyProgress();
    let r = recordGame(p, rec(100), stats({}));
    expect(r.newBest).toBe(true);
    p = r.progress;
    r = recordGame(p, rec(80), stats({}));
    expect(r.newBest).toBe(false);
    expect(r.progress.best.normal).toBe(100);
    p = r.progress;
    r = recordGame(p, rec(50, 'hard'), stats({}));
    expect(r.newBest).toBe(true);
    expect(r.progress.history.map((h) => h.score)).toEqual([50, 80, 100]);
    for (let i = 0; i < ADAPT.historyMax + 5; i++) p = recordGame(p, rec(i), stats({})).progress;
    expect(p.history.length).toBe(ADAPT.historyMax);
  });

  it('survives junk in storage', () => {
    expect(sanitizeProgress('nope')).toEqual(emptyProgress());
    const p = sanitizeProgress({ skills: [null, { acc: 3, attempts: 2 }, { acc: 'x' }], history: [{ score: 5, at: 'x' }, { bad: 1 }], best: { hard: 7, easy: 'z' } });
    expect(p.skills[1]).toEqual({ acc: 1, attempts: 2 });
    expect(p.skills[2]).toBeNull();
    expect(p.history.length).toBe(1);
    expect(p.best).toEqual({ hard: 7 });
  });
});
