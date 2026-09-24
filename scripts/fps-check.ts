// How recognition holds up on slower cameras: every recording is thinned to lower frame rates
// (keeping at most N frames per second, as a webcam in a dim room would deliver) and scored.
//   npm run fps-check                                   default settings at full, 30, 20, 15, 12 fps
//   npm run fps-check -- --set punchMinPeakSpeed=1.8     try a setting (repeatable)
//   npm run fps-check -- -v                              per-recording counts at 15 fps
// This is how the 15 fps problem was found and fixed (docs/DEVELOPMENT.md §4 "낮은 fps 보정").

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { punchNumber } from '../src/core/classify';
import { expectationFromNote, runPipeline, scoreRecordings } from '../src/core/evaluate';
import { defaultParams, type Params } from '../src/core/params';
import { parseRecording, type Recording } from '../src/core/recording';

const dir = join(import.meta.dirname, '..', 'recordings');
const recs = (existsSync(dir) ? readdirSync(dir) : [])
  .filter((f) => f.endsWith('.json') && !f.startsWith('rec-game-'))
  .sort()
  .map((f) => parseRecording(readFileSync(join(dir, f), 'utf8')));
if (recs.length === 0) {
  console.log('recordings/ 에 연습 녹화가 없습니다.');
  process.exit(0);
}

const params: Params = defaultParams();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--set') continue;
  const [k, v] = args[++i].split('=');
  if (!(k in params)) throw new Error(`unknown setting ${k}`);
  (params as Record<string, number>)[k] = Number(v);
}

export function thin(rec: Recording, fps: number): Recording {
  let last = -Infinity;
  let skip = 1; // start one frame in, so thinned frames aren't aligned with the first one
  return {
    ...rec,
    frames: rec.frames.filter((f) => {
      if (f.t - last < 1000 / fps - 2) return false;
      if (skip-- > 0) return false;
      last = f.t;
      return true;
    }),
  };
}

for (const fps of [Infinity, 30, 20, 15, 12]) {
  const set = Number.isFinite(fps) ? recs.map((r) => thin(r, fps)) : recs;
  const s = scoreRecordings(set, params);
  console.log(`${Number.isFinite(fps) ? `<=${fps} fps` : 'full    '}  hand ${s.detected}/${s.expected}  number ${s.kindCorrect}/${s.expected}  extra ${s.extra}  no-punch false ${s.noPunchFalse}`);
}

if (args.includes('-v')) {
  console.log('\nper recording at 15 fps (got #1..#6 / expected #1..#6)');
  for (const r of recs.map((x) => thin(x, 15))) {
    const exp = expectationFromNote(r.meta.note);
    if (!exp?.counts) continue;
    const got = [0, 0, 0, 0, 0, 0, 0];
    for (const e of runPipeline(r, params).events) if (e.kind) got[punchNumber(e.side, e.kind, exp.stance)]++;
    console.log(`  ${r.meta.note.padEnd(28)} ${got.slice(1).join(' ')}  /  ${exp.counts.slice(1).join(' ')}`);
  }
}
