// Every tunable threshold lives here. All defaults are PLACEHOLDERS (DESIGN.md: "임계값은 전부 placeholder").
// The UI builds one slider per entry, so adding a param here is enough to expose it on screen.

export interface ParamDef {
  key: string;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

export const PARAM_DEFS = [
  // --- 입력 품질 ---
  { key: 'minVisibility', label: '최소 visibility', group: '입력', min: 0, max: 1, step: 0.05, default: 0.5 },
  // --- 필터 (One Euro) ---
  { key: 'filterMinCutoff', label: 'One Euro minCutoff', group: '필터', min: 0.1, max: 20, step: 0.1, default: 3.0, unit: 'Hz' },
  { key: 'filterBeta', label: 'One Euro beta', group: '필터', min: 0, max: 5, step: 0.01, default: 0.3 },
  { key: 'filterDCutoff', label: 'One Euro dCutoff', group: '필터', min: 0.1, max: 10, step: 0.1, default: 1.0, unit: 'Hz' },
  // --- 정규화 ---
  { key: 'scaleTau', label: '몸통 길이 기준 평활 시간', group: '정규화', min: 0, max: 5, step: 0.1, default: 1.5, unit: 's' },
  // --- 가드 기준점 --- (T = 몸통 길이: 어깨 중점~엉덩이 중점)
  { key: 'guardRestSpeed', label: '가드 기준 갱신 속도 상한', group: '가드 기준', min: 0.1, max: 5, step: 0.1, default: 0.7, unit: 'T/s' },
  { key: 'guardTau', label: '가드 기준 평활 시간', group: '가드 기준', min: 0, max: 3, step: 0.05, default: 0.4, unit: 's' },
  { key: 'guardMinUp', label: '가드 판정 최저 손높이', group: '가드 기준', min: -2, max: 1, step: 0.05, default: -0.4, unit: 'T' },
  // --- 펀치 검출 ---
  { key: 'punchStartSpeed', label: '시작 속도 (높은 임계)', group: '펀치 검출', min: 0.2, max: 10, step: 0.05, default: 1.0, unit: 'T/s' },
  { key: 'punchEndSpeed', label: '멈춤 속도 (낮은 임계)', group: '펀치 검출', min: 0.1, max: 5, step: 0.05, default: 0.6, unit: 'T/s' },
  { key: 'punchMinExtent', label: '최소 이동 거리', group: '펀치 검출', min: 0.02, max: 1, step: 0.01, default: 0.1, unit: 'T' },
  { key: 'punchMinPeakSpeed', label: '최소 최고 속도', group: '펀치 검출', min: 0.2, max: 10, step: 0.05, default: 2.0, unit: 'T/s' },
  { key: 'punchDownMinSpeed', label: '아래로 향한 펀치 최소 속도', group: '펀치 검출', min: 0.2, max: 15, step: 0.1, default: 4.0, unit: 'T/s' },
  { key: 'punchMaxDown', label: '허용 아래 이동 (넘으면 무시)', group: '펀치 검출', min: 0, max: 1, step: 0.01, default: 0.25, unit: 'T' },
  { key: 'punchMaxOutward', label: '허용 바깥 이동 (넘으면 무시)', group: '펀치 검출', min: 0, max: 1, step: 0.01, default: 0.15, unit: 'T' },
  { key: 'punchMaxDipDepth', label: '어퍼컷 딥 최대 깊이', group: '펀치 검출', min: 0, max: 2, step: 0.01, default: 0.7, unit: 'T' },
  { key: 'punchMaxCommon', label: '양손 동시 움직임 허용 (넘으면 몸통 회전)', group: '펀치 검출', min: 0, max: 1.5, step: 0.01, default: 0.45 },
  { key: 'torsoTurnMaxSpeed', label: '몸통 회전으로 볼 최고 속도 상한', group: '펀치 검출', min: 0, max: 15, step: 0.1, default: 4.0, unit: 'T/s' },
  { key: 'punchMaxRiseMs', label: '최대 뻗는 데 걸린 시간', group: '펀치 검출', min: 50, max: 1000, step: 10, default: 350, unit: 'ms' },
  { key: 'punchRetractFrac', label: '정점 확정 되돌림 비율', group: '펀치 검출', min: 0.05, max: 0.8, step: 0.01, default: 0.2 },
  { key: 'punchReturnFrac', label: '복귀 판정 비율', group: '펀치 검출', min: 0.05, max: 0.95, step: 0.01, default: 0.7 },
  { key: 'punchReturnTimeoutMs', label: '복귀 대기 최대 시간', group: '펀치 검출', min: 200, max: 3000, step: 50, default: 1000, unit: 'ms' },
  { key: 'punchMaxDurationMs', label: '최대 뻗는 시간', group: '펀치 검출', min: 100, max: 2000, step: 10, default: 600, unit: 'ms' },
  { key: 'punchCooldownMs', label: '같은 손 쿨다운', group: '펀치 검출', min: 0, max: 1000, step: 10, default: 150, unit: 'ms' },
  // --- 가드 판정 (치지 않는 손이 턱 근처인가) --- 녹화에서 가드 손은 입보다 0.15~0.25 T 아래, 옆으로 0.1~0.25 T
  { key: 'guardOkMaxBelow', label: '가드: 입보다 아래 허용', group: '가드 판정', min: 0, max: 1.5, step: 0.01, default: 0.35, unit: 'T' },
  { key: 'guardOkMaxSide', label: '가드: 입에서 옆으로 허용', group: '가드 판정', min: 0, max: 1.5, step: 0.01, default: 0.4, unit: 'T' },
  // --- 펀치 분류 ---
  { key: 'hookMaxForearmAngle', label: '훅: 팔뚝이 이 각도보다 누우면 훅', group: '펀치 분류', min: 0, max: 90, step: 1, default: 30, unit: '°' },
  { key: 'uppercutBias', label: '어퍼컷 쪽으로 기울이기', group: '펀치 분류', min: -4, max: 4, step: 0.1, default: 0 },
] as const satisfies readonly ParamDef[];

export type ParamKey = (typeof PARAM_DEFS)[number]['key'];
export type Params = Record<ParamKey, number>;

export function defaultParams(): Params {
  const p = {} as Params;
  for (const d of PARAM_DEFS) p[d.key] = d.default;
  return p;
}

/** Merge a partial/untrusted object over defaults, clamping to each slider range. */
export function sanitizeParams(input: unknown): Params {
  const p = defaultParams();
  if (!input || typeof input !== 'object') return p;
  const src = input as Record<string, unknown>;
  for (const d of PARAM_DEFS) {
    const v = src[d.key];
    if (typeof v === 'number' && Number.isFinite(v)) p[d.key] = Math.min(d.max, Math.max(d.min, v));
  }
  return p;
}
