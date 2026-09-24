import { describe, expect, it } from 'vitest';
import {
  CALIBRATION, COUNTDOWN_MS, Calibration, DIFFICULTIES, EMIT_GRACE_MS, FIRST_HIT_DELAY_MS, GameSession, SCORING,
  generateCombo, makeRng, numberKind, numberSide, type GameConfig,
} from '../src/core/game';
import { guardOk } from '../src/core/guard';
import { FeatureExtractor } from '../src/core/features';
import { defaultParams } from '../src/core/params';
import { LM, type Side } from '../src/core/pose';
import type { PunchEvent, PunchKind } from '../src/core/punch';
import { ASPECT, frameFrom, guardBody, moved } from './helpers/synth';

const cfg = (o: Partial<GameConfig> = {}): GameConfig => ({
  stance: 'southpaw', difficulty: 'normal', lenientKind: false, rounds: 1, roundMs: 30000, restMs: 5000,
  latencyOffsetMs: 0, seed: 42, ...o,
});

const punch = (t: number, side: Side, kind: PunchKind): PunchEvent => ({
  t, emittedAt: t + 50, side, kind, confidence: 1,
  features: { delta: [0, 0.3], extent: 0.3, peakSpeed: 3, riseMs: 120, elbow2dAtPeak: 40, elbow3dAtPeak: 80, dipped: false, common: 0, forearmAngle: 65, forearmLen: 0.4, elbowUp: -0.1 },
});

/** A punch that exactly matches a mitt, shifted by dt. */
const hitting = (g: GameSession, i: number, dt = 0) => punch(g.mitts[i].tHit + dt, g.mitts[i].side, g.mitts[i].kind);

describe('punch numbers', () => {
  it('odd = lead hand, even = rear hand; 1-2 straight, 3-4 hook, 5-6 uppercut', () => {
    expect(numberSide(1, 'southpaw')).toBe('right');
    expect(numberSide(2, 'southpaw')).toBe('left');
    expect(numberSide(1, 'orthodox')).toBe('left');
    expect([1, 2, 3, 4, 5, 6].map(numberKind)).toEqual(['straight', 'straight', 'hook', 'hook', 'uppercut', 'uppercut']);
  });
});

describe('combo generation', () => {
  it('stays in the allowed numbers and length, and alternates hands except for 1-1', () => {
    const rng = makeRng(7);
    for (const d of Object.values(DIFFICULTIES)) {
      for (let k = 0; k < 300; k++) {
        const c = generateCombo(d, rng);
        expect(c.length).toBeGreaterThanOrEqual(d.comboLen[0]);
        expect(c.length).toBeLessThanOrEqual(d.comboLen[1]);
        for (const n of c) expect(d.numbers).toContain(n);
        for (let i = 1; i < c.length; i++) {
          if (c[i] % 2 === c[i - 1] % 2) expect([c[i - 1], c[i]]).toEqual([1, 1]);
        }
      }
    }
  });
  it('weights steer the choice (M4 adaptive hook)', () => {
    const rng = makeRng(1);
    const spec = { ...DIFFICULTIES.normal, comboLen: [1, 1] as [number, number] };
    const w = [0, 0, 0, 0, 0, 1, 0];
    for (let k = 0; k < 50; k++) expect(generateCombo(spec, rng, w)).toEqual([5]);
  });
  it('same seed → same session', () => {
    const a = new GameSession(cfg(), 0).mitts.map((m) => [m.n, m.tHit]);
    const b = new GameSession(cfg(), 0).mitts.map((m) => [m.n, m.tHit]);
    expect(a).toEqual(b);
  });
});

