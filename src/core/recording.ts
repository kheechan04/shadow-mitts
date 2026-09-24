import type { P4, PoseFrame } from './pose';

export const RECORDING_VERSION = 1;

export interface RecordingMeta {
  version: number;
  createdAt: string;
  /** Free text, e.g. "left jab x10, orthodox". */
  note: string;
  /** videoWidth / videoHeight. Needed to turn normalized x/y into an isotropic space. */
  aspect: number;
  videoWidth: number;
  videoHeight: number;
  model: string;
  delegate: string;
}

export interface Recording {
  meta: RecordingMeta;
  frames: PoseFrame[];
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;
const roundPoints = (pts: P4[] | null): P4[] | null =>
  pts ? pts.map((p) => [round(p[0]), round(p[1]), round(p[2]), round(p[3])] as P4) : null;

/** Frame times are rebased so the first frame is t=0. */
export function serializeRecording(rec: Recording): string {
  const t0 = rec.frames.length ? rec.frames[0].t : 0;
  const frames = rec.frames.map((f) => ({
    t: Math.round((f.t - t0) * 10) / 10,
    lm: roundPoints(f.lm),
    wl: roundPoints(f.wl),
  }));
  return JSON.stringify({ meta: rec.meta, frames });
}

function parsePoints(v: unknown, where: string): P4[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) throw new Error(`${where}: 배열이 아님`);
  return v.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 4 || !p.every((n) => typeof n === 'number')) {
      throw new Error(`${where}[${i}]: [x,y,z,v] 형식이 아님`);
    }
    return p as P4;
  });
}

export function parseRecording(text: string): Recording {
  const raw = JSON.parse(text) as { meta?: Partial<RecordingMeta>; frames?: unknown[] };
  if (!raw || typeof raw !== 'object' || !raw.meta || !Array.isArray(raw.frames)) {
    throw new Error('녹화 파일 형식이 아닙니다 (meta/frames 없음)');
  }
  if (raw.meta.version !== RECORDING_VERSION) {
    throw new Error(`지원하지 않는 녹화 버전: ${String(raw.meta.version)}`);
  }
  const aspect = raw.meta.aspect;
  if (typeof aspect !== 'number' || !(aspect > 0)) throw new Error('meta.aspect가 없거나 잘못됨');

  let prevT = -Infinity;
  const frames = raw.frames.map((f, i): PoseFrame => {
    const fr = f as { t?: unknown; lm?: unknown; wl?: unknown };
    if (typeof fr.t !== 'number') throw new Error(`frames[${i}].t가 숫자가 아님`);
    if (fr.t < prevT) throw new Error(`frames[${i}].t가 감소함`);
    prevT = fr.t;
    return { t: fr.t, lm: parsePoints(fr.lm, `frames[${i}].lm`), wl: parsePoints(fr.wl, `frames[${i}].wl`) };
  });

  return {
    meta: {
      version: RECORDING_VERSION,
      createdAt: String(raw.meta.createdAt ?? ''),
      note: String(raw.meta.note ?? ''),
      aspect,
      videoWidth: Number(raw.meta.videoWidth ?? 0),
      videoHeight: Number(raw.meta.videoHeight ?? 0),
      model: String(raw.meta.model ?? ''),
      delegate: String(raw.meta.delegate ?? ''),
    },
    frames,
  };
}
