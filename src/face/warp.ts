// Expression warps for the reaction face (prototype). Pure geometry, no DOM: one captured photo +
// its 478 MediaPipe face landmarks → moved landmark positions per expression. The photo is then
// drawn through a triangle mesh from the original to the moved points (see facelab.ts).
//
// Only the user's own pixels are moved; nothing is generated, so identity can't drift. What a
// warp can't do (no teeth or inside of the mouth in a closed-mouth photo) is drawn on top as a
// comic overlay instead.

export type Pt = [number, number];

// MediaPipe face mesh indices (canonical 468 + iris). "Left/right" are the SUBJECT's.
export const FACE = {
  mouthCorners: [61, 291],
  upperLipOuter: [185, 40, 39, 37, 0, 267, 269, 270, 409],
  lowerLipOuter: [146, 91, 181, 84, 17, 314, 405, 321, 375],
  upperLipInner: [191, 80, 81, 82, 13, 312, 311, 310, 415],
  lowerLipInner: [95, 88, 178, 87, 14, 317, 402, 318, 324],
  innerLipRing: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95],
  chin: [152, 148, 176, 149, 150, 377, 400, 378, 379, 175, 171, 396, 199],
  cheeks: [205, 425, 50, 280, 187, 411, 147, 376],
  browInner: [107, 336, 55, 285, 65, 295],
  browMid: [105, 334, 66, 296, 52, 282],
  browOuter: [70, 300, 46, 276, 63, 293],
  upperLids: [159, 158, 160, 386, 385, 387],
  lowerLids: [145, 153, 144, 374, 380, 373],
  eyeCenters: [468, 473],
  eyeOuter: [33, 263],
  noseTip: [1],
  faceOval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
};

export type ExpressionName = 'perfect' | 'good' | 'normal' | 'miss' | 'critical';

/** A push on a group of landmarks, in units of the eye distance; +y is DOWN (image axes). */
interface Move {
  idx: number[];
  dx: number;
  dy: number;
  /** mirror dx for the subject's left side (indices listed as right/left pairs → symmetric) */
  mirror?: boolean;
  /** falloff radius for neighbouring landmarks, eye distances */
  sigma: number;
  /** landmarks this move must not touch (e.g. keep the upper lip still while the jaw drops —
   * in a closed-mouth photo the lips touch, so a plain falloff drags both and the mouth never opens) */
  exclude?: number[];
}

const UPPER_LIP = [...FACE.upperLipInner, ...FACE.upperLipOuter, 78, 308];

/**
 * Recipes. Kept moderate: past ~0.15 eye distances a warp stops reading as the same face and
 * starts to look rubbery — the comic overlays carry the rest.
 */
export const EXPRESSIONS: Record<ExpressionName, Move[]> = {
  normal: [],
  good: [
    { idx: FACE.mouthCorners, dx: 0.04, dy: -0.06, mirror: true, sigma: 0.14 },
    { idx: FACE.cheeks, dx: 0, dy: -0.02, sigma: 0.12 },
  ],
  // a grin: corners up and out, lips parted (the teeth are drawn in by the overlay), cheeks up
  perfect: [
    { idx: FACE.mouthCorners, dx: 0.1, dy: -0.17, mirror: true, sigma: 0.15 },
    { idx: [...FACE.lowerLipInner, ...FACE.lowerLipOuter], dx: 0, dy: 0.1, sigma: 0.05, exclude: UPPER_LIP },
    { idx: FACE.upperLipInner, dx: 0, dy: -0.02, sigma: 0.04 },
    { idx: FACE.cheeks, dx: 0.01, dy: -0.06, mirror: true, sigma: 0.14 },
    { idx: FACE.lowerLids, dx: 0, dy: -0.04, sigma: 0.05 },
    { idx: FACE.browMid, dx: 0, dy: -0.03, sigma: 0.1 },
  ],
  miss: [
    { idx: FACE.mouthCorners, dx: -0.02, dy: 0.09, mirror: true, sigma: 0.13 },
    { idx: FACE.lowerLipOuter, dx: 0, dy: -0.02, sigma: 0.06 },
    { idx: FACE.browInner, dx: -0.02, dy: -0.07, mirror: true, sigma: 0.08 },
    { idx: FACE.browOuter, dx: 0, dy: 0.04, sigma: 0.08 },
    { idx: FACE.upperLids, dx: 0, dy: 0.025, sigma: 0.04 },
  ],
  critical: [
    { idx: [...FACE.browInner, ...FACE.browMid, ...FACE.browOuter], dx: 0, dy: -0.12, sigma: 0.12 },
    { idx: FACE.upperLids, dx: 0, dy: -0.045, sigma: 0.045 },
    { idx: FACE.lowerLids, dx: 0, dy: 0.02, sigma: 0.04 },
    // open mouth: drop the lower lip and chin, upper lip held (the dark inside is an overlay)
    { idx: [...FACE.lowerLipInner, ...FACE.lowerLipOuter], dx: 0, dy: 0.17, sigma: 0.06, exclude: UPPER_LIP },
    { idx: FACE.upperLipInner, dx: 0, dy: -0.02, sigma: 0.04 },
    { idx: FACE.chin, dx: 0, dy: 0.12, sigma: 0.12, exclude: UPPER_LIP },
    { idx: FACE.mouthCorners, dx: -0.03, dy: 0.03, mirror: true, sigma: 0.06 },
  ],
};

