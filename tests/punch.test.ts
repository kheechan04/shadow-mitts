import { describe, expect, it } from 'vitest';
import { PUNCH_NAMES, classifyPunch, punchNumber } from '../src/core/classify';
import { runPipeline } from '../src/core/evaluate';
import { mirrorFrame, mirrorRecording } from '../src/core/mirror';
import { defaultParams } from '../src/core/params';
import type { PoseFrame } from '../src/core/pose';
import type { PunchFeatures } from '../src/core/punch';
import type { Recording } from '../src/core/recording';
import { ASPECT, trajectory, type Key } from './helpers/synth';

const params = defaultParams();
const rec = (frames: PoseFrame[]): Recording => ({
  meta: { version: 1, createdAt: '', note: 'synthetic', aspect: ASPECT, videoWidth: 640, videoHeight: 480, model: '', delegate: '' },
  frames,
});
const detect = (frames: PoseFrame[]) => runPipeline(rec(frames), params).events;

// 1 s of still guard first so the guard reference settles, like a real session.
const GUARD: Key[] = [[0, 0, 0], [1000, 0, 0]];
// Real jabs peaked at 2.2–3.6 T/s of 2D wrist speed; this one is ~3 T/s before filtering.
const JAB: Key[] = [...GUARD, [1100, 0.05, 0.3], [1150, 0.05, 0.3], [1400, 0, 0], [2000, 0, 0]];

describe('punch detection on synthetic trajectories', () => {
  it('still guard with landmark jitter: no punches', () => {
    expect(detect(trajectory('right', [[0, 0, 0], [5000, 0, 0]], { jitter: 0.004 }))).toEqual([]);
  });

  it('one jab: one event, right hand, straight, timed near full extension', () => {
    const ev = detect(trajectory('right', JAB, { jitter: 0.002 }));
    expect(ev).toHaveLength(1);
    expect(ev[0].side).toBe('right');
    expect(ev[0].kind).toBe('straight');
    // The One Euro filter delays the peak by ~60 ms here; M2 latency calibration absorbs it.
    expect(Math.abs(ev[0].t - 1125)).toBeLessThan(90);
    expect(ev[0].emittedAt - ev[0].t).toBeLessThan(200);
  });

  it('the same jab with the left hand is reported on the left', () => {
    const ev = detect(trajectory('left', JAB));
    expect(ev.map((e) => e.side)).toEqual(['left']);
  });

  it('holding the punch out and then retracting counts once, not twice', () => {
    const held: Key[] = [...GUARD, [1120, 0.05, 0.3], [1700, 0.05, 0.3], [1950, 0, 0], [2600, 0, 0]];
    expect(detect(trajectory('right', held))).toHaveLength(1);
  });

  it('two jabs 450 ms apart are two events', () => {
    const two: Key[] = [...GUARD, [1100, 0, 0.3], [1300, 0, 0], [1450, 0, 0], [1550, 0, 0.3], [1750, 0, 0], [2400, 0, 0]];
    expect(detect(trajectory('right', two))).toHaveLength(2);
  });

  it('hook with an outward wind-up: one hook, not a wind-up event', () => {
    const hook: Key[] = [...GUARD, [1120, -0.3, 0], [1180, -0.3, 0], [1380, 0.9, 0.05], [1650, 0, 0], [2300, 0, 0]];
    // a real hook raises the elbow to wrist height, so the forearm lies flat at the peak
    const elbow: Key[] = [...GUARD, [1120, -0.2, 0.2], [1180, -0.2, 0.3], [1380, 0.5, 0.62], [1650, 0, 0], [2300, 0, 0]];
    const ev = detect(trajectory('right', hook, { elbow }));
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe('hook');
  });

  it('uppercut that dips, pauses at the bottom, and only drives back up to guard height is still found', () => {
    const upper: Key[] = [...GUARD, [1150, 0, -0.4], [1200, 0, -0.4], [1330, 0.15, 0.05], [1600, 0, 0], [2200, 0, 0]];
    const ev = detect(trajectory('right', upper));
    expect(ev).toHaveLength(1);
    expect(ev[0].features.dipped).toBe(true);
    expect(ev[0].kind).toBe('uppercut');
  });

  it('small uppercut: dips, then drives INWARD at low height (barely rising) — found, and not a hook', () => {
    // shape of the "리어 어퍼컷 10회 작게" recording at ~15 fps; the body turns with it (other hand follows)
    // (the recording shows a ~0.2 s pause at the end of the drive before the hand comes back)
    const small: Key[] = [...GUARD, [1150, -0.05, -0.35], [1300, 0.12, -0.3], [1500, 0.12, -0.3], [1800, 0, 0], [2400, 0, 0]];
    const elbow: Key[] = [...GUARD, [1150, 0, -0.25], [1300, 0.05, -0.25], [1500, 0.05, -0.25], [1800, 0, 0], [2400, 0, 0]];
    const ev = detect(trajectory('left', small, { fps: 15, elbow, follow: 0.5 }));
    expect(ev).toHaveLength(1);
    expect(ev[0].features.dipped).toBe(true);
    expect(ev[0].kind).not.toBe('hook');
  });

  it('dropping the hands and slowly raising them again is not a punch', () => {
    const drop: Key[] = [...GUARD, [1300, 0, -1.2], [2500, 0, -1.2], [3500, 0, 0], [4500, 0, 0]];
    expect(detect(trajectory('right', drop))).toEqual([]);
  });

  it('a punch while the wrist is not trusted (low visibility) is ignored', () => {
    expect(detect(trajectory('right', JAB, { lowVisBetween: [1000, 1500] }))).toEqual([]);
  });

  it('torso turn (both hands swing sideways together) is not a punch; the same motion alone is', () => {
    const swing: Key[] = [...GUARD, [1150, 0.4, 0.05], [1400, 0, 0], [2000, 0, 0]];
    expect(detect(trajectory('right', swing, { follow: 0.9 }))).toEqual([]);
    expect(detect(trajectory('right', swing))).toHaveLength(1);
  });

  it('slow drift of the guard hand is not a punch', () => {
    const drift: Key[] = [...GUARD, [1400, 0.3, -0.1], [2000, 0.3, -0.1], [2600, 0, 0], [3200, 0, 0]];
    expect(detect(trajectory('right', drift))).toEqual([]);
  });
});

