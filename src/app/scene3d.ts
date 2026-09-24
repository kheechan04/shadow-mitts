// First-person 3D mitt scene (three.js). Cosmetic only: judgement lives in core/game.ts and never
// looks at where things are drawn.
//
// Units are meters. The player's eyes are at (0, 1.6, 0) looking down -Z; screen right = +X =
// the player's right (first-person, i.e. mirror-like).

import * as THREE from 'three';
import type { Judgement, Mitt } from '../core/game';
import type { Side, Stance } from '../core/pose';

const HAND_COLOR: Record<Side, number> = { left: 0x22d3ee, right: 0xfb923c };
const HIT_Z = -1.7;

/**
 * Where a pad holder presents each punch, for a SOUTHPAW (from the user's play-test descriptions;
 * 4 and 5 are left-right counterparts of 3 and 6). yaw > 0 turns the mitt face toward screen
 * right, pitch > 0 tilts it to face down. Orthodox mirrors x and yaw.
 * Types are pushed far apart so they read at a glance: straights high and near the center,
 * hooks wide and side-on, uppercuts low and face-down. Jab vs cross (play-test: "자꾸 헷갈려"):
 * the jab mitt faces the player square-on, a bit toward the lead side; the cross comes down the
 * middle, turned the way the body rotates into it.
 */
const PRESENT: Record<number, { x: number; y: number; yaw: number; pitch: number }> = {
  1: { x: 0.3, y: 1.6, yaw: 0, pitch: 0 },
  2: { x: 0, y: 1.6, yaw: -22, pitch: 0 },
  3: { x: -0.7, y: 1.52, yaw: 80, pitch: 0 },
  4: { x: 0.7, y: 1.52, yaw: -80, pitch: 0 },
  5: { x: -0.24, y: 1.2, yaw: 25, pitch: 30 },
  6: { x: 0.24, y: 1.2, yaw: -25, pitch: 30 },
};

export function presentation(n: number, stance: Stance) {
  const p = PRESENT[n];
  return stance === 'southpaw' ? p : { ...p, x: -p.x, yaw: -p.yaw };
}

const deg = THREE.MathUtils.degToRad;

// ---------------------------------------------------------------- procedural textures

/** Fine grain + creases so the leather catches light like leather, not plastic. */
function leatherBump(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 60;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.globalAlpha = 0.15;
  for (let i = 0; i < 40; i++) {
    g.strokeStyle = Math.random() < 0.5 ? '#000' : '#fff';
    g.beginPath();
    g.moveTo(Math.random() * 256, Math.random() * 256);
    g.quadraticCurveTo(Math.random() * 256, Math.random() * 256, Math.random() * 256, Math.random() * 256);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  return t;
}

/** Mitt face print: colored target rings, white stitching ring, and the punch number. */
function faceTexture(n: number, hand: Side): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const hc = `#${HAND_COLOR[hand].toString(16).padStart(6, '0')}`;
  g.clearRect(0, 0, 512, 512);
  // outer hand-colored band
  g.lineWidth = 34;
  g.strokeStyle = hc;
  g.beginPath();
  g.arc(256, 256, 214, 0, Math.PI * 2);
  g.stroke();
  // stitched ring
  g.setLineDash([14, 10]);
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.beginPath();
  g.arc(256, 256, 188, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  // target
  const grd = g.createRadialGradient(236, 230, 10, 256, 256, 120);
  grd.addColorStop(0, '#ff4d4d');
  grd.addColorStop(1, '#a50f14');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(256, 256, 118, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 12;
  g.strokeStyle = '#f5f5f4';
  g.beginPath();
  g.arc(256, 256, 124, 0, Math.PI * 2);
  g.stroke();
  // number
  g.font = '900 170px "Black Han Sans", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 12;
  g.fillText(String(n), 256, 266);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,220,150,0.8)');
  grd.addColorStop(1, 'rgba(255,120,40,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- models

const MITT_R = 0.13;
/** play-test: "미트도 좀 더 키워도 될 것 같아" */
const MITT_SCALE = 1.25;

/** Focus mitt: domed leather pad, piped rim, printed face, hand pocket on the back. Face = +Z. */
function buildMitt(n: number, hand: Side, bump: THREE.Texture): THREE.Group {
  const g = new THREE.Group();
  const R = MITT_R;
  const profile = [
    [0.0001, 0.085], [0.05, 0.083], [0.09, 0.075], [0.115, 0.06], [R, 0.04], [R + 0.003, 0.015],
    [R, -0.005], [0.115, -0.02], [0.08, -0.028], [0.0001, -0.03],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const leather = new THREE.MeshPhysicalMaterial({
    color: 0x151515, roughness: 0.42, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.35,
    bumpMap: bump, bumpScale: 0.6, sheen: 0.4, sheenColor: new THREE.Color(0x553322),
  });
  const pad = new THREE.Mesh(new THREE.LatheGeometry(profile, 48), leather);
  pad.rotation.x = Math.PI / 2; // lathe axis +Y → face +Z
  g.add(pad);

  const face = new THREE.Mesh(
    new THREE.CircleGeometry(R * 0.93, 48),
    new THREE.MeshStandardMaterial({ map: faceTexture(n, hand), transparent: true, roughness: 0.5 }),
  );
  face.position.z = 0.0865;
  g.add(face);

  const piping = new THREE.Mesh(
    new THREE.TorusGeometry(R + 0.002, 0.008, 12, 64),
    new THREE.MeshStandardMaterial({ color: 0xe7e5e4, roughness: 0.6 }),
  );
  piping.position.z = 0.03;
  g.add(piping);

  // back: hand pocket + strap, seen when the mitt is turned side-on (hooks)
  const pocket = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.045, 0.1, 6, 16),
    new THREE.MeshPhysicalMaterial({ color: 0x1f1f1f, roughness: 0.5, clearcoat: 0.3, bumpMap: bump, bumpScale: 0.4 }),
  );
  pocket.rotation.z = Math.PI / 2;
  pocket.position.z = -0.055;
  g.add(pocket);
  const strap = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.05, 0.02),
    new THREE.MeshStandardMaterial({ color: HAND_COLOR[hand], roughness: 0.7 }),
  );
  strap.position.z = -0.1;
  g.add(strap);
  return g;
}

