import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from '../src/core/oneEuro';
import { PARAM_DEFS, defaultParams, sanitizeParams } from '../src/core/params';
import { parseRecording, serializeRecording, type Recording } from '../src/core/recording';
import { frameFrom, guardBody } from './helpers/synth';

describe('OneEuroFilter', () => {
  it('passes a constant signal unchanged', () => {
    const f = new OneEuroFilter(() => ({ minCutoff: 1, beta: 0, dCutoff: 1 }));
    for (let i = 0; i < 30; i++) expect(f.filter(5, i / 30)).toBeCloseTo(5);
  });

  it('lags a step, and lags less with higher minCutoff', () => {
    const run = (minCutoff: number) => {
      const f = new OneEuroFilter(() => ({ minCutoff, beta: 0, dCutoff: 1 }));
      f.filter(0, 0);
      return f.filter(1, 1 / 30);
    };
    const slow = run(1);
    const fast = run(10);
    expect(slow).toBeGreaterThan(0);
    expect(slow).toBeLessThan(fast);
    expect(fast).toBeLessThan(1);
  });

  it('beta makes fast motion track closer', () => {
    const run = (beta: number) => {
      const f = new OneEuroFilter(() => ({ minCutoff: 1, beta, dCutoff: 1 }));
      let y = 0;
      for (let i = 0; i <= 10; i++) y = f.filter(i * 0.1, i / 30); // ramp at 3 units/s
      return 1 - y;
    };
    expect(run(2)).toBeLessThan(run(0));
  });

  it('ignores non-increasing timestamps', () => {
    const f = new OneEuroFilter(() => ({ minCutoff: 1, beta: 0, dCutoff: 1 }));
    f.filter(0, 1);
    expect(f.filter(100, 1)).toBe(0);
  });
});

describe('params', () => {
  it('every default is inside its slider range', () => {
    for (const d of PARAM_DEFS) {
      expect(d.default).toBeGreaterThanOrEqual(d.min);
      expect(d.default).toBeLessThanOrEqual(d.max);
    }
  });
  it('sanitize clamps, ignores junk, fills defaults', () => {
    const p = sanitizeParams({ minVisibility: 7, filterBeta: 'x', filterMinCutoff: NaN, bogus: 1 });
    expect(p.minVisibility).toBe(1);
    expect(p.filterBeta).toBe(defaultParams().filterBeta);
    expect(p.filterMinCutoff).toBe(defaultParams().filterMinCutoff);
    expect('bogus' in p).toBe(false);
    expect(sanitizeParams(null)).toEqual(defaultParams());
  });
});

describe('recording', () => {
  const rec = (): Recording => ({
    meta: { version: 1, createdAt: '2026-09-24T00:00:00Z', note: 'test', aspect: 4 / 3, videoWidth: 640, videoHeight: 480, model: 'lite', delegate: 'GPU' },
    frames: [frameFrom(1000.123, guardBody()), { t: 1033.3, lm: null, wl: null }, frameFrom(1066.6, guardBody())],
  });

  it('round-trips and rebases time to 0', () => {
    const back = parseRecording(serializeRecording(rec()));
    expect(back.meta.note).toBe('test');
    expect(back.frames.map((f) => f.t)).toEqual([0, 33.2, 66.5]);
    expect(back.frames[1].lm).toBeNull();
    const a = rec().frames[0].lm!;
    const b = back.frames[0].lm!;
    for (let i = 0; i < 33; i++) for (let k = 0; k < 4; k++) expect(b[i][k]).toBeCloseTo(a[i][k], 4);
  });

  it('rejects wrong version, missing aspect, decreasing time, bad points', () => {
    const good = JSON.parse(serializeRecording(rec()));
    const bad = (mut: (o: any) => void) => {
      const o = structuredClone(good);
      mut(o);
      return () => parseRecording(JSON.stringify(o));
    };
    expect(bad((o) => (o.meta.version = 2))).toThrow(/버전/);
    expect(bad((o) => delete o.meta.aspect)).toThrow(/aspect/);
    expect(bad((o) => (o.frames[2].t = -1))).toThrow(/감소/);
    expect(bad((o) => (o.frames[0].lm[3] = [1, 2]))).toThrow(/형식/);
    expect(() => parseRecording('{"foo":1}')).toThrow(/형식/);
  });
});
