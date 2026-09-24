// All sound is synthesized with WebAudio — no audio files (DESIGN §1, §5).
// The AudioContext must be created from a click (browser autoplay policy); every call is a
// no-op until then, and failures never break the game.
//
// Play-test (M3): "소리가 너무 재미없어" → hits are layered (sub thump + snap + leather slap,
// a little grit and a short slapback), climb a semitone per hit in a streak, misses go "뿅",
// and combo milestones get a fanfare + drum + crowd swell (+ a spoken shout if a voice exists).

import type { Grade } from '../core/game';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let fxBus: GainNode | null = null;
let noise: AudioBuffer | null = null;
let muted = false;

function makeGrit(a: AudioContext): WaveShaperNode {
  const ws = a.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(2.2 * x);
  }
  ws.curve = curve;
  return ws;
}

export function unlockAudio(): void {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 5;
      master.connect(comp).connect(ctx.destination);
      // hits go through a little saturation and a short slapback "arena" echo
      fxBus = ctx.createGain();
      const grit = makeGrit(ctx);
      const echo = ctx.createDelay(0.5);
      echo.delayTime.value = 0.09;
      const echoGain = ctx.createGain();
      echoGain.gain.value = 0.22;
      const echoTone = ctx.createBiquadFilter();
      echoTone.type = 'lowpass';
      echoTone.frequency.value = 2500;
      fxBus.connect(grit).connect(master);
      grit.connect(echo).connect(echoTone).connect(echoGain).connect(master);
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    void ctx.resume();
  } catch {
    ctx = null;
  }
}

export function setMuted(m: boolean): void {
  muted = m;
  if (m) {
    try {
      speechSynthesis.cancel();
    } catch {
      // no speech API
    }
  }
}

function ready(): AudioContext | null {
  return ctx && master && !muted ? ctx : null;
}

interface ToneOpts { type?: OscillatorType; glideTo?: number; delay?: number; attack?: number; bus?: 'fx' | 'master' }

/** One oscillator with an exponential decay; optional pitch glide. */
function tone(freq: number, dur: number, gain: number, o: ToneOpts = {}): void {
  const a = ready();
  if (!a) return;
  const t = a.currentTime + (o.delay ?? 0);
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, t);
  if (o.glideTo) osc.frequency.exponentialRampToValueAtTime(o.glideTo, t + dur);
  const att = o.attack ?? 0.003;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + att);
  g.gain.exponentialRampToValueAtTime(0.0001, t + att + dur);
  osc.connect(g).connect(o.bus === 'fx' ? fxBus! : master!);
  osc.start(t);
  osc.stop(t + att + dur + 0.03);
}

interface NoiseOpts { q?: number; sweepTo?: number; delay?: number; attack?: number; bus?: 'fx' | 'master' }

/** Filtered noise burst. */
function burst(dur: number, gain: number, filter: BiquadFilterType, freq: number, o: NoiseOpts = {}): void {
  const a = ready();
  if (!a || !noise) return;
  const t = a.currentTime + (o.delay ?? 0);
  const src = a.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = a.createBiquadFilter();
  f.type = filter;
  f.frequency.setValueAtTime(freq, t);
  if (o.sweepTo) f.frequency.exponentialRampToValueAtTime(o.sweepTo, t + dur);
  f.Q.value = o.q ?? 1;
  const g = a.createGain();
  const att = o.attack ?? 0.002;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + att);
  g.gain.exponentialRampToValueAtTime(0.0001, t + att + dur);
  src.connect(f).connect(g).connect(o.bus === 'fx' ? fxBus! : master!);
  src.start(t, Math.random() * 0.5);
  src.stop(t + att + dur + 0.03);
}

const semis = (n: number) => Math.pow(2, n / 12);

/**
 * Glove on a focus mitt. `streak` = hits in a row so far; the tonal "bonk" climbs a semitone per
 * hit (resets on a miss), so a clean combo literally sounds like it's building.
 */