/** Boxing glove, knuckles toward -Z. */
function buildGlove(hand: Side, bump: THREE.Texture): THREE.Group {
  const g = new THREE.Group();
  const leather = new THREE.MeshPhysicalMaterial({
    color: 0xb3121b, roughness: 0.32, clearcoat: 0.9, clearcoatRoughness: 0.18, bumpMap: bump, bumpScale: 0.25,
  });
  const fist = new THREE.Mesh(new THREE.SphereGeometry(0.085, 32, 24), leather);
  fist.scale.set(1, 0.9, 1.3);
  g.add(fist);
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.026, 0.07, 6, 12), leather);
  thumb.position.set(hand === 'left' ? 0.07 : -0.07, 0.02, -0.02);
  thumb.rotation.set(deg(70), 0, hand === 'left' ? deg(-20) : deg(20));
  g.add(thumb);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.074, 0.13, 32, 1, true), leather);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.z = 0.13;
  g.add(cuff);
  // dark opening at the wrist end, and a white trim stripe
  const opening = new THREE.Mesh(new THREE.CircleGeometry(0.072, 32), new THREE.MeshStandardMaterial({ color: 0x4a0b10, roughness: 0.8 }));
  opening.position.z = 0.195;
  g.add(opening);
  const trim = new THREE.Mesh(
    new THREE.TorusGeometry(0.071, 0.009, 10, 40),
    new THREE.MeshStandardMaterial({ color: 0xf5f5f4, roughness: 0.5 }),
  );
  trim.position.z = 0.1;
  g.add(trim);
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(0.073, 0.012, 10, 40),
    new THREE.MeshStandardMaterial({ color: HAND_COLOR[hand], roughness: 0.5, emissive: HAND_COLOR[hand], emissiveIntensity: 0.25 }),
  );
  band.position.z = 0.17;
  g.add(band);
  g.scale.setScalar(0.85);
  return g;
}

// ---------------------------------------------------------------- gym environment

