// Pose data types shared by the camera path, replay path and Node tests.
// No DOM or MediaPipe imports here so this runs under plain Node.

/** [x, y, z, visibility] */
export type P4 = [number, number, number, number];

/** One processed video frame. lm/wl are null when no pose was detected. */
export interface PoseFrame {
  /** Source clock in ms (camera: performance.now() at detection; replay: recorded time). */
  t: number;
  /** Normalized image landmarks (33 entries), camera image space, NOT mirrored. */
  lm: P4[] | null;
  /** World landmarks in meters (33 entries). Axis directions: see DESIGN.md §3 / README. */
  wl: P4[] | null;
}

// MediaPipe Pose landmark indices (DESIGN.md §3, "문서 확인").
// "L"/"R" are the person's own anatomical left/right.
export const LM = {
  NOSE: 0,
  MOUTH_L: 9,
  MOUTH_R: 10,
  SHOULDER_L: 11,
  SHOULDER_R: 12,
  ELBOW_L: 13,
  ELBOW_R: 14,
  WRIST_L: 15,
  WRIST_R: 16,
  HIP_L: 23,
  HIP_R: 24,
} as const;

export type Side = 'left' | 'right';
export type Stance = 'orthodox' | 'southpaw';

export function leadSide(stance: Stance): Side {
  return stance === 'orthodox' ? 'left' : 'right';
}
export const SIDES: readonly Side[] = ['left', 'right'];

export interface ArmIndices {
  shoulder: number;
  elbow: number;
  wrist: number;
  otherShoulder: number;
}

export const ARM: Record<Side, ArmIndices> = {
  left: { shoulder: LM.SHOULDER_L, elbow: LM.ELBOW_L, wrist: LM.WRIST_L, otherShoulder: LM.SHOULDER_R },
  right: { shoulder: LM.SHOULDER_R, elbow: LM.ELBOW_R, wrist: LM.WRIST_R, otherShoulder: LM.SHOULDER_L },
};

/** Landmarks the app actually reads (filtered + recorded at full precision). */
export const USED_LANDMARKS: readonly number[] = [
  LM.NOSE, LM.MOUTH_L, LM.MOUTH_R,
  LM.SHOULDER_L, LM.SHOULDER_R, LM.ELBOW_L, LM.ELBOW_R, LM.WRIST_L, LM.WRIST_R,
  LM.HIP_L, LM.HIP_R,
];

/** Upper-body skeleton edges for drawing. */
export const UPPER_BODY_EDGES: readonly [number, number][] = [
  [LM.SHOULDER_L, LM.SHOULDER_R],
  [LM.SHOULDER_L, LM.ELBOW_L], [LM.ELBOW_L, LM.WRIST_L],
  [LM.SHOULDER_R, LM.ELBOW_R], [LM.ELBOW_R, LM.WRIST_R],
  [LM.SHOULDER_L, LM.HIP_L], [LM.SHOULDER_R, LM.HIP_R], [LM.HIP_L, LM.HIP_R],
  [LM.MOUTH_L, LM.MOUTH_R],
];
