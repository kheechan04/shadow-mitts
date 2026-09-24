import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { P4 } from '../core/pose';
import type { WorkerReply, WorkerRequest } from './poseWorker';

// WASM is pinned to the installed package version (DESIGN.md used @latest, which can drift
// away from the JS bundle we ship).
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${__MP_VERSION__}/wasm`;

export type ModelVariant = 'lite' | 'full' | 'heavy';
export type Delegate = 'GPU' | 'CPU';

export const modelUrl = (v: ModelVariant) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${v}/float16/latest/pose_landmarker_${v}.task`;

export interface PoseResult {
  lm: P4[] | null;
  wl: P4[] | null;
  /** time spent inside detectForVideo, ms */
  inferMs: number;
}

/** One pose detector, running either in a worker (default) or on the main thread (fallback). */
export interface PoseDetector {
  readonly where: 'worker' | 'main';
  /** `ts` must strictly increase (vision.d.ts: VIDEO mode timestamp in ms). */
  detect(video: HTMLVideoElement, ts: number): Promise<PoseResult>;
  close(): void;
}

export interface LoadedLandmarker {
  landmarker: PoseDetector;
  delegate: Delegate;
  model: ModelVariant;
  /** Why GPU was not used, if it wasn't. */
  gpuError?: string;
}

const toP4 = (p: { x: number; y: number; z: number; visibility?: number }): P4 => [p.x, p.y, p.z, p.visibility ?? 0];

// ---------------------------------------------------------------- worker

class WorkerDetector implements PoseDetector {
  readonly where = 'worker' as const;
  private worker = new Worker(new URL('./poseWorker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: WorkerReply) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.type === 'error') p.reject(new Error(ev.data.message));
      else p.resolve(ev.data);
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'worker error');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private send(req: Omit<WorkerRequest, 'id'>, transfer: Transferable[] = []): Promise<WorkerReply> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id } as WorkerRequest, transfer);
    });
  }

  async init(model: ModelVariant, delegate: Delegate): Promise<void> {
    await this.send({ type: 'init', wasmBase: WASM_BASE, modelUrl: modelUrl(model), delegate } as Omit<WorkerRequest, 'id'>);
  }

  async detect(video: HTMLVideoElement, ts: number): Promise<PoseResult> {
    // the only main-thread work per frame: grab the current video frame (a GPU copy)
    const bitmap = await createImageBitmap(video);
    const r = await this.send({ type: 'detect', bitmap, ts } as Omit<WorkerRequest, 'id'>, [bitmap]);
    if (r.type !== 'result') throw new Error('unexpected worker reply');
    return { lm: r.lm, wl: r.wl, inferMs: r.inferMs };
  }

  close(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('closed'));
    this.pending.clear();
  }
}

// ---------------------------------------------------------------- main thread (fallback)

class MainThreadDetector implements PoseDetector {
  readonly where = 'main' as const;
  constructor(private lm: PoseLandmarker) {}

  async detect(video: HTMLVideoElement, ts: number): Promise<PoseResult> {
    const t0 = performance.now();
    const res = this.lm.detectForVideo(video, ts);
    return {
      inferMs: performance.now() - t0,
      lm: res.landmarks[0]?.map(toP4) ?? null,
      wl: res.worldLandmarks[0]?.map(toP4) ?? null,
    };
  }

  close(): void {
    this.lm.close();
  }
}

async function createMain(model: ModelVariant, delegate: Delegate): Promise<PoseDetector> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const lm = await PoseLandmarker.createFromOptions(fileset, {
    // `delegate` is in BaseOptions per vision.d.ts (verified against v1.0.1).
    baseOptions: { modelAssetPath: modelUrl(model), delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });
  return new MainThreadDetector(lm);
}

async function createWorker(model: ModelVariant, delegate: Delegate): Promise<PoseDetector> {
  const w = new WorkerDetector();
  try {
    await w.init(model, delegate);
    return w;
  } catch (e) {
    w.close();
    throw e;
  }
}

async function create(model: ModelVariant, delegate: Delegate, useWorker = true): Promise<PoseDetector> {
  if (!useWorker) return createMain(model, delegate);
  try {
    return await createWorker(model, delegate);
  } catch (e) {
    // e.g. a browser without module workers or OffscreenCanvas WebGL2: run on the main thread
    console.warn(`pose worker (${delegate}) failed, using the main thread:`, e);
    return createMain(model, delegate);
  }
}

/** Try GPU first, fall back to CPU. `forceCpu` skips the GPU attempt. */
export async function loadLandmarker(model: ModelVariant, forceCpu = false, useWorker = true): Promise<LoadedLandmarker> {
  let gpuError: string | undefined;
  if (!forceCpu) {
    try {
      return { landmarker: await create(model, 'GPU', useWorker), delegate: 'GPU', model };
    } catch (e) {
      gpuError = e instanceof Error ? e.message : String(e);
      console.warn('GPU delegate failed, falling back to CPU:', e);
    }
  } else {
    gpuError = 'CPU 강제';
  }
  return { landmarker: await create(model, 'CPU', useWorker), delegate: 'CPU', model, gpuError };
}