/** Ring canvas print: pale blue-grey canvas with a center logo. */
function matTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d')!;
  g.fillStyle = '#dfe7ef';
  g.fillRect(0, 0, 1024, 1024);
  const img = g.getImageData(0, 0, 1024, 1024);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  // center logo
  g.fillStyle = 'rgba(225,29,46,0.9)';
  g.beginPath();
  g.arc(512, 512, 230, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 18;
  g.strokeStyle = '#ffffff';
  g.beginPath();
  g.arc(512, 512, 200, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '400 92px "Black Han Sans", system-ui, sans-serif';
  g.fillText('SHADOW', 512, 470);
  g.font = '400 120px "Black Han Sans", system-ui, sans-serif';
  g.fillText('MITTS', 512, 578);
  // border band
  g.lineWidth = 40;
  g.strokeStyle = '#1e3a8a';
  g.strokeRect(20, 20, 984, 984);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function woodTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 16; i++) {
    const tone = 180 + Math.floor(Math.random() * 30);
    g.fillStyle = `rgb(${tone},${tone - 45},${tone - 95})`;
    g.fillRect(0, i * 32, 512, 32);
    g.fillStyle = 'rgba(80,50,20,0.25)';
    g.fillRect(0, i * 32, 512, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 10);
  return t;
}

/** Ring the player stands in (mat top at y = 0) + a sunny gym around it. */
function buildGym(scene: THREE.Scene, backdropUrl: string): void {
  const half = 3.2;
  const cz = -2.0; // ring center; the player stands near the back ropes
  const mat = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 2, half * 2),
    new THREE.MeshStandardMaterial({ map: matTexture(), roughness: 0.95 }),
  );
  mat.rotation.x = -Math.PI / 2;
  mat.position.set(0, 0, cz);
  mat.receiveShadow = true;
  scene.add(mat);
  const apron = new THREE.Mesh(
    new THREE.BoxGeometry(half * 2 + 0.6, 1, half * 2 + 0.6),
    new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.7 }),
  );
  apron.position.set(0, -0.505, cz);
  scene.add(apron);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(30, 48),
    new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.6 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1;
  floor.receiveShadow = true;
  scene.add(floor);

  // posts, corner pads, ropes
  const postMat = new THREE.MeshStandardMaterial({ color: 0xd4d4d8, metalness: 0.8, roughness: 0.25 });
  const corners: [number, number, number][] = [
    [-half, cz - half, 0xe11d2e], [half, cz - half, 0x2563eb], [-half, cz + half, 0xffffff], [half, cz + half, 0xffffff],
  ];
  for (const [x, z, pad] of corners) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.75, 16), postMat);
    post.position.set(x, 0.875, z);
    post.castShadow = true;
    scene.add(post);
    const cushion = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 1.25, 0.28),
      new THREE.MeshStandardMaterial({ color: pad, roughness: 0.55 }),
    );
    cushion.position.set(x - Math.sign(x) * 0.12, 0.95, z - Math.sign(z - cz) * 0.12);
    cushion.castShadow = true;
    scene.add(cushion);
  }
  const ropeColors = [0xe11d2e, 0xffffff, 0x2563eb, 0xe11d2e];
  const ropeHeights = [0.45, 0.8, 1.15, 1.5];
  const sides: [THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(-half, 0, cz - half), new THREE.Vector3(half, 0, cz - half)],
    [new THREE.Vector3(-half, 0, cz - half), new THREE.Vector3(-half, 0, cz + half)],
    [new THREE.Vector3(half, 0, cz - half), new THREE.Vector3(half, 0, cz + half)],
  ];
  ropeHeights.forEach((h, i) => {
    const m = new THREE.MeshStandardMaterial({ color: ropeColors[i], roughness: 0.45 });
    for (const [a, b] of sides) {
      const len = a.distanceTo(b);
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, len, 12), m);
      rope.position.copy(a).add(b).multiplyScalar(0.5).setY(h);
      rope.lookAt(b.clone().setY(h));
      rope.rotateX(Math.PI / 2);
      rope.castShadow = true;
      scene.add(rope);
    }
  });

  // curved photo wall around the far side of the ring
  const radius = 13;
  const arc = deg(120);
  const height = radius * arc * (9 / 16);
  const wallMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: 0xffffff, fog: false });
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 64, 1, true, Math.PI - arc / 2, arc),
    wallMat,
  );
  // photo's eye-level line (a bit below its middle) at the player's eye height
  wall.position.set(0, 1.6 + height * 0.05, cz);
  new THREE.TextureLoader().load(backdropUrl, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.x = -1; // seen from inside, the cylinder mirrors the image; flip it back
    wallMat.map = t;
    wallMat.needsUpdate = true;
  });
  scene.add(wall);
}

