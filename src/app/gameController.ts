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
import { adaptiveWeights, recordGame, statAccuracy, weakestPunch, type GameRecord, type Progress } from '../core/progress';
import { clearProgress, loadProgress, saveProgress } from './records';
import { downloadCanvas, drawResultCard, type CardData } from './resultCard';
import { disposeRenderer, prepareFace, renderAllExpressions, wipe, type ExpressionName } from '../face/reactions';
import { bell, comboUp, countBeep, cue, hit, setMuted, shout, swish, tick, uiClick, unlockAudio } from './sfx';

const SETTINGS_KEY = 'shadowmitts.game.v2';
const GUARD_HISTORY_MS = 2000;

interface Settings {
  difficulty: Difficulty;
  rounds: number;
  roundSec: number;
  lenient: boolean;
  sound: boolean;
  /** accessibility: camera shake on hits */
  shake: boolean;
  offsetMs: number;
  /** M4: serve weak punches more often */
  adaptive: boolean;
}

const DEFAULTS: Settings = { difficulty: 'normal', rounds: 1, roundSec: 60, lenient: true, sound: true, shake: true, offsetMs: 150, adaptive: true };

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
/** Comic-book impact burst ("팡!") at the mitt. */
interface Pow { word: string; x: number; y: number; at: number; size: number; spin: number; fill: string }
interface Confetto { x: number; y: number; vx: number; vy: number; rot: number; vr: number; color: string; at: number }

const POW_WORDS: Record<'perfect' | 'good' | 'partial', string[]> = {
  perfect: ['빡!', '팡!!', 'POW!', '쾅!', 'BAM!'],
  good: ['팡!', '퍽!', '탁!', 'POP!'],
  partial: ['툭', '톡'],
};
const CONFETTI = ['#e11d2e', '#fbbf24', '#22d3ee', '#34d399', '#a78bfa', '#fb923c', '#ffffff'];
const COMBO_SHOUTS = ['나이스!', '대박!', '미쳤다!', '좋아요!', '계속 가자!', '최고예요!'];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

/** Below this the camera status warns (punch recognition drops sharply under ~20 fps). */
const SLOW_FPS = 20;
const POW_MS = 260;
const CRITICAL_HOLD_MS = 1100;

const GRADE_FACE: Record<Judgement['grade'], ExpressionName> = { perfect: 'perfect', good: 'good', partial: 'normal', miss: 'miss' };
const FACE_TAG: Record<ExpressionName, { text: string; color: string }> = {
  perfect: { text: 'PERFECT!', color: '#f59e0b' },
  good: { text: 'GOOD!', color: '#10b981' },
  normal: { text: '…', color: '#64748b' },
  miss: { text: 'MISS…', color: '#3b82f6' },
  critical: { text: 'CRITICAL!!', color: '#e11d2e' },
};
const SPEED_LINES_MS = 130;