export function eyeDistance(lm: Pt[]): number {
  const [a, b] = FACE.eyeOuter;
  return Math.hypot(lm[a][0] - lm[b][0], lm[a][1] - lm[b][1]);
}

/**
 * Moved landmark positions. Each move pushes its anchors fully and nearby landmarks with a
 * Gaussian falloff; contributions add up. `strength` 0 returns the input unchanged.
 * In the image the subject's right side is on the viewer's left; for mirrored moves the anchor
 * on the subject's right (smaller x in a normal photo) gets −dx … i.e. "outward" is away from the
 * face's vertical center line.
 */
export function warpLandmarks(lm: Pt[], expr: ExpressionName, strength = 1): Pt[] {
  const out = lm.map((p) => [p[0], p[1]] as Pt);
  if (strength === 0) return out;
  const u = eyeDistance(lm);
  const cx = (lm[FACE.eyeOuter[0]][0] + lm[FACE.eyeOuter[1]][0]) / 2;
  for (const mv of EXPRESSIONS[expr]) {
    const s2 = 2 * (mv.sigma * u) ** 2;
    const skip = new Set(mv.exclude ?? []);
    for (const a of mv.idx) {
      if (!lm[a]) continue;
      const side = mv.mirror ? Math.sign(lm[a][0] - cx) || 1 : 1;
      const dx = mv.dx * u * side * strength;
      const dy = mv.dy * u * strength;
      for (let j = 0; j < lm.length; j++) {
        if (skip.has(j)) continue;
        const d2 = (lm[j][0] - lm[a][0]) ** 2 + (lm[j][1] - lm[a][1]) ** 2;
        // anchors of the same move don't pile onto each other: each point takes the strongest pull
        const w = Math.exp(-d2 / s2);
        if (w < 0.01) continue;
        out[j][0] += dx * w / Math.max(1, countNear(lm, mv.idx, j, s2));
        out[j][1] += dy * w / Math.max(1, countNear(lm, mv.idx, j, s2));
      }
    }
  }
  return out;
}

/** Sum of the falloff weights of a move's anchors at point j (normalizes overlapping anchors). */
function countNear(lm: Pt[], idx: number[], j: number, s2: number): number {
  let sum = 0;
  for (const a of idx) {
    if (!lm[a]) continue;
    sum += Math.exp(-((lm[j][0] - lm[a][0]) ** 2 + (lm[j][1] - lm[a][1]) ** 2) / s2);
  }
  return sum;
}

// ---------------------------------------------------------------- triangulation

/** Delaunay triangulation (Bowyer–Watson). Returns index triples into `pts`. O(n²), fine for ~550 points once. */
export function delaunay(pts: Pt[]): [number, number, number][] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const d = Math.max(maxX - minX, maxY - minY) * 20;
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const P: Pt[] = [...pts, [mx - d, my - d], [mx, my + d], [mx + d, my - d]];
  const n = pts.length;
  type Tri = { a: number; b: number; c: number; x: number; y: number; r2: number };
  const circ = (a: number, b: number, c: number): Tri => {
    const [ax, ay] = P[a], [bx, by] = P[b], [cx, cy] = P[c];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    return { a, b, c, x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris: Tri[] = [circ(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const [px, py] = P[i];
    const bad: Tri[] = [];
    const keep: Tri[] = [];
    for (const t of tris) ((px - t.x) ** 2 + (py - t.y) ** 2 < t.r2 ? bad : keep).push(t);
    const edges = new Map<string, [number, number]>();
    for (const t of bad) {
      for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as [number, number][]) {
        const k = u < v ? `${u},${v}` : `${v},${u}`;
        if (edges.has(k)) edges.delete(k);
        else edges.set(k, [u, v]);
      }
    }
    for (const [u, v] of edges.values()) keep.push(circ(u, v, i));
    tris = keep;
  }
  return tris.filter((t) => t.a < n && t.b < n && t.c < n).map((t) => [t.a, t.b, t.c]);
}

/**
 * Pinned points that frame the warp so only the face moves: the image border plus a ring well
 * outside the face oval (hair, neck and background stay put).
 */
export function framePoints(lm: Pt[], w: number, h: number): Pt[] {
  const pts: Pt[] = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([t * w, 0], [t * w, h]);
    if (i > 0 && i < steps) pts.push([0, t * h], [w, t * h]);
  }
  // ring 35% outside the oval, clamped into the image
  let cx = 0, cy = 0;
  for (const i of FACE.faceOval) { cx += lm[i][0]; cy += lm[i][1]; }
  cx /= FACE.faceOval.length; cy /= FACE.faceOval.length;
  for (const i of FACE.faceOval) {
    const x = cx + (lm[i][0] - cx) * 1.35, y = cy + (lm[i][1] - cy) * 1.35;
    pts.push([Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y))]);
  }
  return pts;
}