// ---------------------------------------------------------------- scene

interface MittView {
  mitt: Mitt;
  group: THREE.Group;
  ghost: THREE.Group;
  ring: THREE.Mesh;
  target: THREE.Vector3;
  start: THREE.Vector3;
  control: THREE.Vector3;
  judgedAt: number | null;
  /** when it came into view (grows in from here) */
  bornAt: number;
  grade: Judgement['grade'] | null;
  /** materials that light up on impact */
  glowMats: THREE.MeshStandardMaterial[];
}

/**
 * How hard each grade hits (M3 "타격감"; play-test said the first pass "wasn't 시원"):
 * shake, sparks, flash, shockwave and a zoom kick. (A hit-stop freeze was tried and removed: it
 * stopped every other mitt mid-flight and made them jump — "끊기는 느낌".)
 */
const IMPACT: Record<Judgement['grade'], { shake: number; sparks: number; flash: number; wave: number; color: number; kick: number }> = {
  // kick (zoom) kept small: a big one jolted every other mitt 20–40 px on screen
  perfect: { shake: 0.065, sparks: 70, flash: 2.4, wave: 1.4, color: 0xffc940, kick: 1.5 },
  good: { shake: 0.035, sparks: 38, flash: 1.5, wave: 1.0, color: 0x5eead4, kick: 0.8 },
  partial: { shake: 0.014, sparks: 16, flash: 0.8, wave: 0.6, color: 0x93c5fd, kick: 0 },
  miss: { shake: 0, sparks: 0, flash: 0, wave: 0, color: 0xffffff, kick: 0 },
};

interface Spark { sprite: THREE.Sprite; vel: THREE.Vector3; at: number; life: number }

/**
 * Play-test "잔상" (fast combos: which mitt is real?). Moving, fading or see-through copies all
 * read as afterimages, so: a judged mitt pops and is gone in this time, right where it was hit.
 */
const JUDGED_POP_MS = 160;
const SPAWN_MS = 200;
interface Wave { mesh: THREE.Mesh; at: number; size: number }

export interface HandInput {
  /** wrist relative to shoulder midpoint, image x in T (+ = un-mirrored image right) */
  imgX: number;
  up: number;
  /** 2D wrist speed, T/s — drives the glove forward immediately, before a punch is confirmed */
  speed: number;
}

