// "❔ 플레이 방법": how a game goes and what punches 1–6 are, for people who never boxed.
// The hands follow the stance picked on the menu (1·3·5 = lead hand, 2·4·6 = rear hand).
// Figures are drawn as the player sees themself in the mirrored camera view, at the moment the
// punch lands — the same arm shape the recognizer looks at (core/classify.ts: flat forearm = hook,
// upright forearm with a low elbow = uppercut, the rest = straight).

import { PUNCH_NAMES } from '../core/classify';
import { leadSide, type Side, type Stance } from '../core/pose';

type Kind = 'straight' | 'hook' | 'uppercut';

const HAND_KO: Record<Side, string> = { left: '왼손', right: '오른손' };
const STANCE_KO: Record<Stance, string> = { orthodox: '오소독스', southpaw: '사우스포' };

const HOW: Record<number, string> = {
  1: '앞손을 카메라 쪽으로 <b>곧게 쭉</b>. 가장 빠르고 제일 자주 나와요.',
  2: '뒷손을 <b>곧게 쭉</b>. 허리를 같이 돌리면 더 세져요.',
  3: '앞손 팔꿈치를 <b>어깨 높이로 들고</b>, 팔을 ㄱ자로 <b>옆에서</b> 휘둘러요.',
  4: '뒷손 팔꿈치를 <b>어깨 높이로 들고</b>, 팔을 ㄱ자로 <b>옆에서</b> 휘둘러요.',
  5: '앞손을 살짝 내렸다가 팔꿈치는 낮게, <b>아래에서 위로</b> 올려 쳐요.',
  6: '뒷손을 살짝 내렸다가 팔꿈치는 낮게, <b>아래에서 위로</b> 올려 쳐요.',
};

const KIND_OF: Record<number, Kind> = { 1: 'straight', 2: 'straight', 3: 'hook', 4: 'hook', 5: 'uppercut', 6: 'uppercut' };

/** Arm (shoulder→elbow→fist) for an arm on the screen's left side; mirrored for the right. */
const ARMS: Record<Kind | 'guard', { elbow: [number, number]; fist: [number, number]; r: number }> = {
  guard: { elbow: [37, 76], fist: [51, 45], r: 6.5 },
  straight: { elbow: [41, 62], fist: [47, 52], r: 11 },
  hook: { elbow: [16, 54], fist: [45, 47], r: 7 },
  uppercut: { elbow: [40, 86], fist: [45, 56], r: 7 },
};

/** Motion arrow (screen-left arm). */
const ARROWS: Record<Kind, string> = {
  straight: '',
  hook: 'M8 33 Q 24 18 46 30',
  uppercut: 'M58 104 Q 60 84 56 66',
};

function figure(kind: Kind, side: Side): string {
  // mirrored view: the player's right hand shows on the right of the picture
  const mx = (x: number, onRight: boolean) => (onRight ? 120 - x : x);
  const arm = (k: Kind | 'guard', onRight: boolean, color: string) => {
    const a = ARMS[k];
    const sx = mx(40, onRight);
    const [ex, ey] = [mx(a.elbow[0], onRight), a.elbow[1]];
    const [fx, fy] = [mx(a.fist[0], onRight), a.fist[1]];
    return `<polyline points="${sx},52 ${ex},${ey} ${fx},${fy}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<circle cx="${fx}" cy="${fy}" r="${a.r}" fill="${color}" stroke="#1e3a8a" stroke-width="2"/>`;
  };
  const punchRight = side === 'right';
  const color = side === 'left' ? '#0891b2' : '#ea580c';
  let extra = '';
  if (kind === 'straight') {
    // foreshortened toward the camera: a big fist with burst lines
    const cx = mx(47, punchRight);
    extra = [[-18, -2, -24, -4], [-14, -14, -19, -19], [0, -18, 0, -24], [14, -14, 19, -19], [18, -2, 24, -4]]
      .map(([x1, y1, x2, y2]) => `<line x1="${cx + x1}" y1="${52 + y1}" x2="${cx + x2}" y2="${52 + y2}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`)
      .join('');
  } else {
    const d = ARROWS[kind].replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, x: string, y: string) => `${mx(Number(x), punchRight)} ${y}`);
    extra = `<path d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-dasharray="5 4" stroke-linecap="round" marker-end="url(#gArrow${side === 'left' ? 'L' : 'R'})"/>`;
  }
  return `<svg viewBox="0 0 120 112" class="fig" aria-hidden="true">
    <path d="M40 50 Q60 44 80 50 L76 108 L44 108 Z" fill="#dbe4ff" stroke="#1e3a8a" stroke-width="2"/>
    <circle cx="60" cy="28" r="13" fill="#fde7cf" stroke="#1e3a8a" stroke-width="2"/>
    ${arm('guard', !punchRight, '#94a3b8')}
    ${arm(kind, punchRight, color)}
    ${extra}
  </svg>`;
}

