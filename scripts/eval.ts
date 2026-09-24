// Runs the recognition pipeline over recordings/*.json and reports what it detected.
//   npm run eval            summary table
//   npm run eval -- -v      also list every event
//   npm run eval -- --mirror  also run the left/right-mirrored copies (orthodox from southpaw)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { punchNumber } from '../src/core/classify';
import { expectationFromNote, runPipeline, scoreRecordings } from '../src/core/evaluate';
import { mirrorRecording } from '../src/core/mirror';
import { defaultParams } from '../src/core/params';
import { parseRecording, type Recording } from '../src/core/recording';

const verbose = process.argv.includes('-v');
const withMirror = process.argv.includes('--mirror');
const dir = join(import.meta.dirname, '..', 'recordings');
const params = defaultParams();

const recs: Recording[] = (existsSync(dir) ? readdirSync(dir) : [])
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => parseRecording(readFileSync(join(dir, f), 'utf8')));
if (recs.length === 0) {
  console.log('recordings/ 에 녹화 JSON이 없습니다. 개발자 도구(⚙) → 녹화로 만들 수 있어요 (recordings/README.md 참고).');
  process.exit(0);
}
const all = withMirror ? recs.flatMap((r) => [r, mirrorRecording(r)]) : recs;

const pad = (s: string | number, n: number) => String(s).padStart(n);
const counts = (c: number[]) => [1, 2, 3, 4, 5, 6].map((n) => pad(c[n] || '.', 3)).join('');
console.log(`${'recording'.padEnd(34)} ${pad('fps', 4)}  got  #1 #2 #3 #4 #5 #6   expected #1..#6`);
for (const rec of all) {
  const exp = expectationFromNote(rec.meta.note);
  const stance = exp?.stance ?? 'orthodox';
  const { events } = runPipeline(rec, params);
  const got = [0, 0, 0, 0, 0, 0, 0];
  for (const e of events) if (e.kind) got[punchNumber(e.side, e.kind, stance)]++;
  const n = rec.frames.length;
  const fps = n > 1 ? ((n - 1) * 1000) / (rec.frames[n - 1].t - rec.frames[0].t) : 0;
  const expText = !exp ? '?' : exp.counts ? counts(exp.counts) : '  (free)';
  console.log(`${rec.meta.note.padEnd(34)} ${pad(fps.toFixed(0), 4)}  ${counts(got)}   ${expText}`);
  if (verbose) {
    for (const e of events) {
      const f = e.features;
      console.log(
        `   ${(e.t / 1000).toFixed(2).padStart(6)}s ${e.side.padEnd(5)} #${e.kind ? punchNumber(e.side, e.kind, stance) : '?'} ${String(e.kind).padEnd(8)}` +
          ` in${f.delta[0].toFixed(2).padStart(6)} up${f.delta[1].toFixed(2).padStart(6)} ext${f.extent.toFixed(2)}` +
          ` spd${f.peakSpeed.toFixed(1).padStart(5)} rise${pad(Math.round(f.riseMs), 4)}ms` +
          ` e2d${pad(Math.round(f.elbow2dAtPeak), 4)}${f.dipped ? ' dip' : ''} delay${pad(Math.round(e.emittedAt - e.t), 4)}ms`,
      );
    }
  }
}

const sc = scoreRecordings(all, params);
const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(0) + '%' : '-');
console.log(
  `\nhand/timing: ${sc.detected}/${sc.expected} (${pct(sc.detected, sc.expected)})  extra: ${sc.extra}` +
    `  no-punch false: ${sc.noPunchFalse}  number: ${sc.kindCorrect}/${sc.expected} (${pct(sc.kindCorrect, sc.expected)})`,
);
