import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { FrameFeatures, Vec3 } from '../core/features';
import { RecognitionPipeline } from '../core/pipeline';
import type { P4, PoseFrame } from '../core/pose';
import { parseRecording, serializeRecording, type Recording } from '../core/recording';
import { GameController } from './gameController';
import { FeatureGraph } from './graph';
import { loadLandmarker, type Delegate, type ModelVariant } from './landmarker';
import { drawOverlay } from './overlay';
import { PunchUi } from './punchUi';
import { buildTuningPanel, loadParams } from './tuning';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const view = $<HTMLCanvasElement>('view');
const ctx = view.getContext('2d')!;
const video = $<HTMLVideoElement>('video');
const banner = $('banner');
const graph = new FeatureGraph($<HTMLCanvasElement>('graph'));
const punchUi = new PunchUi($<HTMLSelectElement>('stance'), $('punchCounts'), $('punchLog'));

const params = loadParams();
// Filters read params live; in replay, re-run from frame 0 so a change shows on the whole clip.
buildTuningPanel($('tuning'), params, () => {
  if (mode === 'replay') seekTo(rpIndex);
});

type Mode = 'idle' | 'loading' | 'camera' | 'replay';
let mode: Mode = 'idle';
let aspect = 4 / 3;
let pipeline = new RecognitionPipeline(() => params, aspect);
let lastFrame: PoseFrame | null = null;
let lastFeatures: FrameFeatures | null = null;

const game = new GameController({
  params: () => params,
  stance: () => punchUi.stance,
  setStance: (s) => {
    const sel = $<HTMLSelectElement>('stance');
    sel.value = s;
    sel.dispatchEvent(new Event('change'));
  },
  cameraRunning: () => mode === 'camera',
  notify: (msg) => showBanner(msg),
});
// dev-only handle for automated visual checks (stripped from production builds)
if (import.meta.env.DEV) (window as unknown as { __game: GameController }).__game = game;

// ---------------------------------------------------------------- camera

let stream: MediaStream | null = null;
let landmarker: PoseLandmarker | null = null;
let delegate: Delegate | null = null;
let model: ModelVariant = 'lite';
let lastTs = 0;
let inferMs = NaN;
let latencyMs = NaN;
let latencySupported: boolean | null = null;
let fpsCount = 0;
let fps = NaN;
let fpsWindowStart = performance.now();
let gpuRetried = false;

function showBanner(text: string, ok = false): void {
  banner.textContent = text;
  banner.classList.toggle('ok', ok);
  banner.classList.toggle('hidden', !text);
}

function setMode(m: Mode): void {
  mode = m;
  $('sMode').textContent = { idle: '대기', loading: '로딩 중…', camera: '카메라', replay: '녹화 재생' }[m];
}

function stopCamera(): void {
  game.stop();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  if (recording) toggleRecording();
  if (mode === 'camera') setMode('idle');
}

async function ensureLandmarker(): Promise<void> {
  const wantModel = $<HTMLSelectElement>('model').value as ModelVariant;
  const forceCpu = $<HTMLInputElement>('forceCpu').checked;
  if (landmarker && model === wantModel && (!forceCpu || delegate === 'CPU')) return;
  landmarker?.close();
  landmarker = null;
  showBanner(`포즈 모델(${wantModel}) 로딩 중…`, true);
  const loaded = await loadLandmarker(wantModel, forceCpu);
  landmarker = loaded.landmarker;
  delegate = loaded.delegate;
  model = loaded.model;
  gpuRetried = false;
  $('sDelegate').textContent = loaded.gpuError ? `${delegate} (GPU 실패: ${loaded.gpuError})` : delegate;
}

const CAMERA_KEY = 'shadowmitts.camera.v1';