export function hit(grade: Grade, streak = 0): void {
  if (grade === 'miss') return whiff();
  const k = grade === 'perfect' ? 1 : grade === 'good' ? 0.8 : 0.55;
  const step = semis(Math.min(streak, 24));
  // body: sub thump with a fast pitch drop
  tone(150, 0.2, 1.0 * k, { glideTo: 42, bus: 'fx' });
  // snap: the first millisecond of glove on leather
  burst(0.025, 0.9 * k, 'highpass', 2500, { q: 0.7, bus: 'fx' });
  // leather slap
  burst(0.09, 0.8 * k, 'bandpass', grade === 'partial' ? 600 : 1200, { q: 1.4, bus: 'fx' });
  // tonal "bonk" that climbs with the streak
  tone(330 * step, 0.12, 0.28 * k, { type: 'triangle', glideTo: 250 * step, bus: 'fx' });
  if (grade === 'perfect') {
    // sparkle on top, also climbing
    tone(1568 * step, 0.18, 0.12, { type: 'square', delay: 0.03 });
    tone(2349 * step, 0.22, 0.09, { type: 'triangle', delay: 0.07 });
    burst(0.18, 0.12, 'highpass', 6000, { delay: 0.02 });
  }
}

/** Missed mitt: a cartoon "뿅" + air — funny, not a punishment. */
export function whiff(): void {
  tone(760, 0.22, 0.22, { type: 'sine', glideTo: 260 });
  burst(0.25, 0.18, 'bandpass', 500, { q: 0.8, sweepTo: 2600 });
}

/** A glove thrown (no mitt): quick air whoosh. */
export function swish(): void {
  burst(0.12, 0.12, 'bandpass', 900, { q: 1, sweepTo: 3000 });
}

/**
 * Combo milestone fanfare: drum hit + rising brass-ish chord stab + crowd swell.
 * `level` = combo / 10, raises the key each time.
 */
export function comboUp(level = 1): void {
  const key = semis(Math.min(level - 1, 7) * 2);
  // drum: kick + snare
  tone(120, 0.25, 0.9, { glideTo: 45, bus: 'fx' });
  burst(0.16, 0.5, 'bandpass', 1800, { q: 0.6, bus: 'fx' });
  // ta-da-da-DAAA
  const notes = [523, 659, 784, 1047];
  notes.forEach((f, i) => {
    const last = i === notes.length - 1;
    for (const detune of [1, 1.006]) {
      tone(f * key * detune, last ? 0.55 : 0.1, last ? 0.14 : 0.12, { type: 'sawtooth', delay: i * 0.085, attack: 0.01 });
    }
    tone(f * key * 2, last ? 0.5 : 0.08, 0.05, { type: 'square', delay: i * 0.085 });
  });
  // crowd "와~": swelling band-passed noise
  burst(1.1, 0.22, 'bandpass', 900, { q: 0.5, sweepTo: 1400, delay: 0.1, attack: 0.25 });
  burst(0.9, 0.12, 'bandpass', 2200, { q: 0.6, delay: 0.15, attack: 0.3 });
}

/** Boxing bell: inharmonic partials with a long ring. `times` strikes. */
export function bell(times = 1): void {
  for (let i = 0; i < times; i++) {
    const d = i * 0.32;
    for (const [f, g] of [[820, 0.28], [1130, 0.16], [1680, 0.1], [2440, 0.06]] as const) tone(f, 1.6, g, { delay: d });
    burst(0.03, 0.3, 'highpass', 5000, { q: 0.7, delay: d });
  }
}

/** Countdown beep; the last one (go) is higher and longer. */
export function countBeep(go = false): void {
  tone(go ? 1175 : 880, go ? 0.3 : 0.12, 0.16, { type: 'square' });
}

let koVoice: SpeechSynthesisVoice | null | undefined;

/** Short announcer shout ("나이스!"). Silently skipped when there's no Korean voice. */
export function shout(text: string): void {
  if (muted) return;
  try {
    if (koVoice === undefined || koVoice === null) {
      koVoice = speechSynthesis.getVoices().find((v) => v.lang.startsWith('ko')) ?? null;
    }
    if (!koVoice) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.voice = koVoice;
    u.lang = koVoice.lang;
    u.rate = 1.25;
    u.pitch = 1.3;
    u.volume = 0.9;
    speechSynthesis.speak(u);
  } catch {
    // no speech API
  }
}

/** lead-in beat before a combo ("틱") */
export const tick = () => tone(660, 0.05, 0.12, { type: 'triangle' });
/** the moment a mitt arrives ("딱") */
export const cue = () => tone(1320, 0.04, 0.09, { type: 'square' });
export const uiClick = () => tone(520, 0.05, 0.08, { type: 'triangle' });
