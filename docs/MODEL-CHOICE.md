# 포즈 인식 모델: MediaPipe vs YOLO

이 게임은 **MediaPipe Pose Landmarker**를 쓴다. 설계 단계에서 **Ultralytics YOLO(pose)** 와 함께 검토했고,
"웹 실행 가능성·구현 편의성·개인정보"를 기준으로 MediaPipe를 골랐다.

> 구분해서 읽을 것
> - **§1 일반 비교**: 공식 문서·모델 카드에서 확인한 사실. 두 모델을 이 프로젝트에서 **나란히 측정하지는 않았다.**
> - **§3 이 프로젝트에서 측정한 것**: 고른 MediaPipe로 실제로 얻은 수치.

## 1. 일반 비교

| 항목 | MediaPipe Pose Landmarker | Ultralytics YOLO pose | 이 게임에 주는 의미 |
|---|---|---|---|
| **웹 브라우저 실행** | 공식 JS 패키지 `@mediapipe/tasks-vision` (WASM, CPU/GPU) | 공식 웹 런타임 없음. ONNX 등으로 내보낸 뒤 onnxruntime-web 같은 라이브러리에 직접 연결하고, 전·후처리(박스 선택 등)를 직접 구현해야 함 | **설치 없이 링크로 실행**하는 목표에 MediaPipe가 바로 맞음 |
| **관절(랜드마크) 수** | 33개 (얼굴 일부·입 양끝, 손가락 쪽 점, 발 포함) | 17개 (COCO: 코·눈·귀·어깨·팔꿈치·손목·엉덩이·무릎·발목) | 가드 판정에 **입 양끝(9, 10번)** 을 씀 — YOLO의 17개에는 입이 없음 |
| **3D 좌표** | 이미지 좌표 + **월드 좌표(미터, 3D)** | 이미지 2D 좌표 | 이론상 장점이지만, 이 프로젝트에선 카메라 쪽 깊이가 부정확해서(아래 §3) 결국 쓰지 않음 |
| **대상 인원** | 한 사람 추적에 맞춤 (영상 모드에서 프레임 사이 추적) | 여러 사람을 한 번에 검출 | 1인용 게임이라 여러 명 검출은 불필요한 계산 |
| **라이선스** | **Apache 2.0** (패키지·모델 모두, 상업 이용 가능) | **AGPL-3.0** 또는 유료 **Enterprise** 라이선스. 쓰면 프로젝트 전체를 AGPL로 공개하거나 기업 라이선스 필요 | 나중에 상업화해도 MediaPipe는 조건이 가벼움 |
| **모델 크기** | lite 약 5.8MB (실제 내려받은 파일) | 가장 작은 YOLO26n-pose 약 290만 파라미터 (파일 크기는 확인 안 함) | 둘 다 웹에서 받을 만한 크기 |
| **정확도 자료** | 공식 문서·모델 카드 기준 | COCO 벤치마크 mAP 공개 (예: YOLO26n-pose 57.2) | 서로 다른 기준이라 숫자로 바로 비교할 수 없음 |

### YOLO가 더 나은 경우 (공정하게)
- 한 화면에 **여러 사람**이 있는 장면(군중, 스포츠 중계 분석).
- **서버·파이썬·GPU** 환경에서 돌릴 때 — 학습·미세조정 도구와 생태계가 강함.
- 사람뿐 아니라 **물체 검출 등 다른 작업**과 한 모델 계열로 묶고 싶을 때.

### 이 게임에 MediaPipe가 맞았던 이유 (요약)
1. **브라우저에서 바로** 돌아가서, 설치 없이 링크만으로 할 수 있다.
2. **영상이 서버로 나가지 않는다** — 브라우저 안에서 처리. (웹에서 돌리는 방식의 장점이라 YOLO도 브라우저에서 돌리면 같지만, 그 준비가 훨씬 번거로움)
3. 게임에 필요한 **입 위치까지** 한 번에 나온다.
4. **1인 추적**에 맞춰져 있어 불필요한 계산이 적다.
5. **Apache 2.0** — 상업화해도 라이선스 부담이 작다.

## 2. 같은 계열의 선택: 얼굴도 MediaPipe
리액션 얼굴에는 **MediaPipe Face Landmarker**(478개 좌표, Apache 2.0)를 썼다. 생성형 AI 서버 대신 브라우저 안에서 사진을 변형하는 방식을
고른 이유는 [FACE-PRIVACY.md](FACE-PRIVACY.md) 참고.

## 3. 이 프로젝트에서 측정한 것 (고른 모델로 얻은 결과)
- 녹화 19개(175펀치): 친 손 94%, 펀치 번호 91% 인식. 가드만·몸통 회전만 한 구간의 오검출 0.
- 실제 PC, 게임 중: **CPU 추론(Web Worker) 초당 약 20회**, 화면 60fps. GPU 추론은 3D 화면과 그래픽카드를 나눠 써서 초당 15회로 오히려 느렸다.
- lite 모델 기본: 60fps 녹화를 15fps로 솎으면 펀치의 약 40%를 놓쳤다 → **속도가 정확도에 결정적**이라 가장 빠른 lite를 기본으로 둠.
- 3D 월드 좌표의 깊이(z)는 카메라 쪽으로 잽을 뻗을 때 오히려 반대로 움직여 **쓰지 않았다**(M0 녹화로 확인).

자세한 측정과 결정 기록은 [DEVELOPMENT.md](DEVELOPMENT.md).

## 출처
- MediaPipe Pose Landmarker 가이드: [Google AI Edge](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker), [웹 가이드](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js)
- BlazePose(33개 3D 랜드마크, 1인 추적): [MediaPipe Pose 문서](https://mediapipe.readthedocs.io/en/latest/solutions/pose.html), [Google Research 블로그](https://research.google/blog/on-device-real-time-body-pose-tracking-with-mediapipe-blazepose/)
- Ultralytics YOLO pose(17 COCO 키포인트, 다인원, 내보내기 형식, YOLO26n-pose 2.9M·57.2 mAP): [Ultralytics Pose 문서](https://docs.ultralytics.com/tasks/pose/)
- Ultralytics 라이선스(AGPL-3.0 / Enterprise): [Ultralytics License](https://www.ultralytics.com/license), [YOLOv8 문서](https://docs.ultralytics.com/models/yolov8)
- MediaPipe 라이선스: 설치된 `@mediapipe/tasks-vision` package.json(Apache-2.0), [Face Mesh V2 모델 카드](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf)(Apache 2.0)

<sub>확인일: 2026-09-24. 라이선스·모델 정보는 바뀔 수 있으니 인용 전에 출처를 다시 확인할 것.</sub>
