import { LM, UPPER_BODY_EDGES, type P4, type PoseFrame } from '../core/pose';

export const SIDE_COLOR = { left: '#22d3ee', right: '#fb923c' } as const;

const LEFT_POINTS = new Set<number>([LM.SHOULDER_L, LM.ELBOW_L, LM.WRIST_L, LM.HIP_L, LM.MOUTH_L]);
const RIGHT_POINTS = new Set<number>([LM.SHOULDER_R, LM.ELBOW_R, LM.WRIST_R, LM.HIP_R, LM.MOUTH_R]);

function colorFor(i: number): string {
  if (LEFT_POINTS.has(i)) return SIDE_COLOR.left;
  if (RIGHT_POINTS.has(i)) return SIDE_COLOR.right;
  return '#e5e7eb';
}

export interface OverlayOptions {
  /** Draw as a mirror (selfie view). Landmarks stay in camera space; only drawing is flipped. */
  mirror: boolean;
  video: HTMLVideoElement | null;
  minVisibility: number;
  /** Recognized punches to pop up next to the punching wrist. */
  flashes?: { side: 'left' | 'right'; text: string; color: string; alpha: number }[];
}

export function drawOverlay(ctx: CanvasRenderingContext2D, frame: PoseFrame | null, opts: OverlayOptions): void {
  const { width: w, height: h } = ctx.canvas;
  ctx.save();
  if (opts.video && opts.video.readyState >= 2) {
    if (opts.mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(opts.video, 0, 0, w, h);
    ctx.restore();
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = '#0b0f17';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();

  if (!frame?.lm) return;
  const lm = frame.lm;
  const px = (p: P4) => (opts.mirror ? 1 - p[0] : p[0]) * w;
  const py = (p: P4) => p[1] * h;
  const lw = Math.max(2, w / 200);

  ctx.lineWidth = lw;
  for (const [a, b] of UPPER_BODY_EDGES) {
    const pa = lm[a];
    const pb = lm[b];
    const weak = pa[3] < opts.minVisibility || pb[3] < opts.minVisibility;
    const same = colorFor(a) === colorFor(b);
    ctx.strokeStyle = weak ? 'rgba(148,163,184,0.35)' : same ? colorFor(a) : '#e5e7eb';
    ctx.setLineDash(weak ? [lw * 2, lw * 2] : []);
    ctx.beginPath();
    ctx.moveTo(px(pa), py(pa));
    ctx.lineTo(px(pb), py(pb));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const i of [LM.NOSE, ...LEFT_POINTS, ...RIGHT_POINTS]) {
    const p = lm[i];
    ctx.fillStyle = p[3] < opts.minVisibility ? 'rgba(148,163,184,0.5)' : colorFor(i);
    ctx.beginPath();
    ctx.arc(px(p), py(p), lw * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // Wrist labels — the main tool for verifying left/right under mirroring.
  const font = Math.round(Math.max(12, w / 40));
  ctx.font = `bold ${font}px system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  for (const [i, label, color] of [
    [LM.WRIST_L, 'L (15)', SIDE_COLOR.left],
    [LM.WRIST_R, 'R (16)', SIDE_COLOR.right],
  ] as const) {
    const p = lm[i];
    const x = px(p);
    const y = py(p) - lw * 3;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(label, x - font, y);
    ctx.fillStyle = color;
    ctx.fillText(label, x - font, y);
  }

  // Punch pop-ups: rise and fade above the wrist that threw it.
  const big = Math.round(Math.max(20, w / 14));
  ctx.font = `900 ${big}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  // Newest last; stack older ones upward so simultaneous punches don't overlap.
  const flashes = opts.flashes ?? [];
  flashes.forEach((f, i) => {
    const p = lm[f.side === 'left' ? LM.WRIST_L : LM.WRIST_R];
    const x = Math.min(w - big * 2, Math.max(big * 2, px(p)));
    const stack = (flashes.length - 1 - i) * big * 1.1;
    const y = Math.max(big, py(p) - big * 0.6 - (1 - f.alpha) * big - stack);
    ctx.globalAlpha = Math.max(0, f.alpha);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(f.text, x, y);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, x, y);
  });
  ctx.globalAlpha = 1;
  ctx.textAlign = 'start';
}
