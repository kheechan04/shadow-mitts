import { describe, expect, it } from 'vitest';
import { EXPRESSIONS, FACE, delaunay, eyeDistance, framePoints, warpLandmarks, type Pt } from '../src/face/warp';

/** A fake 478-point face: a grid inside an oval, with the named landmarks placed plausibly. */
function fakeFace(): Pt[] {
  const lm: Pt[] = [];
  for (let i = 0; i < 478; i++) {
    const a = (i * 2.399963) % (Math.PI * 2); // golden-angle spiral → well spread points
    const r = Math.sqrt(i / 478);
    lm.push([200 + Math.cos(a) * r * 90, 220 + Math.sin(a) * r * 120]);
  }
  lm[33] = [150, 190]; lm[263] = [250, 190]; // eye outer corners → eye distance 100
  lm[61] = [170, 290]; lm[291] = [230, 290]; // mouth corners
  return lm;
}

describe('reaction-face warp', () => {
  const lm = fakeFace();

  it('strength 0 and "normal" leave the face unchanged', () => {
    expect(warpLandmarks(lm, 'perfect', 0)).toEqual(lm);
    expect(warpLandmarks(lm, 'normal', 1)).toEqual(lm);
  });

  it('a smile lifts both mouth corners and pulls them outward, symmetrically', () => {
    const u = eyeDistance(lm);
    const out = warpLandmarks(lm, 'perfect', 1);
    const [l, r] = FACE.mouthCorners;
    expect(out[l][1]).toBeLessThan(lm[l][1] - 0.05 * u);
    expect(out[r][1]).toBeLessThan(lm[r][1] - 0.05 * u);
    expect(out[l][0]).toBeLessThan(lm[l][0]); // left one moves further left
    expect(out[r][0]).toBeGreaterThan(lm[r][0]);
    expect(Math.abs((lm[l][1] - out[l][1]) - (lm[r][1] - out[r][1]))).toBeLessThan(0.02 * u);
  });

  it('a miss turns the mouth corners down', () => {
    const out = warpLandmarks(lm, 'miss', 1);
    for (const i of FACE.mouthCorners) expect(out[i][1]).toBeGreaterThan(lm[i][1]);
  });

  it('moves stay moderate (no point moves more than 0.3 eye distances at strength 1; the open mouth is the largest)', () => {
    const u = eyeDistance(lm);
    for (const name of Object.keys(EXPRESSIONS) as (keyof typeof EXPRESSIONS)[]) {
      const out = warpLandmarks(lm, name, 1);
      for (let i = 0; i < lm.length; i++) expect(Math.hypot(out[i][0] - lm[i][0], out[i][1] - lm[i][1])).toBeLessThan(0.3 * u);
    }
  });

  it('delaunay covers the points with non-degenerate triangles', () => {
    const pts = [...lm, ...framePoints(lm, 400, 460)];
    const tris = delaunay(pts);
    // planar triangulation of n points: about 2n triangles
    expect(tris.length).toBeGreaterThan(pts.length * 1.5);
    const used = new Set(tris.flat());
    expect(used.size).toBeGreaterThan(pts.length * 0.98);
    for (const [a, b, c] of tris) {
      const area = (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[c][0] - pts[a][0]) * (pts[b][1] - pts[a][1]);
      expect(Math.abs(area)).toBeGreaterThan(1e-9);
    }
  });
});
