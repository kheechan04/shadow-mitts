import type { FrameFeatures } from '../core/features';
import { SIDE_COLOR } from './overlay';

interface Sample {
  t: number;
  speed: [number, number];
  angle: [number, number];
}

const WINDOW_MS = 5000;

/** Scrolling plot of wrist speed and elbow angle for both arms (threshold tuning aid). */
export class FeatureGraph {
  private samples: Sample[] = [];
  private marks: { t: number; side: 'left' | 'right' }[] = [];

  constructor(private canvas: HTMLCanvasElement, private speedMax = 8) {}

  clear(): void {
    this.samples = [];
    this.marks = [];
  }

  /** Vertical marker at a detected punch's peak time. */
  mark(t: number, side: 'left' | 'right'): void {
    this.marks.push({ t, side });
  }

  push(f: FrameFeatures): void {
    this.samples.push({
      t: f.t,
      speed: [f.arms.left.speed2d, f.arms.right.speed2d],
      angle: [f.arms.left.elbowAngle3d, f.arms.right.elbowAngle3d],
    });
    const cutoff = f.t - WINDOW_MS;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
    while (this.marks.length && this.marks[0].t < cutoff) this.marks.shift();
  }

  draw(): void {
    const ctx = this.canvas.getContext('2d')!;
    const { width: w, height: h } = this.canvas;
    const cs = getComputedStyle(this.canvas);
    ctx.fillStyle = cs.getPropertyValue('--graph-bg') || '#0b0f17';
    ctx.fillRect(0, 0, w, h);
    const half = h / 2;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`손목 속도 2D (T/s, 0–${this.speedMax}) · 세로선 = 인식된 펀치`, 4, 12);
    ctx.fillText('팔꿈치 각도 3D (0–180°)', 4, half + 12);
    ctx.strokeStyle = 'rgba(148,163,184,0.3)';
    ctx.beginPath();
    ctx.moveTo(0, half);
    ctx.lineTo(w, half);
    ctx.stroke();
    if (this.samples.length < 2) return;

    const tEnd = this.samples[this.samples.length - 1].t;
    const x = (t: number) => w - ((tEnd - t) / WINDOW_MS) * w;
    const plot = (get: (s: Sample) => number, max: number, top: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const s of this.samples) {
        const v = get(s);
        if (!Number.isFinite(v)) {
          started = false;
          continue;
        }
        const y = top + half - 2 - (Math.min(v, max) / max) * (half - 16);
        if (started) ctx.lineTo(x(s.t), y);
        else ctx.moveTo(x(s.t), y);
        started = true;
      }
      ctx.stroke();
    };
    for (const m of this.marks) {
      ctx.strokeStyle = SIDE_COLOR[m.side];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x(m.t), 16);
      ctx.lineTo(x(m.t), h);
      ctx.stroke();
    }
    plot((s) => s.speed[0], this.speedMax, 0, SIDE_COLOR.left);
    plot((s) => s.speed[1], this.speedMax, 0, SIDE_COLOR.right);
    plot((s) => s.angle[0], 180, half, SIDE_COLOR.left);
    plot((s) => s.angle[1], 180, half, SIDE_COLOR.right);
  }
}
