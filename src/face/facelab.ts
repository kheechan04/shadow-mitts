// Reaction-face lab (prototype): one webcam photo → five expression images, all in this browser.
//
// Privacy by construction (the notice on the page must stay true to this):
// - the photo lives only in canvases/variables of this page; nothing is uploaded or stored
//   (no fetch/XHR with image data, no localStorage/IndexedDB); "지우기" drops it all
// - the camera stops right after the shot; there is no file upload (own face only)
// - FaceLandmarker is used for landmark positions only: no blendshapes/emotion analysis and no
//   identification (its model card: "do not provide facial recognition or identification")

import { disposeRenderer, prepareFace, renderExpression, wipe, type ExpressionName, type PreparedFace } from './reactions';

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
/** the captured face crop and its landmarks — the only copy of the photo */
let face: PreparedFace | null = null;

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

async function processShot(src: HTMLCanvasElement): Promise<void> {
  status('얼굴 위치 찾는 중… (처음엔 모델을 받느라 조금 걸려요)');
  const prepared = await prepareFace(src);
  wipe(src); // the full frame is no longer needed
  if (!prepared) {
    status('얼굴을 못 찾았어요. 밝은 곳에서 정면으로 다시 찍어 주세요');
    $<HTMLButtonElement>('camBtn').disabled = false;
    return;
  }
  face = prepared;
  status('완성! 강도를 바꿔 보세요');
  $('results').hidden = false;
  $<HTMLButtonElement>('clearBtn').disabled = false;
  $<HTMLButtonElement>('camBtn').disabled = false;
  $('camBtn').textContent = '📷 다시 찍기';
  renderAll();
}

// ---------------------------------------------------------------- results

function renderAll(): void {
  if (!face) return;
  const strength = Number($<HTMLInputElement>('strength').value);
  $('strengthOut').textContent = strength.toFixed(2);
  const withOverlays = $<HTMLInputElement>('overlays').checked;
  const grid = $('grid');
  grid.textContent = '';
  for (const L of LABELS) {
    const view = renderExpression(face, L.key, strength, withOverlays);
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
  if (face) wipe(face.crop);
  face = null;
  $('grid').textContent = '';
  $('results').hidden = true;
  shot.width = shot.height = 1;
  shot.hidden = true;
  video.hidden = false;
  disposeRenderer();
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
