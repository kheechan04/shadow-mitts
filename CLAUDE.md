# Shadow Mitts — Claude Code 작업 규칙

웹캠 포즈 인식만으로 복싱 미트를 치는 브라우저 게임. 배포: https://shadow-mitts.vercel.app ·
저장소: github.com/kheechan04/shadow-mitts (public) · 포트폴리오: https://kheechan04.github.io/shadow-mitts/

## 현재 상태 (2026-09-24 기준)
- M0\~M5 완료·배포됨(사용자 확인 완료). **다음은 M6 디펜스(슬립·더킹 → 위빙)** — 계획과 녹화 요청은 `docs/M6-PLAN.md`.
- 설계서는 `DESIGN.md`(사용자가 별도 Claude 대화에서 만듦). 모든 결정과 근거 수치는 `docs/DEVELOPMENT.md`의 결정 기록 표.

## 사용자
- **항상 한국어로 답한다.** 기술 용어는 풀어서 설명한다(깊은 기술 배경이 없음). 숫자 해석을 사용자에게 떠넘기지 말고, 녹화·게임 기록을 직접 분석해서 결론을 말한다.
- **사우스포**(오른손이 앞손). 녹화는 전부 사우스포, 오소독스는 좌우 반전으로 검사한다.
- 사용하는 카메라는 "LG Camera"(기본 카메라는 시간 초과로 안 켜짐). 어두우면 15fps로 떨어진다.

## 처음부터 정한 규칙 (사용자 지시)
1. DESIGN.md의 "확인됨/미확인" 표를 지킨다. 미확인 API는 추측으로 코딩하지 말고 설치된 패키지의 `.d.ts`나 실제 실행으로 먼저 확인한다.
2. 마일스톤은 순서대로. 각 마일스톤이 끝나면 **실행 방법과 "무엇을 확인해야 하는지"를 한국어로 알려 주고, 사용자 확인 없이 다음 마일스톤으로 넘어가지 않는다.**
3. 펀치 인식 임계값은 전부 placeholder — `src/core/params.ts`에 모으고 개발자 도구(⚙) 슬라이더로 조정 가능하게.
4. 인식 로직은 카메라 없이 테스트 가능해야 한다(녹화 JSON 재생 + 합성 데이터 단위 테스트).

## 일하는 방식 (이 프로젝트에서 효과가 확인된 것)
- **짐작으로 고치지 말고 먼저 측정한다.** "게임에서만 안 된다" → 게임 기록(`npm run game-report`), 시각 문제 → 프레임 추적(`scripts/dev/mitt-trace.mjs`), fps 문제 → `npm run fps-check`. 세 번 짐작으로 고쳐 실패한 뒤 측정 한 번에 풀린 사례가 있다(DEVELOPMENT.md 결정 기록).
- 규칙을 바꾸면 `npm test`(녹화 floor 포함) + `npm run eval` + `npm run fps-check`로 연습 녹화·15fps가 나빠지지 않았는지 확인. 게임 데이터로 맞출 땐 판(파일) 단위로 빼고 교차 검증한다.
- 화면 변경은 헤드리스 크롬 스크린샷으로 직접 보고 확인한 뒤 보고한다.
- 사용자 체감(피드백)과 숫자가 다르면 체감을 우선 의심하지 말고 데이터를 더 모은다.

## 개인정보·보안 (반드시 지킬 것)
- **`recordings/*.json`은 절대 커밋하지 않는다**(사용자 동작 데이터, .gitignore). `PROCESS_LOG.md`(설계 대화 기록)는 `.git/info/exclude`로 로컬 전용 — 사용자가 공개하라고 할 때만.
- 영상·얼굴은 브라우저 밖으로 나가지 않는다. `docs/FACE-PRIVACY.md` §5 표의 안내 문구가 계속 사실이어야 한다 — 코드를 바꿔 사실이 아니게 되면 안내문을 먼저 고친다. Vercel Analytics는 켜지 않는다.
- 사용자 이메일(gmail)은 식별용으로만. 커밋은 이 저장소 로컬 git 설정(noreply: `280937297+kheechan04@users.noreply.github.com`, 이름 `HC KIM`)으로.

