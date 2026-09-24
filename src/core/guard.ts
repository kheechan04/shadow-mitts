// Guard check (DESIGN §4 "가드 판정"): is this wrist up near the chin?
// Measured in the M1 recordings: a guarding wrist sat 0.15–0.25 T below the mouth and
// 0.1–0.25 T to the side of it. Thresholds are sliders.

import type { FrameFeatures } from './features';
import type { Params } from './params';
import type { Side } from './pose';

/** +1 if "inward" for this arm is +X in the un-mirrored image (same as features.ts). */
const IN_SIGN: Record<Side, number> = { left: -1, right: 1 };

export function guardOk(f: FrameFeatures, side: Side, p: Params): boolean {
  const a = f.arms[side];
  if (!a.valid) return false;
  const wristX = IN_SIGN[side] * a.rel[0];
  const below = f.mouth[1] - a.rel[1];
  return below <= p.guardOkMaxBelow && Math.abs(wristX - f.mouth[0]) <= p.guardOkMaxSide;
}
