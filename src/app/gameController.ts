// Screens (menu → playing → results, plus calibration), HUD, and the per-frame glue between the
// recognition pipeline, the pure game rules (core/game.ts) and the 3D scene.

import { PUNCH_NAMES } from '../core/classify';
import type { FrameFeatures } from '../core/features';
import {
  CALIBRATION, Calibration, DIFFICULTIES, GameSession,
  type Difficulty, type Grade, type Judgement, type Mitt,
} from '../core/game';
import { guardOk } from '../core/guard';
import type { Params } from '../core/params';
import type { Side, Stance } from '../core/pose';
import type { PunchEvent } from '../core/punch';
import { GameScene, type HandInput } from './scene3d';
import { cue, setMuted, tick, uiClick, unlockAudio } from './sfx';

const SETTINGS_KEY = 'shadowmitts.game.v2';
const GUARD_HISTORY_MS = 2000;

interface Settings {
  difficulty: Difficulty;
  rounds: number;
  roundSec: number;
  lenient: boolean;
  sound: boolean;
  offsetMs: number;
}

const DEFAULTS: Settings = { difficulty: 'normal', rounds: 1, roundSec: 60, lenient: true, sound: true, offsetMs: 150 };

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    const s = { ...DEFAULTS, ...raw };
    if (!(s.difficulty in DIFFICULTIES)) s.difficulty = DEFAULTS.difficulty;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const GRADE_TEXT: Record<Grade, string> = { perfect: 'PERFECT', good: 'GOOD', partial: 'OK', miss: 'MISS' };
const GRADE_COLOR: Record<Grade, string> = { perfect: '#ffd766', good: '#34d399', partial: '#60a5fa', miss: '#f43f5e' };
const KIND_KO = { straight: '직선', hook: '훅', uppercut: '어퍼컷' } as const;

type Screen = 'menu' | 'playing' | 'calibrating' | 'results';

interface Popup { text: string; sub?: string; color: string; x: number; y: number; at: number }

export interface GameDeps {
  params: () => Params;
  stance: () => Stance;
  setStance: (s: Stance) => void;
  cameraRunning: () => boolean;
  notify: (msg: string) => void;
}

export class GameController {
  private settings = loadSettings();
  private screen: Screen = 'menu';
  private session: GameSession | null = null;
  private calib: Calibration | null = null;
  private calibMitts: Mitt[] = [];
  private scene: GameScene;
  private fx: HTMLCanvasElement;
  private popups: Popup[] = [];
  private guardHistory: { t: number; ok: Record<Side, boolean> }[] = [];
  private hands: Record<Side, HandInput | null> = { left: null, right: null };
  private handsAt = 0;
  private cued = new Set<string>();
  private raf = 0;
  private lastBig = '';