/** Fills the camera dropdown. Labels are empty until camera permission has been granted once. */
async function refreshCameraList(): Promise<void> {
  const sel = $<HTMLSelectElement>('camera');
  let current = sel.value;
  if (!current) {
    try {
      current = localStorage.getItem(CAMERA_KEY) ?? '';
    } catch {
      // storage unavailable — fall back to the default camera
    }
  }
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch {
    return;
  }
  sel.textContent = '';
  sel.append(new Option('기본 카메라', ''));
  devices.forEach((d, i) => sel.append(new Option(d.label || `카메라 ${i + 1}`, d.deviceId)));
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

function cameraErrorHint(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
      return '카메라 권한이 거부됨 — 주소창 왼쪽 아이콘에서 카메라를 "허용"으로 바꾸고 새로고침하세요';
    case 'NotReadableError':
    case 'AbortError':
      return '카메라를 열지 못함 — 다른 프로그램(줌, 팀즈, 카메라 앱, OBS 등)을 끄거나, 위 "카메라" 목록에서 다른 장치를 골라보세요';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '카메라를 찾지 못함 — 연결/전원(노트북 카메라 키, 가림막)과 "카메라" 목록을 확인하세요';
    default:
      return window.isSecureContext ? '' : 'HTTPS 또는 localhost 주소로 접속해야 합니다';
  }
}

async function openCamera(): Promise<MediaStream> {
  const deviceId = $<HTMLSelectElement>('camera').value;
  const [w, h] = $<HTMLSelectElement>('resolution').value.split('x').map(Number);
  const device = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' };
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { ...device, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 60 } },
      audio: false,
    });
  } catch (e) {
    // Some Windows drivers time out on resolution/frame-rate hints. Retry with nothing but the device.
    if (e instanceof Error && e.name === 'NotAllowedError') throw e;
    console.warn('getUserMedia with constraints failed, retrying plain:', e);
    return navigator.mediaDevices.getUserMedia({ video: deviceId ? device : true, audio: false });
  }
}

async function startCamera(): Promise<void> {
  stopReplay();
  stopCamera();
  setMode('loading');
  try {
    await ensureLandmarker();
    showBanner('카메라 여는 중…', true);
    stream = await openCamera();
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    setMode('idle');
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const hint = cameraErrorHint(e);
    showBanner(`시작 실패 — ${msg}${hint ? `  → ${hint}` : ''}`);
    void refreshCameraList();
    return;
  }
  void refreshCameraList();
  const settings = stream.getVideoTracks()[0].getSettings();
  $('sCamFps').textContent = `${settings.frameRate ?? '?'} (${video.videoWidth}×${video.videoHeight})`;
  view.width = video.videoWidth;
  view.height = video.videoHeight;
  aspect = video.videoWidth / video.videoHeight;
  pipeline = new RecognitionPipeline(() => params, aspect);
  graph.clear();
  punchUi.reset();
  latencySupported = null;
  showBanner('');
  setMode('camera');
  scheduleVideoFrame();
}

