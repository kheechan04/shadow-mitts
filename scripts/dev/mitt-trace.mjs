// Frame-by-frame mitt trace in virtual time — the check that found the "revived mitt" afterimage
// bug (docs/DEVELOPMENT.md §6). No camera needed: it drives GameController.frame(t) directly.
//
// Needs: the dev server running (npm run dev) and puppeteer-core once:  npm i --no-save puppeteer-core
//   node scripts/dev/mitt-trace.mjs [difficulty=hard] [plan=on,late,miss] [stepMs=33] [url=http://localhost:5173/]
//   CHROME=path/to/chrome.exe to override the browser path.
// plan: what the virtual player does to each mitt of the first 3+ combo — on (hit on time),
// late (+350 ms), early (−150 ms), miss (no punch).
// Output per mitt: when it appears/disappears and any JUMP (a one-frame move 2.5× its neighbours)
// or SCALE JUMP. Camera shake shows up as small wobble; a mitt that re-appears after "gone" is a bug.

import puppeteer from 'puppeteer-core';

const [diff = 'hard', plan = 'on,late,miss', step = '33', url = 'http://localhost:5173/'] = process.argv.slice(2);
const chrome = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const b = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--enable-unsafe-swiftshader'], protocolTimeout: 120000 });
const p = await b.newPage();
await p.setViewport({ width: 1000, height: 586 });
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
await p.goto(url, { waitUntil: 'networkidle0' });

const info = await p.evaluate((diff, plan) => {
  const g = window.__game;
  if (!g) throw new Error('window.__game missing — run against the dev server (npm run dev)');
  g.deps.cameraRunning = () => true;
  g.skipFaceAsk = true;
  g.settings.difficulty = diff;
  g.start();
  cancelAnimationFrame(g.raf);
  g.setScreen = () => {}; // keep the real-time loop from restarting
  const S = g.session.constructor;
  let ms, first = -1;
  for (let seed = 12345; first < 0; seed++) {
    g.session = new S({ ...g.session.cfg, seed, latencyOffsetMs: 0 }, 0);
    ms = g.session.mitts;
    first = ms.findIndex((m) => m.comboIndex === 0 && m.comboSize >= 3);
  }
  const combo = ms.slice(first, first + ms[first].comboSize);
  const acts = plan.split(',');
  window.__plan = combo.map((m, i) => ({ id: m.id, a: acts[i] ?? 'on' }));
  return { combo: combo.map((m) => `#${m.n}@${m.tHit}`), start: combo[0].tHit - 1200, end: combo[combo.length - 1].tHit + 1000 };
}, diff, plan);
console.log('combo', info.combo.join(' '));

const trace = [];
for (let t = info.start; t <= info.end; t += Number(step)) {
  trace.push(await p.evaluate((t) => {
    const g = window.__game; const s = g.session;
    for (const pl of window.__plan) {
      const m = s.mitts.find((x) => x.id === pl.id);
      if (m.judgement || pl.done) continue;
      const at = pl.a === 'on' ? m.tHit + 30 : pl.a === 'late' ? m.tHit + 350 : pl.a === 'early' ? m.tHit - 150 : Infinity;
      if (t < at + 120) continue; // the detector reports ~120 ms after the peak
      pl.done = true;
      const ev = { t: at, emittedAt: t, side: m.side, kind: m.kind, confidence: 1,
        features: { delta: [0.2, 0.3], extent: 0.3, peakSpeed: 3, riseMs: 120, elbow2dAtPeak: 40, elbow3dAtPeak: 80, dipped: false, common: 0, forearmAngle: 65, forearmLen: 0.4, elbowUp: -0.1 } };
      const j = s.onPunch(ev, true, t);
      g.scene.punch(m.side, t, j ? j.mittId : null);
      if (j) g.onJudged(j, t);
    }
    g.frame(t);
    const row = { t };
    for (const m of s.mitts) {
      const v = g.scene.views.get(m.id);
      if (!v) continue;
      const pr = g.scene.project(v.group.position);
      row[`${m.id}:#${m.n}`] = v.group.visible ? [Math.round(pr.x), Math.round(pr.y), +v.group.scale.x.toFixed(2)] : 'hidden';
    }
    return row;
  }, t));
}
await b.close();

const keys = [...new Set(trace.flatMap((r) => Object.keys(r).filter((k) => k !== 't')))];
for (const k of keys) {
  const notes = [];
  let prev = null; // null = not seen yet, 'gone' = was on screen and left
  let appearedAt = -Infinity;
  const steps = [];
  for (const r of trace) {
    const v = r[k];
    if (!v || v === 'hidden') {
      if (prev && prev !== 'gone') {
        notes.push(`${r.t}: gone`);
        prev = 'gone';
      }
      continue;
    }
    if (!prev || prev === 'gone') {
      notes.push(`${r.t}: ${prev === 'gone' ? 'RE-APPEARS (bug?)' : 'appears'} at (${v[0]},${v[1]})`);
      appearedAt = r.t;
    } else steps.push({ t: r.t, d: Math.hypot(v[0] - prev[0], v[1] - prev[1]), ds: v[2] - prev[2] });
    prev = v;
  }
  for (let i = 1; i < steps.length - 1; i++) {
    const { t, d, ds } = steps[i];
    const nb = Math.max(steps[i - 1].d, steps[i + 1].d, 1);
    if (d > 12 && d > 2.5 * nb) notes.push(`${t}: JUMP ${d.toFixed(0)}px`);
    // growing in over the first 200 ms after appearing is intended; the hit pop is ±0.3–0.7
    if (Math.abs(ds) > 0.3 && t - appearedAt > 250) notes.push(`${t}: SCALE ${ds > 0 ? '+' : ''}${ds.toFixed(2)}`);
  }
  console.log(k.padEnd(8), notes.join('; '));
}
if (errors.length) console.log('page errors:', errors);
