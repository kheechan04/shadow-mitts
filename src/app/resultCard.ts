// Result card (M4): a 1080×1350 PNG drawn on a canvas, saved by the player's own click.
// Only facts from the game (no calorie-style guesses — DESIGN §5). The reaction face goes in only
// when the player took one AND left "카드에 내 얼굴" on; the file is a normal download on their
// device, nothing is uploaded.

import { PUNCH_NAMES } from '../core/classify';

export interface CardData {
  grade: string;
  score: number;
  accuracy: number;
  maxCombo: number;
  difficultyLabel: string;
  date: Date;
  /** per number 1..6 with attempts > 0 */
  rows: { n: number; hits: number; attempts: number; pct: number }[];
  weakest: number | null;
  newBest: boolean;
  face: HTMLCanvasElement | null;
}

const W = 1080;
const H = 1350;
const NAVY = '#1e3a8a';
const RED = '#e11d2e';

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function outlined(g: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, stroke: string, width: number): void {
  g.lineJoin = 'round';
  g.lineWidth = width;
  g.strokeStyle = stroke;
  g.strokeText(text, x, y);
  g.fillStyle = fill;
  g.fillText(text, x, y);
}

export async function drawResultCard(d: CardData): Promise<HTMLCanvasElement> {
  // the page's fonts (Black Han Sans / Jua) must be ready before drawing text on a canvas
  try {
    await document.fonts.ready;
  } catch {
    // fall back to system fonts
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;

  // background: warm gradient + sunburst
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#fff3c4');
  bg.addColorStop(1, '#ffd6e2');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.save();
  g.translate(W / 2, 420);
  g.fillStyle = 'rgba(255, 255, 255, 0.45)';
  for (let i = 0; i < 24; i++) {
    g.rotate((Math.PI * 2) / 24);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(-60, -1100);
    g.lineTo(60, -1100);
    g.closePath();
    if (i % 2 === 0) g.fill();
  }
  g.restore();

  // logo
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.font = "400 46px 'Black Han Sans', sans-serif";
  outlined(g, 'SHADOW', W / 2, 108, NAVY, '#ffffff', 10);
  g.font = "400 96px 'Black Han Sans', sans-serif";
  outlined(g, 'MITTS', W / 2, 200, RED, NAVY, 14);

  // face (or glove) in a badge, grade next to it
  const cx = W / 2 - 170;
  const cy = 420;
  const R = 150;
  g.save();
  g.beginPath();
  g.arc(cx, cy, R + 14, 0, Math.PI * 2);
  g.fillStyle = NAVY;
  g.fill();
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
  g.clip();
  if (d.face) {
    const s = Math.max((R * 2) / d.face.width, (R * 2) / d.face.height);
    const fw = d.face.width * s;
    const fh = d.face.height * s;
    g.drawImage(d.face, cx - fw / 2, cy - fh / 2 + 10, fw, fh);
  } else {
    g.font = "170px 'Noto Color Emoji', 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif";
    g.textBaseline = 'middle';
    g.fillText('🥊', cx, cy + 8);
  }
  g.restore();

  g.textBaseline = 'alphabetic';
  g.font = "400 300px 'Black Han Sans', sans-serif";
  const gradeColor = d.grade === 'S' ? '#f59e0b' : d.grade === 'A' ? '#10b981' : d.grade === 'B' ? '#3b82f6' : '#64748b';
  outlined(g, d.grade, W / 2 + 190, 530, gradeColor, NAVY, 18);

  if (d.newBest) {
    g.save();
    g.translate(W / 2 + 250, 300);
    g.rotate(0.18);
    roundRect(g, -150, -42, 300, 84, 42);
    g.fillStyle = RED;
    g.fill();
    g.font = "400 44px 'Black Han Sans', sans-serif";
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText('🏆 NEW BEST', 0, 3);
    g.restore();
  }

  // score panel
  roundRect(g, 90, 620, W - 180, 640, 44);
  g.fillStyle = 'rgba(255, 255, 255, 0.94)';
  g.fill();
  g.lineWidth = 8;
  g.strokeStyle = NAVY;
  g.stroke();

  g.textAlign = 'center';
  g.fillStyle = '#64748b';
  g.font = "400 34px 'Jua', sans-serif";
  g.fillText('SCORE', W / 2, 690);
  g.font = "400 120px 'Black Han Sans', sans-serif";
  outlined(g, d.score.toLocaleString(), W / 2, 810, NAVY, '#ffffff', 6);
  g.font = "400 38px 'Jua', sans-serif";
  g.fillStyle = NAVY;
  g.fillText(`정확도 ${Math.round(d.accuracy * 100)}%  ·  최대 ${d.maxCombo} 콤보  ·  ${d.difficultyLabel}`, W / 2, 875);

  // per-punch bars
  const top = 925;
  const rowH = Math.min(52, 300 / Math.max(1, d.rows.length));
  d.rows.forEach((r, i) => {
    const y = top + i * rowH;
    const weak = r.n === d.weakest;
    g.textAlign = 'left';
    g.font = "400 30px 'Jua', sans-serif";
    g.fillStyle = weak ? RED : NAVY;
    g.fillText(`${r.n} ${PUNCH_NAMES[r.n]}`, 150, y + 30);
    roundRect(g, 390, y + 8, 440, 28, 14);
    g.fillStyle = '#e2e8f0';
    g.fill();
    roundRect(g, 390, y + 8, Math.max(28, 440 * r.pct), 28, 14);
    g.fillStyle = weak ? RED : '#3b82f6';
    g.fill();
    g.textAlign = 'right';
    g.fillStyle = '#475569';
    g.fillText(`${r.hits}/${r.attempts}`, 935, y + 30);
  });

  // footer
  g.textAlign = 'center';
  g.fillStyle = NAVY;
  g.font = "400 34px 'Jua', sans-serif";
  const date = `${d.date.getFullYear()}.${String(d.date.getMonth() + 1).padStart(2, '0')}.${String(d.date.getDate()).padStart(2, '0')}`;
  g.fillText(`웹캠 하나로 미트 치기!  ·  ${date}`, W / 2, H - 42);
  return c;
}

export function downloadCanvas(c: HTMLCanvasElement, name: string): void {
  c.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
}