describe('schedule', () => {
  it('mitts fall inside their round, in time order, and none during the countdown or rest', () => {
    const g = new GameSession(cfg({ rounds: 3 }), 1000);
    expect(g.mitts.length).toBeGreaterThan(20);
    for (let i = 1; i < g.mitts.length; i++) expect(g.mitts[i].tHit).toBeGreaterThan(g.mitts[i - 1].tHit);
    for (const m of g.mitts) {
      const s = g.roundStart(m.round);
      expect(m.tHit).toBeGreaterThanOrEqual(s + FIRST_HIT_DELAY_MS);
      expect(m.tHit).toBeLessThanOrEqual(s + g.cfg.roundMs);
    }
    expect(g.phaseAt(1000).phase).toBe('countdown');
    expect(g.phaseAt(1000 + COUNTDOWN_MS + 10).phase).toBe('round');
    expect(g.phaseAt(g.roundStart(0) + g.cfg.roundMs + 10).phase).toBe('rest');
    expect(g.phaseAt(g.endAt + 1).phase).toBe('done');
  });
});

describe('judgement', () => {
  const spec = DIFFICULTIES.normal;

  it('pad-work window: a little early or right on arrival → perfect, while held → good, after → nothing', () => {
    const g = new GameSession(cfg(), 0);
    expect(g.onPunch(hitting(g, 0, -(spec.earlyMs - 1)), false, 0)!.grade).toBe('perfect');
    expect(g.onPunch(hitting(g, 1, spec.perfectMs - 1), false, 0)!.grade).toBe('perfect');
    expect(g.onPunch(hitting(g, 2, spec.holdMs - 1), false, 0)!.grade).toBe('good');
    expect(g.onPunch(hitting(g, 3, spec.holdMs + 30), false, 0)).toBeNull();
    expect(g.onPunch(hitting(g, 4, -(spec.earlyMs + 30)), false, 0)).toBeNull();
    expect(g.stray).toBe(2);
  });

  it('the window is wide: the normal difficulty accepts a full second around each mitt', () => {
    expect(spec.earlyMs + spec.holdMs).toBeGreaterThanOrEqual(1000);
  });

  it('two same-hand mitts (1-1): each punch takes the mitt that has been waiting longest', () => {
    const g = new GameSession(cfg(), 0);
    const [a, b] = g.mitts;
    const side = a.side;
    // force a double jab shape: two mitts for the same hand 600 ms apart
    b.side = side; b.kind = a.kind; b.tHit = a.tHit + 600;
    expect(g.onPunch(punch(a.tHit + 500, side, a.kind), false, 0)!.mittId).toBe(a.id);
    expect(g.onPunch(punch(a.tHit + 650, side, a.kind), false, 0)!.mittId).toBe(b.id);
  });

  it('latency offset is subtracted from the punch time', () => {
    const g = new GameSession(cfg({ latencyOffsetMs: 150 }), 0);
    // detector timestamps 150 ms late → still perfect
    expect(g.onPunch(hitting(g, 0, 150), false, 0)!.grade).toBe('perfect');
  });

  it('the wrong hand is ignored, not penalized', () => {
    const g = new GameSession(cfg(), 0);
    const m = g.mitts[0];
    const wrong = punch(m.tHit, m.side === 'left' ? 'right' : 'left', m.kind);
    // may match a later mitt of the other hand only if one is within the window; the target stays open
    g.onPunch(wrong, false, 0);
    expect(g.mitts[0].judgement).toBeNull();
    expect(g.combo).toBe(0);
  });

  it('wrong punch type: miss normally, partial with the lenient option', () => {
    const strict = new GameSession(cfg(), 0);
    const m = strict.mitts[0];
    const other: PunchKind = m.kind === 'hook' ? 'straight' : 'hook';
    const j = strict.onPunch(punch(m.tHit, m.side, other), false, 0)!;
    expect(j.grade).toBe('miss');
    expect(j.seenKind).toBe(other);

    const lenient = new GameSession(cfg({ lenientKind: true }), 0);
    expect(lenient.onPunch(punch(m.tHit, m.side, other), false, 0)!.grade).toBe('partial');
    expect(lenient.score).toBe(SCORING.partial);
  });

  it('unanswered mitts become misses only after the window plus the detector delay', () => {
    const g = new GameSession(cfg(), 0);
    const m = g.mitts[0];
    expect(g.update(m.tHit + spec.holdMs + EMIT_GRACE_MS - 1)).toEqual([]);
    const out = g.update(m.tHit + spec.holdMs + EMIT_GRACE_MS + 1);
    expect(out.map((j) => j.mittId)).toContain(m.id);
    expect(m.judgement!.grade).toBe('miss');
    // a late punch can no longer take it
    expect(g.onPunch(hitting(g, 0), false, 0)?.mittId).not.toBe(m.id);
  });

  it('a large latency offset delays the miss so an on-time punch arriving late still counts', () => {
    const g = new GameSession(cfg({ latencyOffsetMs: 300 }), 0);
    const m = g.mitts[0];
    const raw = m.tHit + 300 + 50; // detector timestamp of a punch 50 ms late
    const arrives = raw + 200; // emitted after the peak is confirmed
    expect(g.update(arrives)).toEqual([]);
    expect(g.onPunch(punch(raw, m.side, m.kind), false, arrives)!.grade).toBe('perfect');
  });

  it('guard bonus, combo multiplier, and combo reset on a miss', () => {
    const g = new GameSession(cfg({ rounds: 3 }), 0);
    expect(g.onPunch(hitting(g, 0), true, 0)!.points).toBe(Math.round(SCORING.perfect * (1 + SCORING.guardBonus)));
    for (let i = 1; i < SCORING.comboStep; i++) g.onPunch(hitting(g, i), false, 0);
    expect(g.combo).toBe(SCORING.comboStep);
    // the 11th hit in a row gets the first multiplier step
    expect(g.onPunch(hitting(g, SCORING.comboStep), false, 0)!.points).toBe(Math.round(SCORING.perfect * (1 + SCORING.comboStepBonus)));
    g.update(g.mitts[SCORING.comboStep + 1].tHit + 10_000);
    expect(g.combo).toBe(0);
    expect(g.maxCombo).toBe(SCORING.comboStep + 1);
  });

  it('per-number stats and accuracy', () => {
    const g = new GameSession(cfg(), 0);
    g.onPunch(hitting(g, 0), false, 0);
    g.update(g.mitts[1].tHit + 10_000);
    const s = g.stats[g.mitts[0].n];
    expect(s.perfect).toBeGreaterThanOrEqual(1);
    const total = g.stats.reduce((a, x) => a + x.attempts, 0);
    expect(total).toBeGreaterThanOrEqual(2);
    expect(g.accuracy()).toBeGreaterThan(0);
    expect(g.accuracy()).toBeLessThan(1);
  });
});