export class GameScene {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.05, 50);
  private bump = leatherBump();
  private glow = glowTexture();
  private views = new Map<number, MittView>();
  private gloves: Record<Side, THREE.Group>;
  private gloveRest: Record<Side, THREE.Vector3> = {
    left: new THREE.Vector3(-0.26, 1.2, -0.74),
    right: new THREE.Vector3(0.26, 1.2, -0.74),
  };
  private thrust: Partial<Record<Side, { at: number; to: THREE.Vector3 }>> = {};
  private flashes: { sprite: THREE.Sprite; at: number }[] = [];
  private sparks: Spark[] = [];
  private waves: Wave[] = [];
  private shake = { amp: 0, at: 0 };
  private fovKick = { amount: 0, at: 0 };
  private lastRender = 0;
  /** accessibility: screen shake can be turned off in the menu */
  shakeEnabled = true;

  constructor(canvas: HTMLCanvasElement, backdropUrl: string) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    // kept light: the pose model shares the GPU, and its frame rate matters more than crisp edges
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = new THREE.Color(0xf1ece4);
    this.scene.fog = new THREE.Fog(0xf1ece4, 16, 34);
    this.camera.position.set(0, 1.6, 0);
    this.camera.lookAt(0, 1.45, -3);

    // bright daylight gym (play-test: "밝은 톤이었으면")
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xcdb89a, 1.5));
    const sun = new THREE.DirectionalLight(0xfff0d6, 2.4);
    sun.position.set(-4, 7, 2);
    sun.target.position.set(0, 0, -2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -5;
    sun.shadow.camera.right = 5;
    sun.shadow.camera.top = 5;
    sun.shadow.camera.bottom = -5;
    sun.shadow.bias = -0.0005;
    sun.shadow.radius = 4;
    this.scene.add(sun, sun.target);
    // soft light from the player's position so mitt faces (incl. face-down uppercut mitts) read
    const front = new THREE.PointLight(0xfff6e8, 2.5, 6, 1.5);
    front.position.set(0, 1.45, 0.3);
    this.scene.add(front);

    buildGym(this.scene, backdropUrl);

    this.gloves = { left: buildGlove('left', this.bump), right: buildGlove('right', this.bump) };
    for (const s of ['left', 'right'] as const) {
      this.gloves[s].position.copy(this.gloveRest[s]);
      this.scene.add(this.gloves[s]);
    }
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Screen position (CSS pixels of the canvas) of a world point. */
  project(p: THREE.Vector3): { x: number; y: number } {
    const v = p.clone().project(this.camera);
    const el = this.renderer.domElement;
    return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight };
  }

  targetOf(n: number, stance: Stance): THREE.Vector3 {
    const p = presentation(n, stance);
    return new THREE.Vector3(p.x, p.y, HIT_Z);
  }

  mittScreenPos(id: number): { x: number; y: number } | null {
    const v = this.views.get(id);
    return v ? this.project(v.target) : null;
  }

  /** On-screen circle around a mitt at its hit position (for the 2D hold gauge). */
  mittScreenCircle(id: number): { x: number; y: number; r: number } | null {
    const v = this.views.get(id);
    if (!v) return null;
    const c = this.project(v.target);
    const e = this.project(v.target.clone().add(new THREE.Vector3(MITT_R * MITT_SCALE, 0, 0)));
    return { ...c, r: Math.hypot(e.x - c.x, e.y - c.y) };
  }

  clear(): void {
    for (const v of this.views.values()) this.scene.remove(v.group, v.ghost);
    this.views.clear();
    for (const f of this.flashes) this.scene.remove(f.sprite);
    this.flashes = [];
    for (const s of this.sparks) this.scene.remove(s.sprite);
    this.sparks = [];
    for (const w of this.waves) this.scene.remove(w.mesh);
    this.waves = [];
    this.shake = { amp: 0, at: 0 };
  }

  private makeView(m: Mitt, stance: Stance): MittView {
    const p = presentation(m.n, stance);
    const target = new THREE.Vector3(p.x, p.y, HIT_Z);
    const sx = Math.sign(p.x) || 1;
    // Flight paths differ by type so the punch reads before the number does.
    let start: THREE.Vector3;
    let control: THREE.Vector3;
    if (m.kind === 'hook') {
      start = new THREE.Vector3(p.x + sx * 3.2, p.y + 0.2, -7);
      control = new THREE.Vector3(p.x + sx * 2.0, p.y, HIT_Z - 0.6);
    } else if (m.kind === 'uppercut') {
      start = new THREE.Vector3(p.x * 0.4, -0.3, -7);
      control = new THREE.Vector3(p.x, 0.6, HIT_Z - 0.9);
    } else {
      start = new THREE.Vector3(p.x * 0.3, p.y + 0.15, -10);
      control = new THREE.Vector3(p.x * 0.8, p.y + 0.05, HIT_Z - 3);
    }
    const group = buildMitt(m.n, m.side, this.bump);
    group.scale.setScalar(MITT_SCALE);
    group.traverse((o) => { o.castShadow = true; });
    group.rotation.set(deg(p.pitch), deg(p.yaw), 0, 'YXZ');
    this.scene.add(group);

    // Ghost: where and how the mitt will be when it's time to hit.
    const ghost = new THREE.Group();
    ghost.position.copy(target);
    ghost.rotation.copy(group.rotation);
    ghost.scale.setScalar(MITT_SCALE);
    const ghostMat = new THREE.MeshBasicMaterial({ color: HAND_COLOR[m.side], transparent: true, opacity: 0.08, depthWrite: false });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(MITT_R, 48), ghostMat);
    disc.position.z = 0.09;
    ghost.add(disc);
    const edge = new THREE.Mesh(
      new THREE.TorusGeometry(MITT_R, 0.004, 8, 64),
      new THREE.MeshBasicMaterial({ color: HAND_COLOR[m.side], transparent: true, opacity: 0.7, depthWrite: false }),
    );
    edge.position.z = 0.09;
    ghost.add(edge);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(MITT_R, 0.005, 8, 64),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    ring.position.z = 0.09;
    ghost.add(ring);
    this.scene.add(ghost);
    const glowMats: THREE.MeshStandardMaterial[] = [];
    group.traverse((o) => {
      const mat = (o as THREE.Mesh).material;
      if (mat instanceof THREE.MeshStandardMaterial) glowMats.push(mat);
    });
    return { mitt: m, group, ghost, ring, target, start, control, judgedAt: null, grade: null, glowMats, bornAt: 0 };
  }

  /** A punch was detected: throw that glove (toward its mitt when it hit one). */
  punch(side: Side, now: number, mittId: number | null): void {
    const v = mittId !== null ? this.views.get(mittId) : undefined;
    const to = v ? v.target.clone() : this.gloves[side].position.clone().add(new THREE.Vector3(0, 0.05, -0.55));
    this.thrust[side] = { at: now, to };
  }

  judged(j: Judgement, now: number): void {
    const v = this.views.get(j.mittId);
    if (!v) return;
    v.judgedAt = now;
    v.grade = j.grade;
    if (j.grade === 'miss') return;
    const fx = IMPACT[j.grade];
    const normal = new THREE.Vector3(0, 0, 1).applyEuler(v.group.rotation);
    const hitPoint = v.target.clone().addScaledVector(normal, 0.12);

    // flash of light
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: fx.color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    s.position.copy(hitPoint);
    s.scale.setScalar(0.25 * fx.flash);
    this.scene.add(s);
    this.flashes.push({ sprite: s, at: now });

    // sparks burst out of the mitt face, mostly toward the player and outward
    for (let i = 0; i < fx.sparks; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: i % 3 ? fx.color : 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      sp.position.copy(hitPoint);
      sp.scale.setScalar(0.025 + Math.random() * 0.03);
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(0.7).add(normal);
      this.scene.add(sp);
      this.sparks.push({ sprite: sp, vel: dir.normalize().multiplyScalar(2 + Math.random() * 3.5 * fx.wave), at: now, life: 400 + Math.random() * 450 });
    }

    // shockwave ring on the mitt face plane
    const w = new THREE.Mesh(
      new THREE.TorusGeometry(MITT_R * MITT_SCALE, 0.012, 8, 48),
      new THREE.MeshBasicMaterial({ color: fx.color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    w.position.copy(hitPoint);
    w.rotation.copy(v.group.rotation);
    this.scene.add(w);
    this.waves.push({ mesh: w, at: now, size: fx.wave });

    // the mitt lights up
    for (const m of v.glowMats) {
      m.emissive = new THREE.Color(fx.color);
      m.emissiveIntensity = fx.flash;
    }

    if (this.shakeEnabled && fx.shake > 0) this.shake = { amp: Math.max(this.shake.amp * 0.5, fx.shake), at: now };
    if (fx.kick) this.fovKick = { amount: fx.kick, at: now };
  }

  /**
   * approachMs: flight time. Each mitt stays presented until its holdUntil (pad work).
   */
  render(
    mitts: readonly Mitt[], stance: Stance, approachMs: number, now: number,
    hands: Record<Side, HandInput | null>,
  ): void {
    // Every mitt moves only by the clock, at an even pace along its whole path, like notes in a
    // rhythm game. (Tried: parking later combo mitts and sending them in on their turn — the stop
    // and sudden dash read as "끊김" and "갑자기 나타남".) The timing ring and target marker go to
    // the one mitt to hit now: the earliest that is still unjudged and inside its window.
    const current = mitts.find((m) => !m.judgement && this.views.get(m.id)?.judgedAt == null && now < m.holdUntil - JUDGED_POP_MS);
    // create / update / retire mitts
    for (const m of mitts) {
      const since = now - (m.tHit - approachMs);
      let v = this.views.get(m.id);
      // an unjudged mitt is gone once its window ends (it has shrunk away by then); keeping the
      // hidden view until the late miss verdict blocked the next same-number mitt, which then
      // popped up in the same spot — "놓친 미트가 다시 뜬다"
      const done = v?.judgedAt != null ? now - v.judgedAt > JUDGED_POP_MS : now >= m.holdUntil;
      if (since < 0 || done) {
        if (v && done) {
          this.scene.remove(v.group, v.ghost);
          this.views.delete(m.id);
        }
        continue;
      }
      if (!v) {
        // Never (re)create a view for a mitt that is already judged or past its window: after a
        // judged view was retired, this used to rebuild it as a fresh unjudged mitt for a few
        // frames — the long-standing "잔상" / "갑자기 나타남" (found with a frame-by-frame trace).
        if (m.judgement || now >= m.holdUntil) continue;
        // One mitt per spot: while an earlier mitt with the same number is still on screen, this one
        // stays unseen (still moving on the clock) and grows in once that one is gone — a copy
        // trailing on the same path read as "같은 자리에 또 나옴" / an afterimage.
        let blocked = false;
        for (const o of this.views.values()) if (o.mitt.n === m.n && o.mitt.tHit < m.tHit) blocked = true;
        if (blocked) continue;
        v = this.makeView(m, stance);
        v.bornAt = now;
        this.views.set(m.id, v);
      }
      const k = since / approachMs;
      if (v.judgedAt === null) {
        const held = now - m.tHit;
        const u = Math.min(1, k);
        // grows in over its first 200 ms instead of popping into existence (hooks spawn on screen)
        if (now < m.holdUntil - JUDGED_POP_MS) v.group.scale.setScalar(MITT_SCALE * Math.min(1, (now - v.bornAt) / SPAWN_MS));
        const isCurrent = m === current;
        if (u < 1) {
          // quadratic Bezier start → control → target
          const a = v.start.clone().multiplyScalar((1 - u) * (1 - u));
          const b = v.control.clone().multiplyScalar(2 * (1 - u) * u);
          const c = v.target.clone().multiplyScalar(u * u);
          v.group.position.copy(a.add(b).add(c));
        } else if (now <= m.holdUntil - JUDGED_POP_MS) {
          // presented: the pad holder keeps it there, with a little life in the hands
          const w = Math.sin(held / 90) * 0.006;
          v.group.position.copy(v.target).add(new THREE.Vector3(w, w * 0.5, 0));
        } else {
          // time's up (or the next mitt is arriving): shrinks away in place, then stays hidden —
          // the game only calls it a miss ~0.3–0.5 s later (a late-detected punch may still come)
          const gone = Math.min(1, (now - (m.holdUntil - JUDGED_POP_MS)) / JUDGED_POP_MS);
          v.group.position.copy(v.target);
          v.group.scale.setScalar(MITT_SCALE * Math.max(0.01, 1 - gone));
          v.group.visible = gone < 1;
        }
        // the timing ring appears halfway and closes onto the mitt outline exactly at the hit
        const r = Math.min(1, Math.max(0, (1 - k) / 0.5));
        v.ring.visible = isCurrent && k > 0.45;
        v.ring.scale.setScalar(1 + 1.3 * r);
        (v.ring.material as THREE.MeshBasicMaterial).color.set(k >= 0.97 ? 0xfbbf24 : 0xffffff);
        v.ghost.visible = isCurrent && k > 0.5 && k < 1.05;
      } else {
        // pops where it was hit (a quick squash-and-swell), then it's simply gone; a miss just shrinks
        const age = Math.min(1, (now - v.judgedAt) / JUDGED_POP_MS);
        v.ghost.visible = false;
        v.ring.visible = false;
        // A miss judged after the mitt already left (time ran out) must not pop back into view:
        // that "reappear and shrink again" over the next mitt was the play-test "miss 후 꼬임".
        if (v.grade === 'miss' && v.judgedAt! >= m.holdUntil - JUDGED_POP_MS) v.group.visible = false;
        else if (v.grade === 'miss') v.group.scale.setScalar(MITT_SCALE * Math.max(0.01, 1 - age));
        else {
          const swell = age < 0.35 ? 1 + 0.3 * Math.sin((age / 0.35) * Math.PI * 0.5) : 1.3 * (1 - (age - 0.35) / 0.65);
          v.group.scale.set(MITT_SCALE * swell, MITT_SCALE * swell, MITT_SCALE * swell * 0.7);
        }
      }
    }

    // gloves follow the wrists; a detected punch throws them out and back
    for (const s of ['left', 'right'] as const) {
      const glove = this.gloves[s];
      const h = hands[s];
      const rest = this.gloveRest[s].clone();
      if (h) {
        // first-person = mirrored: screen x = −(un-mirrored image x)
        // play-test: "글러브가 찔끔찔끔 움직여" — follow the wrist at about 2× the old gain
        rest.x = THREE.MathUtils.clamp(-h.imgX * 1.15, -0.95, 0.95);
        rest.y = 1.08 + THREE.MathUtils.clamp(h.up, -1.2, 1.2) * 0.75; // guard (up ≈ 0.2) → ~1.23, in view
        // fast hands push the glove out right away (depth itself isn't measurable from a webcam) —
        // but only the clearly faster hand: a punch turns the torso and drags the other wrist
        // along, which made the wrong glove jab (play-test: "오른손 어퍼컷에 왼손이 찔끔 크로스").
        const other = hands[s === 'left' ? 'right' : 'left'];
        // Measured on the recordings: wrong-glove pushes 121 → 22 of 216 punches with this gate.
        if (h.speed > 2.5 && (!other || h.speed > other.speed * 2.5)) rest.z -= THREE.MathUtils.clamp((h.speed - 1) * 0.12, 0, 0.55);
      }
      let goal = rest;
      const th = this.thrust[s];
      if (th) {
        const t = now - th.at;
        const outMs = 110;
        const backMs = 240;
        if (t > outMs + backMs) delete this.thrust[s];
        else {
          const u = t < outMs ? t / outMs : 1 - (t - outMs) / backMs;
          const reach = th.to.clone().add(new THREE.Vector3(0, 0, 0.12));
          goal = rest.clone().lerp(reach, Math.sin((u * Math.PI) / 2));
        }
      }
      glove.position.lerp(goal, th ? 0.6 : 0.35);
      // knuckles tipped up and slightly inward, like a guard seen from behind
      glove.rotation.set(deg(22), s === 'left' ? deg(10) : deg(-10), s === 'left' ? deg(-14) : deg(14));
    }

    for (const f of [...this.flashes]) {
      const age = (now - f.at) / 350;
      if (age >= 1) {
        this.scene.remove(f.sprite);
        this.flashes.splice(this.flashes.indexOf(f), 1);
        continue;
      }
      f.sprite.scale.setScalar(0.2 + age * 0.9);
      f.sprite.material.opacity = 1 - age;
    }

    const dt = this.lastRender ? Math.min(0.05, (now - this.lastRender) / 1000) : 0;
    this.lastRender = now;
    for (const s of [...this.sparks]) {
      const age = (now - s.at) / s.life;
      if (age >= 1) {
        this.scene.remove(s.sprite);
        this.sparks.splice(this.sparks.indexOf(s), 1);
        continue;
      }
      s.vel.y -= 4.5 * dt;
      s.vel.multiplyScalar(1 - 1.8 * dt);
      s.sprite.position.addScaledVector(s.vel, dt);
      s.sprite.material.opacity = 1 - age;
    }
    for (const w of [...this.waves]) {
      const age = (now - w.at) / 220; // short: a lingering ring read as an afterimage
      if (age >= 1) {
        this.scene.remove(w.mesh);
        this.waves.splice(this.waves.indexOf(w), 1);
        continue;
      }
      w.mesh.scale.setScalar(1 + age * 2.2 * w.size);
      (w.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - age) * (1 - age);
    }

    // camera shake (decays over ~250 ms) and a small zoom kick on PERFECT
    const shakeAge = (now - this.shake.at) / 250;
    const amp = shakeAge < 1 ? this.shake.amp * (1 - shakeAge) ** 2 : 0;
    this.camera.position.set(
      (Math.random() - 0.5) * 2 * amp,
      1.6 + (Math.random() - 0.5) * 2 * amp,
      (Math.random() - 0.5) * amp,
    );
    this.camera.lookAt(0, 1.45, -3);
    this.camera.rotation.z += (Math.random() - 0.5) * amp * 1.5;
    const kickAge = (now - this.fovKick.at) / 200;
    const fov = 52 - (kickAge < 1 ? this.fovKick.amount * Math.sin(kickAge * Math.PI) : 0);
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    this.renderer.render(this.scene, this.camera);
  }
}
