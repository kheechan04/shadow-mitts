// Pose inference off the main thread. In-game recording (M3): detectForVideo took ~37 ms per
// frame at ~22 fps on the main thread — ~80% of it — so the 3D view could only draw in the gaps
// (display frames every 37 ms, up to 226 ms: the "끊기는 느낌"). Here it runs in parallel.
//
// Worker support in @mediapipe/tasks-vision 1.0.1 (checked in the installed bundle): the WASM
// loader falls back to import() when importScripts is unavailable (module worker), with the
// ES-module WASM build selected by FilesetResolver.forVisionTasks(base, useModule = true), and
// the GPU graph creates its own OffscreenCanvas when no canvas is given.

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { P4 } from '../core/pose';

export type WorkerRequest =
  | { type: 'init'; id: number; wasmBase: string; modelUrl: string; delegate: 'GPU' | 'CPU' }
  | { type: 'detect'; id: number; bitmap: ImageBitmap; ts: number }
  | { type: 'close'; id: number };

export type WorkerReply =
  | { type: 'ready'; id: number }
  | { type: 'result'; id: number; lm: P4[] | null; wl: P4[] | null; inferMs: number }
  | { type: 'error'; id: number; message: string };

let landmarker: PoseLandmarker | null = null;

const toP4 = (p: { x: number; y: number; z: number; visibility?: number }): P4 => [p.x, p.y, p.z, p.visibility ?? 0];
const reply = (r: WorkerReply) => (self as unknown as Worker).postMessage(r);

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      landmarker?.close();
      landmarker = null;
      const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase, true);
      landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: msg.modelUrl, delegate: msg.delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      });
      reply({ type: 'ready', id: msg.id });
    } else if (msg.type === 'detect') {
      try {
        if (!landmarker) throw new Error('모델이 아직 로딩되지 않았어요');
        const t0 = performance.now();
        const res = landmarker.detectForVideo(msg.bitmap, msg.ts);
        const inferMs = performance.now() - t0;
        reply({
          type: 'result', id: msg.id, inferMs,
          lm: res.landmarks[0]?.map(toP4) ?? null,
          wl: res.worldLandmarks[0]?.map(toP4) ?? null,
        });
      } finally {
        msg.bitmap.close();
      }
    } else {
      landmarker?.close();
      landmarker = null;
      reply({ type: 'ready', id: msg.id });
    }
  } catch (e) {
    reply({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) });
  }
};