describe('latency calibration', () => {
  it('median of punch − beat, robust to one outlier; needs half the beats', () => {
    const c = new Calibration(0);
    const lags = [110, 120, 130, 115, 125, 400, 118, 122];
    c.beats.forEach((b, i) => c.onPunch(punch(b + Math.min(lags[i], CALIBRATION.windowMs), 'left', 'straight')));
    const r = c.result()!;
    expect(r.hits).toBe(8);
    expect(r.offsetMs).toBeGreaterThanOrEqual(118);
    expect(r.offsetMs).toBeLessThanOrEqual(125);

    const few = new Calibration(0);
    few.onPunch(punch(few.beats[0] + 100, 'left', 'straight'));
    expect(few.result()).toBeNull();
  });
});

describe('guard check', () => {
  const p = defaultParams();
  const feat = (body: ReturnType<typeof guardBody>) => new FeatureExtractor(() => p, ASPECT).update(frameFrom(0, body))!;
  it('wrists at the chin are guarding; a dropped hand is not', () => {
    const b = guardBody();
    expect(guardOk(feat(b), 'left', p)).toBe(true);
    expect(guardOk(feat(b), 'right', p)).toBe(true);
    const dropped = moved(b, LM.WRIST_L, [0, 0.4, 0]); // 0.4 img ≈ 0.9 T lower
    expect(guardOk(feat(dropped), 'left', p)).toBe(false);
    expect(guardOk(feat(dropped), 'right', p)).toBe(true);
  });
  it('a hand far out to the side is not guarding', () => {
    expect(guardOk(feat(moved(guardBody(), LM.WRIST_R, [-0.3, 0, 0])), 'right', p)).toBe(false);
  });
});