function scheduleVideoFrame(): void {
  if (mode !== 'camera') return;
  // Not in every browser (older Firefox) even though lib.dom declares it.
  if (typeof (video as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === 'function') {
    video.requestVideoFrameCallback((_now, meta) => onVideoFrame(meta.captureTime));
  } else {
    // Fallback: poll on rAF and only process when the video advanced.
    let lastTime = -1;
    const poll = () => {
      if (mode !== 'camera') return;
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        onVideoFrame(undefined);
      } else requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }
}

const toP4 = (p: { x: number; y: number; z: number; visibility?: number }): P4 => [p.x, p.y, p.z, p.visibility ?? 0];

async function onVideoFrame(captureTime: number | undefined): Promise<void> {
  if (mode !== 'camera' || !landmarker) return;
  // detectForVideo needs a strictly increasing timestamp in ms (vision.d.ts: `timestamp: number` "in ms").
  const ts = Math.max(lastTs + 1, performance.now());
  lastTs = ts;
  let frame: PoseFrame;
  try {
    const t0 = performance.now();
    const res = landmarker.detectForVideo(video, ts);
    const t1 = performance.now();
    inferMs = Number.isNaN(inferMs) ? t1 - t0 : inferMs * 0.9 + (t1 - t0) * 0.1;
    if (typeof captureTime === 'number' && captureTime > 0) {
      latencySupported = true;
      const l = t1 - captureTime;
      latencyMs = Number.isNaN(latencyMs) ? l : latencyMs * 0.9 + l * 0.1;
    } else if (latencySupported === null) latencySupported = false;
    frame = {
      t: ts,
      lm: res.landmarks[0]?.map(toP4) ?? null,
      wl: res.worldLandmarks[0]?.map(toP4) ?? null,
    };
  } catch (e) {
    console.error('detectForVideo failed', e);
    if (delegate === 'GPU' && !gpuRetried) {
      gpuRetried = true;
      showBanner('GPU 추론 실패 → CPU로 재시도합니다');
      $<HTMLInputElement>('forceCpu').checked = true;
      mode = 'loading';
      try {
        await ensureLandmarker();
      } catch (e2) {
        setMode('idle');
        showBanner(`CPU 로딩도 실패: ${e2 instanceof Error ? e2.message : String(e2)}`);
        return;
      }
      setMode('camera');
      showBanner('');
    } else {
      showBanner(`추론 오류: ${e instanceof Error ? e.message : String(e)}`);
    }
    scheduleVideoFrame();
    return;
  }
  countFps();
  if (recording) recording.frames.push(frame);
  processFrame(frame);
  scheduleVideoFrame();
}

function countFps(): void {
  fpsCount++;
  const now = performance.now();
  if (now - fpsWindowStart >= 1000) {
    fps = (fpsCount * 1000) / (now - fpsWindowStart);
    fpsCount = 0;
    fpsWindowStart = now;
  }
}

// ---------------------------------------------------------------- shared per-frame path

/** draw: repaint now. flash: pop recognized punches up on the video (off while re-simulating a seek). */
function processFrame(frame: PoseFrame, draw = true, flash = draw): void {
  lastFrame = frame;
  const r = pipeline.update(frame);
  lastFeatures = r.features;
  if (lastFeatures) graph.push(lastFeatures);
  for (const ev of r.events) {
    // During the game the mitt feedback replaces the recognition pop-ups.
    punchUi.add(ev, flash && !game.active);
    graph.mark(ev.t, ev.side);
  }
  if (mode === 'camera') game.onFrame(r.features, r.events, frame.t);
  if (draw) render();
}

/** The webcam canvas: big on the menu, a picture-in-picture during play (the 3D scene is separate). */
function render(): void {
  drawOverlay(ctx, lastFrame, {
    mirror: $<HTMLInputElement>('mirror').checked,
    video: mode === 'camera' ? video : null,
    minVisibility: params.minVisibility,
    flashes: game.active ? [] : punchUi.activeFlashes(),
  });
  graph.draw();
}

// ---------------------------------------------------------------- recording

let recording: Recording | null = null;
let lastRecording: Recording | null = null;

function toggleRecording(): void {
  const btn = $<HTMLButtonElement>('recBtn');
  if (!recording) {
    if (mode !== 'camera') {
      showBanner('녹화는 카메라 모드에서만 가능합니다');
      return;
    }
    recording = {
      meta: {
        version: 1,
        createdAt: new Date().toISOString(),
        note: $<HTMLInputElement>('recNote').value,
        aspect,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        model,
        delegate: delegate ?? '',
      },
      frames: [],
    };
    btn.textContent = '■ 녹화 정지 & 저장';
    btn.classList.add('recording');
    return;
  }
  const rec = recording;
  recording = null;
  btn.textContent = '● 녹화 시작';
  btn.classList.remove('recording');
  if (rec.frames.length === 0) return;
  const text = serializeRecording(rec);
  lastRecording = parseRecording(text); // identical to what a reload of the file would give
  $<HTMLButtonElement>('replayLast').disabled = false;
  const stamp = rec.meta.createdAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = `rec-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- replay

let replay: Recording | null = null;
let rpIndex = 0;
let rpClock = 0;
let rpPlaying = false;
let rpLastNow = 0;

function stopReplay(): void {
  rpPlaying = false;
  replay = null;
  if (mode === 'replay') setMode('idle');
}

function startReplay(rec: Recording): void {
  stopCamera();
  replay = rec;
  const w = rec.meta.videoWidth || 640;
  const h = rec.meta.videoHeight || Math.round(640 / rec.meta.aspect);
  view.width = w;
  view.height = h;
  aspect = rec.meta.aspect;
  pipeline = new RecognitionPipeline(() => params, aspect);
  const seek = $<HTMLInputElement>('rpSeek');
  seek.max = String(Math.max(0, rec.frames.length - 1));
  setMode('replay');
  showBanner('');
  seekTo(0);
  rpPlaying = true;
  rpLastNow = performance.now();
  requestAnimationFrame(replayTick);
}

/** Re-run the pipeline from frame 0 so filters, detector state and counts match a continuous playback. */
function seekTo(i: number): void {
  if (!replay) return;
  i = Math.max(0, Math.min(replay.frames.length - 1, i));
  pipeline.reset();
  graph.clear();
  punchUi.reset();
  for (let k = 0; k <= i; k++) processFrame(replay.frames[k], false);
  rpIndex = i;
  rpClock = replay.frames[i]?.t ?? 0;
  render();
}

function replayTick(now: number): void {
  if (mode !== 'replay' || !replay) return;
  if (rpPlaying) {
    rpClock += (now - rpLastNow) * Number($<HTMLSelectElement>('rpSpeed').value);
    const frames = replay.frames;
    let advanced = false;
    while (rpIndex + 1 < frames.length && frames[rpIndex + 1].t <= rpClock) {
      rpIndex++;
      processFrame(frames[rpIndex], false, true);
      advanced = true;
    }
    // Keep repainting while pop-ups fade, even between recorded frames.
    if (advanced || punchUi.activeFlashes().length) render();
    if (rpIndex >= frames.length - 1) {
      if ($<HTMLInputElement>('rpLoop').checked) seekTo(0);
      else rpPlaying = false;
    }
  }
  rpLastNow = now;
  requestAnimationFrame(replayTick);
}

// ---------------------------------------------------------------- panel text (throttled)

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const fmtV = (v: Vec3, d = 2) => v.map((x) => fmt(x, d)).join(' / ');
const LOW_FPS = 40;
const STATE_KO = { idle: '대기', extending: '<b>뻗는 중</b>', retracting: '복귀 중' } as const;

function updatePanel(): void {
  $('sFps').textContent = mode === 'camera' ? fmt(fps, 1) : '-';
  // Quick jabs span only 2–3 frames at 25 fps (M1 recordings at 25 fps missed the most jabs).
  const lowFps = mode === 'camera' && Number.isFinite(fps) && fps < LOW_FPS;
  $('sFps').className = lowFps ? 'bad' : '';
  $('sFpsHint').textContent = lowFps ? '낮음 — 빠른 펀치를 놓칠 수 있어요. 조명을 밝게, 노트북 전원 연결, 다른 프로그램 종료' : '';
  $('sInfer').textContent = mode === 'camera' ? `${fmt(inferMs, 1)} ms` : '-';
  $('sLatency').textContent =
    mode !== 'camera' ? '-' : latencySupported === false ? '측정 불가 (브라우저가 captureTime 미제공)' : `${fmt(latencyMs, 0)} ms`;

  const f = lastFeatures;
  const sFrame = $('sFrame');
  if (!f) {
    sFrame.textContent = lastFrame ? '사람 없음' : '-';
    sFrame.className = lastFrame ? 'bad' : '';
  } else {
    sFrame.textContent = f.upperBodyInFrame ? 'OK' : `안 보임: ${f.missing.join(', ')}`;
    sFrame.className = f.upperBodyInFrame ? '' : 'bad';
  }

  const rows: [string, (a: FrameFeatures['arms']['left']) => string][] = [
    ['visibility', (a) => `<span class="${a.valid ? '' : 'bad'}">${fmt(a.vis)}</span>`],
    ['검출 상태', (a) => STATE_KO[pipeline.armState(a.side).state]],
    ['속도 2D (T/s)', (a) => fmt(a.speed2d, 1)],
    ['속도 3D (T/s)', (a) => fmt(a.speed3d, 1)],
    ['월드 속도 (m/s)', (a) => fmt(a.worldSpeed, 2)],
    ['팔꿈치 3D (°)', (a) => fmt(a.elbowAngle3d, 0)],
    ['팔꿈치 2D (°)', (a) => fmt(a.elbowAngle2d, 0)],
    ['손목 안쪽/위/z(−=앞) T', (a) => fmtV(a.rel)],
    ['속도 안쪽/위/z T/s', (a) => fmtV(a.vel, 1)],
    ['월드 dx/dy/dz', (a) => fmtV(a.worldRel)],
  ];
  $('armRows').innerHTML = rows
    .map(([label, get]) => `<tr><td>${label}</td><td>${f ? get(f.arms.left) : '–'}</td><td>${f ? get(f.arms.right) : '–'}</td></tr>`)
    .join('');

  const probe: [string, Vec3 | undefined][] = [
    ['코 (0)', f?.probe.nose],
    ['엉덩이 중점', f?.probe.hipMid],
    ['왼손목 (15)', f?.probe.wristL],
    ['오른손목 (16)', f?.probe.wristR],
  ];
  $('probeRows').innerHTML = probe
    .map(([label, v]) => `<tr><td>${label}</td>${[0, 1, 2].map((i) => `<td>${v ? fmt(v[i], 3) : '–'}</td>`).join('')}</tr>`)
    .join('');

  punchUi.render();
  $('recInfo').textContent = recording ? `${recording.frames.length} 프레임 녹화 중` : '';
  if (replay) {
    $<HTMLInputElement>('rpSeek').value = String(rpIndex);
    const note = replay.meta.note ? ` · "${replay.meta.note}"` : '';
    $('rpInfo').textContent = `${rpIndex + 1}/${replay.frames.length} 프레임 · ${(replay.frames[rpIndex].t / 1000).toFixed(2)}s${note}`;
  } else $('rpInfo').textContent = '';
}
setInterval(updatePanel, 100);

// ---------------------------------------------------------------- wiring

$('startCam').addEventListener('click', () => void startCamera());
$('stopCam').addEventListener('click', () => {
  stopCamera();
  stopReplay();
});
$('mirror').addEventListener('change', render);
$('camera').addEventListener('change', () => {
  try {
    localStorage.setItem(CAMERA_KEY, $<HTMLSelectElement>('camera').value);
  } catch {
    // ignore — selection just won't persist
  }
});
$('recBtn').addEventListener('click', toggleRecording);
const devPanel = $('devPanel');
$('devToggle').addEventListener('click', () => devPanel.classList.toggle('open'));
$('devClose').addEventListener('click', () => devPanel.classList.remove('open'));
$('punchReset').addEventListener('click', () => punchUi.reset());
// PunchUi resets its counts on stance change; in replay, recount the clip under the new stance.
$('stance').addEventListener('change', () => {
  if (mode === 'replay') seekTo(rpIndex);
});
$('replayLast').addEventListener('click', () => lastRecording && startReplay(lastRecording));
$<HTMLInputElement>('recFile').addEventListener('change', async (ev) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    startReplay(parseRecording(await file.text()));
  } catch (e) {
    showBanner(`녹화 파일을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
});
$('rpPlay').addEventListener('click', () => {
  rpPlaying = !rpPlaying;
  rpLastNow = performance.now();
});
$('rpRestart').addEventListener('click', () => seekTo(0));
$('rpPrev').addEventListener('click', () => {
  rpPlaying = false;
  seekTo(rpIndex - 1);
});
$('rpNext').addEventListener('click', () => {
  rpPlaying = false;
  if (replay && rpIndex + 1 < replay.frames.length) {
    rpIndex++;
    rpClock = replay.frames[rpIndex].t;
    processFrame(replay.frames[rpIndex]);
  }
});
$<HTMLInputElement>('rpSeek').addEventListener('input', (ev) => {
  rpPlaying = false;
  seekTo(Number((ev.target as HTMLInputElement).value));
});

render();
void refreshCameraList();
if (!window.isSecureContext) showBanner('카메라는 HTTPS 또는 localhost에서만 동작합니다');
