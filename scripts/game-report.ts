// Analyse a saved game recording (results screen → "이번 판 기록 저장" → rec-game-*.json).
//   npm run game-report -- recordings/rec-game-XXXX.json            summary + per-mitt table
//   npm run game-report -- <file> --events                          + every detected punch with its features
//   npm run game-report -- <file> --params '{"punchMaxRiseMs":350}' replay with these settings
//
// It replays the saved pose frames through the current recognition code, judges them the way the
// game does, and reports how many judgements match what happened live. A full match means the
// replay reproduces the game (so fixes can be tested on it); a mismatch usually means different
// settings — newer recordings store the settings that were in effect (game.params).

import { readFileSync } from 'node:fs';
import { punchNumber } from '../src/core/classify';
import { runPipeline } from '../src/core/evaluate';
import { DIFFICULTIES, type Difficulty } from '../src/core/game';
import { defaultParams, type Params } from '../src/core/params';
import { parseRecording } from '../src/core/recording';

interface SavedMitt {
  n: number; side: 'left' | 'right'; kind: string; tHit: number; holdUntil: number;
  grade: string | null; dtMs: number | null; judgedAt: number | null; seenKind: string | null;
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !a.startsWith('{'));
if (!file) {
  console.log('사용법: npm run game-report -- recordings/rec-game-XXXX.json [--events] [--params \'{"key":value}\']');
  process.exit(1);
}
const text = readFileSync(file, 'utf8');
const raw = JSON.parse(text) as { game?: Record<string, unknown> };
if (!raw.game) {
  console.log('게임 기록이 아니에요 (game 블록 없음). 연습 녹화는 npm run eval 로 보세요.');
  process.exit(1);
}
const g = raw.game as {
  difficulty: Difficulty; latencyOffsetMs: number; lenientKind: boolean; mitts: SavedMitt[]; stray: number;
  renderGapsMs?: number[]; inferMs?: number[]; params?: Partial<Params>; paramsChanged?: Partial<Params>;
};
const rec = parseRecording(text);
const stance = rec.meta.note.includes('사우스포') ? 'southpaw' : 'orthodox';
const pIdx = args.indexOf('--params');
const override = pIdx >= 0 ? (JSON.parse(args[pIdx + 1]) as Partial<Params>) : {};
// replay with the settings of that game when saved, else current defaults; --params wins
const params: Params = { ...defaultParams(), ...(g.params ?? {}), ...override };

const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const fr = rec.frames;
const gaps = fr.slice(1).map((f, i) => f.t - fr[i].t);
console.log(`${file}\n${rec.meta.note} · ${rec.meta.delegate} · ${fr.length} frames · ${(fr[fr.length - 1].t / 1000).toFixed(1)} s`);
console.log(`detections: ${(1000 / q(gaps, 0.5)).toFixed(1)}/s (interval median ${q(gaps, 0.5).toFixed(0)} ms, p90 ${q(gaps, 0.9).toFixed(0)} ms)`);
if (g.inferMs?.length) { const inf = g.inferMs.filter((x) => Number.isFinite(x)); console.log(`inference: median ${q(inf, 0.5)} ms, p90 ${q(inf, 0.9)} ms`); }
if (g.renderGapsMs?.length) {
  const r = g.renderGapsMs;
  console.log(`display frames: median ${q(r, 0.5)} ms, p99 ${q(r, 0.99)} ms, max ${Math.max(...r)} ms, >50 ms: ${r.filter((x) => x > 50).length}`);
}
console.log(`settings changed from defaults at the time: ${JSON.stringify(g.paramsChanged ?? '(not recorded)')}${pIdx >= 0 ? ` · override ${JSON.stringify(override)}` : ''}`);

// replay + judge like GameSession.onPunch: earliest waiting mitt of that hand, early window .. holdUntil
const { events } = runPipeline(rec, params);
const spec = DIFFICULTIES[g.difficulty];
const L = g.latencyOffsetMs;
const replay = g.mitts.map(() => null as string | null);
for (const e of events) {
  const t = e.t - L;
  const i = g.mitts.findIndex((m, k) => !replay[k] && m.side === e.side && t >= m.tHit - spec.earlyMs && t <= m.holdUntil);
  if (i < 0) continue;
  const m = g.mitts[i];
  replay[i] = e.kind === m.kind ? (t - m.tHit <= spec.perfectMs ? 'perfect' : 'good') : g.lenientKind ? 'partial' : 'miss';
}
const tally = (xs: (string | null)[]) => xs.reduce((o: Record<string, number>, x) => ((o[x ?? 'miss'] = (o[x ?? 'miss'] ?? 0) + 1), o), {});
const hits = (xs: (string | null)[]) => xs.filter((x) => x === 'perfect' || x === 'good').length;
console.log(`\nlive:   ${JSON.stringify(tally(g.mitts.map((m) => m.grade)))} hits ${hits(g.mitts.map((m) => m.grade))}/${g.mitts.length}, stray ${g.stray}`);
console.log(`replay: ${JSON.stringify(tally(replay))} hits ${hits(replay)}/${g.mitts.length}`);
const same = g.mitts.filter((m, i) => (m.grade ?? 'miss') === (replay[i] ?? 'miss')).length;
console.log(`replay matches live: ${same}/${g.mitts.length}`);

console.log('\nmitt            live      replay    punches seen near it (ms from arrival, hand, number, extent, speed)');
for (const [i, m] of g.mitts.entries()) {
  const near = events.filter((e) => e.t - L >= m.tHit - 700 && e.t - L <= m.holdUntil + 300)
    .map((e) => `${Math.round(e.t - L - m.tHit)} ${e.side[0]}#${e.kind ? punchNumber(e.side, e.kind, stance) : '?'} ext${e.features.extent.toFixed(2)} spd${e.features.peakSpeed.toFixed(1)}`);
  console.log(`${(m.tHit / 1000).toFixed(2).padStart(6)}s #${m.n} ${m.side[0]}  ${String(m.grade).padEnd(9)} ${String(replay[i] ?? 'miss').padEnd(9)} ${near.join(' | ')}`);
}

if (args.includes('--events')) {
  console.log('\nevent features (want# = the mitt of that hand up at the time)');
  for (const e of events) {
    const f = e.features;
    const m = g.mitts.find((x) => x.side === e.side && e.t - L >= x.tHit - 250 && e.t - L <= x.holdUntil);
    console.log(`${((e.t - L) / 1000).toFixed(2)}s ${e.side[0]}#${e.kind ? punchNumber(e.side, e.kind, stance) : '?'} want#${m?.n ?? '-'} ` +
      `d(${f.delta[0].toFixed(2)},${f.delta[1].toFixed(2)}) ext${f.extent.toFixed(2)} spd${f.peakSpeed.toFixed(1)} rise${f.riseMs.toFixed(0)} ` +
      `fa${f.forearmAngle.toFixed(0)} fl${f.forearmLen.toFixed(2)} eu${f.elbowUp.toFixed(2)} dip${f.dipped ? 1 : 0} e2d${f.elbow2dAtPeak.toFixed(0)}`);
  }
}
