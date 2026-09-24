// Punch type from ARM POSTURE at the peak (M2 play-test: "height-based" types felt wrong — the
// player had to aim high for uppercuts and low for hooks). Fitted and checked on the M1 southpaw
// recordings (92 labeled punches, leave-one-recording-out: 87/92 vs 86/92 for the old height rules):
//   hook     — forearm (elbow→wrist) lies flat: angle −12°…13° for hooks vs ≥51° for everything
//              else, wherever the fist ends up.
//   uppercut — vs straight, a logistic score: long upright forearm, LOW elbow, a dip, and rise.
//              Straights thrown at the camera look short (foreshortened) with the elbow higher.
//   straight — the rest.
// hookMaxForearmAngle and uppercutBias are sliders; the weights below come from the fit.

import type { Params } from './params';
import { leadSide, type Side, type Stance } from './pose';
import type { PunchFeatures, PunchKind } from './punch';

export interface Classification {
  kind: PunchKind;
  /** 0..1 */
  confidence: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Logistic weights (uppercut vs straight): bias, forearmLen, elbowUp, rise, dipped. */
export const UPPERCUT_WEIGHTS = { bias: -2.68, forearmLen: 0.69, elbowUp: -2.1, rise: 1.76, dipped: 2.94 };

export function uppercutScore(f: PunchFeatures, p: Params): number {
  const w = UPPERCUT_WEIGHTS;
  return w.bias + p.uppercutBias + w.forearmLen * f.forearmLen + w.elbowUp * f.elbowUp + w.rise * f.delta[1] + w.dipped * (f.dipped ? 1 : 0);
}

export function classifyPunch(f: PunchFeatures, p: Params): Classification {
  const ang = Number.isFinite(f.forearmAngle) ? f.forearmAngle : 90;
  if (ang < p.hookMaxForearmAngle) {
    return { kind: 'hook', confidence: clamp01(0.5 + (p.hookMaxForearmAngle - ang) / 60) };
  }
  const s = uppercutScore(f, p);
  const conf = 1 / (1 + Math.exp(-Math.abs(s)));
  return { kind: s > 0 ? 'uppercut' : 'straight', confidence: clamp01(conf) };
}

/** Boxing numbers: 1 jab, 2 cross, 3 lead hook, 4 rear hook, 5 lead uppercut, 6 rear uppercut. */
export function punchNumber(side: Side, kind: PunchKind, stance: Stance): number {
  const lead = side === leadSide(stance);
  const base = kind === 'straight' ? 1 : kind === 'hook' ? 3 : 5;
  return lead ? base : base + 1;
}

export const PUNCH_NAMES: Record<number, string> = {
  1: '잽', 2: '크로스', 3: '리드 훅', 4: '리어 훅', 5: '리드 어퍼컷', 6: '리어 어퍼컷',
};
