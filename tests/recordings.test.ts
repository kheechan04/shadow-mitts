// Checks against the user's real webcam recordings in recordings/ (southpaw).
// These pin down the DESIGN.md §3 axis conventions that were verified in M0.
// Skipped when the recordings are not present.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scoreRecordings } from '../src/core/evaluate';
import { mirrorRecording } from '../src/core/mirror';
import { defaultParams } from '../src/core/params';
import { LM } from '../src/core/pose';
import { parseRecording, type Recording } from '../src/core/recording';

const DIR = join(__dirname, '..', 'recordings');

function loadByNote(note: string): Recording | null {
  if (!existsSync(DIR)) return null;
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    const rec = parseRecording(readFileSync(join(DIR, f), 'utf8'));
    if (rec.meta.note === note) return rec;
  }
  return null;
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const guard = loadByNote('사우스포, 가드 10초');

describe.skipIf(!guard)('world/image axis conventions (guard recording)', () => {
  // describe bodies run even when skipped, so this must not assume the recording exists
  const frames = (guard?.frames ?? []).filter((f) => f.lm && f.wl && [0, 11, 12, 15, 16, 23, 24].every((i) => f.lm![i][3] >= 0.5));
  const med = (fn: (f: (typeof frames)[number]) => number) => median(frames.map(fn));

  it('has enough usable frames', () => {
    expect(frames.length).toBeGreaterThan(300);
  });

  it('world origin is the hip midpoint', () => {
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(med((f) => (f.wl![LM.HIP_L][k] + f.wl![LM.HIP_R][k]) / 2))).toBeLessThan(0.02);
    }
  });

  it('y points DOWN in both world and image (nose has smaller y than hips)', () => {
    expect(med((f) => f.wl![LM.NOSE][1] - f.wl![LM.HIP_L][1])).toBeLessThan(-0.3);
    expect(med((f) => f.lm![LM.NOSE][1] - f.lm![LM.HIP_L][1])).toBeLessThan(-0.3);
  });

  it("x points toward the person's LEFT in both world and (un-mirrored) image", () => {
    expect(med((f) => f.wl![LM.SHOULDER_L][0] - f.wl![LM.SHOULDER_R][0])).toBeGreaterThan(0.1);
    expect(med((f) => f.lm![LM.SHOULDER_L][0] - f.lm![LM.SHOULDER_R][0])).toBeGreaterThan(0.1);
  });

  it('z is NEGATIVE toward the camera (guard wrists are in front of the shoulders)', () => {
    for (const [s, w] of [[LM.SHOULDER_L, LM.WRIST_L], [LM.SHOULDER_R, LM.WRIST_R]]) {
      expect(med((f) => f.wl![w][2] - f.wl![s][2])).toBeLessThan(-0.1);
      expect(med((f) => f.lm![w][2] - f.lm![s][2])).toBeLessThan(-0.1);
    }
  });
});

// ---------------------------------------------------------------- M1 recognition regression floors
// Floors sit a little below the measured numbers (see README) so tuning can move things, but a
// real regression fails loudly. Update them deliberately when the data or the defaults change.
// Measured (19 southpaw recordings, 175 punches, default params): hand 165/175, extra 12,
// no-punch false 0, number 160/175 (incl. small uppercuts and hooks at ~15 fps).
const FLOORS = { hand: 0.9, extraRate: 0.1, number: 0.86, noPunchFalse: 1 };
// Same recordings thinned to 15 fps (what a webcam in a dim room delivers): hand 154/175,
// number 144/175. Before the frame-rate-aware speed rule this was 100/175.
const FLOORS_15FPS = { hand: 0.83, extraRate: 0.05, number: 0.78, noPunchFalse: 0 };

/** Keep at most `fps` frames per second, like a slower camera would have delivered. */
function thin(rec: Recording, fps: number): Recording {
  let last = -Infinity;
  let skip = 1; // start one frame in, so the thinned frames aren't aligned with the original first frame
  const frames = rec.frames.filter((f) => {
    if (f.t - last < 1000 / fps - 2) return false;
    if (skip-- > 0) return false;
    last = f.t;
    return true;
  });
  return { ...rec, frames };
}

function loadAll(): Recording[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => parseRecording(readFileSync(join(DIR, f), 'utf8')));
}

const all = loadAll();

describe.skipIf(all.length === 0)('punch recognition on real recordings', () => {
  const score = scoreRecordings(all, defaultParams());

  it('almost no punches while holding guard or turning the torso', () => {
    expect(score.noPunchFalse).toBeLessThanOrEqual(FLOORS.noPunchFalse);
  });
  it('finds the punching hand', () => {
    expect(score.detected / score.expected).toBeGreaterThanOrEqual(FLOORS.hand);
  });
  it('extra detections (wrong hand, double counts) stay rare', () => {
    expect(score.extra / score.expected).toBeLessThanOrEqual(FLOORS.extraRate);
  });
  it('gets the punch number right', () => {
    expect(score.kindCorrect / score.expected).toBeGreaterThanOrEqual(FLOORS.number);
  });
  it('orthodox (mirrored) data scores exactly the same', () => {
    expect(scoreRecordings(all.map(mirrorRecording), defaultParams())).toEqual(score);
  });
});

describe.skipIf(all.length === 0)('punch recognition at 15 fps', () => {
  const score = scoreRecordings(all.map((r) => thin(r, 15)), defaultParams());

  it('no punches while holding guard or turning the torso', () => {
    expect(score.noPunchFalse).toBeLessThanOrEqual(FLOORS_15FPS.noPunchFalse);
  });
  it('still finds most punches', () => {
    expect(score.detected / score.expected).toBeGreaterThanOrEqual(FLOORS_15FPS.hand);
    expect(score.kindCorrect / score.expected).toBeGreaterThanOrEqual(FLOORS_15FPS.number);
  });
  it('extra detections stay rare', () => {
    expect(score.extra / score.expected).toBeLessThanOrEqual(FLOORS_15FPS.extraRate);
  });
});
