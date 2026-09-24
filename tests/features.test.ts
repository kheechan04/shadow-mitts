import { describe, expect, it } from 'vitest';
import { FeatureExtractor, angleDeg } from '../src/core/features';
import { defaultParams, type Params } from '../src/core/params';
import { LM } from '../src/core/pose';
import { ASPECT, frameFrom, guardBody, moved, scaled } from './helpers/synth';

/** Filter effectively off, scale not smoothed — isolates the geometry. */
function rawParams(): Params {
  return { ...defaultParams(), filterMinCutoff: 1e6, filterBeta: 0, scaleTau: 0 };
}

describe('angleDeg', () => {
  it('straight arm is 180°, right angle is 90°', () => {
    expect(angleDeg([0, 0, 0], [1, 0, 0], [2, 0, 0])).toBeCloseTo(180);
    expect(angleDeg([0, 0, 0], [1, 0, 0], [1, 1, 0])).toBeCloseTo(90);
  });
  it('degenerate input is NaN, not a crash', () => {
    expect(angleDeg([1, 1, 1], [1, 1, 1], [2, 0, 0])).toBeNaN();
  });
});

describe('FeatureExtractor', () => {
  it('relative wrist position is invariant to camera distance', () => {
    const p = rawParams();
    const near = new FeatureExtractor(() => p, ASPECT).update(frameFrom(0, guardBody()))!;
    const far = new FeatureExtractor(() => p, ASPECT).update(frameFrom(0, scaled(guardBody(), 0.5)))!;
    for (const side of ['left', 'right'] as const) {
      for (let k = 0; k < 3; k++) expect(far.arms[side].rel[k]).toBeCloseTo(near.arms[side].rel[k], 6);
    }
  });

  it('guard pose: symmetric body gives identical left/right features; unit is torso length', () => {
    const f = new FeatureExtractor(rawParams, ASPECT).update(frameFrom(0, guardBody()))!;
    // wrists 0.08 to their own side of the midline and 0.10 above the shoulders; torso = 0.45
    for (const side of ['left', 'right'] as const) {
      expect(f.arms[side].rel[0]).toBeCloseTo(-0.08 / 0.45, 6);
      expect(f.arms[side].rel[1]).toBeCloseTo(0.1 / 0.45, 6);
    }
    expect(f.scale).toBeCloseTo(0.45, 6);
  });

  it('inward motion is positive for each arm even though image X directions are opposite', () => {
    const ex = new FeatureExtractor(rawParams, ASPECT);
    const b0 = guardBody();
    ex.update(frameFrom(0, b0));
    // Left wrist moves toward smaller X (toward body center), right wrist toward larger X.
    let b1 = moved(b0, LM.WRIST_L, [-0.03, 0, 0]);
    b1 = moved(b1, LM.WRIST_R, [0.03, 0, 0]);
    const f = ex.update(frameFrom(100, b1))!;
    // 0.03 img units in 0.1 s with torso length 0.45 → 0.667 T/s
    expect(f.arms.left.vel[0]).toBeCloseTo(0.3 / 0.45, 4);
    expect(f.arms.right.vel[0]).toBeCloseTo(0.3 / 0.45, 4);
    expect(f.arms.left.speed2d).toBeCloseTo(0.3 / 0.45, 4);
  });

  it('upward motion is positive (image Y is flipped)', () => {
    const ex = new FeatureExtractor(rawParams, ASPECT);
    ex.update(frameFrom(0, guardBody()));
    const f = ex.update(frameFrom(50, moved(guardBody(), LM.WRIST_R, [0, -0.03, 0])))!;
    expect(f.arms.right.vel[1]).toBeCloseTo(0.6 / 0.45, 4);
    expect(f.arms.left.speed3d).toBeCloseTo(0, 9);
  });

  it('straight arm reads ~180° elbow angle in both 2D and 3D', () => {
    const b = guardBody();
    const s = b[LM.SHOULDER_L]!;
    const straight = {
      ...b,
      [LM.ELBOW_L]: [s[0] - 0.1, s[1], s[2] - 0.1] as [number, number, number],
      [LM.WRIST_L]: [s[0] - 0.2, s[1], s[2] - 0.2] as [number, number, number],
    };
    const f = new FeatureExtractor(rawParams, ASPECT).update(frameFrom(0, straight))!;
    expect(f.arms.left.elbowAngle3d).toBeCloseTo(180, 3);
    expect(f.arms.left.elbowAngle2d).toBeCloseTo(180, 3);
  });

  it('low visibility invalidates the arm and is reported as missing', () => {
    const f = new FeatureExtractor(rawParams, ASPECT).update(frameFrom(0, guardBody(), { vis: { [LM.WRIST_L]: 0.1 } }))!;
    expect(f.arms.left.valid).toBe(false);
    expect(f.arms.right.valid).toBe(true);
    expect(f.upperBodyInFrame).toBe(false);
    expect(f.missing).toEqual(['왼손목']);
  });

  it('landmark outside the image counts as missing even if visible', () => {
    const f = new FeatureExtractor(rawParams, ASPECT).update(frameFrom(0, moved(guardBody(), LM.WRIST_R, [0, 0.7, 0])))!;
    expect(f.missing).toContain('오른손목');
  });

  it('no velocity across a no-pose gap', () => {
    const ex = new FeatureExtractor(rawParams, ASPECT);
    ex.update(frameFrom(0, guardBody()));
    expect(ex.update({ t: 33, lm: null, wl: null })).toBeNull();
    const f = ex.update(frameFrom(66, moved(guardBody(), LM.WRIST_L, [-0.1, 0, 0])))!;
    expect(f.arms.left.speed3d).toBe(0);
  });

  it('shoulders swapping places (bladed guard) does not move the wrist features', () => {
    // M1 guard recording: MediaPipe swapped/jittered the two shoulders frame to frame while the
    // wrists stood still. Features built on the per-arm shoulder turned that into fake punches.
    const ex = new FeatureExtractor(rawParams, ASPECT);
    const b = guardBody();
    const before = ex.update(frameFrom(0, b))!;
    const swapped = { ...b, [LM.SHOULDER_L]: b[LM.SHOULDER_R], [LM.SHOULDER_R]: b[LM.SHOULDER_L] };
    const after = ex.update(frameFrom(20, swapped))!;
    for (const side of ['left', 'right'] as const) {
      expect(after.arms[side].speed2d).toBeCloseTo(0, 9);
      for (let k = 0; k < 2; k++) expect(after.arms[side].rel[k]).toBeCloseTo(before.arms[side].rel[k], 9);
    }
    expect(after.scale).toBeCloseTo(before.scale, 9);
  });
});