export interface GameDeps {
  params: () => Params;
  stance: () => Stance;
  setStance: (s: Stance) => void;
  cameraRunning: () => boolean;
  /** pose detections per second (NaN until measured) */
  detectFps: () => number;
  /** download this game's pose frames + schedule + judgements (for analysis) */
  saveGameRecording: () => void;
  /** the current camera frame, un-mirrored (null when the camera is off) — for the reaction face */
  grabFrame: () => HTMLCanvasElement | null;
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
  private pows: Pow[] = [];
  /** comic "집중선" bursting out from a hit, 130 ms */
  private speedLines: { x: number; y: number; at: number; strength: number }[] = [];
  /** the player's reaction faces (made in this browser from one photo; never stored or sent) */
  private faces: Record<ExpressionName, HTMLCanvasElement> | null = null;
  private faceShown: ExpressionName | null = null;
  private faceAt = 0;
  private faceBusy = false;
  /** M4 local records (game numbers only) */
  private progress: Progress = loadProgress();
  /** data for the result card of the game just finished */
  private card: Omit<CardData, 'face'> | null = null;
  /** the player chose "얼굴 없이" once this session */
  private skipFaceAsk = false;
  private confetti: Confetto[] = [];
  private lastFx = 0;
  /** ms between display frames during play — where the stutter shows up */
  private renderGaps: number[] = [];
  /** the finished game (showResults clears `session`), kept for "이번 판 기록 저장" */
  private lastGame: GameSession | null = null;
  private lastFrameAt = 0;
  private guardHistory: { t: number; ok: Record<Side, boolean> }[] = [];
  private hands: Record<Side, HandInput | null> = { left: null, right: null };
  private handsAt = 0;
  private cued = new Set<string>();
  private raf = 0;
  private lastBig = '';
  /** "10 COMBO!" banner */
  private comboBanner = { text: '', until: 0 };
  /** last phase/second a sound cue was played for (countdown beeps, round bells) */
  private phaseCueKey = '';

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
    $('rSave').addEventListener('click', () => this.deps.saveGameRecording());
    $('rCard').addEventListener('click', () => void this.saveCard());
    $('rClearRec').addEventListener('click', () => {
      if (!confirm('이 브라우저에 저장된 점수와 펀치별 기록을 모두 지울까요? (되돌릴 수 없어요)')) return;
      clearProgress();
      this.progress = loadProgress();
      $('rBest').textContent = '기록을 지웠어요';
      $('rBest').className = 'best-line';
      this.refreshMenu();
    });
    $('faceShoot').addEventListener('click', () => void this.shootFace());
    $('faceClear').addEventListener('click', () => this.clearFaces('지웠어요. 사진은 남아 있지 않아요'));
    window.addEventListener('pagehide', () => this.clearFaces());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (this.screen === 'playing' || this.screen === 'calibrating')) this.finish();
    });
    this.refreshMenu();
    setInterval(() => this.refreshMenu(), 400);
    window.addEventListener('resize', () => this.alignMenuCam());
    void document.fonts?.ready.then(() => this.alignMenuCam());
  }

  get active(): boolean {
    return this.screen === 'playing' || this.screen === 'calibrating';
  }

  get playing(): boolean {
    return this.screen === 'playing';
  }

  /** The last game's schedule, judgements and display frame gaps, for the in-game recording. */
  gameLog(): { session: GameSession; renderGapsMs: number[] } | null {
    const g = this.session ?? this.lastGame;
    return g ? { session: g, renderGapsMs: this.renderGaps } : null;
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
    const shake = $<HTMLInputElement>('gShake');
    shake.checked = s.shake;
    this.scene.shakeEnabled = s.shake;
    shake.addEventListener('change', () => { s.shake = shake.checked; this.scene.shakeEnabled = s.shake; this.save(); });
    const offset = $<HTMLInputElement>('gOffset');
    lenient.checked = s.lenient;
    sound.checked = s.sound;
    offset.value = String(s.offsetMs);
    setMuted(!s.sound);
    lenient.addEventListener('change', () => { s.lenient = lenient.checked; this.save(); });
    const adaptive = $<HTMLInputElement>('gAdaptive');
    adaptive.checked = s.adaptive;
    adaptive.addEventListener('change', () => { s.adaptive = adaptive.checked; this.save(); this.refreshMenu(); });
    sound.addEventListener('change', () => { s.sound = sound.checked; setMuted(!s.sound); this.save(); });
    offset.addEventListener('input', () => { s.offsetMs = Number(offset.value); this.save(); this.refreshMenu(); });
    $('gStart').addEventListener('click', () => this.startOrAskFace());
    $('gateShoot').addEventListener('click', () => void this.gateShoot());
    $('gateSkip').addEventListener('click', () => {
      this.skipFaceAsk = true; // asked once; don't nag every round
      $('faceGate').hidden = true;
      this.start();
    });
    $('gCalibrate').addEventListener('click', () => this.startCalibration());
  }

  /**
   * Menu: line the camera "TV" up with the settings box — same top and bottom (play-test: "높이
   * 맞추자"). The camera is 4:3, so its width follows the box height, capped by the free room to
   * the right (then it's centred on the box). Only CSS variables change, so the in-game
   * picture-in-picture position is untouched.
   */
  private alignMenuCam(): void {
    const stage = $('stage');
    const box = document.querySelector('.menu-box');
    if (this.screen !== 'menu' || !box || window.innerWidth <= 900) {
      stage.style.removeProperty('--mc-top');
      stage.style.removeProperty('--mc-w');
      stage.style.removeProperty('--mc-left');
      return;
    }
    const st = stage.getBoundingClientRect();
    const r = box.getBoundingClientRect();
    const border = 8; // 4 px frame top and bottom
    const gap = Math.max(24, st.width * 0.03);
    const rightPad = st.width * 0.025;
    const room = st.right - rightPad - (r.right + gap);
    let w = ((r.height - border) * 4) / 3 + border;
    let top = r.top - st.top;
    if (w > room) {
      w = room;
      const h = ((w - border) * 3) / 4 + border;
      top += (r.height - h) / 2;
    }
    // pulled a little toward the menu (play-test: the gap looked too wide): keep 70 % of the gap
    // it would have had against the right edge
    const naturalLeft = st.right - rightPad - w;
    const left = r.right + Math.max(gap, (naturalLeft - r.right) * 0.7);
    stage.style.setProperty('--mc-top', `${Math.round(top)}px`);
    stage.style.setProperty('--mc-w', `${Math.round(w)}px`);
    stage.style.setProperty('--mc-left', `${Math.round(left - st.left)}px`);
  }

  private refreshMenu(): void {
    this.alignMenuCam();
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
    $('recLine').innerHTML = this.recordLine();
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
    this.phaseCueKey = '';
    this.comboBanner = { text: '', until: 0 };
    this.pows = [];
    this.confetti = [];
    this.speedLines = [];
    this.renderGaps = [];
    if (this.faces) this.showFace('normal', performance.now(), 'none');
    this.lastFrameAt = 0;
    this.session = new GameSession(
      {
        stance: this.deps.stance(), difficulty: s.difficulty, lenientKind: s.lenient,
        rounds: s.rounds, roundMs: s.roundSec * 1000, restMs: 10_000,
        latencyOffsetMs: s.offsetMs, seed: (Date.now() & 0x7fffffff) >>> 0,
        // M4: weak punches come up more (from this browser's records)
        weights: s.adaptive ? adaptiveWeights(this.progress.skills) : undefined,
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
      id: 10_000 + i, n: 1, side: lead, kind: 'straight' as const, tHit, round: 0, comboIndex: 0, comboSize: 1,
      holdUntil: tHit + CALIBRATION.windowMs, judgement: null,
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
      // Webcams drop to ~15 fps in dim rooms, and quick punches then span only 2–3 frames.
      const fps = this.deps.detectFps();
      const slow = Number.isFinite(fps) && fps < SLOW_FPS;
      st.textContent = !features.upperBodyInFrame ? '상체가 다 보이게 조금 뒤로'
        : slow ? `인식 느림 (${Math.round(fps)}fps) · 방을 더 밝게` : '준비 완료 ✓';
      st.className = `cam-status ${features.upperBodyInFrame && !slow ? 'ok' : 'warn'}`;
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
      else swish();
    }
  }

  private onJudged(j: Judgement, now: number): void {
    const g = this.session;
    const streak = g ? Math.max(0, g.combo - 1) : 0;
    this.scene.judged(j, now, streak);
    if (this.faces && g) {
      const milestone = (j.grade === 'perfect' || j.grade === 'good') && g.combo > 0 && g.combo % 10 === 0;
      this.showFace(milestone ? 'critical' : GRADE_FACE[j.grade], now, milestone ? 'critical' : 'pop');
    }
    const pos = this.scene.mittScreenPos(j.mittId);
    // pan the hit toward where it landed on screen
    hit(j.grade, streak, pos ? (pos.x / Math.max(1, this.fx.clientWidth)) * 2 - 1 : 0);
    if (g && (j.grade === 'perfect' || j.grade === 'good') && g.combo > 0 && g.combo % 10 === 0) {
      const level = g.combo / 10;
      comboUp(level);
      shout(level <= 3 ? COMBO_SHOUTS[level - 1] : pick(COMBO_SHOUTS));
      this.comboBanner = { text: `${g.combo} COMBO!`, until: now + 1200 };
      this.burstConfetti(now);
    }
    if (!pos) return;
    if (j.grade === 'perfect' || j.grade === 'good') {
      this.speedLines.push({ x: pos.x, y: pos.y, at: now, strength: j.grade === 'perfect' ? 1 : 0.65 });
      if (j.grade === 'perfect' && this.settings.shake) this.edgeFlash();
    }
    if (j.grade !== 'miss') {
      this.pows.push({
        word: pick(POW_WORDS[j.grade]), x: pos.x, y: pos.y, at: now,
        size: j.grade === 'perfect' ? 1.25 : j.grade === 'good' ? 1 : 0.6,
        spin: (Math.random() - 0.5) * 0.5,
        fill: j.grade === 'perfect' ? '#ffd23f' : j.grade === 'good' ? '#ffffff' : '#dbeafe',
      });
      // tied to the shake toggle: flashes can bother people sensitive to light
      if (j.grade !== 'partial' && this.settings.shake) this.flashScreen(j.grade === 'perfect' ? 0.45 : 0.2);
    }
    // A time-out miss is decided ~0.3–0.5 s after its mitt left, when the next mitt may already
    // be in that spot — show its MISS off to the side of the lane instead of on top of the mitt.
    const timedOut = j.grade === 'miss' && Number.isNaN(j.dtMs);
    this.popups.push({
      text: GRADE_TEXT[j.grade],
      sub: j.seenKind ? `${KIND_KO[j.seenKind]}로 인식됨` : j.guardOk ? '가드 보너스' : undefined,
      color: GRADE_COLOR[j.grade],
      x: pos.x, y: timedOut ? pos.y - Math.max(60, this.fx.clientHeight * 0.12) : pos.y, at: now,
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
      this.scene.render(this.calibMitts, this.deps.stance(), 2200, now, handsFresh);
      this.setBig(now < c.beats[0] - 700 ? '타이밍 맞추기<small>날아온 미트가 목표 링에 딱 겹칠 때 잽! (8번)</small>' : '');
      this.drawFx(now);
      if (now > c.endAt) this.finishCalibration(c);
      return;
    }

    const g = this.session;
    if (!g) return;
    if (this.lastFrameAt) this.renderGaps.push(Math.round((now - this.lastFrameAt) * 10) / 10);
    this.lastFrameAt = now;
    for (const j of g.update(now)) this.onJudged(j, now);
    // back to a neutral face when nothing has happened for a moment (CRITICAL stays up longer)
    if (this.faces && this.faceShown && this.faceShown !== 'normal' && now - this.faceAt > (this.faceShown === 'critical' ? 1600 : 1300)) {
      this.showFace('normal', now, 'none');
    }
    this.cueBeats(g.mitts, now);
    this.scene.render(g.mitts, g.cfg.stance, g.spec.approachMs, now, handsFresh);
    this.drawFx(now);
    this.phaseCues(g, now);
    this.updateHud(g, now);
    if (g.phaseAt(now).phase === 'done') this.finish();
  }

  /** Countdown beeps, the bell at the start of a round and ding-ding-ding at its end. */
  private phaseCues(g: GameSession, now: number): void {
    const ph = g.phaseAt(now);
    const key = ph.phase === 'countdown' ? `c${Math.ceil(ph.msLeft / 1000)}` : `${ph.phase}${ph.round}`;
    if (key === this.phaseCueKey) return;
    const prev = this.phaseCueKey;
    this.phaseCueKey = key;
    if (ph.phase === 'countdown') countBeep();
    else if (ph.phase === 'round') {
      if (prev.startsWith('c')) countBeep(true);
      bell(1);
      shout(ph.round === 0 ? '파이트!' : `라운드 ${ph.round + 1}!`);
    } else if (ph.phase === 'rest' || ph.phase === 'done') bell(3);
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

  // ---------------------------------------------------------------- reaction face

  // ---------------------------------------------------------------- M4 records & result card

  /** Menu summary: best for the chosen difficulty, games played, what the adaptive mode is working on. */
  private recordLine(): string {
    const p = this.progress;
    if (p.history.length === 0) return '';
    const d = this.settings.difficulty;
    const best = p.best[d];
    const weak = weakestPunch(p.skills);
    const parts = [`🏆 ${DIFFICULTIES[d].label} 최고 <b>${best !== undefined ? best.toLocaleString() : '-'}</b>`, `${p.history.length}판`];
    if (weak && this.settings.adaptive) parts.push(`집중 연습: ${weak.n}번 ${PUNCH_NAMES[weak.n]}`);
    return parts.join(' · ');
  }

  private async saveCard(): Promise<void> {
    if (!this.card) return;
    const acc = this.card.accuracy;
    const expr: ExpressionName = acc >= 0.85 ? 'perfect' : acc >= 0.65 ? 'good' : acc >= 0.45 ? 'normal' : 'miss';
    const withFace = !!this.faces && $<HTMLInputElement>('rCardFace').checked;
    const c = await drawResultCard({ ...this.card, face: withFace ? this.faces![expr] : null });
    const d = this.card.date;
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    downloadCanvas(c, `shadow-mitts-${stamp}.png`);
  }

  private faceMsg(t: string): void {
    $('faceMsg').textContent = t;
    $('gateMsg').textContent = t;
  }

  /**
   * Play-test: the small face button got skipped. Starting without a face asks once, with taking
   * the photo as the big default — but it stays optional (some people won't want their face used,
   * and a forced "consent" isn't one).
   */
  private startOrAskFace(): void {
    if (this.faces || this.skipFaceAsk || !this.deps.cameraRunning()) {
      this.start();
      return;
    }
    $('gateMsg').textContent = '';
    $('faceGate').hidden = false;
  }

  private async gateShoot(): Promise<void> {
    $<HTMLButtonElement>('gateShoot').disabled = true;
    $('faceGate').classList.add('shooting');
    await this.shootFace();
    $('faceGate').classList.remove('shooting');
    $<HTMLButtonElement>('gateShoot').disabled = false;
    if (this.faces) {
      $('faceGate').hidden = true;
      this.start();
    }
  }

  /** 3-2-1 on the camera preview, one frame, faces made here in the browser; the frame is wiped. */
  private async shootFace(): Promise<void> {
    if (this.faceBusy) return;
    if (!this.deps.cameraRunning()) {
      this.faceMsg('먼저 카메라를 켜 주세요');
      return;
    }
    this.faceBusy = true;
    $<HTMLButtonElement>('faceShoot').disabled = true;
    try {
      for (const n of ['3', '2', '1']) {
        $('faceCount').textContent = n;
        await new Promise((r) => setTimeout(r, 700));
      }
      $('faceCount').textContent = '📸';
      const frame = this.deps.grabFrame();
      setTimeout(() => ($('faceCount').textContent = ''), 250);
      if (!frame) {
        this.faceMsg('카메라 화면을 가져오지 못했어요. 다시 해 볼까요?');
        return;
      }
      this.faceMsg('표정 만드는 중… (처음엔 얼굴 모델을 받느라 조금 걸려요)');
      const face = await prepareFace(frame);
      wipe(frame);
      if (!face) {
        this.faceMsg('얼굴을 못 찾았어요. 밝은 곳에서 카메라를 정면으로 보고 다시 찍어 주세요');
        return;
      }
      this.clearFaces();
      this.faces = renderAllExpressions(face);
      wipe(face.crop);
      disposeRenderer();
      const thumb = $<HTMLCanvasElement>('faceThumb');
      const src = this.faces.perfect;
      thumb.width = src.width;
      thumb.height = src.height;
      thumb.getContext('2d')!.drawImage(src, 0, 0);
      thumb.hidden = false;
      $('faceClear').hidden = false;
      $('faceShoot').textContent = '다시 찍기';
      $('faceRow').classList.remove('need');
      this.faceMsg('준비 완료! 판정마다 내 얼굴이 떠요 · 🔒 이 기기 밖으로 안 나가고, 창을 닫으면 사라져요');
    } catch (e) {
      this.faceMsg(`표정을 만들지 못했어요 (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      this.faceBusy = false;
      $<HTMLButtonElement>('faceShoot').disabled = false;
    }
  }

  private clearFaces(msg?: string): void {
    if (this.faces) for (const c of Object.values(this.faces)) wipe(c);
    this.faces = null;
    this.faceShown = null;
    wipe($<HTMLCanvasElement>('faceThumb'));
    wipe($<HTMLCanvasElement>('reactFace'));
    wipe($<HTMLCanvasElement>('rFace'));
    $('faceThumb').hidden = true;
    $('rFace').hidden = true;
    $('faceClear').hidden = true;
    $('faceShoot').textContent = '📸 내 얼굴 찍기';
    $('faceRow').classList.add('need');
    $('react').classList.remove('on');
    if (msg) this.faceMsg(msg);
  }

  /** Swap the reaction box to an expression; `pop` bounces it, `critical` swells it for a beat. */
  private showFace(expr: ExpressionName, now: number, anim: 'pop' | 'critical' | 'none' = 'pop'): void {
    if (!this.faces) return;
    // let a CRITICAL play out: in fast combos the next hit comes ~0.45 s later and cut it off
    if (this.faceShown === 'critical' && expr !== 'critical' && now - this.faceAt < CRITICAL_HOLD_MS) return;
    const box = $('react');
    const cv = $<HTMLCanvasElement>('reactFace');
    const src = this.faces[expr];
    if (cv.width !== src.width || cv.height !== src.height) {
      cv.width = src.width;
      cv.height = src.height;
    }
    cv.getContext('2d')!.drawImage(src, 0, 0);
    const tag = $('reactTag');
    tag.textContent = FACE_TAG[expr].text;
    tag.style.color = FACE_TAG[expr].color;
    box.classList.add('on');
    box.classList.remove('pop', 'critical');
    if (anim !== 'none') {
      void box.offsetWidth; // restart the animation
      box.classList.add(anim);
    }
    this.faceShown = expr;
    this.faceAt = now;
  }

  private edgeFlash(): void {
    const el = $('edgeFlash');
    el.style.transition = 'none';
    el.style.opacity = '1';
    void el.offsetWidth;
    el.style.transition = 'opacity 220ms ease-out';
    el.style.opacity = '0';
  }

  private flashScreen(strength: number): void {
    const el = $('flash');
    el.style.transition = 'none';
    el.style.opacity = String(strength);
    void el.offsetWidth;
    el.style.transition = 'opacity 160ms ease-out';
    el.style.opacity = '0';
  }

  private burstConfetti(now: number): void {
    const w = this.fx.clientWidth;
    const h = this.fx.clientHeight;
    for (let i = 0; i < 90; i++) {
      const fromLeft = i % 2 === 0;
      this.confetti.push({
        x: fromLeft ? w * 0.15 : w * 0.85, y: h * 0.55,
        vx: (fromLeft ? 1 : -1) * (150 + Math.random() * 450), vy: -(500 + Math.random() * 600),
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 16, color: pick(CONFETTI), at: now,
      });
    }
  }

  private setBig(html: string, pop = false, cls = ''): void {
    if (html === this.lastBig) return;
    this.lastBig = html;
    const el = $('bigText');
    el.innerHTML = html;
    el.classList.toggle('combo', cls === 'combo');
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
      // play-test: players guessed that guarding mattered — say how (it adds points, never blocks a hit)
      this.setBig(`${Math.ceil(ph.msLeft / 1000)}<small>🛡 안 치는 손은 턱 앞에! 가드 올리면 점수 +20%</small>`, true);
    } else if (ph.phase === 'round' && now - g.roundStart(ph.round) < 800) {
      this.setBig(ph.round === 0 ? 'FIGHT!' : `ROUND ${ph.round + 1}`, true);
    } else if (now < this.comboBanner.until) {
      this.setBig(this.comboBanner.text, true, 'combo');
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
    const dt = this.lastFx ? Math.min(0.05, (now - this.lastFx) / 1000) : 0;
    this.lastFx = now;

    // comic speed lines: thin wedges converging on the hit, flying outward and fading fast
    this.speedLines = this.speedLines.filter((l) => now - l.at < SPEED_LINES_MS);
    for (const l of this.speedLines) {
      const age = (now - l.at) / SPEED_LINES_MS;
      const R = Math.max(c.clientWidth, c.clientHeight) * 0.28 * l.strength;
      ctx.save();
      ctx.globalAlpha = (1 - age) * 0.85;
      ctx.fillStyle = '#1e3a8a';
      const n = 26;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + (i % 2) * 0.07;
        const r0 = R * (0.28 + age * 0.35) * (0.85 + ((i * 37) % 10) / 30);
        const r1 = r0 + R * (0.55 - age * 0.25);
        const wdt = 0.018 + ((i * 13) % 5) * 0.004;
        ctx.beginPath();
        ctx.moveTo(l.x + Math.cos(a) * r0, l.y + Math.sin(a) * r0);
        ctx.lineTo(l.x + Math.cos(a - wdt) * r1, l.y + Math.sin(a - wdt) * r1);
        ctx.lineTo(l.x + Math.cos(a + wdt) * r1, l.y + Math.sin(a + wdt) * r1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // comic impact bursts: a jagged star that pops in, with the sound word on it
    // short: a burst left hanging where the mitt was read as an afterimage
    this.pows = this.pows.filter((p) => now - p.at < POW_MS);
    for (const p of this.pows) {
      const age = (now - p.at) / POW_MS;
      const pop = age < 0.18 ? 0.3 + (age / 0.18) * 1.0 : 1.3 - (age - 0.18) * 0.35;
      const r = Math.max(34, c.clientWidth / 16) * p.size * pop;
      ctx.save();
      ctx.globalAlpha = age < 0.7 ? 1 : 1 - (age - 0.7) / 0.3;
      ctx.translate(p.x, p.y - r * 0.2);
      ctx.rotate(p.spin);
      ctx.beginPath();
      const spikes = 12;
      for (let i = 0; i <= spikes * 2; i++) {
        const a = (i / (spikes * 2)) * Math.PI * 2;
        const rr = i % 2 === 0 ? r : r * 0.62;
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fillStyle = p.fill;
      ctx.fill();
      ctx.lineWidth = Math.max(4, r * 0.07);
      ctx.strokeStyle = '#e11d2e';
      ctx.stroke();
      ctx.font = `400 ${r * 0.62}px 'Black Han Sans', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(4, r * 0.1);
      ctx.strokeStyle = '#1e3a8a';
      ctx.strokeText(p.word, 0, r * 0.04);
      ctx.fillStyle = '#e11d2e';
      ctx.fillText(p.word, 0, r * 0.04);
      ctx.restore();
    }

    // confetti
    this.confetti = this.confetti.filter((q) => now - q.at < 2200 && q.y < c.clientHeight + 40);
    for (const q of this.confetti) {
      q.vy += 1400 * dt;
      q.vx *= 1 - 0.8 * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.rot += q.vr * dt;
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(q.rot);
      ctx.fillStyle = q.color;
      ctx.fillRect(-6, -3.5, 12, 7);
      ctx.restore();
    }

    this.popups = this.popups.filter((p) => now - p.at < 800);
    for (const p of this.popups) {
      const age = (now - p.at) / 800;
      const size = Math.max(22, c.clientWidth / 28) * (age < 0.15 ? 1 + (0.15 - age) * 3 : 1);
      ctx.globalAlpha = Math.min(1, 2 * (1 - age));
      ctx.font = `400 ${size}px 'Black Han Sans', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // sit above the comic burst drawn on the mitt
      const y = p.y - Math.max(34, c.clientWidth / 16) * 1.45 - 24 - age * 40;
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
      const hold = m.holdUntil - m.tHit;
      if (m.judgement || held < 0 || held > hold) continue;
      const c = this.scene.mittScreenCircle(m.id);
      if (!c) continue;
      const left = 1 - held / hold;
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
    if (this.faces) {
      const expr: ExpressionName = acc >= 0.85 ? 'perfect' : acc >= 0.65 ? 'good' : acc >= 0.45 ? 'normal' : 'miss';
      const rf = $<HTMLCanvasElement>('rFace');
      rf.width = this.faces[expr].width;
      rf.height = this.faces[expr].height;
      rf.getContext('2d')!.drawImage(this.faces[expr], 0, 0);
      rf.hidden = false;
    } else $('rFace').hidden = true;
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
    // M4: record the game locally (numbers only), then report
    const now = new Date();
    const rec: GameRecord = {
      at: now.toISOString(), difficulty: g.cfg.difficulty, score: g.score, maxCombo: g.maxCombo, accuracy: acc,
      perNumber: g.stats.slice(1).map((s) => [s.perfect + s.good, s.partial, s.attempts] as [number, number, number]),
    };
    const r = recordGame(this.progress, rec, g.stats);
    this.progress = r.progress;
    const stored = saveProgress(this.progress);
    const focus = weakestPunch(this.progress.skills);
    const lines: string[] = [];
    if (weakest && weakest.pct < 0.8) lines.push(`이번 판 약점: ${weakest.n}번 ${PUNCH_NAMES[weakest.n]}`);
    if (focus && this.settings.adaptive) {
      const s = this.progress.skills[focus.n]!;
      lines.push(`누적 약점 ${focus.n}번 ${PUNCH_NAMES[focus.n]} (${Math.round(s.acc * 100)}%) — 다음 판에 더 자주 낼게요`);
    } else if (!this.settings.adaptive && weakest && weakest.pct < 0.8) {
      lines.push('다음엔 이 펀치를 더 연습해 봐요');
    }
    $('rWeak').textContent = lines.join(' · ');
    const bestEl = $('rBest');
    bestEl.className = 'best-line' + (r.newBest && r.prevBest !== undefined ? ' new' : '');
    bestEl.textContent = !stored ? '(이 브라우저는 기록 저장이 막혀 있어요 — 게임은 그대로 돼요)'
      : r.newBest && r.prevBest !== undefined ? `🏆 새 최고 기록! (이전 ${r.prevBest.toLocaleString()})`
      : r.prevBest !== undefined ? `${DIFFICULTIES[g.cfg.difficulty].label} 최고 ${(this.progress.best[g.cfg.difficulty] ?? 0).toLocaleString()}`
      : '첫 기록이에요!';
    this.card = {
      grade, score: g.score, accuracy: acc, maxCombo: g.maxCombo, difficultyLabel: DIFFICULTIES[g.cfg.difficulty].label, date: now,
      rows: rows.map((x) => ({ n: x.n, hits: x.s.perfect + x.s.good, attempts: x.s.attempts, pct: statAccuracy(x.s) })),
      weakest: weakest ? weakest.n : null,
      newBest: r.newBest && r.prevBest !== undefined,
    };
    $('rCardFaceWrap').style.display = this.faces ? '' : 'none';
    this.lastGame = g;
    this.session = null;
  }
}
