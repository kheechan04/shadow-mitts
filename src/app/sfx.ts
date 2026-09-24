// Timing cues synthesized with WebAudio (no audio files). Full hit sounds are M3.
// The AudioContext must be created from a click (browser autoplay policy); every call is a
// no-op until then, and failures never break the game.

let ctx: AudioContext | null = null;
let muted = false;

export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
  } catch {
    ctx = null;
  }
}

export function setMuted(m: boolean): void {
  muted = m;
}

function blip(freq: number, dur: number, gain: number, type: OscillatorType = 'sine'): void {
  if (!ctx || muted) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t = ctx.currentTime;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** lead-in beat before a combo ("틱") */
export const tick = () => blip(660, 0.06, 0.12, 'triangle');
/** the moment a mitt arrives ("딱") */
export const cue = () => blip(1320, 0.07, 0.16, 'square');
export const uiClick = () => blip(520, 0.05, 0.08, 'triangle');
