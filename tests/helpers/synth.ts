// Synthetic pose frames for camera-free tests.
// Points are given in the isotropic "img" space used by FeatureExtractor (X = x*aspect, Y = y, Z = z*aspect),
// for a person facing an UN-mirrored camera: their LEFT side appears at LARGER X.

import type { Vec3 } from '../../src/core/features';
import { LM, type P4, type PoseFrame } from '../../src/core/pose';

export const ASPECT = 4 / 3;

export type Body = Partial<Record<number, Vec3>>;

/** Guard stance, shoulder width 0.3, centered. */
export function guardBody(): Body {
  const cx = ASPECT / 2;
  return {
    [LM.NOSE]: [cx, 0.25, -0.1],
    [LM.MOUTH_L]: [cx + 0.03, 0.3, -0.1],
    [LM.MOUTH_R]: [cx - 0.03, 0.3, -0.1],
    [LM.SHOULDER_L]: [cx + 0.15, 0.45, 0],
    [LM.SHOULDER_R]: [cx - 0.15, 0.45, 0],
    [LM.ELBOW_L]: [cx + 0.17, 0.6, -0.05],
    [LM.ELBOW_R]: [cx - 0.17, 0.6, -0.05],
    [LM.WRIST_L]: [cx + 0.08, 0.35, -0.15],
    [LM.WRIST_R]: [cx - 0.08, 0.35, -0.15],
    [LM.HIP_L]: [cx + 0.1, 0.9, 0],
    [LM.HIP_R]: [cx - 0.1, 0.9, 0],
  };
}

export function frameFrom(t: number, body: Body, opts: { vis?: Partial<Record<number, number>>; aspect?: number } = {}): PoseFrame {
  const aspect = opts.aspect ?? ASPECT;
  const lm: P4[] = [];
  const wl: P4[] = [];
  for (let i = 0; i < 33; i++) {
    const p = body[i] ?? [aspect / 2, 0.5, 0];
    const v = opts.vis?.[i] ?? 0.99;
    lm.push([p[0] / aspect, p[1], p[2] / aspect, v]);
    // World: meters, arbitrary but consistent mapping (1 img unit ≈ 1.5 m).
    wl.push([(p[0] - aspect / 2) * 1.5, (p[1] - 0.5) * 1.5, p[2] * 1.5, v]);
  }
  return { t, lm, wl };
}

export function moved(body: Body, idx: number, delta: Vec3): Body {
  const p = body[idx]!;
  return { ...body, [idx]: [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]] };
}

/** Uniform scale about (cx, cy) — simulates stepping closer/farther from the camera. */
export function scaled(body: Body, k: number, aspect = ASPECT): Body {
  const cx = aspect / 2;
  const cy = 0.5;
  const out: Body = {};
  for (const [i, p] of Object.entries(body)) {
    out[Number(i)] = [cx + (p![0] - cx) * k, cy + (p![1] - cy) * k, p![2] * k];
  }
  return out;
}

// ---------------------------------------------------------------- punch trajectories

/** Torso length of guardBody() in img units (shoulder midpoint y .45 → hip midpoint y .9). */
export const TORSO = 0.45;

/** Keyframe: at time t (ms), the wrist is offset from its guard spot by [inward, up] torso lengths. */
export type Key = [t: number, inward: number, up: number];

const IN_SIGN = { left: -1, right: 1 } as const;

function interp(keys: Key[], t: number): [number, number] {
  let j = 0;
  while (j + 1 < keys.length && keys[j + 1][0] <= t) j++;
  const a = keys[j];
  const b = keys[Math.min(j + 1, keys.length - 1)];
  const u = b[0] > a[0] ? Math.min(1, (t - a[0]) / (b[0] - a[0])) : 0;
  return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

/** Tiny deterministic noise so tests don't depend on Math.random. */
function noise(i: number, k: number): number {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

/**
 * Frames at `fps` from 0 to the last keyframe time, one wrist following linearly interpolated
 * keyframes, the rest of the body in guard. `jitter` = ±img units of landmark noise.
 */
export function trajectory(
  side: 'left' | 'right',
  keys: Key[],
  opts: {
    fps?: number;
    jitter?: number;
    lowVisBetween?: [number, number];
    /** the other wrist follows this fraction of the same on-screen motion (torso turn ≈ 1) */
    follow?: number;
    /** keyframes for the same arm's ELBOW offset from its guard spot (default: elbow stays put) */
    elbow?: Key[];
  } = {},
): PoseFrame[] {
  const fps = opts.fps ?? 50;
  const wristIdx = side === 'left' ? LM.WRIST_L : LM.WRIST_R;
  const end = keys[keys.length - 1][0];
  const frames: PoseFrame[] = [];
  for (let i = 0; i * (1000 / fps) <= end; i++) {
    const t = i * (1000 / fps);
    let j = 0;
    while (j + 1 < keys.length && keys[j + 1][0] <= t) j++;
    const a = keys[j];
    const b = keys[Math.min(j + 1, keys.length - 1)];
    const u = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
    const inward = a[1] + (b[1] - a[1]) * u;
    const up = a[2] + (b[2] - a[2]) * u;
    const shift: [number, number, number] = [IN_SIGN[side] * inward * TORSO, -up * TORSO, 0];
    let body = moved(guardBody(), wristIdx, shift);
    if (opts.elbow) {
      const [ei, eu] = interp(opts.elbow, t);
      body = moved(body, side === 'left' ? LM.ELBOW_L : LM.ELBOW_R, [IN_SIGN[side] * ei * TORSO, -eu * TORSO, 0]);
    }
    if (opts.follow) {
      const otherIdx = side === 'left' ? LM.WRIST_R : LM.WRIST_L;
      body = moved(body, otherIdx, [shift[0] * opts.follow, shift[1] * opts.follow, 0]);
    }
    if (opts.jitter) {
      const jittered: Body = {};
      for (const [k, p] of Object.entries(body)) {
        const n = Number(k);
        jittered[n] = [p![0] + opts.jitter * 2 * noise(i, n), p![1] + opts.jitter * 2 * noise(i, n + 50), p![2]];
      }
      body = jittered;
    }
    const lowVis = opts.lowVisBetween && t >= opts.lowVisBetween[0] && t <= opts.lowVisBetween[1];
    frames.push(frameFrom(t, body, lowVis ? { vis: { [wristIdx]: 0.1 } } : {}));
  }
  return frames;
}
