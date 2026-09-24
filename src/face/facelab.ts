// Reaction-face lab (prototype): one webcam photo → five expression images, all in this browser.
//
// Privacy by construction (the notice on the page must stay true to this):
// - the photo lives only in canvases/variables of this page; nothing is uploaded or stored
//   (no fetch/XHR with image data, no localStorage/IndexedDB); "지우기" drops it all
// - the camera stops right after the shot; there is no file upload (own face only)
// - FaceLandmarker is used for landmark positions only: no blendshapes/emotion analysis and no
//   identification (its model card: "do not provide facial recognition or identification")

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import * as THREE from 'three';
import { FACE, delaunay, eyeDistance, framePoints, warpLandmarks, type ExpressionName, type Pt } from './warp';

const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${__MP_VERSION__}/wasm`;
// pinned model version (not "latest")
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const shot = $<HTMLCanvasElement>('shot');
const status = (t: string) => ($('status').textContent = t);

const LABELS: { key: ExpressionName; tag: string; color: string; sub: string }[] = [
  { key: 'perfect', tag: 'PERFECT!', color: '#f59e0b', sub: '환하게 웃는 얼굴' },
  { key: 'good', tag: 'GOOD!', color: '#10b981', sub: '만족스러운 얼굴' },
  { key: 'normal', tag: 'NORMAL', color: '#64748b', sub: '원본 그대로' },
  { key: 'miss', tag: 'MISS…', color: '#3b82f6', sub: '시무룩한 얼굴' },
  { key: 'critical', tag: 'CRITICAL!!', color: '#e11d2e', sub: '깜짝·흥분한 얼굴' },
];

let stream: MediaStream | null = null;
let landmarker: FaceLandmarker | null = null;
/** the captured face crop and its landmarks (crop pixels) — the only copies of the photo */
let crop: HTMLCanvasElement | null = null;
let cropLm: Pt[] | null = null;

// ---------------------------------------------------------------- camera

// The game remembers the camera that works on this PC (play-test: the default one timed out, the
// "LG Camera" worked). Read that choice — only the device id, nothing about the face.
const CAMERA_KEY = 'shadowmitts.camera.v1';

async function fillCameraList(): Promise<void> {
  const sel = $<HTMLSelectElement>('camera');
  let want = sel.value;
  if (!want) {
    try {
      want = localStorage.getItem(CAMERA_KEY) ?? '';
    } catch {
      want = '';
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
  if ([...sel.options].some((o) => o.value === want)) sel.value = want;
}

async function openCamera(): Promise<MediaStream> {
  const id = $<HTMLSelectElement>('camera').value;
  const device = id ? { deviceId: { exact: id } } : { facingMode: 'user' };
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { ...device, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
  } catch (e) {
    // same as the game: some Windows drivers time out on size hints — retry with just the device
    if (e instanceof Error && e.name === 'NotAllowedError') throw e;
    return navigator.mediaDevices.getUserMedia({ video: id ? device : true, audio: false });
  }
}

function cameraHint(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError') return '카메라 권한이 막혀 있어요. 주소창 왼쪽 아이콘에서 카메라를 "허용"으로 바꾸고 새로고침해 주세요';
  if (name === 'NotReadableError' || name === 'AbortError') return '카메라를 열지 못했어요. 게임 탭이나 다른 프로그램이 카메라를 쓰고 있으면 끄고, 위 목록에서 다른 카메라(예: LG Camera)를 골라 보세요';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '카메라를 찾지 못했어요. 위 목록에서 다른 카메라를 골라 보세요';
  return `카메라를 켜지 못했어요 (${e instanceof Error ? e.message : String(e)})`;
}

async function startCamera(): Promise<void> {
  status('카메라 켜는 중…');
  stream = await openCamera();
  video.srcObject = stream;
  await video.play();
  video.hidden = false;
  shot.hidden = true;
  $<HTMLButtonElement>('snapBtn').disabled = false;
  status('얼굴이 가운데 오게 하고 정면을 봐 주세요');
  void fillCameraList(); // names show up once permission is granted
}

function stopCamera(): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

async function countdownAndShoot(): Promise<void> {
  $<HTMLButtonElement>('snapBtn').disabled = true;
  for (const n of [3, 2, 1]) {
    $('count').textContent = String(n);
    await new Promise((r) => setTimeout(r, 700));
  }
  $('count').textContent = '';
  shot.width = video.videoWidth;
  shot.height = video.videoHeight;
  shot.getContext('2d')!.drawImage(video, 0, 0);
  stopCamera(); // the camera is off as soon as we have the frame
  video.hidden = true;
  shot.hidden = false;
  await processShot(shot);
}

// ---------------------------------------------------------------- landmarks

async function ensureLandmarker(): Promise<FaceLandmarker> {
  if (landmarker) return landmarker;
  status('얼굴 모델 불러오는 중… (처음 한 번)');
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'CPU' },
    runningMode: 'IMAGE',
    numFaces: 1,
    outputFaceBlendshapes: false, // no expression analysis — positions only
    outputFacialTransformationMatrixes: false,
  });
  return landmarker;
}

async function processShot(src: HTMLCanvasElement): Promise<void> {
  const lmk = await ensureLandmarker();
  status('얼굴 위치 찾는 중…');
  const res = lmk.detect(src);
  const face = res.faceLandmarks[0];
  if (!face) {
    status('얼굴을 못 찾았어요. 밝은 곳에서 정면으로 다시 찍어 주세요');
    $<HTMLButtonElement>('camBtn').disabled = false;
    return;
  }
  const lm: Pt[] = face.map((p) => [p.x * src.width, p.y * src.height]);
  // crop: a square-ish box around the face with room for hair, chin and overlays
  const u = eyeDistance(lm);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of lm) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const half = Math.max(maxX - minX, maxY - minY) / 2 + u * 0.9;
  const x0 = Math.max(0, cx - half), y0 = Math.max(0, cy - half * 1.08);
  const x1 = Math.min(src.width, cx + half), y1 = Math.min(src.height, cy + half * 0.95);
  const scale = 360 / (x1 - x0);
  crop = document.createElement('canvas');
  crop.width = Math.round((x1 - x0) * scale);
  crop.height = Math.round((y1 - y0) * scale);
  crop.getContext('2d')!.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, crop.width, crop.height);
  cropLm = lm.map(([x, y]) => [(x - x0) * scale, (y - y0) * scale]);
  // the full frame is no longer needed: wipe it
  src.getContext('2d')!.clearRect(0, 0, src.width, src.height);
  src.width = src.height = 1;
  status('완성! 강도를 바꿔 보세요');
  $('results').hidden = false;
  $<HTMLButtonElement>('clearBtn').disabled = false;
  $<HTMLButtonElement>('camBtn').disabled = false;
  $('camBtn').textContent = '📷 다시 찍기';
  renderAll();
}

// ---------------------------------------------------------------- warp rendering

let renderer: THREE.WebGLRenderer | null = null;

function warpImage(img: HTMLCanvasElement, from: Pt[], to: Pt[]): HTMLCanvasElement {
  const w = img.width, h = img.height;
  const frame = framePoints(from, w, h);
  // drop pinned points that fall on top of each other (clamped ring points on the border)
  const seen = new Set<string>();
  const extra: Pt[] = [];
  for (const p of frame) {
    const k = `${Math.round(p[0])},${Math.round(p[1])}`;
    if (!seen.has(k)) { seen.add(k); extra.push(p); }
  }
  const src = [...from, ...extra];
  const dst = [...to, ...extra];
  const tris = delaunay(src);

  if (!renderer) renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, alpha: true, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(0, w, 0, -h, -1, 1);
  const pos = new Float32Array(dst.length * 3);
  const uv = new Float32Array(src.length * 2);
  dst.forEach(([x, y], i) => { pos[i * 3] = x; pos[i * 3 + 1] = -y; });
  src.forEach(([x, y], i) => { uv[i * 2] = x / w; uv[i * 2 + 1] = 1 - y / h; });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(tris.flat());
  const tex = new THREE.CanvasTexture(img);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  scene.add(new THREE.Mesh(geo, mat));
  renderer.render(scene, cam);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')!.drawImage(renderer.domElement, 0, 0);
  geo.dispose(); mat.dispose(); tex.dispose();
  return out;
}

// ---------------------------------------------------------------- comic overlays

const avg = (lm: Pt[], idx: number[]): Pt => {
  let x = 0, y = 0;
  for (const i of idx) { x += lm[i][0]; y += lm[i][1]; }
  return [x / idx.length, y / idx.length];
};

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  g.save();
  g.translate(x, y);
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.28;
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
  g.restore();
}

function drop(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  g.save();
  g.fillStyle = color;
  g.strokeStyle = '#1e3a8a';
  g.lineWidth = Math.max(1.5, r * 0.18);
  g.beginPath();
  g.moveTo(x, y - r * 1.6);
  g.quadraticCurveTo(x + r, y - r * 0.2, x + r, y + r * 0.2);
  g.arc(x, y + r * 0.2, r, 0, Math.PI);
  g.quadraticCurveTo(x - r, y - r * 0.2, x, y - r * 1.6);
  g.fill();
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.beginPath();
  g.ellipse(x - r * 0.35, y, r * 0.2, r * 0.35, -0.4, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function blush(g: CanvasRenderingContext2D, lm: Pt[], u: number, alpha: number): void {
  for (const i of [205, 425]) {
    const [x, y] = lm[i];
    const grd = g.createRadialGradient(x, y, 0, x, y, u * 0.28);
    grd.addColorStop(0, `rgba(255, 90, 120, ${alpha})`);
    grd.addColorStop(1, 'rgba(255, 90, 120, 0)');
    g.fillStyle = grd;
    g.beginPath();
    g.ellipse(x, y, u * 0.3, u * 0.2, 0, 0, Math.PI * 2);
    g.fill();
  }
}

/**
 * The open mouth a closed-mouth photo doesn't have, drawn inside the warped inner-lip ring:
 * a grin shows mostly teeth, a shout a dark inside with a strip of teeth and a tongue.
 */
function mouth(g: CanvasRenderingContext2D, lm: Pt[], u: number, kind: 'grin' | 'shout'): void {
  const ring = FACE.innerLipRing.map((i) => lm[i]);
  const [mx, my] = avg(lm, FACE.innerLipRing);
  const upper = avg(lm, FACE.upperLipInner);
  const lower = avg(lm, FACE.lowerLipInner);
  const gap = lower[1] - upper[1];
  if (gap < u * 0.02) return;
  g.save();
  g.beginPath();
  ring.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  const grd = g.createRadialGradient(mx, my, 0, mx, my, u * 0.45);
  grd.addColorStop(0, '#2a0707');
  grd.addColorStop(1, '#6b1515');
  g.fillStyle = grd;
  g.fill();
  g.clip();
  // upper teeth, slightly shaded at the bottom edge
  const teethH = kind === 'grin' ? gap * 0.62 : Math.min(gap * 0.3, u * 0.09);
  const tg = g.createLinearGradient(0, upper[1], 0, upper[1] + teethH);
  tg.addColorStop(0, '#ffffff');
  tg.addColorStop(1, '#dfe3e8');
  g.fillStyle = tg;
  g.fillRect(mx - u, upper[1] - u * 0.05, u * 2, teethH + u * 0.05);
  g.strokeStyle = 'rgba(120,120,130,0.35)';
  g.lineWidth = Math.max(0.6, u * 0.008);
  for (let k = -3; k <= 3; k++) {
    const x = mx + k * u * 0.075;
    g.beginPath();
    g.moveTo(x, upper[1]);
    g.lineTo(x, upper[1] + teethH);
    g.stroke();
  }
  if (kind === 'shout') {
    g.fillStyle = '#d9667a';
    g.beginPath();
    g.ellipse(mx, lower[1] + u * 0.02, u * 0.2, gap * 0.28, 0, 0, Math.PI * 2);
    g.fill();
  } else {
    // a hint of lower teeth
    g.fillStyle = '#eef0f3';
    g.fillRect(mx - u, lower[1] - gap * 0.18, u * 2, gap * 0.25);
  }
  g.restore();
}

function overlay(g: CanvasRenderingContext2D, expr: ExpressionName, lm: Pt[]): void {
  const u = eyeDistance(lm);
  const top = avg(lm, [10, 338, 109]);
  if (expr === 'perfect') {
    blush(g, lm, u, 0.45);
    mouth(g, lm, u, 'grin');
    // sparkles beside the eyes (not on them)
    for (const [i, s] of [[33, -1], [263, 1]] as const) star(g, lm[i][0] + s * u * 0.22, lm[i][1] - u * 0.22, u * 0.1, '#fde68a');
    star(g, top[0] - u * 0.9, top[1] + u * 0.1, u * 0.18, '#fbbf24');
    star(g, top[0] + u * 0.95, top[1] - u * 0.05, u * 0.14, '#fbbf24');
  } else if (expr === 'good') {
    blush(g, lm, u, 0.25);
    star(g, top[0] + u * 0.85, top[1] + u * 0.1, u * 0.12, '#34d399');
  } else if (expr === 'miss') {
    // tear under the subject's right eye, sweat at the left temple, a little gloom cloud
    const [tx, ty] = lm[145];
    drop(g, tx, ty + u * 0.28, u * 0.09, 'rgba(96,165,250,0.9)');
    const [sx, sy] = lm[251];
    drop(g, sx + u * 0.05, sy, u * 0.11, 'rgba(186,230,253,0.95)');
    g.save();
    g.fillStyle = 'rgba(100,116,139,0.85)';
    const cyCloud = Math.max(u * 0.34, top[1] - u * 0.45); // stays inside the picture
    for (const [dx, r] of [[-0.35, 0.22], [0, 0.3], [0.35, 0.22]] as const) {
      g.beginPath();
      g.arc(top[0] + dx * u, cyCloud, r * u, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  } else if (expr === 'critical') {
    mouth(g, lm, u, 'shout');
    // shock lines
    g.save();
    g.strokeStyle = '#e11d2e';
    g.lineWidth = Math.max(2, u * 0.05);
    g.lineCap = 'round';
    for (const [a, dx] of [[-0.6, -1], [0, 0], [0.6, 1]] as const) {
      const bx = top[0] + dx * u * 0.55, by = top[1] - u * 0.35;
      g.beginPath();
      g.moveTo(bx, by);
      g.lineTo(bx + Math.sin(a) * u * 0.35, by - Math.cos(a) * u * 0.35);
      g.stroke();
    }
    g.restore();
  }
}

// ---------------------------------------------------------------- results

function renderAll(): void {
  if (!crop || !cropLm) return;
  const strength = Number($<HTMLInputElement>('strength').value);
  $('strengthOut').textContent = strength.toFixed(2);
  const withOverlays = $<HTMLInputElement>('overlays').checked;
  const grid = $('grid');
  grid.textContent = '';
  for (const L of LABELS) {
    const to = warpLandmarks(cropLm, L.key, strength);
    const warped = warpImage(crop, cropLm, to);
    const g = warped.getContext('2d')!;
    if (withOverlays) overlay(g, L.key, to);
    // show it like a mirror, the way the player saw themselves
    const view = document.createElement('canvas');
    view.width = warped.width;
    view.height = warped.height;
    const vg = view.getContext('2d')!;
    vg.translate(view.width, 0);
    vg.scale(-1, 1);
    vg.drawImage(warped, 0, 0);
    const cell = document.createElement('div');
    cell.className = 'cell';
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.style.color = L.color;
    tag.textContent = L.tag;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = L.sub;
    cell.append(view, tag, sub);
    grid.append(cell);
  }
}

function clearAll(): void {
  stopCamera();
  crop = null;
  cropLm = null;
  $('grid').textContent = '';
  $('results').hidden = true;
  shot.width = shot.height = 1;
  shot.hidden = true;
  video.hidden = false;
  renderer?.dispose();
  renderer?.forceContextLoss();
  renderer = null;
  $<HTMLButtonElement>('clearBtn').disabled = true;
  $<HTMLButtonElement>('snapBtn').disabled = true;
  $('camBtn').textContent = '📷 카메라 켜기';
  status('지웠어요. 사진은 남아 있지 않아요');
}

$('camBtn').addEventListener('click', () => {
  $<HTMLButtonElement>('camBtn').disabled = true;
  startCamera().catch((e) => {
    stopCamera();
    status(cameraHint(e));
    $<HTMLButtonElement>('camBtn').disabled = false;
    void fillCameraList();
  });
});
$('snapBtn').addEventListener('click', () => void countdownAndShoot());
void fillCameraList();
$('clearBtn').addEventListener('click', clearAll);
$('strength').addEventListener('input', renderAll);
$('overlays').addEventListener('change', renderAll);
window.addEventListener('pagehide', clearAll);

// dev-only hook for automated checks with a synthetic face (never in production builds, so the
// shipped page accepts no images other than the camera)
if (import.meta.env.DEV) {
  (window as unknown as { __faceLabTest: (url: string) => Promise<void> }).__faceLabTest = async (url: string) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    shot.width = img.naturalWidth;
    shot.height = img.naturalHeight;
    shot.getContext('2d')!.drawImage(img, 0, 0);
    video.hidden = true;
    shot.hidden = false;
    await processShot(shot);
  };
}