function card(n: number, stance: Stance): string {
  const lead = leadSide(stance);
  const isLead = n % 2 === 1;
  const side: Side = isLead ? lead : lead === 'left' ? 'right' : 'left';
  return `<li class="pcard" style="--n: ${n}">
    ${figure(KIND_OF[n], side)}
    <div class="pc-head"><b class="${side === 'left' ? 'L' : 'R'}">${n}</b><span>${PUNCH_NAMES[n]}</span></div>
    <div class="pc-hand ${side === 'left' ? 'L' : 'R'}">${HAND_KO[side]} · ${isLead ? '앞손' : '뒷손'}</div>
    <p>${HOW[n]}</p>
  </li>`;
}

/** The guide's body for the current stance. */
export function guideHtml(stance: Stance): string {
  const lead = leadSide(stance);
  const rear: Side = lead === 'left' ? 'right' : 'left';
  const L = (s: Side) => (s === 'left' ? 'L' : 'R');
  const cards = [1, 3, 5, 2, 4, 6].map((n) => card(n, stance)).join('');
  return `
    <svg width="0" height="0" class="g-defs" aria-hidden="true"><defs>
      <marker id="gArrowL" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#0891b2"/></marker>
      <marker id="gArrowR" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#ea580c"/></marker>
    </defs></svg>
    <section>
      <h3>이렇게 놀아요</h3>
      <ol class="steps">
        <li><i>1</i><div><b>미트가 날아와요</b><small>미트에 적힌 <b>번호</b>가 칠 펀치, <b>색</b>이 칠 손이에요 —
          <span class="hand L">하늘색 = 왼손</span> <span class="hand R">주황 = 오른손</span></small></div></li>
        <li><i>2</i><div><b>링에 겹칠 때 쳐요</b><small>미트가 멈춰서 잠깐 대 줘요. 둘레 게이지가 <b>금색</b>일 때 치면 PERFECT!</small></div></li>
        <li><i>3</i><div><b>위쪽 번호는 콤보 순서</b><small>
          <span class="demo"><em class="${L(lead)}">1</em>잽</span> › <span class="demo"><em class="${L(rear)}">2</em>크로스</span> 이면 잽 다음 바로 크로스</small></div></li>
        <li><i>4</i><div><b>안 치는 손은 턱 앞에</b><small>가드를 올리고 있으면 점수 <b>+20%</b>. 화면 아래에 가드 표시가 나와요.</small></div></li>
      </ol>
      <p class="g-note">👀 어디를 치는지는 안 봐요 — <b>어느 손</b>으로 <b>어떤 펀치</b>를 <b>언제</b> 쳤는지만 봐요. 펀치는 <b>크고 또렷하게!</b></p>
    </section>
    <section>
      <h3>펀치 번호 1~6 <small>${STANCE_KO[stance]} 기준 · 앞손 = ${HAND_KO[lead]}, 뒷손 = ${HAND_KO[rear]}</small></h3>
      <p class="g-rule"><b>홀수(1·3·5)는 앞손</b>, <b>짝수(2·4·6)는 뒷손</b>이에요. 그림은 카메라 화면(거울)에 보이는 내 모습이에요.</p>
      <div class="prow-labels"><span>곧게 뻗기</span><span>옆에서 휘두르기</span><span>아래에서 올려 치기</span></div>
      <ul class="pgrid">${cards}</ul>
      <p class="g-note">스탠스는 메뉴의 "누가 앞손이에요?"에서 바꿀 수 있어요. 바꾸면 이 설명도 따라 바뀌어요.</p>
    </section>`;
}
