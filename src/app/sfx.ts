// All sound is synthesized with WebAudio — no audio files (DESIGN §1, §5).
// The AudioContext must be created from a click (browser autoplay policy); every call is a
// no-op until then, and failures never break the game.

import type { Grade } from '../core/game';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let muted = false;

export function unlockAudio(): void {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.9;
      // gentle limiter so stacked hits don't clip
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.ratio.value = 6;
      master.connect(comp).connect(ctx.destination);
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
}

function ready(): AudioContext | null {
  return ctx && master && !muted ? ctx : null;
}

/** One oscillator with an exponential decay; optional pitch glide. */
function tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', glideTo?: number, delay = 0): void {
  const a = ready();
  if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master!);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** Filtered noise burst — the "leather" and "air" part of the sounds. */
function burst(dur: number, gain: number, filter: BiquadFilterType, freq: number, q = 1, sweepTo?: number, delay = 0): void {
  const a = ready();
  if (!a || !noise) return;
  const t = a.currentTime + delay;
  const src = a.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = a.createBiquadFilter();
  f.type = filter;
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  f.Q.value = q;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master!);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

/**
 * Glove on a focus mitt: a low thump (pitch drop) + a leather slap (band-passed noise).
 * Better grades are punchier and brighter; a partial hit sounds muffled.
 */
export function hit(grade: Grade): void {
  if (grade === 'miss') return whiff();
  const k = grade === 'perfect' ? 1 : grade === 'good' ? 0.75 : 0.5;
  tone(170 + 40 * k, 0.16, 0.9 * k, 'sine', 55);
  burst(0.07 + 0.03 * k, 0.8 * k, 'bandpass', grade === 'partial' ? 700 : 1500 + 900 * k, 1.2);
  if (grade === 'perfect') {
    // extra "crack" and a tiny sparkle on top
    burst(0.035, 0.5, 'highpass', 3500, 0.7);
    tone(1760, 0.12, 0.08, 'triangle', undefined, 0.02);
    tone(2637, 0.14, 0.06, 'triangle', undefined, 0.05);
  }
}

/** Missed mitt: a soft swish, not a punishment sound. */
export function whiff(): void {
  burst(0.22, 0.25, 'bandpass', 600, 0.8, 2400);
}

/** Every 10 in a row: a quick rising arpeggio. */
export function comboUp(): void {
  [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 0.14, 'triangle', undefined, i * 0.06));
}

/** Boxing bell: inharmonic partials with a long ring. `times` strikes. */
export function bell(times = 1): void {
  for (let i = 0; i < times; i++) {
    const d = i * 0.32;
    for (const [f, g] of [[820, 0.28], [1130, 0.16], [1680, 0.1], [2440, 0.06]] as const) tone(f, 1.6, g, 'sine', undefined, d);
    burst(0.03, 0.3, 'highpass', 5000, 0.7, undefined, d);
  }
}

/** Countdown beep; the last one (go) is higher and longer. */
export function countBeep(go = false): void {
  tone(go ? 1175 : 880, go ? 0.3 : 0.12, 0.16, 'square');
}

/** lead-in beat before a combo ("틱") */
export const tick = () => tone(660, 0.06, 0.12, 'triangle');
/** the moment a mitt arrives ("딱") */
export const cue = () => tone(1320, 0.05, 0.1, 'square');
export const uiClick = () => tone(520, 0.05, 0.08, 'triangle');
