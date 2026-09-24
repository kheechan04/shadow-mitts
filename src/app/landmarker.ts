import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

// WASM is pinned to the installed package version (DESIGN.md used @latest, which can drift
// away from the JS bundle we ship).
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${__MP_VERSION__}/wasm`;

export type ModelVariant = 'lite' | 'full' | 'heavy';
export type Delegate = 'GPU' | 'CPU';

export const modelUrl = (v: ModelVariant) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${v}/float16/latest/pose_landmarker_${v}.task`;

export interface LoadedLandmarker {
  landmarker: PoseLandmarker;
  delegate: Delegate;
  model: ModelVariant;
  /** Why GPU was not used, if it wasn't. */
  gpuError?: string;
}

async function create(model: ModelVariant, delegate: Delegate): Promise<PoseLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  return PoseLandmarker.createFromOptions(fileset, {
    // `delegate` is in BaseOptions per vision.d.ts (verified against v1.0.1).
    baseOptions: { modelAssetPath: modelUrl(model), delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });
}

/** Try GPU first, fall back to CPU. `forceCpu` skips the GPU attempt. */
export async function loadLandmarker(model: ModelVariant, forceCpu = false): Promise<LoadedLandmarker> {
  let gpuError: string | undefined;
  if (!forceCpu) {
    try {
      return { landmarker: await create(model, 'GPU'), delegate: 'GPU', model };
    } catch (e) {
      gpuError = e instanceof Error ? e.message : String(e);
      console.warn('GPU delegate failed, falling back to CPU:', e);
    }
  } else {
    gpuError = 'CPU 강제';
  }
  return { landmarker: await create(model, 'CPU'), delegate: 'CPU', model, gpuError };
}