## Git·배포
- `main`에 push하면 Vercel이 자동으로 프로덕션 배포한다(사용자의 Vercel 계정, GitHub 연동). 확인: `"C:\Program Files\GitHub CLI\gh.exe" api repos/kheechan04/shadow-mitts/commits/<sha>/status` → Vercel=success.
- 커밋 메시지 끝에 사용자가 요청한 공동 작성자 줄을 붙인다(시스템 안내 참고).
- PWA 서비스 워커(`public/sw.js`)는 프로덕션에서만 등록. 개발 서버에선 꺼져 있다.

## 명령
| 명령 | 용도 |
|---|---|
| `npm run dev` | 개발 서버 (http://localhost:5173, 게임 / `face.html` 얼굴 실험실) |
| `npm test` | 단위 테스트(83개), 카메라 불필요 |
| `npm run eval -- -v` | 연습 녹화 채점 (녹화 메모 "사우스포, 리드 훅 10회" 형식에서 정답을 읽음) |
| `npm run fps-check` | 녹화를 30/20/15/12fps로 솎아 채점 (`--set key=value`로 설정 실험) |
| `npm run game-report -- <rec-game 파일>` | 게임 기록 재생·재판정·실제와 일치 수 (`--events`, `--params '{...}'`) |
| `node scripts/dev/mitt-trace.mjs` | 가상 시간 프레임별 미트 위치 추적 (dev 서버 + `npm i --no-save puppeteer-core`) |
| `npm run build` | 타입 검사 + 빌드 |

## 헤드리스 테스트 요령 (Windows)
- 크롬: `C:/Program Files/Google/Chrome/Application/chrome.exe`, puppeteer-core는 `--no-save`로 설치.
- 가짜 카메라: `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, 사람이 필요하면 `--use-file-for-fake-video-capture=<mjpeg>`. 가짜 카메라는 가끔 멈춘다 — 먼저 `getUserMedia`를 한 번 열었다 닫고, 버튼은 `element.click()`으로 누른다(마우스 클릭이 빗나감).
- 개발 모드에서만 `window.__game`(GameController)이 열려 있다. 게임을 가상 시간으로 돌리려면 `__game.frame(t)`.
- 테스트용 얼굴은 **실존 인물 사진 금지** — AI로 만든 가상 인물을 쓴다.

## 이 환경의 함정
- 마크다운 본문에 `~`가 한 줄에 두 번 있으면 GitHub가 삭제선으로 그린다 → `\~`로.
- bash `sed`/heredoc에 백틱·`\``이 섞이면 파일이 망가진다(한 번 모든 줄에 백틱이 붙었음) → 긴 수정은 Write/Edit 도구나 node 스크립트 파일로.
- `cd`가 들어간 명령에서 `rm`은 안전 검사에 막힌다 → 새 폴더를 쓰거나 절대 경로로.
- `gh`는 bash PATH에 없다 → `"/c/Program Files/GitHub CLI/gh.exe"`.
- PowerShell 5.1: `&&` 없음.

## 문서
`README.md`(소개·풀어낸 문제들) · `docs/USAGE.md`(사용법) · `docs/DEVELOPMENT.md`(설계·결정 기록) ·
`docs/MODEL-CHOICE.md`(MediaPipe vs YOLO) · `docs/FACE-PRIVACY.md`(얼굴 기능 개인정보 검토) · `docs/M6-PLAN.md`(다음 작업)

## 포트폴리오 갱신 (마일스톤을 마칠 때)
저장소 `kheechan04/kheechan04.github.io`의 `shadow-mitts/index.html`(요약)·`full.html`(상세)을 같은 스타일로 갱신한다(그 저장소 README의 방법).
수치는 실제로 잰 것만, 설계 단계의 모델 비교는 "검토"라고만 쓴다(벤치마크 안 함). 그 저장소도 커밋 이메일을 noreply로 설정해서 커밋.
