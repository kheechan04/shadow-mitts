import { PUNCH_NAMES, punchNumber } from '../core/classify';
import type { Stance } from '../core/pose';
import type { PunchEvent } from '../core/punch';
import { SIDE_COLOR } from './overlay';

const STANCE_KEY = 'shadowmitts.stance.v1';
const FLASH_MS = 800;
const LOG_MAX = 12;

export interface Flash {
  side: PunchEvent['side'];
  text: string;
  color: string;
  /** 1 → 0 as it fades */
  alpha: number;
}

const SIDE_KO = { left: '왼손', right: '오른손' } as const;

/** Punch counters, event log and on-screen flashes for the recognition test panel. */
export class PunchUi {
  private counts = new Map<number, number>();
  private log: { ev: PunchEvent; n: number }[] = [];
  private flashes: { ev: PunchEvent; n: number; at: number }[] = [];
  private dirty = true;

  constructor(
    private stanceSelect: HTMLSelectElement,
    private countsEl: HTMLElement,
    private logEl: HTMLElement,
  ) {
    try {
      const saved = localStorage.getItem(STANCE_KEY);
      if (saved === 'orthodox' || saved === 'southpaw') stanceSelect.value = saved;
    } catch {
      // storage unavailable — keep the default
    }
    stanceSelect.addEventListener('change', () => {
      try {
        localStorage.setItem(STANCE_KEY, stanceSelect.value);
      } catch {
        // ignore
      }
      this.reset();
    });
  }

  get stance(): Stance {
    return this.stanceSelect.value as Stance;
  }

  reset(): void {
    this.counts.clear();
    this.log = [];
    this.flashes = [];
    this.dirty = true;
  }

  /** `flash` = show it on the video (live or normal-speed replay, not when re-simulating a seek). */
  add(ev: PunchEvent, flash: boolean): void {
    if (!ev.kind) return;
    const n = punchNumber(ev.side, ev.kind, this.stance);
    this.counts.set(n, (this.counts.get(n) ?? 0) + 1);
    this.log.unshift({ ev, n });
    if (this.log.length > LOG_MAX) this.log.pop();
    if (flash) this.flashes.push({ ev, n, at: performance.now() });
    this.dirty = true;
  }

  activeFlashes(): Flash[] {
    const now = performance.now();
    this.flashes = this.flashes.filter((f) => now - f.at < FLASH_MS);
    return this.flashes.map((f) => ({
      side: f.ev.side,
      text: `${f.n} ${PUNCH_NAMES[f.n]}`,
      color: SIDE_COLOR[f.ev.side],
      alpha: 1 - (now - f.at) / FLASH_MS,
    }));
  }

  /** Cheap to call often; only touches the DOM when something changed. */
  render(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.countsEl.innerHTML = [1, 2, 3, 4, 5, 6]
      .map((n) => `<div class="pc"><b>${this.counts.get(n) ?? 0}</b><span>${n} ${PUNCH_NAMES[n]}</span></div>`)
      .join('');
    this.logEl.innerHTML = this.log
      .map(({ ev, n }) => {
        const f = ev.features;
        const title =
          `안쪽 ${f.delta[0].toFixed(2)} 위 ${f.delta[1].toFixed(2)} T, 최고속도 ${f.peakSpeed.toFixed(1)} T/s, ` +
          `뻗기 ${Math.round(f.riseMs)}ms, 팔꿈치2D ${Math.round(f.elbow2dAtPeak)}°${f.dipped ? ', 딥' : ''}`;
        return (
          `<li title="${title}"><span class="${ev.side === 'left' ? 'cL' : 'cR'}">${SIDE_KO[ev.side]}</span> ` +
          `<b>${n}</b> ${PUNCH_NAMES[n]} <span class="muted">확신 ${Math.round(ev.confidence * 100)}% · ` +
          `${(ev.t / 1000).toFixed(2)}s</span></li>`
        );
      })
      .join('');
  }
}