describe('mirroring', () => {
  it('mirroring twice is the identity', () => {
    const f = trajectory('right', JAB)[60];
    const back = mirrorFrame(mirrorFrame(f));
    for (let i = 0; i < 33; i++) for (let k = 0; k < 4; k++) expect(back.lm![i][k]).toBeCloseTo(f.lm![i][k], 12);
  });

  it('a mirrored right-hand jab is detected as a left-hand jab', () => {
    const ev = runPipeline(mirrorRecording(rec(trajectory('right', JAB))), params).events;
    expect(ev.map((e) => [e.side, e.kind])).toEqual([['left', 'straight']]);
  });
});

describe('classification rules', () => {
  const f = (o: Partial<PunchFeatures>): PunchFeatures => ({
    delta: [0, 0.2], extent: 0.2, peakSpeed: 3, riseMs: 120, elbow2dAtPeak: 40, elbow3dAtPeak: 80, dipped: false, common: 0, forearmAngle: 65, forearmLen: 0.4, elbowUp: -0.1, ...o,
  });
  it('flat forearm → hook, at any fist height', () => {
    for (const up of [-0.3, 0.1, 0.5]) {
      expect(classifyPunch(f({ forearmAngle: 5, delta: [0.6, up] }), params).kind).toBe('hook');
    }
  });
  it('upright forearm with a low elbow (or a dip) → uppercut; short forearm, elbow up → straight', () => {
    // Most recorded uppercuts dipped first, so the fit leans on the dip. Without one, the elbow
    // has to stay clearly low and the fist rise a lot (recordings' p90 values here).
    expect(classifyPunch(f({ forearmAngle: 80, forearmLen: 0.55, elbowUp: -0.57, delta: [0.3, 0.8] }), params).kind).toBe('uppercut');
    expect(classifyPunch(f({ forearmAngle: 75, forearmLen: 0.48, elbowUp: -0.45, delta: [0.3, 0.57], dipped: true }), params).kind).toBe('uppercut');
    expect(classifyPunch(f({ forearmAngle: 65, forearmLen: 0.42, elbowUp: -0.13, delta: [0.19, 0.21] }), params).kind).toBe('straight');
    expect(classifyPunch(f({ forearmAngle: 65, forearmLen: 0.42, elbowUp: -0.13, delta: [0.19, 0.21], dipped: true }), params).kind).toBe('uppercut');
  });
  it('uppercutBias slider shifts borderline punches', () => {
    const border = f({ forearmAngle: 70, forearmLen: 0.45, elbowUp: -0.3, delta: [0.2, 0.35] });
    expect(classifyPunch(border, { ...params, uppercutBias: 3 }).kind).toBe('uppercut');
    expect(classifyPunch(border, { ...params, uppercutBias: -3 }).kind).toBe('straight');
  });
  it('confidence stays within 0..1', () => {
    for (const o of [{}, { dipped: true }, { forearmAngle: -40 }, { forearmAngle: NaN }]) {
      const c = classifyPunch(f(o), params).confidence;
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });
  it('boxing numbers follow the stance', () => {
    expect(punchNumber('left', 'straight', 'orthodox')).toBe(1);
    expect(punchNumber('right', 'straight', 'orthodox')).toBe(2);
    expect(punchNumber('right', 'straight', 'southpaw')).toBe(1);
    expect(punchNumber('left', 'hook', 'southpaw')).toBe(4);
    expect(punchNumber('right', 'uppercut', 'southpaw')).toBe(5);
    expect(PUNCH_NAMES[6]).toBe('리어 어퍼컷');
  });
});