  constructor(private deps: GameDeps) {
    this.scene = new GameScene($<HTMLCanvasElement>('scene3d'), `${import.meta.env.BASE_URL}assets/gym-bright.jpg`);
    this.fx = $<HTMLCanvasElement>('fx');
    const onResize = () => {
      const st = $('stage');
      this.scene.resize(st.clientWidth, st.clientHeight);
      this.fx.width = st.clientWidth * Math.min(devicePixelRatio, 2);
      this.fx.height = st.clientHeight * Math.min(devicePixelRatio, 2);
    };
    window.addEventListener('resize', onResize);
    onResize();

    this.bindMenu();
    $('hQuit').addEventListener('click', () => this.finish());
    $('rAgain').addEventListener('click', () => this.start());
    $('rMenu').addEventListener('click', () => this.setScreen('menu'));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (this.screen === 'playing' || this.screen === 'calibrating')) this.finish();
    });
    this.refreshMenu();
    setInterval(() => this.refreshMenu(), 400);
  }

  get active(): boolean {
    return this.screen === 'playing' || this.screen === 'calibrating';
  }

  // ---------------------------------------------------------------- menu

  private save(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // settings just won't persist
    }
  }

  private bindMenu(): void {
    const s = this.settings;
    const pick = (groupId: string, attr: string, onPick: (v: string) => void) => {
      $(groupId).addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('button');
        if (!b || !b.hasAttribute(attr)) return;
        uiClick();
        onPick(b.getAttribute(attr)!);
        this.save();
        this.refreshMenu();
      });
    };
    pick('stanceSeg', 'data-stance', (v) => this.deps.setStance(v as Stance));
    pick('diffSeg', 'data-diff', (v) => (s.difficulty = v as Difficulty));
    pick('roundsSeg', 'data-v', (v) => (s.rounds = Number(v)));
    pick('lenSeg', 'data-v', (v) => (s.roundSec = Number(v)));
    const lenient = $<HTMLInputElement>('gLenient');
    const sound = $<HTMLInputElement>('gSound');
    const offset = $<HTMLInputElement>('gOffset');
    lenient.checked = s.lenient;
    sound.checked = s.sound;
    offset.value = String(s.offsetMs);
    setMuted(!s.sound);
    lenient.addEventListener('change', () => { s.lenient = lenient.checked; this.save(); });
    sound.addEventListener('change', () => { s.sound = sound.checked; setMuted(!s.sound); this.save(); });
    offset.addEventListener('input', () => { s.offsetMs = Number(offset.value); this.save(); this.refreshMenu(); });
    $('gStart').addEventListener('click', () => this.start());
    $('gCalibrate').addEventListener('click', () => this.startCalibration());
  }

  private refreshMenu(): void {
    const s = this.settings;
    const mark = (groupId: string, attr: string, value: string) => {
      for (const b of $(groupId).querySelectorAll('button')) b.classList.toggle('sel', b.getAttribute(attr) === value);
    };
    mark('stanceSeg', 'data-stance', this.deps.stance());
    mark('diffSeg', 'data-diff', s.difficulty);
    mark('roundsSeg', 'data-v', String(s.rounds));
    mark('lenSeg', 'data-v', String(s.roundSec));
    $('gOffsetOut').textContent = `${s.offsetMs} ms`;
    const cam = this.deps.cameraRunning();
    $<HTMLButtonElement>('gStart').disabled = !cam;
    $<HTMLButtonElement>('gCalibrate').disabled = !cam;
    $('startCam').textContent = cam ? '켜짐 ✓' : '켜기';
    $('startCam').classList.toggle('on', cam);
  }

  private setScreen(s: Screen): void {
    this.screen = s;
    $('stage').dataset.screen = s;
    if (s === 'playing' || s === 'calibrating') {
      cancelAnimationFrame(this.raf);
      const loop = () => {
        this.frame(performance.now());
        if (this.active) this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(this.raf);
      this.scene.clear();
      this.popups = [];
      this.lastBig = '';
      $('bigText').innerHTML = '';
      this.fx.getContext('2d')!.clearRect(0, 0, this.fx.width, this.fx.height);
    }
    this.refreshMenu();
  }

  // ---------------------------------------------------------------- game flow

  start(): void {
    if (!this.deps.cameraRunning()) {
      this.deps.notify('먼저 카메라를 켜 주세요');
      return;
    }
    unlockAudio();
    const s = this.settings;
    this.scene.clear();
    this.cued.clear();
    this.calib = null;
    this.session = new GameSession(
      {
        stance: this.deps.stance(), difficulty: s.difficulty, lenientKind: s.lenient,
        rounds: s.rounds, roundMs: s.roundSec * 1000, restMs: 10_000,
        latencyOffsetMs: s.offsetMs, seed: (Date.now() & 0x7fffffff) >>> 0,
      },
      performance.now(),
    );
    this.setScreen('playing');
  }

  /** Stop early (Esc / 그만) or at the end: show results when a game was running. */
  finish(): void {
    if (this.screen === 'calibrating') {
      this.calib = null;
      this.setScreen('menu');
      return;
    }
    if (this.session) {
      this.showResults(this.session);
      this.setScreen('results');
    } else this.setScreen('menu');
  }

  /** Camera stopped: bail out to the menu. */
  stop(): void {
    this.session = null;
    this.calib = null;
    if (this.screen !== 'menu') this.setScreen('menu');
  }

  startCalibration(): void {
    if (!this.deps.cameraRunning()) {
      this.deps.notify('먼저 카메라를 켜 주세요');
      return;
    }
    unlockAudio();
    this.session = null;
    this.cued.clear();
    this.scene.clear();
    this.calib = new Calibration(performance.now());
    const lead: Side = this.deps.stance() === 'orthodox' ? 'left' : 'right';
    // Show each beat as a jab mitt so calibration feels like the game.
    this.calibMitts = this.calib.beats.map((tHit, i) => ({
      id: 10_000 + i, n: 1, side: lead, kind: 'straight' as const, tHit, round: 0, comboIndex: 0, comboSize: 1, judgement: null,
    }));
    this.setScreen('calibrating');
  }

  // ---------------------------------------------------------------- inputs from the camera loop

  private guardAt(t: number, side: Side): boolean {
    let best: (typeof this.guardHistory)[number] | null = null;
    for (const g of this.guardHistory) if (!best || Math.abs(g.t - t) < Math.abs(best.t - t)) best = g;
    return best?.ok[side] ?? false;
  }

  /** Every processed camera frame. `now` is the frame's clock time (performance.now based). */
  onFrame(features: FrameFeatures | null, events: PunchEvent[], now: number): void {
    const p = this.deps.params();
    const st = $('camStatus');
    if (features) {
      this.guardHistory.push({ t: features.t, ok: { left: guardOk(features, 'left', p), right: guardOk(features, 'right', p) } });
      while (this.guardHistory.length && this.guardHistory[0].t < now - GUARD_HISTORY_MS) this.guardHistory.shift();
      for (const s of ['left', 'right'] as const) {
        const a = features.arms[s];
        this.hands[s] = a.valid ? { imgX: (s === 'left' ? -1 : 1) * a.rel[0], up: a.rel[1], speed: a.speed2d } : null;
      }
      this.handsAt = now;
      st.textContent = features.upperBodyInFrame ? '준비 완료 ✓' : '상체가 다 보이게 조금 뒤로';
      st.className = `cam-status ${features.upperBodyInFrame ? 'ok' : 'warn'}`;
    } else {
      this.hands = { left: null, right: null };
      st.textContent = '사람이 안 보여요';
      st.className = 'cam-status warn';
    }

    if (this.calib) {
      for (const e of events) {
        const i = this.calib.onPunch(e);
        this.scene.punch(e.side, now, i !== null ? this.calibMitts[i].id : null);
        if (i !== null) {
          const m = this.calibMitts[i];
          const j: Judgement = { mittId: m.id, grade: 'perfect', dtMs: e.t - m.tHit, points: 0, guardOk: null, at: now };
          m.judgement = j;
          this.onJudged(j, now);
        }
      }
      return;
    }

    const g = this.session;
    if (!g || this.screen !== 'playing') return;
    for (const e of events) {
      const other: Side = e.side === 'left' ? 'right' : 'left';
      const j = g.onPunch(e, this.guardAt(e.t, other), now);
      this.scene.punch(e.side, now, j?.mittId ?? null);
      if (j) this.onJudged(j, now);
    }
  }

  private onJudged(j: Judgement, now: number): void {
    this.scene.judged(j, now);
    const pos = this.scene.mittScreenPos(j.mittId);
    if (!pos) return;
    this.popups.push({
      text: GRADE_TEXT[j.grade],
      sub: j.seenKind ? `${KIND_KO[j.seenKind]}로 인식됨` : j.guardOk ? '가드 보너스' : undefined,
      color: GRADE_COLOR[j.grade],
      x: pos.x, y: pos.y, at: now,
    });
  }

  // ---------------------------------------------------------------- per display frame

  private frame(now: number): void {
    const handsFresh = now - this.handsAt < 400 ? this.hands : { left: null, right: null };
    if (this.calib) {
      const c = this.calib;
      this.cueBeats(this.calibMitts, now);
      for (const m of this.calibMitts) {
        if (!m.judgement && now > m.tHit + CALIBRATION.windowMs) {
          m.judgement = { mittId: m.id, grade: 'miss', dtMs: NaN, points: 0, guardOk: null, at: now };
          this.onJudged(m.judgement, now);
        }
      }
      this.scene.render(this.calibMitts, this.deps.stance(), 2200, CALIBRATION.windowMs, CALIBRATION.windowMs, now, handsFresh);
      this.setBig(now < c.beats[0] - 700 ? '타이밍 맞추기<small>날아온 미트가 목표 링에 딱 겹칠 때 잽! (8번)</small>' : '');
      this.drawFx(now);
      if (now > c.endAt) this.finishCalibration(c);
      return;
    }

    const g = this.session;
    if (!g) return;
    for (const j of g.update(now)) this.onJudged(j, now);
    this.cueBeats(g.mitts, now);
    this.scene.render(g.mitts, g.cfg.stance, g.spec.approachMs, g.spec.holdMs, g.settleMs, now, handsFresh);
    this.drawFx(now);
    this.updateHud(g, now);
    if (g.phaseAt(now).phase === 'done') this.finish();
  }

  /** "틱 틱" before the first mitt of each combo, "딱" as each mitt lands. */
  private cueBeats(mitts: readonly Mitt[], now: number): void {
    for (const m of mitts) {
      if (m.tHit - now > 1000 || now - m.tHit > 200) continue;
      const fire = (key: string, at: number, fn: () => void) => {
        if (now >= at && !this.cued.has(key)) {
          this.cued.add(key);
          if (now - at < 120) fn();
        }
      };
      if (m.comboIndex === 0) {
        fire(`${m.id}a`, m.tHit - 800, tick);
        fire(`${m.id}b`, m.tHit - 400, tick);
      }
      fire(`${m.id}c`, m.tHit, cue);
    }
  }

  private setBig(html: string, pop = false): void {
    if (html === this.lastBig) return;
    this.lastBig = html;
    const el = $('bigText');
    el.innerHTML = html;
    if (pop) {
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }
  }

  private updateHud(g: GameSession, now: number): void {
    const ph = g.phaseAt(now);
    $('hScore').textContent = g.score.toLocaleString();
    const mult = Math.min(2, 1 + Math.floor(g.combo / 10) * 0.1);
    $('hCombo').innerHTML = g.combo >= 2 ? `${g.combo} COMBO${mult > 1 ? `<small>×${mult.toFixed(1)}</small>` : ''}` : '';
    $('hRound').textContent = `ROUND ${ph.round + 1} / ${g.cfg.rounds}`;
    const secs = ph.phase === 'round' ? Math.ceil(ph.msLeft / 1000) : ph.phase === 'rest' ? 0 : g.cfg.roundMs / 1000;
    $('hTime').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

    if (ph.phase === 'countdown') {
      this.setBig(`${Math.ceil(ph.msLeft / 1000)}`, true);
    } else if (ph.phase === 'round' && now - g.roundStart(ph.round) < 800) {
      this.setBig(ph.round === 0 ? 'FIGHT!' : `ROUND ${ph.round + 1}`, true);
    } else if (ph.phase === 'rest') {
      this.setBig(`휴식<small>${Math.ceil(ph.msLeft / 1000)}초 후 다음 라운드</small>`);
    } else this.setBig('');

    // combo callout: the trainer's "1-2-3!"
    const next = g.mitts.find((m) => !m.judgement && m.tHit - now < g.spec.approachMs);
    const call = $('hCall');
    if (next) {
      const first = g.mitts.indexOf(next) - next.comboIndex;
      const combo = g.mitts.slice(first, first + next.comboSize);
      call.innerHTML = combo
        .map((m) => {
          const state = m.judgement ? (m.judgement.grade === 'miss' ? 'miss' : 'hit') : m === next ? 'now' : '';
          return `<div class="chip ${m.side === 'left' ? 'L' : 'R'} ${state}"><b>${m.n}</b>${PUNCH_NAMES[m.n]}</div>`;
        })
        .join('<span class="sep">›</span>');
    } else call.innerHTML = '';

    const last = this.guardHistory[this.guardHistory.length - 1];
    const guard = $('hGuard');
    if (!last || now - last.t > 500) {
      guard.innerHTML = '<span class="title no">사람이 안 보여요</span>';
    } else {
      const both = last.ok.left && last.ok.right;
      const g1 = (s: Side, label: string) => `<span class="g ${last.ok[s] ? 'ok' : ''}"><i class="dot"></i>${label}</span>`;
      guard.innerHTML = `${g1('left', '왼손')}<span class="title ${both ? 'ok' : 'no'}">${both ? '가드 좋아요' : '가드 올려요!'}</span>${g1('right', '오른손')}`;
    }
  }

  /** Judgement pop-ups and the early/late strip, drawn over the 3D scene. */
  private drawFx(now: number): void {
    const c = this.fx;
    const ctx = c.getContext('2d')!;
    const k = c.width / Math.max(1, c.clientWidth);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
    this.popups = this.popups.filter((p) => now - p.at < 800);
    for (const p of this.popups) {
      const age = (now - p.at) / 800;
      const size = Math.max(22, c.clientWidth / 28) * (age < 0.15 ? 1 + (0.15 - age) * 3 : 1);
      ctx.globalAlpha = Math.min(1, 2 * (1 - age));
      ctx.font = `400 ${size}px 'Black Han Sans', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const y = p.y - 70 - age * 40;
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(p.text, p.x, y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, y);
      if (p.sub) {
        ctx.font = `900 ${size * 0.42}px 'Noto Sans KR', system-ui, sans-serif`;
        ctx.lineWidth = 4;
        ctx.strokeText(p.sub, p.x, y + size * 0.75);
        ctx.fillStyle = '#fff';
        ctx.fillText(p.sub, p.x, y + size * 0.75);
      }
    }
    ctx.globalAlpha = 1;

    const g = this.session;
    if (!g) return;
    // hold gauge: how much longer each presented mitt stays (gold while it's still a PERFECT)
    for (const m of g.mitts) {
      const held = now - m.tHit;
      if (m.judgement || held < 0 || held > g.spec.holdMs) continue;
      const c = this.scene.mittScreenCircle(m.id);
      if (!c) continue;
      const left = 1 - held / g.spec.holdMs;
      ctx.lineWidth = Math.max(5, c.r * 0.12);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r * 1.25, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = held <= g.spec.perfectMs ? '#f5b301' : '#ffffff';
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r * 1.25, -Math.PI / 2, -Math.PI / 2 + left * Math.PI * 2);
      ctx.stroke();
    }
    const recent = g.judgements.filter((j) => Number.isFinite(j.dtMs)).slice(-10);
    if (!recent.length) return;
    const cx = c.clientWidth / 2;
    const y = c.clientHeight - 78;
    const half = Math.min(170, c.clientWidth * 0.14);
    ctx.fillStyle = 'rgba(10,10,14,0.7)';
    ctx.beginPath();
    ctx.roundRect(cx - half - 50, y - 13, half * 2 + 100, 26, 13);
    ctx.fill();
    // left half = early side (down to −earlyMs), right half = while the mitt is held (to holdMs)
    const xOf = (dt: number) => cx + (dt < 0 ? dt / g.spec.earlyMs : dt / g.spec.holdMs) * half;
    ctx.fillStyle = 'rgba(245,179,1,0.35)';
    ctx.fillRect(xOf(-g.spec.earlyMs), y - 5, xOf(g.spec.perfectMs) - xOf(-g.spec.earlyMs), 10);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(cx - 1, y - 8, 2, 16);
    recent.forEach((j, i) => {
      ctx.globalAlpha = 0.35 + (0.65 * (i + 1)) / recent.length;
      ctx.fillStyle = GRADE_COLOR[j.grade];
      ctx.fillRect(xOf(j.dtMs) - 2, y - 9, 4, 18);
    });
    ctx.globalAlpha = 1;
    ctx.font = "700 12px 'Noto Sans KR', sans-serif";
    ctx.fillStyle = '#a8a29e';
    ctx.textAlign = 'right';
    ctx.fillText('빠름', cx - half - 8, y);
    ctx.textAlign = 'left';
    ctx.fillText('늦음', cx + half + 8, y);
  }

  // ---------------------------------------------------------------- endings

  private finishCalibration(c: Calibration): void {
    this.calib = null;
    const r = c.result();
    const msg = $('gCalibMsg');
    if (!r) {
      msg.textContent = `보정 실패 — ${CALIBRATION.beats}번 중 절반 이상 인식돼야 해요. 또렷한 잽으로 다시 해 주세요.`;
    } else {
      const v = Math.max(0, Math.min(400, r.offsetMs));
      this.settings.offsetMs = v;
      $<HTMLInputElement>('gOffset').value = String(v);
      this.save();
      msg.textContent = `보정 완료: ${v} ms (${r.hits}/${c.beats.length}회 인식, 흩어짐 ±${Math.round(r.spreadMs / 2)} ms)` +
        (r.hits < c.beats.length * 0.75 ? ' · 인식이 적었으니 한 번 더 해 보세요' : '');
    }
    this.setScreen('menu');
  }

  private showResults(g: GameSession): void {
    const acc = g.accuracy();
    const grade = acc >= 0.9 ? 'S' : acc >= 0.8 ? 'A' : acc >= 0.65 ? 'B' : acc >= 0.5 ? 'C' : 'D';
    $('rGrade').textContent = grade;
    $('rScore').textContent = g.score.toLocaleString();
    $('rMeta').textContent = `정확도 ${Math.round(acc * 100)}% · 최대 ${g.maxCombo} 콤보 · ${DIFFICULTIES[g.cfg.difficulty].label}`;
    const rows = [1, 2, 3, 4, 5, 6]
      .map((n) => {
        const s = g.stats[n];
        return { n, s, pct: s.attempts ? (s.perfect + s.good + s.partial * 0.5) / s.attempts : NaN };
      })
      .filter((r) => r.s.attempts > 0);
    // only call out a weak punch when it actually stands out from the rest
    const spread = rows.length > 1 ? Math.max(...rows.map((r) => r.pct)) - Math.min(...rows.map((r) => r.pct)) : 0;
    const weakest = spread >= 0.15 ? rows.reduce((a, b) => (b.pct < a.pct ? b : a)) : null;
    $('rBars').innerHTML = rows
      .map((r) => `<div class="bar ${r === weakest ? 'weakest' : ''}"><span>${r.n} ${PUNCH_NAMES[r.n]}</span>` +
        `<div class="track"><div class="fill" style="width:${Math.round(r.pct * 100)}%"></div></div>` +
        `<span class="pct">${r.s.perfect + r.s.good}/${r.s.attempts}</span></div>`)
      .join('');
    $('rWeak').textContent = weakest && weakest.pct < 0.8 ? `약점: ${weakest.n}번 ${PUNCH_NAMES[weakest.n]} — 다음엔 이 펀치를 더 연습해 봐요` : '';
    this.session = null;
  }
}
