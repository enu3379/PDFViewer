/*
 * fig-extract.js — 논문 PDF에서 figure 영역을 자동 감지·크롭하는 엔진
 *
 * ⚠ 이 파일은 PDFViewer(Margin) repo의 src/core/fig-extract.js 로 그대로 복사(vendoring)된다.
 *   알고리즘 수정은 figure-preview-test repo에서만 한다.
 *   릴리스 절차: figure-preview-test/docs/PLAYBOOKS.md §SUB-R
 *   벤더링 절차: PDFViewer/docs/fig-extract-integration.md §갱신 절차
 *
 * 의존성: pdf.js (전역 pdfjsLib). 브라우저 전용 (canvas 사용).
 * 사용법:
 *   const result = await FigExtract.extract(uint8Array, {
 *     onProgress: msg => {},   // 진행 상태 문자열
 *     debug: msg => {},        // 상세 진단 로그 (선택)
 *     maxPages: 200,           // 선택 — 스캔 페이지 상한 (미지정 시 전체 페이지)
 *     pdfDocument: doc,        // 선택 — 이미 로드된 PDFDocumentProxy 재사용 (지정 시 data는 null 가능)
 *     renderPage: async (pageNum, scale) => canvas,  // 선택 — 호스트 렌더 캐시 주입
 *     signal: abortCtrl.signal, // 선택 — 협조 취소 (페이지 단위 체크, abort 시 AbortError throw)
 *     onDiagnostic: records => {}, // 선택 — PB-4A 구조화 관측 record 배열을 문서 끝에 1회 전달
 *     cropImages: false,       // 선택 — v2.19.1+ 진단 전용. 크롭 생성·PNG 직렬화를 통째로 생략한다.
 *                              //   크롭은 감지 이후 단계라 figures 출력은 완전히 동일하고, PNG 인코딩·
 *                              //   전송·저장 비용만 사라진다. 이 모드에서는 cropDataURL/cropBlob 사용 불가.
 *   });
 *   // throw: AbortError(취소) 외에 v2.19.1+ `FigRenderError` — 렌더 결과가 존재하지 않는 경우
 *   //   (메모리 부족으로 Chrome이 캔버스 백킹 스토어를 회수). 엔진이 직접 렌더한 페이지의 불투명
 *   //   픽셀이 절반 미만이거나 크롭 캔버스가 투명할 때 발화하며, 불투명 배경 불변식이 없는 호스트
 *   //   주입 캔버스(renderPage)에는 적용하지 않는다. 조용히 빈 그림을 내놓는 대신 실패시킨다 —
 *   //   일시적 조건이므로 호스트는 재시도를 제공하는 것이 적절하다.
 *   // result = { title, numPages, engineVersion, figures: [...], suspectedMissing: ["1", ...] }
 *   // figure = { num, page, confidence, caption, bboxPt(그림만), captionBoxPt, bboxPx }
 *   //   식별 키 = (num, page). 같은 num이 다른 페이지에 복수 등장 가능 (v2.5.0+ — 합본·부록 번호 재시작)
 *   // suspectedMissing = 감지된 정수 번호 1..최대 중 빠진 번호 (미탐지 의심 — 소비자가 무시해도 됨)
 *   // 크롭 이미지: FigExtract.cropDataURL(fig) / FigExtract.cropBlob(fig) — 그림 영역만 (scale 2.2)
 *   //   v2.19.1+: 크롭은 스캔 중 PNG로 직렬화된다. `figure.cropCanvas` 필드와 `cropCanvas()` 접근자는
 *   //   제거됐다 ([BREAKING]) — 소비자가 캔버스 수명을 관리할 필요가 없어졌다 (이전에는 프리뷰 생성 후
 *   //   참조를 버리라고 요구했다). 페이지 캔버스도 스캔 중 동시 상주 최대 1장이고 즉시 반환된다.
 *   // 좌표: pt, 좌상단 원점. PDF user space 변환은 y' = pageHeight - y
 *
 * 알고리즘 설명과 각 규칙의 유래는 docs/ALGORITHM.md 참고.
 */
"use strict";

const FigExtract = (() => {

const VERSION = "2.19.4";
// 2.19.1: [BREAKING] 죽은 캔버스 내성 (백로그 B7 — 전수 배치 비결정성의 근본 원인). Chrome은 메모리
//        압력을 받으면 캔버스 백킹 스토어를 예외 없이 회수하는데, 회수된 캔버스는 모든 그리기가
//        무성과로 끝나고 읽으면 전면 투명이다. makeInk가 알파를 무시해 이걸 "잉크 100% 페이지"로
//        읽어 유령 figure 2건·bbox 44.5pt 이동을 만들었고, 크롭은 전량 백지 PNG로 저장됐다
//        (v2.19.0 출하본에 23장 혼입). ① 잉크 판정을 흰 배경 합성으로 교정 — 불투명 픽셀은 합성식이
//        항등이라 정상 렌더 출력은 완전 불변이다. ② 엔진이 직접 렌더한 페이지 캔버스의 불투명 픽셀이
//        절반 미만이거나 크롭 캔버스가 투명하면 `FigRenderError`로 즉시 실패 (조용한 오염 방지). pdf.js가
//        페이지를 불투명 흰색으로 채우고 시작하므로 정상 렌더의 기대 투명 비율은 0이고, 이 불변식이 없는
//        호스트 주입 캔버스(`opts.renderPage`)에는 검사를 적용하지 않는다. ③ 크롭을 생성 즉시 PNG로 직렬화하고
//        캔버스를 반환 — 문서 끝까지 캔버스를 쌓던 구조(논문당 최대 130MB)가 사라져 회수 자체가
//        일어나지 않는다. `figure.cropCanvas` 필드와 `cropCanvas()` 접근자 제거([BREAKING]),
//        `cropDataURL`/`cropBlob`은 시그니처 불변. ④ 진단 전용 `cropImages:false` 옵션(출력 불변).
// 2.19.4: [수정] v2.19.2/.3 적대 리뷰 후속 — ① capLineNorm도 글리프를 벗겨 비교(안 그러면 글리프
//        앵커의 bareLabel이 항상 false가 되어 down/side/12-B 증거 분기가 통째로 죽는다) ② 선두
//        글리프가 독립 조각일 때 임베디드 캡션 분해가 무발동이던 게이트 수정 ③ 글리프 열거를 관측된
//        좌향 2자로 축소(우향은 양성 증거 0, 유일 사례가 비-캡션 불릿) ④ 12-B 방출이 emittedNums를
//        갱신하도록 수정(같은 num 두 앵커 통과 시 F8 중단이 문서 전체를 실패시켰다) ⑤ 장식 띠로
//        거부된 후보도 dedup 레코드를 남겨 살아남은 후보의 sole-identity-candidate 거짓 사유 제거.
// 2.19.3: [행동 변경] 지면 장식 띠 거부 — dedup **앞**에서 heightRatio < 0.05 ∧ widthRatio >= 0.80
//        인 후보를 버린다(머리글 띠 오방출). dedup 뒤에 두면 띠가 우승한 뒤 죽고 진짜 후보는 이미
//        버려져 복구 불가다. 12-B N−1 방출 경로에도 같은 바닥을 적용해 same-page에서 막은 띠가
//        adjacent로 새어나가지 않게 한다.
// 2.19.2: [행동 변경] 캡션 라벨 앞 삼각 글리프(◀◂◄▶▸►◁▹) 허용 — buildLines가 조판 장식을 캡션과
//        같은 줄로 병합해 ^(Fig|Figure)가 깨지던 조판을 복구한다. hard·soft·자간분리 **세 판정 경로
//        전부**에 같은 접두 제거를 적용하고, 길이 가드는 벗겨낸 문자열 기준으로 잰다. 원본 line.s는
//        건드리지 않아 캡션 텍스트·박스 계산은 불변이다.
// 2.19.0: [행동 변경] PB-4B 12-B — 캡션이 다음 장 상단에 있고 직전 페이지에 주인 없는 합성 영역이
//        있을 때 그 페이지에 figure를 **신규 방출**한다(page = 실제 그림 페이지, captionPage optional).
//        조건은 composition:confirmed ∧ unclaimed 3가드 ∧ 기존 방출 없음 ∧ 같은 num 미방출 ∧
//        textCoverage ≤ 0.50 ∧ selectionAreaRatio ≥ 0.30(잠정). 기존 상자 replace는 12-C로 계속 잠금이며
//        같은 num이 이미 있으면 fail-closed로 중단한다. 불통과는 abstain = 이전 동작.
// 2.18.0: [계약 무변경] PB-4B 12-A strong 계측 — 선택 영역의 텍스트 점유율·면적·raster·잉크밀도를
//        adjacent-observation.strongMetrics로 방출. strong tri-state는 null 유지, 임계 없음.
// 2.17.0: [계약 무변경] PB-4B 12-A 관측 전용 기반. N−1 observer를 diagnostic callback과
//        무관하게 항상 실행하고 기록만 optional로 분리해 graph off↔on이 같은 public 경로를 검증하게
//        한다. 잔여 합집합(A)과 30pt seed 성장(B)의 합의는 새 composition tri-state로, target page의
//        owned 교차·다른 num anchor·다른 adjacent selection 세 가드는 unclaimed 관측 필드로만 기록한다.
//        기존 single은 region 정확히 1개라는 의미를 바꾸지 않고 null/deprecated로 동결한다. resolver,
//        reassignment, public captionPage/page 변경은 없으며 suspectedMissing 계산만 observer 이후로 옮겼다.
// 2.16.0: [계약 무변경] 중첩 라벨 계열 경합 — 한 물리 캡션 줄이 "Extended Data Fig. N | Figure SN. …"
//        처럼 ED와 S 라벨을 함께 낳는 문서(저자 오제출 — Goldstein-2022)에서 임베디드 스플리터(v2.9.2)가
//        같은 그림을 ED.N + 유령 S.N 둘로 방출하고, 형제 clamp가 ED.N 영역까지 축소했다. 줄의 identity
//        (첫 라벨)가 ED면 같은 줄의 S 라벨은 형제 앵커로 만들지 않는다. 근거는 표기 관습이다 — 한 영역이
//        동시에 Extended Data이면서 Supplementary일 수 없고, ED는 Nature 계열 전용이라 같은 문서가 같은
//        그림에 S 번호를 겹쳐 붙이지 않는다. 겹침 임계 없이 "같은 물리 라인"이라는 사실만 쓴다. 형제가
//        남지 않으면 분해 자체를 하지 않으므로 sibL/sibR clamp도 함께 사라진다(ED 영역 복원).
// 2.15.0: [필드 추가: optional opts.onDiagnostic] PB-4A observation infrastructure. 명시적으로
//        diagnostic callback을 준 실행에서만 anchor→candidate→selection→floor→dedup→emission의 scalar
//        record를 문서 끝에 한 번 전달한다. canvas/PNG/raw pixel은 포함하지 않는다. callback 부재 시 recorder
//        객체·record를 만들지 않는다. 공개 result/figure 필드, 선택/score/crop/dedup 동작은 2.14.0과 동일하다.
//        batch-runner `--graph`가 별도 paper-local JSONL/meta로 영속화하며 `--one`은 graph를 자동 활성화하지 않는다.
// 2.14.0: [계약 무변경] soft 캡션 문서 게이트 강건화 — 혼합-관습 문서에서 hard 앵커 1개가 같은 문서
//        soft 캡션을 전량 몰살하던 문제 해결. 두 갈래. **Part1**: soft 게이트의 hard 카운트를 "sep-증거"로
//        교정 — 구 hardCount(비-family 앵커를 sep·bare 무차별 1로 셈)를 hardBody = (비-family sep 앵커)
//        + (반복 동형 bare, 같은 form ≥2)로 바꿔, 고립 bare 맨-라벨(캡션 라벨이 wrap돼 번호가 줄끝에 온
//        Hao "Figure 7")을 hard 관습 증거에서 제외한다. bare form 집계는 문서-레벨·per-FORM·soft formCount와
//        물리 분리(공유 시 고립 bare가 동형 soft와 합산돼 오분류). family(S·ED·A~D)는 sep/bare 분기 前 배제.
//        **Part2**: hardBody 3-체제 라우터 — 0=전량승격(구 pass 경로)·1..K-1=애매역·≥K=전량기각(구 pass=0),
//        K=2. 애매역(hard 관습 딱 1건: 본문 soft + 진짜 캡션/FP hard 1개를 분간 못 하는 경계)은 잠정승격 후
//        pass2에서 up-점수 floor(SOFT_UP_FLOOR=8.5) 검증 → 미달·무-fig 앵커 강등 → detectPage 재실행으로
//        이웃 오염(other-cap stop·sibling-clamp) 복구. 재실행 후 재-floor(bounded loop) — 앵커 제거가
//        up-점수에 비단조(hugePenalty)라 "1회 고정"이 근거 없어 fixpoint까지 반복. 강등 0이면 재실행 없이
//        전량승격과 byte-identical. up-점수는 chosen이 아니라 **up 후보 점수**를 읽는다(floor 정의 준수).
//        복구: bench 3편 15 not_detected critical (Hao 8[전량승격]·s10854 4·s11269 3[애매역]). Rivaroxaban
//        Fig1(caption_next_page, 캡션페이지 얇은 스트립 up=7.90<8.5)은 정답 기각 유지. 정상기각 4편
//        (acm·Balci·Vaquero·wiley, hardBody≥4)·전량승격 원산지(Robertson·Fauzi·Kim·PAH) 무변경. 전수 diff로
//        hard 문서 비국소 회귀 0 확인. 설계는 3 Fable subagent 적대검증 + 4-critic 패널 확정(EVAL 규칙 유래 표).
//        출력 필드·좌표계·(num,page) 키·manifest 스키마 불변. ⚠ 반복-bare include 분기는 코퍼스 witness 0.
// 2.13.1: [계약 무변경] hugeExempt 커버리지 면제에 widthRatio ≥ HUGE_WIDTH_MIN(0.60) 폭 바닥 가드 추가.
//        coverage(=잉크 90% 질량 최소폭 ÷ 후보 폭)는 후보 '자기 폭' 기준 밀도라, hugeCond가 heightRatio>0.82
//        단독으로 발동하는 좁고 긴 raster 후보(자기 폭 안 잉크 조밀 → coverage↑)도 면제되는 사각이 있었다
//        (CodeRabbit PR#31 Major 지적, 전수 실측 1건: Blockchain 2@36 widthRatio 0.47 coverage 0.73). 페이지
//        폭의 60% 미만이면 '전폭'이 아니므로 coverage 면제 불허(프록시 farClosed‖!raster 경로는 무관). clip
//        표적 전건 widthRatio ≥ 0.82라 무영향, Blockchain 2는 v2.12.1부터 벌점 상태로도 chose=up이라 선택 불변
//        → 전수 diff 0(하드닝). 견고성 gap 차단(좁고 긴 over-grab의 잠재 false positive).
// 2.13.0: [계약 무변경] hugePenalty 전면 figure 오발 근본 해결 — 수평 잉크 커버리지 판별자 신설. v2.12.0
//        프록시 (farClosed‖!raster)의 사각(신규 Nature 2026 전폭 clip은 `!farClosed && raster`라 미면제)을
//        해소. measureCandidate가 up+huge 영역에서 잉크 90% 질량을 담는 최소 연속 컬럼 폭/영역 폭 =
//        coverage를 산출(내부 패널 갭에 강건, over-grab은 한쪽이 비어 낮음). hugeExempt에 `coverage ≥
//        HUGE_COVERAGE_MIN(0.54)` OR 조건으로 보강 — 프록시 면제분은 커버리지 무관하게 유지(회귀 0 보장).
//        전수 실측 분리: clip 표적 11건 coverage min 0.58 vs Simões4 over-grab 0.50, 임계 0.54. clip 해소
//        11건(Tsyporin 4·Vaquero 1/2/4/ED.3/ED.8/ED.11·Yue 4·Pan ED.1/ED.2/ED.11) + Simões4/Pandey3 가드 유지.
// 2.12.1: [계약 무변경] 위생 — hugeExempt의 죽은 가드 `bodyStops===0` 제거(동작 무변경, diff 0).
//        up 스캔(scan)은 body 블록을 만나면 그 블록을 영역에서 제외하고 stop하므로(line ~904 break)
//        up 영역은 구조적으로 body를 포함하지 않아 upBodyStops는 항상 0 — 이 조건은 up 방향에서 항상
//        참이라 무의미했다. `up && (farClosed || !raster)`로 단순화하고 이유를 주석화. (CodeRabbit
//        PR#30 지적: 가드가 no-op이라는 관찰은 맞음. 단 봇 제안 "제외된 body 블록의 stopNstop을
//        카운트"는 의미상 오류 — body를 제외한 정상 up 후보 7건에 틀린 bodyPenalty를 매겨 미채택.)
// 2.12.0: [계약 무변경] hugePenalty 전면 figure 오발 완화 — Nature Extended Data류 전면 figure(up 영역이
//        페이지의 65~78% 차지)가 hugePenalty(-8)를 맞아 healthy(≥8) 문턱 아래로 눌리면, ⓐ up 점수 직접
//        하락 + ⓑ detached-with-up side 거부(up≥8 조건)가 꺼져 작은 side 크롭에 짐 → clip. **up 방향이고
//        bodyStops=0(본문 stop 없음)이며 (farClosed || !raster)일 때 hugePenalty 면제**한다 — 진짜 전면
//        figure는 far 경계가 닫혔거나 벡터로 채워지고, `!farClosed && raster`는 경계 안 닫힌 영역이 raster
//        너머로 over-reach한 것이라 벌점 유지(Simões 4@6 칼럼폭 over-grab 회귀 방지). body>0·side는 무변경.
//        전수 diff 회귀 감사(v2.11.0↔): gate FIX 8 critical clip(Xue ED.1/2/6/9·Simões ED.9·Luques 3/ED.3·
//        Paul ED.4) + Structural 13@14 보너스, gate REGRESS 0. measureCandidate가 metrics.direction을 실어
//        figureScore가 up 한정 판정.
// 2.11.0: [계약 무변경] 캡션 문법 확장 (M1 점없는 문자+숫자 번호 · M2 괄호 한정구) — 보충/부록 캡션의
//        모든 표면표기를 탐지해 canonical(점형 S.N·A.N·ED.N)로 방출한다(EVAL §4.5 정체성 규약). 세 갈래:
//        ① inline 문자+숫자 — "FIG. S1." "Fig. S1:" "Figure S1" "Figure S.1" "Figure A1"(점 유무·구분자
//        . : | 양형·두자리·자간분리)를 번호 클래스 `[A-DS]\.?\d+`로 잡아 normNum이 점형(S.1·A.1)으로 통일.
//        CAP_RE·CAP_RE2·TABLE_CAP_RE(2)·HARD_STITCH_NUM_RE가 같은 클래스를 공유(형식 교체 저비용).
//        문자접두는 대문자 case-sensitive(라벨만 대소문자 관용) — 공백제거 경로에서 복수형 "Figures 2.0"이
//        "Figure"+소문자"s2"→S.2로 오탐되던 것을 차단(pdf2.0). 실제 보충/부록 라벨은 항상 대문자 S/A.
//        ② 접두 확장 — SPECIAL_CAP_RE(2)에 supplemental|supporting|supp. 추가(physrevapplied det=0 직접원인).
//        ③ M2 괄호 한정구 — 번호와 구분자 사이 `(...)`(≤24자) 허용: "FIG. 3 (color online)." "Figure 1
//        (Gardner)."(Penn 저자명). 오탐 가드 = hard 구분자(. : |) 필수 + 괄호 내용 대문자 시작 또는
//        color online만("Fig. 2 (left)." 소문자·위치어 배제). ★ soft 문서 게이트의 hard 카운트에서
//        보충/부록 계열(S·ED·A~D) 앵커를 제외 — 본문 soft + 보충 Fig.S1 문서에서 게이트 플립으로
//        soft 앵커 4편(Robertson·Fauzi·PAH·Kim)이 전멸하는 것을 방지. soft(v2.9.1)·임베디드(v2.9.2)·
//        buildLines·픽셀 스캔 무변경. 출력 필드·좌표계·(num,page) 키·manifest 스키마 불변.
//        astro A.1/A.2·SM inline Fig.S1 계열 미탐 해소. 전수 diff로 gate FP·앵커 무악화 확인.
// 2.10.2: [계약 무변경] offset side-by-side 컬럼 분리 (S2 클러스터 A 2차) — baseline이 어긋난 나란한
//        형제(키 큰/작은 이웃 — Dong Fig4는 Fig3보다 141pt 아래, same-baseline ≤24pt 규칙 밖)를 분리한다.
//        v2.10.1 per-candidate clamp(same-baseline)은 그대로 두고, 페이지 말미에 **검출된 up-figure**
//        기반 후처리를 추가: F·G 둘 다 up 후보이고 캡션 컬럼이 disjoint하며 두 영역이 **세로로 겹치면**
//        (=같은 행) F의 침범한 x를 자기 캡션 가장자리±SIBLING_COL_MARGIN으로 되돌린다. 캡션 앵커가
//        아니라 검출된 up-figure끼리 보는 게 3중 안전장치: ①up 한정(side/down 캡션은 figure와 다른
//        컬럼이라 역클램프·소멸 위험 — Saunders Fig6·ieee side 방지) ②검출 figure만(phantom 상호참조
//        "Fig. 3." CHOSE none 배제 — physrevb·ieee) ③영역 세로겹침(stacked 다른 행 배제 — acs·springer;
//        진짜 전폭 figure는 겹치는 up-형제가 없어 자연 미클램프). 병합 블록 전폭이어도 크롭은 x-slice라
//        분리. Dong Fig3@p6 other_fig_merged 완화(gate critical, IoU 0.43→0.86). same-baseline 제외로
//        v2.10.1 게이트 결과(pdf2.0·Structural·Aegaeon) 보존. 전수 diff로 phantom·stacked·side 오클램프 0 확인.
// 2.10.1: [계약 무변경] 나란한 컬럼 병합 방지 (S2 클러스터 A 1차) — 같은 baseline(캡션 라인 기준)의
//        다른 컬럼 형제 figure가 있고 이 figure의 최종 x범위가 형제 캡션 컬럼으로 실제 침범했을 때만
//        (crossing guard) 자기 캡션 가장자리로 x를 되돌린다(up 후보 post-scan x-clamp). 병합 블록은
//        전폭이어도 크롭은 x-slice라 컬럼이 분리된다. crossing guard가 narrow 캡션 형제(Structural
//        Fig9)의 과클립을 막고, 임베디드 형제(Aegaeon 15/16)·stacked·단일 figure는 자연 미발동.
//        pdf2.0 Fig6/7·Structural Fig5/10 other_fig_merged 완화. Dong(offset side-by-side)은 후속.
// 2.10.0: [계약 무변경] table 캡션 경계 (방출 없음) — "Table N"/"TABLE N"/자간분리 "T A B L E N"을
//        경계로만 인식한다. table 캡션은 자기 table '위'에 있으므로, up-scan이 캡션 블록에 닿으면
//        STOP하고 캡션 아래로 작은 갭(<TABLE_GAP_PT)으로 이어지는 블록 run(=table 본체)을 소급 제외한다
//        (★ 방향 함정: OTHER-CAP의 "캡션 아래 포함"을 table에 쓰면 정반대로 동작). 종결 갭 없이 전부
//        먹으면 롤백을 취소해 figure 손실을 막는다(병합 케이스 방어). 가드: incl 비었을 때·블록 높이
//        >TABLE_CAP_BLOCK_MAX·BODY stop 우선(본문 "Table 1. ..." 오탐이 stopper로 먼저 걸림)에서 미발동.
//        문법은 isCaption과 동일(hard 구분자 . : | 또는 짧은 무구분자·자간분리). 방출·prefilter·truth 행 없음.
//        Blockchain Fig4/18·Structural Fig13의 other_fig_merged 완화. (무구분자 "TABLE N <제목>" soft
//        표기는 미지원 — figure soft 캡션(v2.9.1)처럼 문서 게이트가 필요해 후속으로 분리.)
// 2.9.3: [계약 무변경] 줄끝 종결형 길이 가드에서 접두어 길이 제외 — "Extended Data Fig. 1"처럼
//        번호 뒤 구두점 없이 끝나는 접두 계열 라벨이 접두어("Extended Data " 14자)만으로 14자
//        예산을 소진해 거부되던 문제. 가드는 "라벨에 딸린 텍스트 분량"을 재려는 것이므로
//        matchCaption이 lead(접두어 길이)를 돌려주고 예산에서 뺀다. 맨 Figure N 계열은 무변경.
// 2.9.2: [계약 무변경] 임베디드 캡션 앵커 — 나란한 figure의 캡션들이 같은 baseline에 있고 조각 간
//        x-갭이 8pt 미만이라 buildLines가 한 라인으로 합쳐 앞 번호만 앵커되던 경우, 그 라인을
//        라벨 조각 기준으로 세그먼트 분해해 형제 앵커를 만든다. 발동은 "이미 hard 앵커로 인정된
//        라인"에 한정해 본문 상호참조 오탐을 원천 차단하고, buildLines의 8pt 분리 규칙과 라인
//        geometry는 건드리지 않는다. 형제끼리는 서로의 라벨 x를 확장 한계로 삼는다. Aegaeon Fig15/16.
// 2.9.1: [계약 무변경] soft 캡션 앵커 — 번호 뒤 구분자가 없는 표기("Fig. 1 Experimental roadmap …",
//        Wiley 자간 분리 "F I G U R E 1 Bar chart …")를 후보로 모으고, 문서 수준 게이트
//        (hard 앵커 총수 0 + 같은 라벨폼 2회 이상)를 통과한 문서에서만 앵커로 승격한다.
//        본문 상호참조("Figure 5 shows …")는 번호 뒤 본문이 대문자로 시작할 것을 요구해 배제.
//        기존 hard 경로(isCaption·CAP_RE 계열·hard stitch)는 무변경. Robertson·Fauzi·PAH·Kim 미탐지 해소.
// 2.9.0: [계약 무변경] 서브패널 라벨 면제 — figure 내부의 "(a) …" 서브캡션 행(같은 baseline 타일
//        또는 인라인 나열, 같은 계열 오름 연속 마커)이 dom 폰트·본문 폭이어도, 캡션 바로 위 "첫"
//        블록에 한해 BODY stop에서 면제한다. 면제는 빈 결과만 뒤집을 수 있고 기존 영역을 넓히지
//        못한다(첫 블록 한정 + all-exempt + 24pt 인접). Ju Fig3·Aegaeon Fig12·ICLR B.1 미탐지 해소.
// 2.8.0: [계약 무변경] hard caption anchor를 page prefilter와 탐지에서 공유하고,
//        up/down/left/right 후보를 공통 채점·선택기에 통합. side column-profile scan과
//        본문·캡션·margin stopper, frame/raster 보호, sliver/tail tightening을 추가.
//        공개 export·결과 필드·좌표계·(num,page) 식별자·manifest 스키마 불변.
// 2.7.0: [계약 무변경] label-above(캡션 바로 아래 figure) 하향 재시도 감지.
//        현행 상향 결과를 먼저 보존하고, 이상 신호가 있을 때만 캡션 아래 후보를 대칭 스캔·공통 채점해
//        유의하게 나은 경우에만 교체하는 재시도 scaffold 도입. 출력 필드·(num,page) 키·좌표계 불변.
// 2.6.0: Extended Data("ED.N")·Supplementary/선행 S("S.N") 캡션 감지 추가 [계약 무변경].
//        전용 정규식과 isCaption num 매핑을 확장. 기존 "Figure N" 출력·구분자 방어 불변.
// 2.5.1: 메모리 패치 (PDFViewer#12) — ① 페이지 스캔 상한 기본값(60) 제거: 미지정 시 전체 페이지 스캔,
//        opts.maxPages는 선택적 상한으로 유지. ② figure.canvas(페이지 전체 렌더 보관) 폐지 → 스캔 중
//        즉시 크롭한 figure.cropCanvas로 대체: 페이지 캔버스 동시 상주 최대 1장, dedup·크기 필터를
//        페이지 루프 안으로 이동(탈락 후보는 크롭 생략). 탐지·bbox 로직 무변경 (스냅샷 물리 diff 0 기대).
//        ③ opts.signal abort 시 진행 중 페이지 렌더도 RenderTask.cancel()로 즉시 중단(페이지 경계 대기 제거).
// 2.5.0: [BREAKING] figures의 num 유일성 폐기 — dedup을 (num, page) 인스턴스 단위로 완화 (PDFViewer#14:
//        합본 논문·부록 번호 재시작 보존. 같은 페이지 중복만 score 선택). 정렬을 page→num 자연순으로 결정화.
//        소비자 식별 키는 (num, page) — Margin은 fig{num}-p{page} ID로 이미 대응.
//        + opts.signal(AbortSignal) 협조 취소 지원 (PDFViewer#12, 페이지 단위 체크)
// 2.4.0: [필드 추가] suspectedMissing — 감지된 정수 번호 1..최대 중 빠진 번호 목록 (미탐지 의심 후처리).
//        감지·bbox 로직 무변경. QA(review.html)와 소비자(Margin)가 같은 추론을 공유하기 위해 엔진으로 이동
// 2.3.0: [BREAKING] method 필드 제거 — 감지 경로가 아니라 "영역이 래스터 이미지와 겹치는지"의
//        사후 라벨이었음. 중복 번호 dedup 내부용으로만 유지. 헤더 정리·globalThis 노출 포함. bbox 로직 무변경
// 2.2.1: opts.pdfDocument 지원 — 호스트(Margin 뷰어)가 이미 로드한 PDFDocumentProxy 재사용 (재파싱 방지)
// 2.2.0: region(그림만)/캡션(텍스트) 분리 출력, confidence 추가(현재 1.0 고정), renderPage 주입 지원
// 2.1.1: pdf.js 3.11.174 → 4.10.38 (Margin과 버전 일치). 알고리즘 무변경

/* ===================== 상수 (pt 단위 기준) ===================== */
/* 번호 클래스 (v2.11.0) — 정수·소수·로마 + 문자접두 계열(부록 A~D·보충 S). 문자접두는 점 유무 양형
 * `[A-DS]\.?\d+`(Figure A1 / Figure A.1 / Fig. S1 / Figure S.1)을 잡고 normNum이 점형(A.1·S.1)으로 통일한다
 * (EVAL §4.5 정체성 규약). CAP_RE·CAP_RE2·TABLE_CAP_RE(2)·HARD_STITCH_NUM_RE가 이 클래스를 공유한다.
 * 순서: 문자접두를 정수보다 앞에 둬야 "A1"이 A로 시작해 잡힌다. 로마 C/D와 부록 C/D는 숫자 유무로 갈린다
 * (`C1`=부록 C.1, `C`=로마). soft(SOFT_CAP_RE)는 S 확장 대상 아님 — 무변경.
 * ★ 문자접두는 대문자 case-sensitive(`[A-DS]`, /i 미적용) — 공백제거 경로에서 복수형 "Figure⎵s⎵2.0"이
 *   "Figure"+소문자"s2"로 붙어 S.2 오탐되던 것을 차단한다(pdf2.0 "Figures 2.0"). 실제 보충/부록 라벨은
 *   항상 대문자 S/A. 라벨(fig/FIG/Figure)만 LABEL로 대소문자 관용, 번호 문자는 대문자만. */
const NUM_CLASS = String.raw`[A-DS]\.?\d+|\d+(?:\.\d+)?|[IVXLC]+`;
const LABEL = String.raw`[Ff][Ii][Gg](?:[Uu][Rr][Ee])?`;   // fig/FIG/Fig/figure/FIGURE/Figure (혼용 대소문자)
// 확장 캡션 정규식: "Extended Data Fig. 1" / "Supplementary Figure 1" / "Supplemental Figure 1" / "Supp. Fig 1"
/* 접두어를 공백까지 포함해 캡처한다 — 줄끝 종결형 길이 가드가 접두어 길이에 잠식되지 않도록
 * matchCaption이 lead(접두어가 차지한 문자 수)를 함께 돌려주기 위함 (v2.9.3).
 * supplemental|supporting|supp.는 v2.11.0 추가 (physrevapplied "Supplemental Figure N." det=0 직접원인). */
const SPECIAL_CAP_RE  = /^((?:extended data|supplementary|supplemental|supporting|suppl\.|supp\.)\s+)(?:figure|fig)\s*\.?\s*(\d+)\s*([.:|]|$)/i;
const SPECIAL_CAP_RE2 = /^(extendeddata|supplementary|supplemental|supporting|suppl\.|supp\.)(?:figure|fig)\.?(\d+)([.:|]|$)/i;
// PLOS 선행형: "S1 Fig. ..." / "S12 Figure: ..."
const LEADING_S_CAP_RE  = /^S(\d+)\s+(?:figure|fig)\s*\.?\s*([.:|]|$)/i;
const LEADING_S_CAP_RE2 = /^S(\d+)(?:figure|fig)\.?([.:|]|$)/i;
/* 기본 캡션 정규식: "Figure 1:" "Fig. 2." "Fig. 3 |" "FIGURE 4" "Figure A.1:" "Figure A1." "Fig. S1." "Figure IV." 등.
 * v2.11.0: 번호 뒤·구분자 앞에 괄호 한정구 `(...)`(≤24자) 옵션 그룹 추가 (M2 — "FIG. 3 (color online)."·
 * Penn "Figure 1 (Gardner)."). 그룹 = [1]라벨 [2]번호 [3]괄호내용(선택) [4]구분자. 괄호 가드는 matchCaption. */
const CAP_RE  = new RegExp(String.raw`^(${LABEL})\s*\.?\s*(${NUM_CLASS})\s*(?:\(([^)]{1,24})\)\s*)?([.:|]|$)`);
// 공백 제거 버전: PDF.js가 small-caps를 "F IGURE 2"처럼 조각내는 경우 대응
const CAP_RE2 = new RegExp(String.raw`^(${LABEL})\.?(${NUM_CLASS})(?:\(([^)]{1,24})\))?([.:|]|$)`);
/* ---- soft 캡션 (v2.9.1): 번호 뒤 구분자가 없는 표기 "Fig. 1 Experimental roadmap …".
 * RSC·Springer·Wiley가 널리 쓰지만 본문 상호참조("Figure 5 shows …")와 형태가 같아, 후보로만
 * 모아두고 문서 수준 게이트(promoteSoftAnchors)를 통과한 것만 앵커로 승격한다. ---- */
const SOFT_CAP_RE  = /^(figure|fig)\s*\.?\s*(\d+(?:\.\d+)?|[A-D]\.\d+)(.*)$/i;
const SOFT_CAP_RE2 = /^(figure|fig)\.?(\d+(?:\.\d+)?|[A-D]\.\d+)(.*)$/i;
/* 번호 뒤: (선택)소문자 패널 라벨 "a" "a–c" → 공백 → 대문자·괄호·따옴표로 캡션 본문 시작.
 * 이 한 규칙이 본문 상호참조 배제의 전부다 — "shows/illustrates/presents/depicts"가 전부
 * 소문자로 시작하고, "Fig. 6a is glass-bottomed"·번호 뒤 ,); 도 같은 조건에서 탈락한다.
 * 라벨부(/i)와 본문 머리 판정을 분리해야 한다: /i를 한 정규식에 걸면 [A-Z]가 소문자까지 먹는다. */
const SOFT_BODY_RE  = /^(?:[a-z](?:\s*[–—-]\s*[a-z])*)?\s+[A-Z(\[“‘"•]/;
const SOFT_BODY_RE2 = /^(?:[a-z](?:[–—-][a-z])*)?[A-Z(\[“‘"•]/;
/* 공백 제거 경로는 자간 분리 라벨(Wiley "F I G U R E")에만 허용 — 무제한 허용하면
 * "Figure 2B is a composite" 류가 어절 경계 소실로 통과한다. */
const SOFT_SPACED_RE = /^(?:[A-Za-z]\s){3,}/;
const SOFT_FORM_MIN     = 2;   // 같은 라벨폼이 문서 내 반복돼야 하는 최소 횟수
/* soft 문서 게이트 라우터 (v2.14.0) — hardBody(= 본문 figure hard 관습 증거) 기준 3-체제:
 *   hardBody == 0            → 전량승격 (구 SOFT_DOC_HARD_MAX=0 경로)
 *   1 .. SOFT_GATE_K-1       → 애매역 (잠정승격 → up-점수 floor 검증 → 강등 → 재실행 fixpoint)
 *   >= SOFT_GATE_K           → 전량기각
 * hardBody = 비-family sep 앵커 수 + 반복 동형 bare(같은 form ≥2) 수. 고립 bare(맨-라벨 wrap 잔재)는 제외.
 * ★ k=2 근거 = "빈·미검증 {2,3} 밴드에 대한 애매역 최소 노출(보수)". 현 코퍼스 hardBody 분포는
 *   0(다수)·1{Rivaroxaban·s10854·s11269}·4(Balci)·8(wiley)·9(Vaquero)·17(acm)로 {2,3}이 공집합이라
 *   k∈{2,3,4}는 회귀-동등하다. UP_FLOOR가 regime을 대체하지 못한다는 핵심 통찰은 k≥5에서 성립한다
 *   (그때 Balci 본문상호참조 phantom up=10.86 > 8.5로 floor를 뚫는다) — 그래서 k를 키우지 않는다. */
const SOFT_GATE_K   = 2;
/* 애매역 잠정승격 soft 앵커의 최소 up-점수. healthy 바(8.0, minScore)보다 엄격하게 둔다 —
 * 애매역 phantom(Rivaroxaban 캡션페이지 얇은 스트립 up=7.90)과 진짜 soft 캡션(전수 프로브 최저 9.57)
 * 사이 gap(7.90 … 9.57)의 중앙. 8.0 재사용은 phantom margin 0.10으로 batch 비결정성에 취약해 불가.
 * ⚠ 3편(reject 1 phantom + target 2 recover) 실측 기반 잠정치 — 애매역 hardBody==1 문서가 늘면 재교정. */
const SOFT_UP_FLOOR = 8.5;
/* ---- table 캡션 (v2.10.0): 방출하지 않고 경계로만 쓴다. isCaption과 동일한 번호·구분자 문법의 table
 * 버전 — 단 대문자 Table/TABLE만 허용해 본문 "table 3. With ..." 소문자 오탐을 배제한다. 무구분자
 * "TABLE N <제목>"(Frontiers/Springer soft 표기)은 미지원(후속 — 문서 게이트 필요, figure v2.9.1과 동형). ---- */
const TABLE_CAP_RE  = new RegExp(String.raw`^(?:Table|TABLE)\s*\.?\s*(${NUM_CLASS})\s*([.:|]|$)`);
const TABLE_CAP_RE2 = new RegExp(String.raw`^(?:Table|TABLE)\.?(${NUM_CLASS})([.:|]|$)`);
const TABLE_GAP_PT = 15;         // 롤백 run 연결 임계 (블록 분리 4.8pt < T < 상단 슬리버 40pt; gate 표적 창 교집합)
const TABLE_CAP_BLOCK_MAX = 60;  // 이보다 높은 블록의 table 캡션은 figure와 병합된 것으로 보고 미발동(Aegaeon 8@p8 방어)
const SAME_BASELINE_PT = 24;     // 나란한 컬럼 형제 판정 — 캡션 라인 baseline 차(v2.10.1). stacked(Δ≥100) 배제
const SIBLING_COL_MARGIN = 12;   // 자기 캡션 가장자리 밖으로 그래픽이 살짝 넓을 여지 (v2.10.1·v2.10.2 공용)
const HUGE_COVERAGE_MIN = 0.54;  // hugePenalty 면제 커버리지 임계 (v2.13.0) — 잉크 90% 질량 폭이 영역 폭의
                                 // 이 비율 이상이면 진짜 전폭 figure로 보고 면제. clip 표적 min 0.58 vs
                                 // Simões4 over-grab 0.50 분리점(전수 실측). farClosed‖!raster 프록시에 보강(OR).
const HUGE_WIDTH_MIN = 0.60;     // coverage 면제 폭 바닥 가드 (v2.13.1) — coverage는 후보 '자기 폭' 기준
                                 // 밀도라 좁고 긴 후보(hugeCond가 heightRatio>0.82 단독 발동)도 자기 폭 안
                                 // 잉크가 조밀하면 면제될 수 있다. 페이지 폭의 이 비율 미만이면 '전폭'이
                                 // 아니므로 coverage 면제를 불허(프록시 경로는 무관). clip 전건 widthRatio≥0.82.
const S = 2.2;             // 분석/크롭 렌더 스케일 (px per pt)

/* ===================== 기하 유틸 ===================== */
const ox = (a, b) => Math.min(a.left + a.w, b.left + b.w) - Math.max(a.left, b.left);
const mul = (m, n) => [
  m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1],
  m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3],
  m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]
];

/* ===================== 텍스트 라인 구성 ===================== */
// PDF.js 텍스트 조각(fragment)을 시각적 "줄(line)" 단위로 병합.
// 같은 baseline끼리 묶고, 8pt 넘는 x-갭에서는 별도 라인으로 분리(컬럼 경계 보호).
function buildLines(tc, pageH) {
  const frags = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const h = Math.abs(it.height || it.transform[3]) || 9;
    frags.push({ left: it.transform[4], top: pageH - it.transform[5] - h,
                 w: it.width || 0, h, font: it.fontName, s: it.str });
  }
  frags.sort((a, b) => (a.top + a.h) - (b.top + b.h) || a.left - b.left);
  const groups = [];
  for (const f of frags) {
    const g = groups[groups.length - 1];
    if (g && Math.abs((f.top + f.h) - g.bl) < Math.max(2, f.h * 0.45)) g.fr.push(f);
    else groups.push({ bl: f.top + f.h, fr: [f] });
  }
  const lines = [];
  for (const g of groups) {
    g.fr.sort((a, b) => a.left - b.left);
    const chunks = [[g.fr[0]]];
    for (const f of g.fr.slice(1)) {
      const cur = chunks[chunks.length - 1];
      if (f.left - (cur[cur.length-1].left + cur[cur.length-1].w) > 8) chunks.push([f]);
      else cur.push(f);
    }
    for (const ch of chunks) {
      const left = Math.min(...ch.map(f => f.left));
      const right = Math.max(...ch.map(f => f.left + f.w));
      const top = Math.min(...ch.map(f => f.top));
      const bot = Math.max(...ch.map(f => f.top + f.h));
      let s = "", prev = null;
      for (const f of ch) {
        if (prev !== null && f.left - prev > 1) s += " ";
        s += f.s; prev = f.left + f.w;
      }
      s = s.trim();
      if (!s) continue;
      const main = ch.reduce((a, b) => a.w >= b.w ? a : b);
      /* frags: 이 라인을 구성한 조각 배열 (v2.9.2 임베디드 캡션 앵커용).
       * left/w/top/h/s/font는 그대로 — 라인 geometry가 바뀌면 stopper 폭 조건·dom 폰트 가중·yPre가
       * 전부 흔들리므로 조각 정보만 덧붙이고 기하는 한 값도 건드리지 않는다. */
      lines.push({ left, w: right - left, top, h: bot - top, s, font: main.font, frags: ch });
    }
  }
  return lines;
}

/* ===================== 캡션 판별 ===================== */
/* num 정규화 (v2.11.0) — 문자접두 계열(부록 A~D·보충 S)의 표면표기(점 유무·대소문자)를 점형 canonical로
 * 통일한다: "S1"·"S.1"→"S.1", "A1"·"a.1"→"A.1". 정수·소수·로마는 대문자화만(정체성 그대로). EVAL §4.5.
 * ED/보충 접두 계열은 SPECIAL/LEADING에서 이미 점형이라 여기 오지 않는다. canonical 형식 교체는 이 함수 1곳. */
function normNum(raw) {
  const m = /^([A-DS])\.?(\d+)$/i.exec(raw);
  if (m) return `${m[1].toUpperCase()}.${m[2]}`;
  return raw.toUpperCase();
}
/* M2 괄호 한정구 허용 판정 — 대문자 시작(저자명 "Gardner"·"Gentner & Christie") 또는 color online류만.
 * 소문자 위치·패널어("left"·"a"·"inset")를 배제해 라인선두 상호참조 "Fig. 2 (left)."를 걸러낸다. */
function m2ParenOk(p) {
  const t = p.trim();
  return /^[A-Z]/.test(t) || /^colou?r\s*online$|^online$/i.test(t);
}
/* 보충/확장/부록 계열 num 판별 — soft 문서 게이트의 hard 카운트 제외용 (v2.11.0 ★). */
const isFamilyNum = n => /^(?:S|ED|[A-D])\./.test(n);

/* lead = 접두 계열("Extended Data " 등)이 차지한 문자 수. 줄끝 종결형 길이 가드는
 * "라벨 말고 딸린 텍스트가 얼마나 되나"를 재려는 것이므로 접두어는 예산에서 빼야 한다 (v2.9.3). */
function matchCaption(s, compact) {
  let m = (compact ? SPECIAL_CAP_RE2 : SPECIAL_CAP_RE).exec(s);
  if (m) {
    const prefix = m[1].trim().toLowerCase().startsWith("extended") ? "ED" : "S";
    return { num: `${prefix}.${m[2]}`, sep: m[3] || "", lead: m[1].length };
  }
  m = (compact ? LEADING_S_CAP_RE2 : LEADING_S_CAP_RE).exec(s);
  if (m) return { num: `S.${m[1]}`, sep: m[2] || "", lead: 0 };
  m = (compact ? CAP_RE2 : CAP_RE).exec(s);
  if (m) {
    const paren = m[3], sep = m[4] || "";     // [3]=괄호내용(선택) [4]=구분자 (v2.11.0 M2)
    if (paren !== undefined) {                // 괄호 한정구가 있으면: hard 구분자 필수 + 내용 가드
      if (![".", ":", "|"].includes(sep)) return null;
      if (!m2ParenOk(paren)) return null;
    }
    return { num: normNum(m[2]), sep, lead: 0 };
  }
  return null;
}

/* 캡션 라벨 앞 삼각 글리프 (v2.19.2) — Nature Reviews "◀ Fig. 1 |", Springer "◂Fig. 5 …"처럼
 * 조판 장식이 라벨 앞에 붙는 조판이 있다. buildLines가 이 글리프를 캡션과 **같은 줄로 병합**하므로
 * (베이스라인 차 2.9pt < 허용치, x-갭 4.8pt < 8pt) `^(Fig|Figure)`가 깨져 앵커가 아예 생성되지 않는다.
 * 판정 입력에서만 벗겨낸다 — line.s 원본은 그대로라 캡션 텍스트·박스 계산에 영향이 없다.
 * ★ 코드포인트는 열거로 못 박는다: 전 코퍼스 330편에서 줄 시작 출현이 8건뿐이고 그중 figure 라벨을
 *   끄는 것은 대상 4건이다(나머지는 글리프 단독 줄과 "►Additional supplemental" 1건). 오탐 표면 0.
 * ★ 길이 가드(12/14자)는 **벗겨낸 문자열 기준**으로 잰다 — 글리프는 캡션 텍스트가 아니므로 예산을
 *   먹지 않는다. 그 결과 "◀ Fig. 5"는 "Fig. 5"와 정확히 같게 판정된다. */
/* v2.19.4: 열거를 **관측된 2자로 좁힌다**. 우향(▶▸►▹)은 캡션 접두로 관측된 적이 없고,
 * 코퍼스의 유일한 우향 사례는 비-캡션 불릿("►Additional supplemental")이다 — SI 목록의
 * "► Figure S1. …" 같은 불릿을 앵커로 만들 위험만 있고 얻는 것이 없다. 새 사례가 관측되면
 * 그때 추가한다. */
const CAPTION_LEAD_GLYPH_RE = /^[◀◂]\s*/;
const captionTestText = s => s.replace(CAPTION_LEAD_GLYPH_RE, "");

function isCaption(line) {
  const text = captionTestText(line.s);
  let match = matchCaption(text, false);
  if (!match) {
    const stripped = text.replace(/\s+/g, "");
    match = matchCaption(stripped, true);
    if (!match) return null;
    if (![".", ":", "|"].includes(match.sep) && stripped.length - match.lead > 12) return null;
    return match.num;
  }
  if (![".", ":", "|"].includes(match.sep) && text.length - match.lead > 14) return null;
  return match.num;
}

/* table 캡션 판별 (v2.10.0) — isCaption과 동일 규율의 table 버전. 방출하지 않고 경계로만 소비한다.
 * hard 구분자(. : |)는 항상, 무구분자(자간분리 "T A B L E N" 포함)는 짧을 때만 허용(isCaption 12/14자 가드).
 * 대문자 Table/TABLE만 매칭해 본문 "table 3. With longer ..." 소문자 상호참조를 배제한다. */
function isTableCaption(line) {
  /* v2.19.2: figure 라벨에만 글리프를 관용하면 같은 조판의 "◀ Table 3."이 경계로 인식되지 않아
   * 영역이 표를 넘어 자란다. 같은 규율을 적용한다. */
  const text = captionTestText(line.s);
  let m = TABLE_CAP_RE.exec(text);
  if (m) {
    if (![".", ":", "|"].includes(m[2]) && text.length > 14) return false;
    return true;
  }
  const stripped = text.replace(/\s+/g, "");
  m = TABLE_CAP_RE2.exec(stripped);
  if (m) {
    if (![".", ":", "|"].includes(m[2]) && stripped.length > 12) return false;
    return true;
  }
  return false;
}

/* isCaption이 거부한 라인 중 "번호 뒤 구분자 없는 캡션"만 골라낸다 (v2.9.1).
 * 반환 {num, form} — form은 문서 내 라벨 표기 관습 키("fig"|"figure"|"spaced").
 * isCaption과 상호배타적: 구분자가 있으면 SOFT_BODY_RE의 공백 요구에서 탈락한다.
 * isCaption의 길이 가드(12/14자)는 soft 경로에 적용하지 않는다 — 그 자리를
 * SOFT_BODY_RE(본문 대문자 시작)와 SOFT_SPACED_RE(자간 분리 한정)가 대신한다. */
function softCaptionOf(line) {
  /* v2.19.2: hard 경로(isCaption)와 **같은 접두 처리**를 여기에도 적용한다. soft는 matchCaption을
   * 거치지 않고 자기 정규식을 raw line에 직접 들이대므로, isCaption만 고치면 Springer "◂Fig. 5 …"
   * 같은 무구분자 조판은 후보조차 생기지 않는다(자간분리 경로도 선두 글리프에서 즉시 실패한다). */
  const text = captionTestText(line.s);
  let m = SOFT_CAP_RE.exec(text);
  if (m && SOFT_BODY_RE.test(m[3]))
    return { num: m[2].toUpperCase(), form: m[1].toLowerCase() };
  if (!SOFT_SPACED_RE.test(text)) return null;
  m = SOFT_CAP_RE2.exec(text.replace(/\s+/g, ""));
  if (m && SOFT_BODY_RE2.test(m[3]))
    return { num: m[2].toUpperCase(), form: "spaced" };
  return null;
}

const HARD_STITCH_NUM_RE = new RegExp(String.raw`^(${NUM_CLASS})\s*([.:|])(?!\d)(?:\s*.*)?$`);   // 문자접두 대문자 (case-sensitive, 위 ★)
const STITCH_GAP_PT = 18;

/* slots(라인 순서)를 걷되 각 라인 뒤에 그 라인에서 분해된 임베디드 앵커를 이어 붙인다.
 * anchors 순서는 detectPage의 밴드 한계(exL/exR)·otherCaps가 소비하므로 결정적이어야 한다. */
function assembleAnchors(slots, embedded) {
  const out = [];
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]) out.push(slots[i]);
    const emb = embedded && embedded.get(i);
    if (emb) for (const a of emb) out.push(a);
  }
  return out;
}

/* buildLines의 8pt 컬럼 보호로 Figure/Fig.와 번호가 갈라진 경우만 hard anchor로 복원한다. */
function captionAnchors(lines, dbg) {
  const slots = new Array(lines.length);
  const ownerByPart = new Map();
  const infoByAnchor = new Map();
  const bottom = u => u.top + u.h;
  const boxOf = parts => {
    const left = Math.min(...parts.map(u => u.left));
    const right = Math.max(...parts.map(u => u.left + u.w));
    const top = Math.min(...parts.map(u => u.top));
    const bot = Math.max(...parts.map(bottom));
    return { left, w: right - left, top, h: bot - top };
  };
  const sameBaseline = (a, b) =>
    Math.abs(bottom(b) - bottom(a)) < Math.max(2, b.h * 0.45);
  /* v2.19.2: stitch 선두 조각도 글리프를 벗기고 본다 ("◀ Fig." + 8pt 초과 갭 + "1 | Title"). */
  const hardPrefix = u => /^(?:figure|fig)\.?$/i.test(captionTestText(u.s).replace(/\s+/g, ""));

  /* 기존 isCaption 결과는 clone하지 않고 동일 raw line 객체·순서로 보존한다. */
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], num = isCaption(line);
    if (!num) continue;
    /* isCaption과 **같은 입력**으로 재조회해야 한다 — 여기서만 raw line을 쓰면 글리프 접두 라인의
     * match가 null이 되어 hard 판정이 조용히 soft로 강등된다 (v2.19.2). */
    const text = captionTestText(line.s);
    let match = matchCaption(text, false);
    if (!match) match = matchCaption(text.replace(/\s+/g, ""), true);
    slots[i] = line;
    ownerByPart.set(line, line);
    infoByAnchor.set(line, {
      num,
      hard: !!match && [".", ":", "|"].includes(match.sep),
      stitched: false,
      parts: [line],
      labelBox: boxOf([line])
    });
  }

  /* 1b) 임베디드 캡션 앵커 (v2.9.2) — 나란한 figure의 캡션들이 같은 baseline에 있고 조각 간
   * x-갭이 8pt 미만이면 buildLines가 한 라인으로 합쳐 앞 번호만 앵커된다 (Aegaeon p12:
   * "Figure 14. … across Figure 15. Left: … Figure 16. …"). 그 라인을 라벨 조각 기준으로
   * 세그먼트 분해해 형제 앵커를 만든다.
   * ★ 발동 조건을 "이미 loop-1이 hard 앵커로 인정한 라인"으로 한정하는 것이 핵심이다 —
   *   모든 라인의 조각을 훑으면 본문 상호참조("… (Figure 1J). Notably, Figure 1K presents …")가
   *   가짜 앵커가 된다 (Wei-2026 p5/p10, Weiss p6에서 실측).
   * buildLines의 8pt 분리 규칙 자체는 건드리지 않는다 (Aslin 유래 앵커 보호). */
  const embedded = new Map();
  const hardLabelOf = frag => {
    /* v2.19.2: 첫 조각에 글리프가 붙으면 형제 분해가 통째로 무발동이 된다
     * ("◀Figure 14. … Figure 15. …"에서 Fig 15 이후가 조용히 소실). */
    const m = matchCaption(captionTestText(frag.s.trim()), false);
    return m && [".", ":", "|"].includes(m.sep) ? m.num.toUpperCase() : null;
  };
  const joinFrags = fr => {
    let s = "", prev = null;
    for (const f of fr) { if (prev !== null && f.left - prev > 1) s += " "; s += f.s; prev = f.left + f.w; }
    return s.trim();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (slots[i] !== line || !line.frags || line.frags.length < 2) continue;
    const info0 = infoByAnchor.get(line);
    if (!info0 || !info0.hard) continue;
    const labelIdx = [];
    for (let k = 0; k < line.frags.length; k++)
      if (hardLabelOf(line.frags[k])) labelIdx.push(k);
    /* 선두 조판 글리프가 **독립 조각**이면 첫 라벨 인덱스가 0이 아니게 되어 형제 분해가 통째로
     * 무발동이 된다 (v2.19.4). 글리프만으로 이뤄진 선두 조각은 라벨 위치 계산에서 건너뛴다 —
     * hardLabelOf에 글리프 관용을 넣는 것만으로는 이 게이트를 통과하지 못한다. */
    let firstContentIdx = 0;
    while (firstContentIdx < line.frags.length &&
           captionTestText(line.frags[firstContentIdx].s).trim() === "") firstContentIdx++;
    if (labelIdx.length < 2 || labelIdx[0] !== firstContentIdx) continue;

    /* ★ 중첩 라벨 계열 경합 (v2.16.0) — 줄의 identity(첫 라벨)가 ED인데 같은 줄에 S 라벨이 섞여
     * 있으면 그 S는 형제로 만들지 않는다. 한 영역이 동시에 Extended Data이면서 Supplementary일 수
     * 없고, ED는 Nature 계열 전용 표기라 같은 문서가 같은 그림에 S 번호를 겹쳐 붙이지 않는다
     * (Goldstein-2022은 저자가 옛 S 표기를 ED 캡션 본문에 남긴 오제출). 남는 라벨이 1개면 분해
     * 자체를 하지 않으므로 loop-1의 ED 앵커가 그대로 줄을 소유하고 sibL/sibR clamp도 생기지 않는다.
     * 겹침 임계나 기하는 쓰지 않는다 — 근거는 "같은 물리 캡션 라인"이라는 사실뿐이다. */
    const famOf = k => {
      const n = hardLabelOf(line.frags[k]);
      return /^ED\./.test(n) ? "ED" : /^S\./.test(n) ? "S" : "other";
    };
    let keptIdx = labelIdx;
    if (famOf(labelIdx[0]) === "ED" && labelIdx.some(k => famOf(k) === "S")) {
      keptIdx = labelIdx.filter(k => famOf(k) !== "S");
      if (dbg) dbg(`  [split] line T${line.top.toFixed(0)} ED>S suppress ` +
        labelIdx.filter(k => famOf(k) === "S").map(k => hardLabelOf(line.frags[k])).join("/"));
    }
    if (keptIdx.length < 2) continue;

    const segs = keptIdx.map((start, n) =>
      line.frags.slice(start, n + 1 < keptIdx.length ? keptIdx[n + 1] : line.frags.length));
    const made = segs.map(fr => {
      const main = fr.reduce((a, b) => a.w >= b.w ? a : b);
      return { ...boxOf(fr), s: joinFrags(fr), font: main.font };
    });
    /* 병합 라인은 첫 캡션이 소유한다 — 형제가 이 물리 라인을 다시 캡션·본문으로 오해하지 않게. */
    infoByAnchor.delete(line);
    ownerByPart.set(line, made[0]);
    slots[i] = made[0];
    embedded.set(i, made.slice(1));
    made.forEach((a, n) => {
      ownerByPart.set(a, a);
      infoByAnchor.set(a, {
        num: hardLabelOf(segs[n][0]),
        hard: true,
        stitched: false,
        embedded: true,
        parts: [line],
        labelBox: boxOf([segs[n][0]]),
        sibL: n > 0 ? made[n].left : null,                       // 자기 라벨 left = 왼쪽 형제와의 경계
        sibR: n + 1 < made.length ? made[n + 1].left : null      // 다음 라벨 left = 오른쪽 경계
      });
    });
    if (dbg) dbg(`  [split] line T${line.top.toFixed(0)} -> ${made.length} caps ` +
      made.map(a => infoByAnchor.get(a).num).join("/"));
  }

  for (let i = 0; i < lines.length; i++) {
    const prefix = lines[i];
    if (ownerByPart.has(prefix) || !hardPrefix(prefix)) continue;
    const row = lines.filter(u => u !== prefix && sameBaseline(prefix, u))
      .sort((a, b) => a.left - b.left);
    const prefixRight = prefix.left + prefix.w;
    let numeric = null, numericMatch = null;
    for (const u of row) {
      if (ownerByPart.has(u)) continue;
      const gap = u.left - prefixRight;
      if (gap <= 8) continue;
      if (gap > STITCH_GAP_PT) break;
      const match = HARD_STITCH_NUM_RE.exec(u.s.trim());
      if (match) { numeric = u; numericMatch = match; break; }
    }
    if (!numeric) continue;

    const parts = [prefix, numeric];
    let prev = numeric;
    const numericIndex = row.indexOf(numeric);
    for (const u of row.slice(numericIndex + 1)) {
      const gap = u.left - (prev.left + prev.w);
      if (gap < -2 || gap > STITCH_GAP_PT) break;
      if (ownerByPart.has(u) || hardPrefix(u)) break;
      parts.push(u);
      prev = u;
    }
    const anchorBox = boxOf(parts);
    const main = parts.reduce((a, b) => a.w >= b.w ? a : b);
    const anchor = {
      ...anchorBox,
      s: parts.map(u => u.s).join(" ").trim(),
      font: main.font
    };
    slots[i] = anchor;
    ownerByPart.set(anchor, anchor);
    for (const part of parts) ownerByPart.set(part, anchor);
    infoByAnchor.set(anchor, {
      num: normNum(numericMatch[1]),
      hard: true,
      stitched: true,
      parts,
      labelBox: boxOf([prefix, numeric])
    });
  }

  /* 3) soft 후보 수집 (v2.9.1) — slots/ownerByPart/infoByAnchor에는 넣지 않는다.
   *    승격 여부는 문서 전체를 보는 promoteSoftAnchors가 결정한다. */
  const softSlots = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ownerByPart.has(line)) continue;          // 이미 hard 앵커이거나 그 조각
    const soft = softCaptionOf(line);
    if (soft) softSlots.push({ index: i, line, num: soft.num, form: soft.form });
  }
  /* slots(희소 배열)를 노출하는 이유: 승격 시 slots[index] 기입 후 filter(Boolean) 재실행만으로
   * 라인 순서가 보존된다 — anchors 순서는 detectPage의 밴드 한계·otherCaps가 소비하므로 결정적이어야 한다. */
  /* soft 문서 게이트용 hard 관습 증거 (v2.14.0 — 구 hardCount 대체). "이 문서가 본문 figure에 hard
   * 구분자 관습을 쓰나"를 sep-증거로 센다. 세 갈래로 분리(★순서 불변: family 배제를 sep/bare 분기 前에):
   *   family(S·ED·A~D, isFamilyNum:282) → 무시 (별개 번호계열, v2.11.0 유래).
   *   비-family sep 앵커(. : | 있음, info.hard=true) → hardSep 카운트 (진짜 hard 관습 증거).
   *   비-family bare 앵커(구분자 없는 맨-라벨, info.hard=false) → form만 모아 bareForms로 노출.
   *     문서-레벨 반복 판정(같은 form ≥2 = 관습)은 promoteSoftAnchors가 전 페이지 합산으로 한다 —
   *     페이지별로 세면 s11427식 페이지-산개 7/7 맨-라벨이 각 페이지 count=1로 고립 오판된다.
   *   ⚠ bareForms는 bare 전용 multiset이다 — softSlots.form(승격 formCount)과 물리적으로 분리한다.
   *     고립 bare "Figure 7"(Hao)의 form이 soft 8앵커 form과 같은 키라 공유 맵이면 반복 오분류된다. */
  const bareFormOf = ln => {
    /* v2.19.2: 여기서 글리프를 안 벗기면 "◂Fig. 5 …"가 form "spaced"로 **오분류**되어
     * bareFormCount가 오염되고, 그 집계가 문서 전역 soft 체제(전량승격/애매역/전량기각)를
     * 뒤집을 수 있다 — 파급이 그 라인 하나에 국한되지 않는 유일한 누락 지점이었다. */
    const s = captionTestText((ln.s || "").replace(/\s+/g, " ").trim());
    return /^figure\b/i.test(s) ? "figure" : (/^fig\b|^fig\.?\d/i.test(s) ? "fig" : "spaced");
  };
  const bareForms = [];
  let hardSep = 0;
  const tally = info => {
    if (!info || isFamilyNum(info.num)) return;   // family는 sep/bare 분기 前 배제
    if (info.hard) hardSep++;                       // 구분자 있는 비-family = hard 관습 증거
  };
  const tallyBare = (info, ln) => {
    if (!info || isFamilyNum(info.num) || info.hard) return;
    bareForms.push(bareFormOf(ln));                 // 구분자 없는 비-family 맨-라벨의 form
  };
  for (const ln of slots.filter(Boolean)) { const info = infoByAnchor.get(ln); tally(info); tallyBare(info, ln); }
  for (const arr of embedded.values()) for (const a of arr) { const info = infoByAnchor.get(a); tally(info); tallyBare(info, a); }
  return { anchors: assembleAnchors(slots, embedded), ownerByPart, infoByAnchor,
           slots, embedded, softSlots, hardSep, bareForms };
}

/* 1차 패스 종료 후 문서 전체를 보고 soft 앵커 승격 여부를 결정한다 (v2.9.1 · v2.14.0 라우터).
 * hardBody(= 본문 figure hard 관습 증거 = 비-family sep 앵커 + 반복 동형 bare)로 3-체제 라우팅:
 *   0 → 전량승격 / 1..K-1 → 애매역(잠정승격, pass2 floor 검증) / >=K → 전량기각.
 * 근거: 한 문서는 보통 캡션 표기 관습을 하나만 쓴다 — hard 관습이 이미 있는 문서의 soft 후보는 거의
 * 전부 본문 상호참조, hard 관습이 없는 문서의 그것은 거의 전부 진짜 캡션(코퍼스 실측). 애매역은
 * "hard 관습이 딱 1건뿐"이라 혼합-관습(본문 soft + 진짜 캡션 hard 1개 or FP hard 1개)을 분간 못 하는
 * 경계 — 잠정승격 후 up-점수 floor로 진짜 캡션만 남긴다(구 게이트는 이 문서들의 soft를 전멸시켰다).
 * 승격 앵커는 hard:false·parts 1개로 기존 "구분자 없는 앵커"와 구조적으로 동일 → 후보 생성·채점·선택
 * 경로 불변. 애매역 앵커만 provisional:true로 표시해 pass2의 floor 검증 대상이 됨. */
function promoteSoftAnchors(pageData, dbg, diag) {
  let hardSepTotal = 0, softTotal = 0;
  const formCount = new Map();       // soft 라벨폼 (승격 form-rep 판정) — bare와 분리
  const bareFormCount = new Map();   // ★ bare 전용 multiset (문서-레벨 반복 판정, formCount와 disjoint)
  for (const pd of pageData) {
    hardSepTotal += pd.captionData.hardSep;
    for (const f of pd.captionData.bareForms) bareFormCount.set(f, (bareFormCount.get(f) || 0) + 1);
    for (const c of pd.captionData.softSlots) {
      softTotal++;
      formCount.set(c.form, (formCount.get(c.form) || 0) + 1);
    }
  }
  if (!softTotal) return;   // soft 후보 없으면 hardSep/bareForms 미소비 — 무영향(무-soft 문서 불변)
  /* 반복 동형 bare(같은 form ≥2)만 hard 관습으로 카운트 — 고립 bare(Hao wrap 잔재 "Figure 7")는 제외.
   * per-FORM 집계(문서 총 bare 수 아님): 서로 다른 form 고립 bare 2개는 관습이 아니다. */
  let bareRep = 0;
  for (const [, n] of bareFormCount) if (n >= SOFT_FORM_MIN) bareRep += n;
  const hardBody = hardSepTotal + bareRep;
  const forms = [...formCount].map(([f, n]) => `${f}:${n}`).join(",");
  const bareInfo = [...bareFormCount].map(([f, n]) => `${f}:${n}`).join(",") || "-";
  const regime = hardBody === 0 ? "promote-all"
               : hardBody < SOFT_GATE_K ? "ambiguous" : "reject-all";
  const recordRejectedSoft = diag ? ((pd, c, reason, repetitions) => {
    const anchorId = `p${pd.num}/l${c.index}/e0`;
    diag.add("anchor", {
      anchorId, captionPage: pd.num, num: c.num,
      numFamily: /^ED\./.test(String(c.num)) ? "extended-data"
        : /^S\./.test(String(c.num)) ? "supplementary"
        : /^[A-D]\./.test(String(c.num)) ? "appendix"
        : /^\d/.test(String(c.num)) ? "main" : "roman-or-other",
      sourceLineIndex: c.index, embeddedOrdinal: 0,
      sourceText: String(c.line.s || "").replace(/\s+/g, " ").trim().slice(0, 180),
      sourceTextHash: diag.textHash(c.line.s),
      sourceParts: [{
        index: 0, lineIndex: c.index, bboxPt: diag.boxPt(c.line),
        textHash: diag.textHash(c.line.s),
      }],
      anchorBoxPt: diag.boxPt(c.line), labelBoxPt: diag.boxPt(c.line),
      hard: false, soft: true, provisional: false, stitched: false, embedded: false,
      active: false, form: c.form,
    });
    diag.add("anchor-gate", {
      anchorId, captionPage: pd.num, num: c.num,
      decision: "rejected", reasons: [reason], form: c.form, repetitions,
    });
  }) : null;
  if (diag) diag.add("soft-gate", {
    decision: regime,
    hardBody,
    hardSep: hardSepTotal,
    bareRepeat: bareRep,
    softTotal,
    formCount: Object.fromEntries(formCount),
    bareFormCount: Object.fromEntries(bareFormCount),
  });
  dbg(`[doc] SOFT gate hardBody=${hardBody} (sep=${hardSepTotal} bareRep=${bareRep} bare=[${bareInfo}])` +
      ` soft=${softTotal} forms=${forms} regime=${regime}`);
  /* {2,3} 저-hardBody 기각은 현 코퍼스 공witness(공집합) — 혼합-관습 soft 문서가 여기 걸리면 침묵
   * 표적 손실이다. 전수 diff에서 표면화되도록 NOTE 방출(현재 미발동, 미래 대비 계측). */
  if (regime === "reject-all" && hardBody <= 3)
    dbg(`[doc] SOFT gate NOTE reject-all with low hardBody=${hardBody} — verify not a soft-target doc`);
  if (regime === "reject-all") {
    if (diag) for (const pd of pageData) for (const c of pd.captionData.softSlots)
      recordRejectedSoft(pd, c, "soft-document-gate", formCount.get(c.form) || 0);
    return;
  }
  const provisional = regime === "ambiguous";

  for (const pd of pageData) {
    const cd = pd.captionData;
    let promoted = 0;
    for (const c of cd.softSlots) {
      const reps = formCount.get(c.form);
      if (reps < SOFT_FORM_MIN) {
        dbg(`[doc] SOFT reject p${pd.num} num=${c.num} form=${c.form} reason=form-rep(${reps})`);
        if (diag) recordRejectedSoft(pd, c, "soft-form-repetition", reps);
        continue;
      }
      cd.slots[c.index] = c.line;
      cd.ownerByPart.set(c.line, c.line);
      cd.infoByAnchor.set(c.line, {
        num: c.num,
        hard: false,      // 구분자가 없으므로 hard 문법이 아니다 (hardLong 경로 비진입)
        stitched: false,
        soft: true,
        provisional,      // 애매역이면 pass2 floor 검증 대상 (전량승격은 false — 검증 없이 확정)
        form: c.form,
        parts: [c.line],
        labelBox: { left: c.line.left, w: c.line.w, top: c.line.top, h: c.line.h }
      });
      promoted++;
      if (diag) {
        const anchorId = diag.registerAnchor(pd, c.line);
        diag.add("anchor-gate", {
          anchorId, captionPage: pd.num, num: c.num,
          decision: provisional ? "provisional" : "promoted",
          reasons: [regime], form: c.form, repetitions: reps,
        });
      }
      dbg(`[doc] SOFT ${provisional ? "provisional" : "promote"} p${pd.num} num=${c.num} form=${c.form}` +
          ` s=${JSON.stringify(c.line.s.slice(0, 50))}`);
    }
    if (promoted) cd.anchors = assembleAnchors(cd.slots, cd.embedded);   // 라인 순서 보존 재구성
  }
}

/* 위/아래 인접 줄(문단 이웃) 존재 여부 — 본문 문단 판별에 사용 */
function neighborsOf(u, lines) {
  let above = false, below = false;
  for (const v of lines) {
    if (v === u || ox(u, v) < 0.3 * Math.min(u.w, v.w)) continue;
    const d = (v.top + v.h) - (u.top + u.h);
    const a = Math.abs(d);
    if (a >= 0.85 * u.h && a <= 1.95 * u.h) {
      if (d < 0) above = true; else below = true;
      if (above && below) break;
    }
  }
  return { above, below };
}

/* ===================== 서브패널 라벨 판별 (v2.9.0) ===================== */
/* figure 내부의 "(a) …" 서브캡션은 dom 폰트 + 본문 폭 + 상하 이웃 조건을 만족해 stopper로
 * 오인된다 (Ju Fig3, Aegaeon Fig12, ICLR B.1이 이 오인으로 CHOSE none → figure 소실).
 * 여기서 찾은 라인은 픽셀 블록 스캔의 "캡션 바로 위 첫 블록"에 한해 BODY stop에서 면제된다.
 * 판별: 같은 baseline의 stopper 타일들이 각각 (a)(b)…로 시작하거나 한 줄 안에 (a)…(b)…가
 * 인라인 나열되고, 마커가 같은 계열(a/A/1/i)의 오름 연속이며 첫 마커가 계열의 0일 것.
 * dom 폰트·같은 좌단의 문단 이웃이 바로 위에 있으면 본문 열거 문단으로 보고 제외한다. */
const SUBPANEL_MARK_RE = /\(\s*([a-zA-Z]|[ivx]{2,4}|\d{1,2})\s*\)/g;
const SUBPANEL_HEAD_RE = /^\(\s*([a-zA-Z]|[ivx]{2,4}|\d{1,2})\s*\)/;
const SUBPANEL_ROMAN = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6, viii: 7, ix: 8, x: 9 };
function subpanelSeqOk(tokens) {
  if (tokens.length < 2 || tokens.some(t => t == null)) return false;
  const ordIn = (fam, t) => {
    if (fam === "a") return /^[a-z]$/.test(t) ? t.charCodeAt(0) - 97 : -1;
    if (fam === "A") return /^[A-Z]$/.test(t) ? t.charCodeAt(0) - 65 : -1;
    if (fam === "1") return /^\d+$/.test(t) ? +t - 1 : -1;
    return t in SUBPANEL_ROMAN ? SUBPANEL_ROMAN[t] : -1;   // fam "i"
  };
  /* "(i)"가 로마자인지 알파벳인지는 계열 전체가 결정한다 — 어느 한 계열로든 0부터 오름 연속이면 통과 */
  return ["a", "A", "1", "i"].some(fam => tokens.every((t, k) => ordIn(fam, t) === k));
}
function subpanelStoppers(lines, stoppers, dom) {
  const exempt = new Set();
  const stopList = [...stoppers].sort((a, b) => (a.top + a.h) - (b.top + b.h));
  /* 같은 baseline 행으로 클러스터링 (buildLines와 동일한 허용오차) */
  const rows = [];
  for (const u of stopList) {
    const r = rows[rows.length - 1];
    if (r && Math.abs((u.top + u.h) - r.bl) < Math.max(2, u.h * 0.45)) r.us.push(u);
    else rows.push({ bl: u.top + u.h, us: [u] });
  }
  const paragraphAbove = u => lines.some(v =>
    v !== u && v.font === dom && Math.abs(v.left - u.left) <= 4 &&
    (u.top + u.h) - (v.top + v.h) >= 0.85 * u.h &&
    (u.top + u.h) - (v.top + v.h) <= 1.95 * u.h);
  for (const row of rows) {
    row.us.sort((a, b) => a.left - b.left);
    let tokens;
    if (row.us.length > 1) {
      /* 타일 형: 각 stopper가 줄머리 마커로 시작 — (a) xxx | (b) xxx | (c) xxx */
      tokens = row.us.map(u => { const m = SUBPANEL_HEAD_RE.exec(u.s); return m ? m[1] : null; });
    } else {
      /* 인라인 형: 한 줄 안에 (a) … (b) … — 줄머리에서 시작할 때만 */
      const u = row.us[0];
      if (!SUBPANEL_HEAD_RE.test(u.s)) continue;
      tokens = [...u.s.matchAll(SUBPANEL_MARK_RE)].map(m => m[1]);
    }
    if (!subpanelSeqOk(tokens)) continue;
    if (row.us.every(u => paragraphAbove(u))) continue;   // 본문 열거 문단
    for (const u of row.us) {
      exempt.add(u);
      /* 줄바꿈 이어짐: 같은 폰트·같은 좌단·한 줄 피치로 바로 아래 최대 2줄까지 함께 면제
       * (ICLR B.1의 서브캡션 둘째 줄) */
      let prev = u;
      for (let k = 0; k < 2; k++) {
        const next = lines.find(v => !exempt.has(v) && v.font === prev.font &&
          Math.abs(v.left - prev.left) <= 4 &&
          (v.top + v.h) - (prev.top + prev.h) >= 0.85 * prev.h &&
          (v.top + v.h) - (prev.top + prev.h) <= 1.95 * prev.h);
        if (!next || SUBPANEL_HEAD_RE.test(next.s)) break;
        exempt.add(next);
        prev = next;
      }
    }
  }
  return exempt;
}

/* ===================== 이미지 XObject bbox (CTM 추적) ===================== */
async function getImageBoxes(page, pageH, onError) {
  let opsList;
  try { opsList = await page.getOperatorList(); }
  catch (e) {
    console.error("getOperatorList 실패:", e);
    if (onError) onError(e);
    return [];
  }
  const O = pdfjsLib.OPS, stack = [], boxes = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < opsList.fnArray.length; i++) {
    const fn = opsList.fnArray[i], args = opsList.argsArray[i];
    if (fn === O.save) stack.push(ctm.slice());
    else if (fn === O.restore) ctm = stack.pop() || ctm;
    else if (fn === O.transform) ctm = mul(ctm, args);
    else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject ||
             fn === O.paintImageMaskXObject || fn === O.paintJpegXObject) {
      const pts = [[0,0],[1,0],[0,1],[1,1]].map(([x,y]) =>
        [ctm[0]*x + ctm[2]*y + ctm[4], ctm[1]*x + ctm[3]*y + ctm[5]]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const yT = pageH - Math.max(...ys), yB = pageH - Math.min(...ys);
      if (x1 - x0 > 10 && yB - yT > 10)
        boxes.push({ left: x0, top: yT, w: x1 - x0, h: yB - yT });
    }
  }
  return boxes;
}

/* 렌더 실패(죽은 캔버스) 전용 오류 — 소비자가 name으로 분기할 수 있게 별도 이름을 준다 (B7).
 * Chrome은 메모리 압력을 받으면 캔버스 백킹 스토어를 예외 없이 회수한다. 회수된 캔버스는 모든
 * 그리기 연산이 무성과로 끝나고 읽으면 전부 투명 검정이라, 아래 잉크 판정에 "잉크로 꽉 찬 페이지"로
 * 보였다 — 유령 figure와 44.5pt bbox 이동의 원인이다. 조용한 오염보다 즉시 실패가 낫다. */
function figRenderError(message) {
  const error = new Error(message);
  error.name = "FigRenderError";
  return error;
}
const isFigRenderError = error => !!error && error.name === "FigRenderError";

/* ===================== 잉크 그리드 (렌더 픽셀의 명암 이진화) ===================== */
/* 알파는 흰 배경 위 합성으로 처리한다 (B7) — 불투명 픽셀(α=255)은 합성식이 항등이라 판정이
 * 완전히 불변이고, 칠해지지 않은 픽셀(α=0)만 흰색(= 여백)이 된다. */
function makeInk(canvas, canary = true) {
  const W = canvas.width, H = canvas.height;
  /* 0×0 캔버스는 getImageData가 IndexSizeError를 던진다. `canvas.width = 0`은 이 파일이 쓰는
   * 백킹 스토어 반환 관용구이므로, 이미 해제된 캔버스를 넘겨받은 것으로 보고 죽은 캔버스와
   * 같게 취급한다 — 안 그러면 일반 오류로 새어나가 adjacent 경로에서 조용히 삼켜진다.
   * **카나리아와 같은 게이트를 쓴다**: 호스트 주입 캔버스까지 여기서 fail-fast시키면 관측
   * 계층의 graceful degradation을 없애 문서 전체를 실패시킨다 (canary=false의 취지에 반한다). */
  if (canary && (W <= 0 || H <= 0))
    throw figRenderError(`페이지 캔버스가 해제돼 있습니다 (${W}×${H})`);
  const ctx = canvas.getContext("2d");
  const { data } = ctx.getImageData(0, 0, W, H);
  const ink = new Uint8Array(W * H);
  let opaquePx = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const a = data[i + 3];
    let l = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
    if (a !== 255) { const k = a / 255; l = l * k + 255 * (1 - k); }
    if (l < 235) ink[p] = 1;
    if (a !== 0) opaquePx++;
  }
  /* 카나리아 — **엔진이 직접 렌더한 캔버스에서만** 켠다. pdf.js는 페이지 내용을 그리기 전에
   * 캔버스를 불투명 흰색으로 채우므로 정상 렌더는 100% α=255다. 즉 투명 픽셀이 많다는 것은
   * 백킹 스토어가 회수됐다는 뜻이다. 호스트 주입 캔버스(opts.renderPage)는 이 불변식이 없어
   * (투명 배경으로 렌더하는 호스트가 정상일 수 있다) 호출부가 canary=false로 끈다.
   *
   * 전면(=0)이 아니라 비율로 보는 이유: Chromium은 렌더 도중에도 백킹 스토어를 버리고 다음
   * 그리기에서 빈 버퍼를 재할당할 수 있어, 앞부분만 그려진 페이지가 나올 수 있다. 그 경우
   * 위 합성이 투명 영역을 "흰 종이"로 읽어 **조용히** 틀린 검출을 낸다(알파 무시 시절에는
   * 최소한 요란하게 틀렸다). 0.5는 잠정 문턱 — 정상 렌더의 기대 투명 비율이 0이라 여유가
   * 극단적으로 크고, 전수 실행에서 발화 0건이면 그 자체가 문턱 검증이다. */
  if (canary && opaquePx < 0.5 * W * H)
    throw figRenderError(`페이지 렌더 결과가 비어 있습니다 (${W}×${H} 중 불투명 ${opaquePx}px — 메모리 부족으로 캔버스가 회수됐을 수 있습니다)`);
  return { ink, W, H };
}
const inkAt = (g, x, y) => (x >= 0 && y >= 0 && x < g.W && y < g.H) ? g.ink[y * g.W + x] : 0;

/* PB-4A N−1 관측 primitive. 기존 up/down scan의 기계적 row noise floor와 4.8pt
 * whitespace separator만 재사용한다. 이 함수들은 후보를 만들거나 점수/선택에 관여하지 않는다. */
function adjacentInkBands(grid) {
  const rowInk = new Int32Array(grid.H);
  const threshold = Math.max(2, Math.floor(0.002 * grid.W));
  for (let y = 0; y < grid.H; y++) {
    let count = 0;
    for (let x = 0; x < grid.W; x++) count += inkAt(grid, x, y);
    rowInk[y] = count;
  }
  const separatorPx = Math.round(4.8 * S);
  const bands = [];
  let y = 0;
  while (y < grid.H) {
    while (y < grid.H && rowInk[y] <= threshold) y++;
    if (y >= grid.H) break;
    let y0 = y, y1 = y + 1, lastInk = y, gap = 0;
    while (y < grid.H) {
      if (rowInk[y] > threshold) {
        lastInk = y;
        gap = 0;
      } else if (++gap >= separatorPx) {
        break;
      }
      y++;
    }
    y1 = lastInk + 1;
    /* 같은 vertical band 안에서도 separator 너비 이상의 실제 수평 whitespace로 분할한다.
     * minX/maxX 하나로 축약하면 좌우 disjoint XObject를 빈 중앙 bbox가 bridge하는 오류가 난다. */
    const colInk = new Int32Array(grid.W);
    for (let yy = y0; yy < y1; yy++)
      for (let x = 0; x < grid.W; x++) colInk[x] += inkAt(grid, x, yy);
    let x = 0;
    while (x < grid.W) {
      while (x < grid.W && colInk[x] === 0) x++;
      if (x >= grid.W) break;
      let x0 = x, lastInkX = x, horizontalGap = 0;
      while (x < grid.W) {
        if (colInk[x] > 0) {
          lastInkX = x;
          horizontalGap = 0;
        } else if (++horizontalGap >= separatorPx) {
          break;
        }
        x++;
      }
      const x1 = lastInkX + 1;
      let tightY0 = y1, tightY1 = y0, inkPixels = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        if (!inkAt(grid, xx, yy)) continue;
        tightY0 = Math.min(tightY0, yy);
        tightY1 = Math.max(tightY1, yy + 1);
        inkPixels++;
      }
      if (tightY1 > tightY0) bands.push({
        kind: "ink-band", bboxPx: { x0, y0: tightY0, x1, y1: tightY1 },
        rowStart: y0, rowEnd: y1, rowInkMax: Math.max(...rowInk.slice(y0, y1)),
        inkPixels, inkDensity: inkPixels / Math.max(1, (x1 - x0) * (tightY1 - tightY0)),
        threshold, separatorPx,
      });
      x = Math.max(x + 1, x1);
    }
    y = Math.max(y + 1, y1);
  }
  return bands;
}

const adjacentIntersection = (a, b) => {
  const w = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const h = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return w * h;
};
const adjacentArea = box => Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
const adjacentPxBoxToPt = box => ({
  x0: box.x0 / S, y0: box.y0 / S, x1: box.x1 / S, y1: box.y1 / S,
});

function adjacentRegions(seeds) {
  const parent = seeds.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const join = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };
  for (let i = 0; i < seeds.length; i++)
    for (let j = i + 1; j < seeds.length; j++)
      if (adjacentIntersection(seeds[i].bboxPx, seeds[j].bboxPx) > 0) join(i, j);
  const groups = new Map();
  for (let i = 0; i < seeds.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(seeds[i]);
  }
  return [...groups.values()].map(group => {
    const bboxPx = {
      x0: Math.min(...group.map(seed => seed.bboxPx.x0)),
      y0: Math.min(...group.map(seed => seed.bboxPx.y0)),
      x1: Math.max(...group.map(seed => seed.bboxPx.x1)),
      y1: Math.max(...group.map(seed => seed.bboxPx.y1)),
    };
    return {
      seeds: group,
      bboxPx,
      sourceKinds: [...new Set(group.map(seed => seed.kind))].sort(),
    };
  }).sort((a, b) => a.bboxPx.y0 - b.bboxPx.y0 || a.bboxPx.x0 - b.bboxPx.x0 ||
    a.bboxPx.y1 - b.bboxPx.y1 || a.bboxPx.x1 - b.bboxPx.x1);
}

/* ===================== PB-4A 구조화 관측 (output-neutral) =====================
 * callback이 없으면 null을 반환하고 아래 모든 callsite가 건너뛴다. ID는 물리 source slot/pass/direction/
 * seed ordinal만 사용해 bbox·raster AA·worker/runtime이 topology identity를 바꾸지 않게 한다. */
const diagnosticTextHash = text => {
  let h = 0x811c9dc5;
  for (const ch of String(text || "").replace(/\s+/g, " ").trim()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

function makeDiagnosticRecorder(callback) {
  if (typeof callback !== "function") return null;
  const records = [];
  const anchorIds = new WeakMap(), candidateMeta = new WeakMap(), figCandidateIds = new WeakMap();
  const candidateAnchorById = new Map(), selectionByAnchor = new Map();
  const emissionByCandidate = new Map(), claimByCandidate = new Map();
  const finite = value => {
    if (typeof value !== "number") return value;
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    if (Object.is(value, -0)) return 0;
    return Math.round(value * 1e6) / 1e6;
  };
  const scalar = value => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return finite(value);
    if (value === undefined) return undefined;
    if (Array.isArray(value)) return value.map(v => scalar(v));
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = scalar(value[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  };
  const textHash = diagnosticTextHash;
  const boxPt = box => box ? {
    x0: box.x0 ?? box.left,
    y0: box.y0 ?? box.top,
    x1: box.x1 ?? ((box.left ?? 0) + (box.w ?? 0)),
    y1: box.y1 ?? ((box.top ?? 0) + (box.h ?? 0)),
  } : null;
  const pxBoxToPt = box => box ? {
    x0: box.x0 / S, y0: box.y0 / S, x1: box.x1 / S, y1: box.y1 / S,
  } : null;
  const add = (record, data = {}) => {
    const normalized = scalar({ seq: records.length, record, ...data });
    records.push(normalized);
    if (record === "candidate" && normalized.candidateId && normalized.anchorId)
      candidateAnchorById.set(normalized.candidateId, normalized.anchorId);
    else if (record === "selection" && normalized.anchorId)
      selectionByAnchor.set(normalized.anchorId, normalized);
    else if (record === "emission" && normalized.candidateId)
      emissionByCandidate.set(normalized.candidateId, normalized);
    else if (record === "claim" && normalized.candidateId)
      claimByCandidate.set(normalized.candidateId, normalized);
  };
  const family = num => /^ED\./.test(String(num)) ? "extended-data"
    : /^S\./.test(String(num)) ? "supplementary"
    : /^[A-D]\./.test(String(num)) ? "appendix"
    : /^\d/.test(String(num)) ? "main" : "roman-or-other";
  const registerAnchor = (pd, cap) => {
    if (anchorIds.has(cap)) return anchorIds.get(cap);
    const cd = pd.captionData, info = cd.infoByAnchor.get(cap);
    let slot = -1, embeddedOrdinal = 0;
    for (let i = 0; i < cd.slots.length; i++) {
      if (cd.slots[i] === cap) { slot = i; break; }
      const embedded = cd.embedded.get(i) || [];
      const ei = embedded.indexOf(cap);
      if (ei >= 0) { slot = i; embeddedOrdinal = ei + 1; break; }
    }
    if (slot < 0 && info && info.parts && info.parts.length)
      slot = pd.lines.indexOf(info.parts[0]);
    if (slot < 0)
      throw new Error(`diagnostic anchor source slot을 찾지 못했습니다 (p${pd.num}).`);
    const id = `p${pd.num}/l${slot}/e${embeddedOrdinal}`;
    anchorIds.set(cap, id);
    const sourceText = (info && info.parts ? info.parts : [cap])
      .map(line => line.s || "").join(" ").replace(/\s+/g, " ").trim();
    add("anchor", {
      anchorId: id,
      captionPage: pd.num,
      num: info && info.num,
      numFamily: family(info && info.num),
      sourceLineIndex: slot,
      embeddedOrdinal,
      sourceText: sourceText.slice(0, 180),
      sourceTextHash: textHash(sourceText),
      sourceParts: (info && info.parts ? info.parts : [cap]).map((line, index) => ({
        index, lineIndex: pd.lines.indexOf(line), bboxPt: boxPt(line), textHash: textHash(line.s),
      })),
      anchorBoxPt: boxPt(cap),
      labelBoxPt: boxPt(info && info.labelBox),
      hard: !!(info && info.hard),
      soft: !!(info && info.soft),
      provisional: !!(info && info.provisional),
      stitched: !!(info && info.stitched),
      embedded: !!(info && info.embedded),
      form: info && info.form,
    });
    return id;
  };
  const registerCandidate = (candidate, meta) => {
    const candidateId = `${meta.anchorId}/pass${meta.pass}/${meta.direction}/` +
      `${meta.seedSource || "none"}/${meta.seedOrdinal || 0}`;
    const full = { ...meta, candidateId };
    candidateMeta.set(candidate, full);
    if (candidate && candidate.fig) figCandidateIds.set(candidate.fig, candidateId);
    return candidateId;
  };
  const candidateId = candidate => candidate && candidateMeta.get(candidate)?.candidateId || null;
  const figCandidateId = fig => fig && figCandidateIds.get(fig) || null;
  const emitCandidate = (candidate, extra = {}) => {
    const meta = candidateMeta.get(candidate);
    if (!meta) throw new Error("diagnostic candidate metadata가 없습니다.");
    const fig = candidate.fig || null;
    add("candidate", {
      ...meta,
      valid: !!candidate.valid,
      rejectReason: candidate.rejectReason || null,
      reasons: candidate.rejectReason ? candidate.rejectReason.split(",").filter(Boolean) : [],
      regionBoxPx: meta.regionBoxPx || null,
      regionBoxPt: pxBoxToPt(meta.regionBoxPx),
      outputBoxPx: fig ? { x0: fig.x0, y0: fig.y0, x1: fig.x1, y1: fig.y1 } : null,
      outputBoxPt: fig ? pxBoxToPt({ x0: fig.x0, y0: fig.y0, x1: fig.x1, y1: fig.y1 }) : null,
      metrics: candidate.metrics || null,
      score: candidate.score || null,
      ...extra,
    });
  };
  const anchorState = anchorId => {
    const selection = selectionByAnchor.get(anchorId) || null;
    const candidateId = selection && selection.chosenCandidateId || null;
    const emission = candidateId ? emissionByCandidate.get(candidateId) || null : null;
    const claim = candidateId ? claimByCandidate.get(candidateId) || null : null;
    return scalar({
      chosenCandidateId: candidateId,
      chosenDirection: selection && selection.chosenDirection || null,
      selection: selection && selection.decision || "none",
      emission: emission && emission.decision || "none",
      claim: claim && claim.decision || "none",
    });
  };
  const ownedClaims = () => [...claimByCandidate.entries()]
    .filter(([, claim]) => claim.decision === "owned")
    .map(([candidateId, claim]) => scalar({
      candidateId,
      anchorId: candidateAnchorById.get(candidateId) || null,
      num: claim.num,
      page: claim.page,
      outputBoxPx: claim.outputBoxPx,
      outputBoxPt: claim.outputBoxPt,
    }));
  return {
    add, boxPt, pxBoxToPt, scalar, textHash, registerAnchor, registerCandidate, emitCandidate,
    candidateId, figCandidateId, anchorState, ownedClaims,
    finish: () => callback(records),
  };
}

/* 방향별 후보가 공유하는 순수 채점기. 후보 생성기(up/down, Phase 2: left/right)는
   평범한 수치 지표만 이 함수에 넘기고, 선택기는 동일 점수축으로 비교한다. */
const clamp01 = v => Math.max(0, Math.min(1, v));
function figureScore(m) {
  const area = 3.0 * clamp01(m.areaRatio / 0.08);
  const width = 2.0 * clamp01(m.widthRatio / 0.35);
  const height = 2.0 * clamp01(m.heightRatio / 0.22);
  const density = 2.0 * clamp01(m.inkDensity / 0.035);
  const proximity = 2.0 * clamp01(1 - m.gapPt / 18);
  const boundary = m.farClosed ? 1.2 : 0;
  const raster = m.raster ? 0.8 : 0;
  const bodyPenalty = Math.min(6, m.bodyStops * 1.5);
  const tinyPenalty = (m.areaRatio < 0.002 || m.heightRatio < 0.012) ? 8 : 0;
  const slenderPenalty = (m.widthRatio < 0.10 && m.heightRatio > 0.12) ? 5 : 0;
  /* hugePenalty: 영역이 페이지를 통째로 삼키는 over-grab 방지. 단 up 방향이고 아래 중 하나면 면제:
     ① 수평 잉크 커버리지 ≥ HUGE_COVERAGE_MIN **그리고** widthRatio ≥ HUGE_WIDTH_MIN (v2.13.0 커버리지 +
        v2.13.1 폭 바닥) — 잉크 90% 질량이 영역 폭 대부분에 퍼지고 영역 자체가 페이지 폭의 60%↑인 진짜
        전폭 figure. `!farClosed && raster`라 v2.12.0 프록시가 못 잡던 Nature 2026 전폭 clip 11건 해소.
        폭 바닥은 coverage가 후보 자기 폭 기준 밀도라 좁고 긴 후보(hugeCond가 heightRatio 단독 발동)를
        면제하는 사각을 막는다(Blockchain 2@36 widthRatio 0.47). ② farClosed 또는 !raster (v2.12.0 프록시 —
        far 경계 닫힘/벡터충전 전면 figure — 폭 무관).
     coverage 판별자는 over-grab(칼럼 figure를 전폭으로 잡아 한쪽이 빈 영역)을 커버리지 낮음으로
     걸러 벌점 유지 → Simões 4@6·Pandey 3@6 칼럼폭 over-grab 회귀 방지. 프록시에 OR로 보강한
     것이라 v2.12.0에서 면제되던 figure는 커버리지와 무관하게 계속 면제(회귀 0 보장). side 후보는
     무변경(full-height 보호 유지). coverage는 huge 조건일 때만 산출되며 그 외엔 0(면제 판정에 무영향).
     ※ up 스캔은 body 블록을 제외하고 stop하므로 up 영역은 body를 구조적으로 포함하지 않는다. */
  const hugeExempt = m.direction === "up" &&
    ((m.coverage >= HUGE_COVERAGE_MIN && m.widthRatio >= HUGE_WIDTH_MIN) || m.farClosed || !m.raster);
  const hugePenalty = (!hugeExempt && (m.areaRatio > 0.65 || m.heightRatio > 0.82)) ? 8 : 0;
  const otherCapPenalty = m.stopReason === "other-cap" ? 0.5 : 0;
  const total = area + width + height + density + proximity + boundary + raster
    - bodyPenalty - tinyPenalty - slenderPenalty - hugePenalty - otherCapPenalty;
  return { total, area, width, height, density, proximity, boundary, raster,
    bodyPenalty, tinyPenalty, slenderPenalty, hugePenalty, otherCapPenalty };
}
function chooseCandidate(up, alternatives, policy) {
  /* 채점 이상은 대체 방향 채택의 근거가 될 수 없다. status quo(up)를 우선한다. */
  if (up && (!up.score || !Number.isFinite(up.score.total)))
    return { candidate: up, direction: "up", margin: policy.margin };
  /* Keep the strongest seed per direction, then apply hysteresis in the locked
     up -> down -> left -> right order. A later direction cannot steal a nearly
     tied result from an earlier, better-established direction. */
  const eligible = alternatives.filter(candidate => candidate && candidate.valid &&
    Number.isFinite(candidate.score.total) && candidate.score.total >= policy.minScore);
  let incumbent = up, direction = up ? "up" : "none", usedMargin = policy.margin;
  for (const dir of ["down", "left", "right"]) {
    const best = eligible.filter(candidate => candidate.direction === dir)
      .reduce((winner, candidate) =>
        !winner || candidate.score.total > winner.score.total ? candidate : winner, null);
    if (!best) continue;
    const margin = typeof policy.marginFor === "function"
      ? policy.marginFor(best) : policy.margin;
    if (incumbent && best.score.total <= incumbent.score.total + margin) continue;
    incumbent = best;
    direction = dir;
    usedMargin = margin;
  }
  return { candidate: incumbent, direction, margin: usedMargin };
}

/* ===================== 페이지 단위 감지 (핵심) ===================== */
function detectPage(pg, lines, dom, grid, dbg, captionData, diag, pass = 0) {
  const figs = [];
  const { anchors: caps, ownerByPart, infoByAnchor } = captionData;
  if (diag) diag.add("detection-pass", {
    page: pg.num, pass, decision: "started", anchorCount: caps.length,
  });
  const otherCaps = (blockLines, cap) => [...new Set(blockLines
    .map(u => ownerByPart.get(u)).filter(owner => owner && owner !== cap))];
  // stopper: 도달하면 figure 영역 상한으로 간주하는 "본문 줄"
  const stoppers = new Set(lines.filter(u => {
    if (u.font !== dom) return false;
    const nb = neighborsOf(u, lines);
    return (u.w >= 190 && (nb.above || nb.below)) ||
           (u.w >= 100 && nb.above && nb.below);   // 좁은 wrapfigure 본문 컬럼
  }));
  /* 서브패널 라벨 면제 대상 (v2.9.0) — 픽셀 블록 스캔의 첫 블록 BODY stop에서만 소비 */
  const subPanel = subpanelStoppers(lines, stoppers, dom);
  /* table 캡션 경계 (v2.10.0) — 페이지 전역. figure 앵커(caps)와 섞지 않는다: 방출·prefilter 대상이 아니다. */
  const tableStop = new Set(lines.filter(isTableCaption));
  dbg(`[p${pg.num}] lines=${lines.length} imgs=${pg.images.length} caps=${caps.map(c=>JSON.stringify(c.s.slice(0,30))).join(" ")}`);
  if (subPanel.size)
    dbg(`  subpanel=${subPanel.size} ${[...subPanel].slice(0, 4).map(u => JSON.stringify(u.s.slice(0, 22))).join(" ")}`);
  if (tableStop.size)
    dbg(`  tables=${tableStop.size} ${[...tableStop].slice(0, 4).map(u => JSON.stringify(u.s.slice(0, 22))).join(" ")}`);
  for (const cap of caps) {
    const capInfo = infoByAnchor.get(cap);
    const anchorId = diag ? diag.registerAnchor(pg, cap) : null;
    /* PB-4B observer가 graph 유무와 무관하게 같은 lifecycle을 보도록 public output과 분리한 내부
     * scalar 상태다. detectPage 재실행 때마다 초기화되어 active floor pass만 남는다. */
    capInfo.adjacentState_ = {
      selection: "none", chosenDirection: null, selectedFig: null,
      emission: "none", claim: "none",
    };
    capInfo.upScore_ = undefined;   // 매 앵커 초기화 (v2.14.0) — legacyBelow continue가 아래 갱신을 건너뛰어도
                                    // 이전 detectPage 재실행의 값이 남지 않게 (soft floor 판정 오염 방지)
    const num = capInfo.num;
    if (capInfo.stitched) {
      const lb = capInfo.labelBox;
      dbg(`  Fig${num}: STITCH parts=${capInfo.parts.length}` +
        ` label=[${lb.left.toFixed(0)},${(lb.left + lb.w).toFixed(0)}]` +
        ` text=${JSON.stringify(cap.s.slice(0, 50))}`);
    }
    if (capInfo.soft)
      dbg(`  Fig${num}: SOFT anchor form=${capInfo.form} text=${JSON.stringify(cap.s.slice(0, 50))}`);
    if (capInfo.embedded)
      dbg(`  Fig${num}: EMBEDDED sib=[${capInfo.sibL == null ? "-" : capInfo.sibL.toFixed(0)},` +
        `${capInfo.sibR == null ? "-" : capInfo.sibR.toFixed(0)}] text=${JSON.stringify(cap.s.slice(0, 50))}`);
    /* 1) 캡션 블록 확장 (여러 줄 캡션 흡수) + 캡션 전체 텍스트 수집 */
    let capBottom = cap.top + cap.h, colL = cap.left, colR = cap.left + cap.w;
    /* 방출 caption 문자열에서도 선두 글리프를 벗긴다 (v2.19.2) — 조판 장식이지 캡션 텍스트가
     * 아니다. 상자(captionBox)는 원본 라인 기하 그대로라 영향이 없다. */
    let capText = captionTestText(cap.s);
    const ownCaptionLines = new Set(capInfo.parts);
    for (const u of [...lines].sort((a, b) => a.top - b.top)) {
      if (ownerByPart.has(u)) continue;
      const gap = u.top - capBottom;
      const win = Math.max(u.h, cap.h) * (u.font === dom ? 0.45 : 1.7);
      if (!(gap >= -3 && gap < win)) continue;
      if (ox(u, { left: colL, w: colR - colL }) <= 0) continue;
      if (u.font === dom && u.left < cap.left - 3) continue;
      capBottom = Math.max(capBottom, u.top + u.h);
      colL = Math.min(colL, u.left); colR = Math.max(colR, u.left + u.w);
      capText += " " + u.s;
      ownCaptionLines.add(u);
    }
    const capbox = { left: colL, w: colR - colL, top: cap.top };
    const captionBox = { x0: colL, y0: cap.top, x1: colR, y1: capBottom }; // pt, 좌상단 원점
    /* 12-B N−1 방출이 caption page 좌표계의 캡션 텍스트·박스를 그대로 재사용하도록 보존한다.
     * public output에는 나가지 않는 내부 필드다 (v2.19.0). */
    capInfo.captionTextObserved_ = capText;
    capInfo.captionBoxObserved_ = captionBox;
    if (diag) diag.add("anchor-evaluation", {
      anchorId, captionPage: pg.num, candidatePage: pg.num, pass, num,
      decision: "evaluated", anchorBoxPt: diag.boxPt(cap),
      captionBoxPt: captionBox,
      captionTextHash: diag.textHash(capText),
      captionParts: [...ownCaptionLines]
        .map(line => ({
          lineIndex: lines.indexOf(line), bboxPt: diag.boxPt(line),
          textHash: diag.textHash(line.s),
        }))
        .sort((a, b) => a.lineIndex - b.lineIndex),
      edgeDistancePt: {
        top: captionBox.y0,
        right: pg.w - captionBox.x1,
        bottom: pg.h - captionBox.y1,
        left: captionBox.x0,
      },
    });
    const diagnosticAttempt = (direction, seedSource, seedOrdinal, decision, reasons, extra = {}) => {
      if (!diag) return;
      diag.add("candidate-attempt", {
        anchorId, captionPage: pg.num, candidatePage: pg.num, pass, num,
        direction, seedSource: seedSource || "none", seedOrdinal: seedOrdinal || 0,
        decision, reasons, ...extra,
      });
    };
    const registerDiagnosticCandidate = (candidate, direction, seedSource, seedOrdinal, regionBoxPx,
      extra = {}) => {
      if (!diag) return null;
      const regionArea = regionBoxPx
        ? Math.max(0, regionBoxPx.x1 - regionBoxPx.x0) * Math.max(0, regionBoxPx.y1 - regionBoxPx.y0)
        : 0;
      let imageIntersectionPx2 = 0;
      const imageRefs = [];
      if (regionBoxPx) for (let imageIndex = 0; imageIndex < pg.images.length; imageIndex++) {
        const im = pg.images[imageIndex];
        const imageBoxPx = {
          x0: im.left * S, y0: im.top * S,
          x1: (im.left + im.w) * S, y1: (im.top + im.h) * S,
        };
        const ix = Math.max(0, Math.min(regionBoxPx.x1, imageBoxPx.x1)
          - Math.max(regionBoxPx.x0, imageBoxPx.x0));
        const iy = Math.max(0, Math.min(regionBoxPx.y1, imageBoxPx.y1)
          - Math.max(regionBoxPx.y0, imageBoxPx.y0));
        const intersectionPx2 = ix * iy;
        if (!intersectionPx2) continue;
        const imageArea = Math.max(0, imageBoxPx.x1 - imageBoxPx.x0)
          * Math.max(0, imageBoxPx.y1 - imageBoxPx.y0);
        imageIntersectionPx2 += intersectionPx2;
        imageRefs.push({
          imageId: `p${pg.num}/image${imageIndex}`,
          bboxPt: { x0: im.left, y0: im.top, x1: im.left + im.w, y1: im.top + im.h },
          intersectionPx2,
          regionCoverage: regionArea > 0 ? intersectionPx2 / regionArea : 0,
          imageContainment: imageArea > 0 ? intersectionPx2 / imageArea : 0,
        });
      }
      return diag.registerCandidate(candidate, {
        anchorId, captionPage: pg.num, candidatePage: pg.num, pass, num,
        direction, seedSource: seedSource || "none", seedOrdinal: seedOrdinal || 0,
        regionBoxPx, imageRefs,
        imageCoverage: regionArea > 0 ? Math.min(1, imageIntersectionPx2 / regionArea) : 0,
        ...extra,
      });
    };

    /* 2) 예비 상한: stopper 스캔 (x-확장 판단용) */
    let yPre = 40;
    for (const u of lines) {
      const ub = u.top + u.h;
      if (ub >= cap.top || ox(u, capbox) < 10) continue;
      const owner = ownerByPart.get(u);
      if ((stoppers.has(u) || (owner && owner !== cap)) && ub > yPre) yPre = ub;
    }
    let x0 = capbox.left, x1 = capbox.left + capbox.w;
    const inband = lines.filter(u => u.top >= yPre - 2 && u.top + u.h <= cap.top + 2);
    /* 밴드 내 다른 캡션 → 확장 한계 */
    let exL = 0, exR = pg.w;
    for (const oc of caps) {
      if (oc === cap || oc.top < yPre - 2 || oc.top + oc.h > cap.top + 2) continue;
      if (oc.left > x1) exR = Math.min(exR, oc.left - 8);
      else if (oc.left + oc.w < x0) exL = Math.max(exL, oc.left + oc.w + 8);
    }
    /* 임베디드 형제 클램프 (v2.9.2) — 같은 라인에서 분해된 나란한 캡션끼리는 서로의 라벨 x를
     * 확장 한계로 삼는다. 형제는 캡션과 같은 baseline이라 위 밴드 루프가 잡지 못한다.
     * sibL/sibR은 임베디드 앵커에만 있으므로 나머지 코퍼스에 대한 영향은 없다. */
    if (capInfo.sibL != null) exL = Math.max(exL, capInfo.sibL);
    if (capInfo.sibR != null) exR = Math.min(exR, capInfo.sibR);
    if (!inband.some(u => (u.left + u.w < x0 || u.left > x1) && stoppers.has(u))) {
      for (const u of inband)
        if (u.left >= exL && u.left + u.w <= exR) {
          x0 = Math.min(x0, u.left); x1 = Math.max(x1, u.left + u.w);
        }
    }
    for (const im of pg.images) {
      if (im.top < cap.top && im.top + im.h > yPre - 20 &&
          ox(im, { left: x0, w: x1 - x0 }) > 0.3 * Math.min(im.w, x1 - x0)) {
        x0 = Math.min(x0, im.left); x1 = Math.max(x1, im.left + im.w);
      }
    }
    x0 = Math.max(x0, exL); x1 = Math.min(x1, exR);
    dbg(`  Fig${num}: cap L${cap.left.toFixed(0)} T${cap.top.toFixed(0)} font=${cap.font} | capbox L${colL.toFixed(0)}-R${colR.toFixed(0)} | yPre=${yPre.toFixed(0)} x=[${x0.toFixed(0)},${x1.toFixed(0)}] ex=[${exL.toFixed(0)},${exR.toFixed(0)}]`);

    /* 3) 픽셀 블록 스캔 (렌더 px) — 실패 시 캡션 폭으로 재시도 */
    const rcap = Math.max(0, Math.round(cap.top * S) - 2);
    const hasImage = (b0, b1) => pg.images.some(im => {
      const it = im.top * S, ib = (im.top + im.h) * S;
      return Math.min(ib, b1) - Math.max(it, b0) > 0.5 * (ib - it);
    });
    const scan = (bx0, bx1) => {
      const rx0 = Math.max(0, Math.round(bx0 * S)), rx1 = Math.min(grid.W, Math.round(bx1 * S));
      const Wb = Math.max(1, rx1 - rx0);
      const prof = new Int32Array(rcap);
      for (let y = 0; y < rcap; y++) {
        let c = 0;
        for (let x = rx0; x < rx1; x++) c += inkAt(grid, x, y);
        prof[y] = c;
      }
      const thr = Math.max(2, Math.floor(0.002 * Wb));
      const blank = y => prof[y] <= thr;
      const SEP = Math.round(4.8 * S);
      const blocks = [];
      let y = rcap - 1;
      while (y >= 0) {
        while (y >= 0 && blank(y)) y--;
        if (y < 0) break;
        const b1 = y; let gap = 0, b0 = y;
        while (y >= 0) {
          if (blank(y)) { gap++; if (gap >= SEP) break; }
          else { gap = 0; b0 = y; }
          y--;
        }
        blocks.push([b0, b1]);
      }
      const blockLines = (b0, b1) => lines.filter(u => {
        const c = (u.top + u.h / 2) * S;
        return c >= b0 - 4 && c <= b1 + 4 && ox(u, { left: bx0, w: bx1 - bx0 }) > 0.5 * u.w;
      });
      const hasBorder = (b0, b1) => {
        const h = b1 - b0 + 1;
        if (h < 18) return false;
        const step = Math.max(1, Math.floor(h / 40));
        const colsInk = [];
        for (let x = rx0; x < rx1; x++) {
          let any = 0;
          for (let yy = b0; yy <= b1; yy += step) if (inkAt(grid, x, yy)) { any = 1; break; }
          if (any) colsInk.push(x);
        }
        if (!colsInk.length) return false;
        for (const edge of [colsInk[0], colsInk[colsInk.length - 1]]) {
          for (let dx = 0; dx < 3; dx++) {
            const x = edge === colsInk[0] ? Math.min(grid.W-1, edge+dx) : Math.max(0, edge-dx);
            let run = 0, best = 0;
            for (let yy = b0; yy <= b1; yy++) {
              run = inkAt(grid, x, yy) ? run + 1 : 0;
              if (run > best) best = run;
            }
            if (best >= 0.75 * h) return true;
          }
        }
        return false;
      };
      const incl = [];
      let stopReason = "page-edge", stopNstop = 0;
      let farBoundary = 0;
      for (const [b0, b1] of blocks) {
        const bl = blockLines(b0, b1);
        const others = otherCaps(bl, cap);
        if (others.length) {
          if (!incl.length) {
            const cb = Math.max(...others.map(u => (u.top + u.h) * S)) + 3;
            if (b1 - cb > 15) incl.push([cb, b1]);
          }
          dbg(`    blk [${b0}-${b1}] OTHER-CAP stop`);
          stopReason = "other-cap";
          farBoundary = b1;
          break;
        }
        if (b1 < 56 * S && (b1 - b0) < 28 * S && bl.length) {
          dbg(`    blk [${b0}-${b1}] HEADER stop`); stopReason = "header"; farBoundary = b1; break;
        }
        const stopLines = bl.filter(u => stoppers.has(u));
        const nstop = stopLines.length;
        const guard = incl.length ? 1 : 2;
        /* 서브패널 면제 (v2.9.0): 캡션 바로 위 "첫" 블록의 stopper가 전부 서브패널 라벨이면
         * 본문이 아니라 figure 내부다. 첫 블록 한정(incl 비었을 때만) — 이 면제는 빈 결과만
         * 뒤집을 수 있고 이미 포함된 영역을 위로 넓히지 못한다 (인접 figure 침범 차단). */
        const subpanelPass = nstop >= guard && incl.length === 0 &&
          (cap.top - b1 / S) <= 24 && stopLines.every(u => subPanel.has(u));
        if (nstop >= guard && !subpanelPass && !hasBorder(b0, b1) && !hasImage(b0, b1)) {
          dbg(`    blk [${b0}-${b1}] BODY stop (nstop=${nstop})`);
          stopReason = "body"; stopNstop = nstop; farBoundary = b1; break;
        }
        /* table 캡션 경계 (v2.10.0) — ★ BODY stop '뒤'에 둔다. table은 자기 table '위'에 있어, up-scan이
         * 캡션에 닿을 땐 table 본체가 이미 아래로 포함된 뒤다. 여기서 STOP하고 캡션 아래로 작은 갭
         * (<TABLE_GAP_PT)으로 이어지는 블록 run(=table 본체)을 소급 제외한다. 종결 갭 없이 incl 전부를
         * 먹으면 롤백을 취소해 figure 손실을 막는다(병합 케이스 방어). incl 비었을 때(첫 블록)·거대 블록
         * (figure와 한 덩어리)에서는 미발동 → Aegaeon 8@p8 무회귀. BODY보다 뒤라 본문 "Table 1. The
         * results ..." 같은 오탐은 stopper로 먼저 BODY stop되어 여기 닿지 않는다(gate 표적 캡션은 nstop=0). */
        if (incl.length && (b1 - b0) <= TABLE_CAP_BLOCK_MAX * S && bl.some(u => tableStop.has(u))) {
          const T = TABLE_GAP_PT * S;
          let keep = incl.length, prevTop = b1;
          for (let i = incl.length - 1; i >= 0; i--) {
            if (incl[i][0] - prevTop >= T) { keep = i + 1; break; }
            prevTop = incl[i][1];
          }
          const removed = incl.length - keep;
          farBoundary = keep < incl.length ? incl[keep][1] : b1;
          incl.length = keep;
          dbg(`    blk [${b0}-${b1}] TABLE stop (rollback ${removed}${removed ? "" : " abort"})`);
          stopReason = "table"; break;
        }
        if (subpanelPass) dbg(`    blk [${b0}-${b1}] SUBPANEL pass (nstop=${nstop})`);
        dbg(`    blk [${b0}-${b1}] lines=${bl.length} nstop=${nstop} -> incl`);
        incl.push([b0, b1]);
        if (rcap - b0 > 660 * S) { stopReason = "max-span"; farBoundary = b0; break; }
      }
      /* 상단 슬리버(가는 선/헤더 잔재) 제거 */
      while (incl.length > 1) {
        const top = incl[incl.length - 1], nxt = incl[incl.length - 2];
        if ((top[1] - top[0]) < 12 * S && (nxt[0] - top[1]) > 40 * S) {
          farBoundary = Math.max(farBoundary, top[1]); incl.pop();
        }
        else break;
      }
      /* 상단 섹션 헤딩("2.1 Framework Overview" 등) 제거 */
      while (incl.length > 1) {
        const [tb0, tb1] = incl[incl.length - 1];
        if (tb1 - tb0 >= 20 * S) break;
        const bl = blockLines(tb0, tb1);
        if (!bl.length) break;
        const joined = bl.map(u => u.s).join(" ");
        if (joined.length <= 45 && /^(\d+(\.\d+)*|[A-Z](\.\d+)+)\s/.test(joined)) {
          farBoundary = Math.max(farBoundary, tb1); incl.pop();
        }
        else break;
      }
      const farBlankPx = incl.length
        ? Math.max(0, incl[incl.length - 1][0] - farBoundary - 1) : 0;
      return { incl, rx0, rx1, stopReason, stopNstop, farBlankPx, unprotectedBodyStops: 0 };
    };
    let { incl, rx0, rx1, stopReason: upStopReason, farBlankPx: upFarBlankPx,
      unprotectedBodyStops: upBodyStops, stopNstop: upStopNstop } = scan(x0, x1);
    if (!incl.length && (Math.abs(x0 - capbox.left) > 2 || Math.abs(x1 - (capbox.left + capbox.w)) > 2)) {
      dbg(`  Fig${num}: RETRY with capbox width`);
      ({ incl, rx0, rx1, stopReason: upStopReason, farBlankPx: upFarBlankPx,
        unprotectedBodyStops: upBodyStops, stopNstop: upStopNstop } =
        scan(capbox.left, capbox.left + capbox.w));
    }

    const measureCandidate = (dir, fx0, fx1, ry0, ry1, raster, stopReason,
      bodyStops, farBlankPx, gapOverride) => {
      const w = Math.max(1, fx1 - fx0), h = Math.max(1, ry1 - ry0);
      let ink = 0, samples = 0;
      const step = 3;
      const sy0 = Math.max(0, Math.ceil(ry0)), sy1 = Math.min(grid.H - 1, Math.floor(ry1));
      const sx0 = Math.max(0, Math.ceil(fx0)), sx1 = Math.min(grid.W - 1, Math.floor(fx1));
      for (let yy = sy0; yy <= sy1; yy += step) {
        for (let xx = sx0; xx <= sx1; xx += step) {
          ink += inkAt(grid, xx, yy); samples++;
        }
      }
      /* ── 수평 잉크 커버리지 (v2.13.0) ─────────────────────────────────────────
         up 후보 영역에서 잉크 질량의 90%를 담는 최소 연속 컬럼 폭 / 영역 폭 = coverage.
         진짜 전폭 figure는 잉크가 폭 전반에 퍼져 coverage↑(내부 패널 갭에 강건),
         over-grab(칼럼 figure를 전폭으로 잡음)은 잉크가 좁게 뭉쳐 coverage↓ + 가장자리 빈 여백.
         hugePenalty 면제 판별에만 쓰이므로 huge 조건(area>0.65‖h>0.82)일 때만 계산.
         covOcc(점유 컬럼 비율)·prof(24-bin 프로파일)는 진단 로그용. */
      const heightRatio0 = h / grid.H, areaRatio0 = (w * h) / (grid.W * grid.H);
      const hugeCond0 = areaRatio0 > 0.65 || heightRatio0 > 0.82;
      let coverage = 0, covOcc = 0;
      if (dir === "up" && hugeCond0 && sx1 > sx0 && sy1 >= sy0) {
        const cw = sx1 - sx0 + 1;
        const colCnt = new Uint32Array(cw);
        let rowsSampled = 0, total = 0;
        for (let yy = sy0; yy <= sy1; yy += step) {
          rowsSampled++;
          for (let xx = sx0; xx <= sx1; xx++)
            if (inkAt(grid, xx, yy)) { colCnt[xx - sx0]++; total++; }
        }
        if (total > 0) {
          /* 잉크 질량 90%를 담는 최소 연속 컬럼 창(슬라이딩 윈도우) / 영역 폭 = coverage */
          const need = 0.90 * total;
          let bestW = cw, lo = 0, acc = 0;
          for (let hi = 0; hi < cw; hi++) {
            acc += colCnt[hi];
            while (acc - colCnt[lo] >= need) { acc -= colCnt[lo]; lo++; }
            if (acc >= need && hi - lo + 1 < bestW) bestW = hi - lo + 1;
          }
          coverage = bestW / cw;
          const FILL = 0.12 * Math.max(1, rowsSampled);   // covOcc: 점유 컬럼 비율 (진단 로그용)
          let occ = 0; for (let i = 0; i < cw; i++) if (colCnt[i] >= FILL) occ++;
          covOcc = occ / cw;
        }
      }
      let geometricGapPt;
      if (dir === "up") geometricGapPt = Math.max(0, cap.top * S - ry1) / S;
      else if (dir === "down") geometricGapPt = Math.max(0, ry0 - capBottom * S) / S;
      else if (dir === "left") geometricGapPt = Math.max(0, cap.left * S - fx1) / S;
      else if (dir === "right")
        geometricGapPt = Math.max(0, fx0 - (cap.left + cap.w) * S) / S;
      else geometricGapPt = Infinity;
      const gapPt = Number.isFinite(gapOverride) ? gapOverride : geometricGapPt;
      return {
        widthPt: w / S,
        heightPt: h / S,
        widthRatio: w / grid.W,
        heightRatio: h / grid.H,
        areaRatio: (w * h) / (grid.W * grid.H),
        inkDensity: samples ? ink / samples : 0,
        gapPt,
        bodyStops,
        farBlankPx,
        farClosed: farBlankPx >= Math.round(4.8 * S),
        raster,
        stopReason,
        direction: dir,
        coverage, covOcc
      };
    };
    const scoreText = (dir, candidate) => {
      if (!candidate) return `  Fig${num}: SCORE ${dir} none`;
      const m = candidate.metrics, s = candidate.score;
      return `  Fig${num}: SCORE ${dir} total=${s.total.toFixed(2)} valid=${candidate.valid ? 1 : 0}` +
        ` area=${m.areaRatio.toFixed(3)} wh=${m.widthRatio.toFixed(3)}/${m.heightRatio.toFixed(3)}` +
        ` density=${m.inkDensity.toFixed(3)} gap=${m.gapPt.toFixed(1)}pt` +
        ` body=${m.bodyStops} blank=${m.farBlankPx}px closed=${m.farClosed ? 1 : 0}` +
        ` raster=${m.raster ? 1 : 0}` +
        ` stop=${m.stopReason} reject=${candidate.rejectReason || "-"}` +
        ` terms=${s.area.toFixed(2)}/${s.width.toFixed(2)}/${s.height.toFixed(2)}/` +
        `${s.density.toFixed(2)}/${s.proximity.toFixed(2)}/${s.boundary.toFixed(2)}/${s.raster.toFixed(2)}` +
        ` penalties=${s.bodyPenalty.toFixed(2)}/${s.tinyPenalty.toFixed(2)}/` +
        `${s.slenderPenalty.toFixed(2)}/${s.hugePenalty.toFixed(2)}/${s.otherCapPenalty.toFixed(2)}` +
        ` cov=${m.coverage.toFixed(2)} occ=${m.covOcc.toFixed(2)}`;
    };

    const downStart = Math.max(0, Math.round(capBottom * S) + 2);
    const capNorm = capText.replace(/\s+/g, " ").trim();
    /* ★ 양쪽 모두 글리프를 벗긴 값으로 비교해야 한다 (v2.19.4). capText만 벗기고 cap.s를 raw로
     * 두면 글리프 앵커는 두 문자열이 정의상 달라 bareLabel이 **항상 false**가 되고, 거기 매달린
     * empty·bareDown·huge·otherCap·suspect·healthyBareUp·adjacentEvidence 분기가 통째로 죽는다
     * — "글리프 유무와 무관하게 같게 판정된다"는 v2.19.2의 계약이 여기서 깨졌었다. */
    const capLineNorm = captionTestText(cap.s).replace(/\s+/g, " ").trim();
    const bareLabel = capNorm === capLineNorm && capNorm.length <= 16 &&
      capBottom - cap.top <= Math.max(cap.h * 1.4, cap.h + 2);

    const downSeedBounds = () => {
      /* 위쪽 yPre에서 만든 x0/x1·exL/exR은 하향 후보에 재사용하지 않는다.
         캡션 아래의 실제 이미지/근접 잉크를 성분별 seed로 두어, 같은 높이의 figure와
         본문 열을 한 범위로 합치지 않고 BODY 판정이 각자 작동하게 한다. */
      const seeds = [];
      const capR = capbox.left + capbox.w;
      const nearbyImages = [];
      for (const im of pg.images) {
        const vgap = im.top - capBottom;
        const hgap = im.left > capR ? im.left - capR
          : capbox.left > im.left + im.w ? capbox.left - (im.left + im.w) : 0;
        if (vgap >= -4 && vgap < 48 && hgap <= 96)
          nearbyImages.push({ bx0: im.left, bx1: im.left + im.w, source: "image", hgap });
      }
      nearbyImages.sort((a, b) => a.hgap - b.hgap ||
        (b.bx1 - b.bx0) - (a.bx1 - a.bx0) || a.bx0 - b.bx0);
      for (const imageSeed of nearbyImages.slice(0, 1))
        seeds.push({ bx0: imageSeed.bx0, bx1: imageSeed.bx1, source: imageSeed.source });
      const eL = 0, eR = grid.W;
      const bandEnd = Math.min(grid.H, downStart + Math.round(48 * S));
      const capLpx = Math.round(capbox.left * S), capRpx = Math.round(capR * S);
      const occupied = [];
      for (let xx = eL; xx < eR; xx++) {
        let any = false;
        for (let yy = downStart; yy < bandEnd; yy += 2) {
          if (inkAt(grid, xx, yy)) { any = true; break; }
        }
        if (!any) continue;
        occupied.push(xx);
      }
      const runs = [], JOIN = Math.round(8 * S);
      for (const xx of occupied) {
        const last = runs[runs.length - 1];
        if (!last || xx - last.x1 > JOIN) runs.push({ x0: xx, x1: xx });
        else last.x1 = xx;
      }
      const nearbyRuns = [];
      for (const run of runs) {
        const gap = run.x1 < capLpx ? capLpx - run.x1 : run.x0 > capRpx ? run.x0 - capRpx : 0;
        const width = run.x1 - run.x0 + 1;
        if (gap <= 140 * S && width >= 4 * S) nearbyRuns.push({ ...run, gap, width });
      }
      nearbyRuns.sort((a, b) => b.width - a.width || a.gap - b.gap || a.x0 - b.x0);
      for (const run of nearbyRuns.slice(0, 2))
        seeds.push({ bx0: run.x0 / S, bx1: (run.x1 + 1) / S, source: "ink" });
      /* component 증거가 같은 점수면 image/넓은 ink를 먼저 유지하고 cap-only는 마지막 폴백이다. */
      seeds.push({ bx0: capbox.left, bx1: capR, source: "cap" });
      const unique = [];
      for (const seed of seeds) {
        const clipped = {
          bx0: Math.max(0, seed.bx0), bx1: Math.min(pg.w, seed.bx1), source: seed.source
        };
        if (clipped.bx1 <= clipped.bx0) continue;
        const key = `${Math.round(clipped.bx0 * S)}:${Math.round(clipped.bx1 * S)}`;
        if (!unique.some(u => u.key === key)) unique.push({ ...clipped, key });
      }
      return unique.map(({ key, ...seed }) => seed);
    };
    const hasImageIn = (b0, b1, bx0, bx1) => pg.images.some(im => {
      const it = im.top * S, ib = (im.top + im.h) * S;
      const vertical = Math.min(ib, b1) - Math.max(it, b0);
      return vertical > 0.5 * (ib - it) &&
        ox(im, { left: bx0, w: bx1 - bx0 }) > 0.2 * Math.min(im.w, bx1 - bx0);
    });
    const downSeeds = downSeedBounds();
    const firstMeaningfulDownGap = seed => {
      if (!seed || downStart >= grid.H || seed.bx1 <= seed.bx0) return Infinity;
      const rx0 = Math.max(0, Math.round(seed.bx0 * S));
      const rx1 = Math.min(grid.W, Math.round(seed.bx1 * S));
      const Wb = Math.max(1, rx1 - rx0);
      const limit = Math.min(grid.H, downStart + Math.round(30 * S));
      const prof = new Int32Array(Math.max(0, limit - downStart));
      for (let y = downStart; y < limit; y++) {
        let c = 0;
        for (let x = rx0; x < rx1; x++) c += inkAt(grid, x, y);
        prof[y - downStart] = c;
      }
      const thr = Math.max(2, Math.floor(0.002 * Wb));
      const blank = y => prof[y - downStart] <= thr;
      const SEP = Math.round(4.8 * S), MIN_H = Math.round(4 * S);
      let y = downStart;
      while (y < limit) {
        while (y < limit && blank(y)) y++;
        if (y >= limit) break;
        const b0 = y; let b1 = y, gap = 0;
        while (y < limit) {
          if (blank(y)) { gap++; if (gap >= SEP) break; }
          else { gap = 0; b1 = y; }
          y++;
        }
        if (b1 - b0 + 1 >= MIN_H) return (b0 - downStart) / S;
      }
      return Infinity;
    };
    const downGapPt = downSeeds.reduce((best, seed) =>
      Math.min(best, firstMeaningfulDownGap(seed)), Infinity);

    const scanDown = (bx0, bx1, strictProseTail) => {
      const drx0 = Math.max(0, Math.round(bx0 * S));
      const drx1 = Math.min(grid.W, Math.round(bx1 * S));
      const Wb = Math.max(1, drx1 - drx0);
      const prof = new Int32Array(Math.max(0, grid.H - downStart));
      for (let y = downStart; y < grid.H; y++) {
        let c = 0;
        for (let x = drx0; x < drx1; x++) c += inkAt(grid, x, y);
        prof[y - downStart] = c;
      }
      const thr = Math.max(2, Math.floor(0.002 * Wb));
      const blank = y => prof[y - downStart] <= thr;
      const SEP = Math.round(4.8 * S);
      const blocks = [];
      let y = downStart;
      while (y < grid.H) {
        while (y < grid.H && blank(y)) y++;
        if (y >= grid.H) break;
        const b0 = y; let gap = 0, b1 = y;
        while (y < grid.H) {
          if (blank(y)) { gap++; if (gap >= SEP) break; }
          else { gap = 0; b1 = y; }
          y++;
        }
        blocks.push([b0, b1]);
      }
      const blockLines = (b0, b1) => lines.filter(u => {
        const c = (u.top + u.h / 2) * S;
        return c >= b0 - 4 && c <= b1 + 4 && ox(u, { left: bx0, w: bx1 - bx0 }) > 0.5 * u.w;
      });
      const borderEdgeCount = (b0, b1) => {
        const h = b1 - b0 + 1;
        if (h < 18) return 0;
        const step = Math.max(1, Math.floor(h / 40));
        const colsInk = [];
        for (let x = drx0; x < drx1; x++) {
          let any = 0;
          for (let yy = b0; yy <= b1; yy += step) if (inkAt(grid, x, yy)) { any = 1; break; }
          if (any) colsInk.push(x);
        }
        if (!colsInk.length) return 0;
        let count = 0;
        for (const edge of new Set([colsInk[0], colsInk[colsInk.length - 1]])) {
          let continuous = false;
          for (let dx = 0; dx < 3; dx++) {
            const x = edge === colsInk[0] ? Math.min(grid.W - 1, edge + dx) : Math.max(0, edge - dx);
            let run = 0, best = 0;
            for (let yy = b0; yy <= b1; yy++) {
              run = inkAt(grid, x, yy) ? run + 1 : 0;
              if (run > best) best = run;
            }
            if (best >= 0.75 * h) { continuous = true; break; }
          }
          if (continuous) count++;
        }
        return count;
      };
      const hasBorder = (b0, b1) => borderEdgeCount(b0, b1) > 0;
      const hasFrame = (b0, b1) => borderEdgeCount(b0, b1) >= 2;
      const hasHorizontalEdge = (b0, b1, top) => {
        const from = top ? b0 : Math.max(b0, b1 - 4);
        const to = top ? Math.min(b1, b0 + 4) : b1;
        const need = 0.65 * Math.max(1, drx1 - drx0);
        for (let yy = from; yy <= to; yy++) {
          let run = 0, best = 0;
          for (let x = drx0; x < drx1; x++) {
            run = inkAt(grid, x, yy) ? run + 1 : 0;
            if (run > best) best = run;
          }
          if (best >= need) return true;
        }
        return false;
      };
      const hasClosedFrame = (b0, b1) => hasFrame(b0, b1) &&
        hasHorizontalEdge(b0, b1, true) && hasHorizontalEdge(b0, b1, false);
      const dIncl = [];
      let stopReason = "page-edge";
      let farBoundary = grid.H, unprotectedBodyStops = 0;
      for (const [b0, b1] of blocks) {
        const bl = blockLines(b0, b1);
        const proseLines = strictProseTail ? bl.filter(u => {
          const text = u.s.replace(/\s+/g, " ").trim();
          if (u.w < 90 || u.h < 6 || text.length < 24) return false;
          const nb = neighborsOf(u, lines);
          return nb.above && nb.below;
        }) : [];
        if (strictProseTail && dIncl.length) {
          const prev = dIncl[dIncl.length - 1];
          const gapPt = (b0 - prev[1] - 1) / S;
          const includedPt = (prev[1] - dIncl[0][0] + 1) / S;
          const textHeavy = proseLines.length >= 4 && proseLines.length * 2 >= bl.length;
          dbg(`    DOWN blk [${b0}-${b1}] hard-prose=${proseLines.length}/${bl.length}` +
            ` gap=${gapPt.toFixed(1)}pt span=${includedPt.toFixed(1)}pt`);
          if (gapPt >= 6 && includedPt >= 80 && textHeavy) {
            dbg(`    DOWN blk [${b0}-${b1}] PROSE-TAIL stop`);
            stopReason = "prose-tail"; farBoundary = b0; break;
          }
        }
        const others = otherCaps(bl, cap);
        if (others.length) {
          if (!dIncl.length) {
            const ct = Math.min(...others.map(u => u.top * S)) - 3;
            if (ct - b0 > 15) dIncl.push([b0, ct]);
          }
          dbg(`    DOWN blk [${b0}-${b1}] OTHER-CAP stop`);
          stopReason = "other-cap";
          farBoundary = b0;
          break;
        }
        if (b0 > grid.H - 56 * S && (b1 - b0) < 28 * S && bl.length) {
          dbg(`    DOWN blk [${b0}-${b1}] FOOTER stop`);
          stopReason = "footer"; farBoundary = b0; break;
        }
        const stopperLines = bl.filter(u => stoppers.has(u));
        const nstop = stopperLines.length;
        const imageProtectedStops = stopperLines.filter(u => pg.images.some(im => {
          const vertical = Math.min(im.top + im.h, u.top + u.h) - Math.max(im.top, u.top);
          return vertical > 0.5 * u.h && ox(im, u) > 0.5 * u.w;
        })).length;
        const unprotectedNstop = nstop - imageProtectedStops;
        const guard = dIncl.length ? 1 : 2;
        const frame = nstop ? hasFrame(b0, b1) : false;
        if (unprotectedNstop >= guard && !frame) {
          dbg(`    DOWN blk [${b0}-${b1}] BODY stop` +
            ` (nstop=${nstop} protected=${imageProtectedStops})`);
          stopReason = "body"; farBoundary = b0;
          break;
        }
        dbg(`    DOWN blk [${b0}-${b1}] lines=${bl.length} nstop=${nstop}` +
          ` protected=${imageProtectedStops} -> incl`);
        dIncl.push([b0, b1]);
        /* 이미지/테두리가 페이지 본문 전체와 우연히 겹쳐도 대량 stopper는 figure 증거가 아니다. */
        if (nstop >= 12) unprotectedBodyStops += nstop;
        else if (!frame) unprotectedBodyStops += unprotectedNstop;
        if (b1 - downStart > 660 * S) {
          stopReason = "max-span"; farBoundary = b1; break;
        }
      }
      /* label 바로 아래의 얇은 구분선은 figure 폭을 페이지 전체로 부풀리지 않게 제외한다. */
      while (dIncl.length > 1) {
        const near = dIncl[0], next = dIncl[1];
        if ((near[1] - near[0] + 1) < 4 * S && (next[0] - near[1] - 1) >= 4 * S) {
          dbg(`    DOWN NEAR-SLIVER drop [${near[0]}-${near[1]}]`); dIncl.shift();
        } else break;
      }
      /* 큰 래스터/완전 프레임 뒤의 짧은 텍스트 블록은 figure 밖 설명문이다.
         한쪽 축만 긴 차트는 frame으로 보지 않아 내부 source/note를 보존한다. */
      for (let i = 0; i + 1 < dIncl.length; i++) {
        const cur = dIncl[i], next = dIncl[i + 1];
        const gap = next[0] - cur[1] - 1;
        const nextLines = blockLines(next[0], next[1]);
        const curProtected = hasImageIn(cur[0], cur[1], bx0, bx1) || hasClosedFrame(cur[0], cur[1]);
        const nextProtected = hasImageIn(next[0], next[1], bx0, bx1) || hasBorder(next[0], next[1]);
        if ((cur[1] - cur[0] + 1) >= 80 * S && gap >= 8 * S && curProtected &&
            nextLines.length && !nextProtected && (next[1] - next[0] + 1) <= 36 * S) {
          dbg(`    DOWN TEXT-TAIL stop [${next[0]}-${next[1]}] lines=${nextLines.length}`);
          stopReason = "text-tail"; farBoundary = Math.min(farBoundary, next[0]);
          dIncl.splice(i + 1); break;
        }
      }
      /* 캡션에서 먼 끝(하단)의 가는 슬리버·섹션 헤딩 제거 */
      while (dIncl.length > 1) {
        const far = dIncl[dIncl.length - 1], prev = dIncl[dIncl.length - 2];
        if ((far[1] - far[0]) < 12 * S && (far[0] - prev[1]) > 40 * S) {
          farBoundary = Math.min(farBoundary, far[0]); dIncl.pop();
        }
        else break;
      }
      while (dIncl.length > 1) {
        const [fb0, fb1] = dIncl[dIncl.length - 1];
        if (fb1 - fb0 >= 20 * S) break;
        const bl = blockLines(fb0, fb1);
        if (!bl.length) break;
        const joined = bl.map(u => u.s).join(" ");
        if (joined.length <= 45 && /^(\d+(\.\d+)*|[A-Z](\.\d+)+)\s/.test(joined)) {
          farBoundary = Math.min(farBoundary, fb0); dIncl.pop();
        }
        else break;
      }
      const farBlankPx = dIncl.length
        ? Math.max(0, farBoundary - dIncl[dIncl.length - 1][1] - 1) : 0;
      return { incl: dIncl, rx0: drx0, rx1: drx1, stopReason,
        farBlankPx, unprotectedBodyStops };
    };

    const buildDownCandidate = (seed, index, total, strictProseTail) => {
      const seedGapPt = firstMeaningfulDownGap(seed);
      dbg(`  Fig${num}: DOWN seed ${index + 1}/${total} ${seed.source}` +
        ` x=[${seed.bx0.toFixed(0)},${seed.bx1.toFixed(0)}]` +
        ` start=${downStart} capBottom=${capBottom.toFixed(1)}pt`);
      const down = scanDown(seed.bx0, seed.bx1, strictProseTail);
      if (!down.incl.length) {
        diagnosticAttempt("down", seed.source, index, "not-generated", ["no-block"], {
          seedBoxPt: { x0: seed.bx0, y0: capBottom, x1: seed.bx1, y1: capBottom },
          stopReason: down.stopReason,
        });
        return null;
      }
      const ry0 = down.incl[0][0], ry1 = down.incl[down.incl.length - 1][1];
      const raster = down.incl.some(([a, b]) => hasImageIn(a, b, seed.bx0, seed.bx1));
      /* 방향별 후보 생성기는 달라도 공통 figureScore/선택기로 합류한다. 좌/우는 Phase 2. */
      const scanY0 = Math.max(0, Math.ceil(ry0)), scanY1 = Math.min(grid.H - 1, Math.floor(ry1));
      const rowsHasInk = x => {
        for (let yy = scanY0; yy <= scanY1; yy += 2) if (inkAt(grid, x, yy)) return true;
        return false;
      };
      const forbid = [];
      for (const u of lines) {
        const c = (u.top + u.h / 2) * S;
        if (c < ry0 || c > ry1) continue;
        const owner = ownerByPart.get(u);
        let bodyish = stoppers.has(u) || (!!owner && owner !== cap);
        if (!bodyish && u.font === dom && u.h >= 6 && u.w >= 100) {
          const nb = neighborsOf(u, lines);
          bodyish = nb.above && nb.below;
        }
        if (bodyish) forbid.push([Math.round(u.left * S), Math.round((u.left + u.w) * S)]);
      }
      const inForbid = x => forbid.some(([a, b]) => x >= a && x <= b);
      const tol = Math.round(12 * S);
      const eR = grid.W, eL = 0;
      let xx = down.rx1, gap2 = 0, lastInk = down.rx1;
      while (xx < eR && gap2 < tol && !inForbid(xx)) {
        if (rowsHasInk(xx)) { lastInk = xx + 1; gap2 = 0; } else gap2++;
        xx++;
      }
      let nrx1 = Math.max(down.rx1, lastInk);
      xx = down.rx0 - 1; gap2 = 0; lastInk = down.rx0;
      while (xx >= eL && gap2 < tol && !inForbid(xx)) {
        if (rowsHasInk(xx)) { lastInk = xx; gap2 = 0; } else gap2++;
        xx--;
      }
      let nrx0 = Math.min(down.rx0, lastInk);
      const textInStrip = (a, b) => lines.filter(u => {
        const c = (u.top + u.h / 2) * S;
        if (c < ry0 || c > ry1 || u.h < 6 || u.font !== dom) return false;
        const ul = u.left * S, ur = (u.left + u.w) * S;
        return Math.min(ur, b) - Math.max(ul, a) > 4;
      }).length;
      if (nrx0 < down.rx0 && textInStrip(nrx0, down.rx0) >= 3) nrx0 = down.rx0;
      if (nrx1 > down.rx1 && textInStrip(down.rx1, nrx1) >= 3) nrx1 = down.rx1;
      let fx0 = nrx1, fx1 = nrx0;
      for (let x = nrx0; x < nrx1; x++) {
        for (let yy = scanY0; yy <= scanY1; yy += 2) {
          if (inkAt(grid, x, yy)) { fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); break; }
        }
      }
      if (fx0 > fx1) { fx0 = nrx0; fx1 = nrx1; }
      /* 래스터 seed는 이미지 bbox 자체가 강한 x 경계다. 멀리 놓인 label 폭까지 강제로
         합치면 Matsuzawa처럼 큰 빈 여백이 생기므로, cap 합집합은 vector/ink seed에만 쓴다. */
      if (seed.source !== "image") {
        fx0 = Math.min(fx0, Math.round(capbox.left * S));
        fx1 = Math.max(fx1, Math.round((capbox.left + capbox.w) * S));
      }
      dbg(`  Fig${num}: DOWN REGION y[${ry0}-${ry1}] x[${fx0}-${fx1}]${raster ? " raster" : ""}`);
      const finalBoxPt = { left: fx0 / S, w: (fx1 - fx0) / S };
      const seedBoxPt = { left: seed.bx0, w: seed.bx1 - seed.bx0 };
      const outsideSeedBodyStops = lines.filter(u => {
        if (!stoppers.has(u)) return false;
        const c = (u.top + u.h / 2) * S;
        return c >= ry0 && c <= ry1 && ox(u, finalBoxPt) > 0.5 * u.w &&
          ox(u, seedBoxPt) <= 0.5 * u.w;
      }).length;
      const metrics = measureCandidate("down", fx0, fx1, ry0, ry1, raster, down.stopReason,
        down.unprotectedBodyStops + outsideSeedBodyStops, down.farBlankPx, seedGapPt);
      const valid = seedGapPt <= 14 && metrics.widthRatio >= 0.15 && metrics.heightPt >= 24 &&
        metrics.areaRatio >= 0.008 && metrics.inkDensity >= 0.002 &&
        metrics.areaRatio <= 0.65 && metrics.heightRatio <= 0.82 && metrics.bodyStops <= 1;
      const candidate = {
        direction: "down",
        seedSource: seed.source,
        valid,
        fig: { num, raster_: raster, page: pg.num,
          x0: fx0 - 10, x1: fx1 + 10,
          y0: Math.max(Math.round(capBottom * S) + 1, ry0 - 4), y1: Math.min(grid.H, ry1 + 8),
          h_: Math.round(ry1 - cap.top * S), caption: capText, captionBox },
        metrics,
        score: figureScore(metrics)
      };
      if (diag) {
        const reasons = [];
        if (seedGapPt > 14) reasons.push("gap");
        if (metrics.widthRatio < 0.15) reasons.push("thin-width");
        if (metrics.heightPt < 24) reasons.push("short-height");
        if (metrics.areaRatio < 0.008) reasons.push("small-area");
        if (metrics.inkDensity < 0.002) reasons.push("sparse");
        if (metrics.areaRatio > 0.65 || metrics.heightRatio > 0.82) reasons.push("huge");
        if (metrics.bodyStops > 1) reasons.push("body");
        candidate.diagReasons_ = reasons;
        registerDiagnosticCandidate(candidate, "down", seed.source, index,
          { x0: fx0, y0: ry0, x1: fx1, y1: ry1 }, {
            seedBoxPt: {
              x0: seed.bx0, y0: capBottom,
              x1: seed.bx1, y1: Math.min(pg.h, capBottom + 48),
            },
          });
      }
      return candidate;
    };

    const SIDE_MAX_GAP_PT = 36;
    const label = capInfo.labelBox;
    const labelT = Math.round(label.top * S);
    const labelB = Math.round((label.top + label.h) * S);
    const capT = Math.round(cap.top * S);
    const capB = Math.round(capBottom * S);
    const quantile = (values, q) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.round((sorted.length - 1) * q)];
    };
    const captionColumnLines = [...ownCaptionLines];
    const sideColumnLeftPt = Math.min(label.left,
      quantile(captionColumnLines.map(u => u.left), 0.25));
    const sideColumnRightPt = Math.max(label.left + label.w,
      quantile(captionColumnLines.map(u => u.left + u.w), 0.75));
    const sideL = Math.max(0, Math.round(sideColumnLeftPt * S));
    const sideR = Math.min(grid.W, Math.round(sideColumnRightPt * S));
    const sideColumnWidthPt = Math.max(0, sideColumnRightPt - sideColumnLeftPt);
    const sideColumnCenterPt = (sideColumnLeftPt + sideColumnRightPt) / 2;
    /* A broad left-half caption is commonly the caption below a half-width panel,
       not a side caption (Payzan Fig3). Right-side editorial columns can be wider
       (Monosov Fig5), so retain the broader allowance only on that side. */
    const sideWidthLimit = sideColumnCenterPt < 0.45 * pg.w ? 0.34 : 0.48;
    const sideShapeEligible = sideColumnWidthPt <= sideWidthLimit * pg.w;
    const sideDirectionAllowed = direction => sideShapeEligible &&
      (direction === "left" ? sideColumnCenterPt >= 0.45 * pg.w
        : sideColumnCenterPt <= 0.55 * pg.w);
    dbg(`  Fig${num}: SIDE-ANCHOR x=[${sideColumnLeftPt.toFixed(0)},` +
      `${sideColumnRightPt.toFixed(0)}] w=${sideColumnWidthPt.toFixed(0)}pt` +
      ` center=${(sideColumnCenterPt / pg.w).toFixed(2)}` +
      ` limit=${sideWidthLimit.toFixed(2)} eligible=${sideShapeEligible ? 1 : 0}`);

    const sideSeedBounds = direction => {
      if (!sideDirectionAllowed(direction)) {
        dbg(`  Fig${num}: ${direction.toUpperCase()} REJECT side-facing`);
        diagnosticAttempt(direction, "none", 0, "not-generated", ["side-facing"], {
          sideAnchor: {
            leftPt: sideColumnLeftPt, rightPt: sideColumnRightPt,
            widthPt: sideColumnWidthPt, centerRatio: sideColumnCenterPt / pg.w,
          },
        });
        return [];
      }
      const leftward = direction === "left";
      const edgePt = leftward ? sideColumnLeftPt : sideColumnRightPt;
      const edgePx = leftward ? sideL : sideR;
      const seeds = [], imageSeeds = [];
      for (const im of pg.images) {
        const center = im.left + im.w / 2;
        if (leftward ? center >= edgePt : center <= edgePt) continue;
        const hgap = leftward ? edgePt - (im.left + im.w) : im.left - edgePt;
        const vgap = im.top + im.h < cap.top ? cap.top - (im.top + im.h)
          : im.top > capBottom ? im.top - capBottom : 0;
        if (hgap >= -4 && hgap <= 72 && vgap <= 96)
          imageSeeds.push({ by0: im.top, by1: im.top + im.h, source: "image",
            hgap: Math.max(0, hgap), area: im.w * im.h });
      }
      imageSeeds.sort((a, b) => a.hgap - b.hgap || b.area - a.area || a.by0 - b.by0);
      if (imageSeeds.length) seeds.push(imageSeeds[0]);

      const start = leftward ? edgePx - 2 : edgePx + 2;
      const bandSpan = Math.round(72 * S);
      const band0 = leftward ? Math.max(0, start - bandSpan) : Math.max(0, start);
      const band1 = leftward ? Math.min(grid.W - 1, start)
        : Math.min(grid.W - 1, start + bandSpan);
      const occupied = [];
      if (band1 >= band0) {
        for (let y = 0; y < grid.H; y++) {
          let any = false;
          for (let x = band0; x <= band1; x += 2) {
            if (inkAt(grid, x, y)) { any = true; break; }
          }
          if (any) occupied.push(y);
        }
      }
      const runs = [], JOIN = Math.round(8 * S);
      for (const y of occupied) {
        const last = runs[runs.length - 1];
        if (!last || y - last.y1 > JOIN) runs.push({ y0: y, y1: y });
        else last.y1 = y;
      }
      const nearbyRuns = runs.map(run => {
        const gap = run.y1 < capT ? capT - run.y1 : run.y0 > capB ? run.y0 - capB : 0;
        return { ...run, gap, height: run.y1 - run.y0 + 1 };
      }).filter(run => run.gap <= 140 * S && run.height >= 4 * S)
        .sort((a, b) => a.gap - b.gap || b.height - a.height || a.y0 - b.y0);
      for (const run of nearbyRuns.slice(0, 2))
        seeds.push({ by0: run.y0 / S, by1: (run.y1 + 1) / S, source: "ink" });
      /* Keep the expanded caption band for horizontal component discovery. The
         candidate builder separately uses mandatory labelBox rows as its vertical
         origin, so swallowed prose cannot inflate the final figure height. */
      seeds.push({ by0: cap.top, by1: capBottom, source: "caption" });

      const unique = [];
      for (const seed of seeds) {
        const clipped = { by0: Math.max(0, Math.min(pg.h, seed.by0)),
          by1: Math.max(0, Math.min(pg.h, seed.by1)), source: seed.source };
        if (clipped.by1 <= clipped.by0) continue;
        const key = Math.round(clipped.by0 * S) + ":" + Math.round(clipped.by1 * S);
        if (!unique.some(u => u.key === key)) unique.push({ ...clipped, key });
      }
      return unique.map(({ key, ...seed }) => {
        const overlappingCaptionLines = captionColumnLines.filter(u =>
          Math.min(u.top + u.h, seed.by1) - Math.max(u.top, seed.by0) > 0.35 * u.h);
        const seedEdgePt = leftward
          ? Math.min(sideColumnLeftPt, ...overlappingCaptionLines.map(u => u.left))
          : Math.max(sideColumnRightPt,
            ...overlappingCaptionLines.map(u => u.left + u.w));
        return { ...seed, edgePt: seedEdgePt };
      });
    };

    const sideProfile = (direction, seed) => {
      const leftward = direction === "left";
      const edgePx = Math.max(0, Math.min(grid.W, Math.round(seed.edgePt * S)));
      const rawStart = leftward ? edgePx - 2 : edgePx + 2;
      const start = Math.max(0, Math.min(grid.W - 1, rawStart));
      const maxD = Math.max(0, leftward ? start : grid.W - 1 - start);
      const sy0 = Math.max(0, Math.min(grid.H - 1, Math.ceil(seed.by0 * S)));
      const sy1 = Math.max(sy0, Math.min(grid.H - 1, Math.floor(seed.by1 * S)));
      const seedHeight = Math.max(1, sy1 - sy0 + 1);
      const xAt = d => leftward ? start - d : start + d;
      const prof = new Int32Array(maxD + 1);
      for (let d = 0; d <= maxD; d++) {
        let count = 0;
        const x = xAt(d);
        for (let y = sy0; y <= sy1; y++) count += inkAt(grid, x, y);
        prof[d] = count;
      }
      const thr = Math.max(2, Math.floor(0.002 * seedHeight));
      const blank = d => prof[d] <= thr;
      const SEP = Math.round(4.8 * S), MIN_W = Math.round(4 * S);
      const blocks = [];
      let d = 0;
      while (d <= maxD) {
        while (d <= maxD && blank(d)) d++;
        if (d > maxD) break;
        const b0 = d; let b1 = d, gap = 0;
        while (d <= maxD) {
          if (blank(d)) {
            gap++;
            if (gap >= SEP) { d++; break; }
          } else { gap = 0; b1 = d; }
          d++;
        }
        if (b1 - b0 + 1 >= MIN_W) blocks.push([b0, b1]);
      }
      return { leftward, edgePx, start, maxD, sy0, sy1, xAt, blocks };
    };

    const scanSide = (direction, seed) => {
      const profile = sideProfile(direction, seed);
      const toActual = ([d0, d1]) => profile.leftward
        ? { x0: profile.start - d1, x1: profile.start - d0, d0, d1 }
        : { x0: profile.start + d0, x1: profile.start + d1, d0, d1 };
      const blockLines = block => lines.filter(u => {
        const cx = (u.left + u.w / 2) * S;
        const ut = u.top * S, ub = (u.top + u.h) * S;
        const vertical = Math.min(ub, profile.sy1) - Math.max(ut, profile.sy0);
        return cx >= block.x0 - 4 && cx <= block.x1 + 4 && vertical > 0.5 * u.h * S;
      });
      const xobjectProtects = u => seed.source === "image" && pg.images.some(im => {
        const vertical = Math.min(im.top + im.h, u.top + u.h) - Math.max(im.top, u.top);
        return vertical > 0.5 * u.h && ox(im, u) > 0.5 * u.w;
      });
      const blockHasImage = block => pg.images.some(im => {
        const ix0 = im.left * S, ix1 = (im.left + im.w) * S;
        const iy0 = im.top * S, iy1 = (im.top + im.h) * S;
        return Math.min(ix1, block.x1) - Math.max(ix0, block.x0) > 8 &&
          Math.min(iy1, profile.sy1) - Math.max(iy0, profile.sy0) > 8;
      });
      const blockHasFrame = block => {
        const x0 = Math.max(0, Math.ceil(block.x0));
        const x1 = Math.min(grid.W - 1, Math.floor(block.x1));
        const y0 = profile.sy0, y1 = profile.sy1;
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        if (w < 18 || h < 18) return false;
        const verticalEdge = left => {
          for (let dx = 0; dx < 3; dx++) {
            const x = left ? Math.min(x1, x0 + dx) : Math.max(x0, x1 - dx);
            let run = 0, best = 0;
            for (let y = y0; y <= y1; y++) {
              run = inkAt(grid, x, y) ? run + 1 : 0;
              if (run > best) best = run;
            }
            if (best >= 0.70 * h) return true;
          }
          return false;
        };
        const horizontalEdge = top => {
          for (let dy = 0; dy < 4; dy++) {
            const y = top ? Math.min(y1, y0 + dy) : Math.max(y0, y1 - dy);
            let run = 0, best = 0;
            for (let x = x0; x <= x1; x++) {
              run = inkAt(grid, x, y) ? run + 1 : 0;
              if (run > best) best = run;
            }
            if (best >= 0.65 * w) return true;
          }
          return false;
        };
        return verticalEdge(true) && verticalEdge(false) &&
          horizontalEdge(true) && horizontalEdge(false);
      };
      const incl = [];
      let stopReason = "page-edge", farBoundaryD = profile.maxD, bodyStops = 0;
      for (const raw of profile.blocks) {
        const block = toActual(raw);
        const bl = blockLines(block);
        const frame = blockHasFrame(block);
        const others = otherCaps(bl, cap);
        if (others.length) {
          dbg(`    ${direction.toUpperCase()} col [${block.x0}-${block.x1}] OTHER-CAP stop`);
          stopReason = "other-cap"; farBoundaryD = block.d0; break;
        }
        const marginal = bl.filter(u => (u.top < 56 || u.top + u.h > pg.h - 56) &&
          !xobjectProtects(u));
        if (marginal.length && !frame) {
          dbg(`    ${direction.toUpperCase()} col [${block.x0}-${block.x1}] MARGIN stop`);
          stopReason = marginal.some(u => u.top < 56) ? "header" : "footer";
          farBoundaryD = block.d0; break;
        }
        const stopperLines = bl.filter(u => stoppers.has(u) &&
          ownerByPart.get(u) !== cap && !ownCaptionLines.has(u));
        const protectedStops = frame ? stopperLines.length
          : stopperLines.filter(xobjectProtects).length;
        const unprotected = stopperLines.length - protectedStops;
        /* One chart label/source line is not enough to terminate a side figure.
           Two independent body stoppers still cut prose columns immediately. */
        const guard = 2;
        if (unprotected >= guard) {
          dbg(`    ${direction.toUpperCase()} col [${block.x0}-${block.x1}] BODY stop` +
            ` (nstop=${stopperLines.length} protected=${protectedStops})`);
          stopReason = "body"; farBoundaryD = block.d0; break;
        }
        dbg(`    ${direction.toUpperCase()} col [${block.x0}-${block.x1}]` +
          ` lines=${bl.length} nstop=${stopperLines.length} protected=${protectedStops}` +
          `${frame ? " frame" : ""} -> incl`);
        incl.push({ ...block, frame, image: blockHasImage(block) });
        bodyStops += unprotected;
        if (block.d1 > 660 * S) {
          stopReason = "max-span"; farBoundaryD = block.d1; break;
        }
      }
      while (incl.length > 1) {
        const near = incl[0], next = incl[1];
        const nearLines = blockLines(near);
        const width = near.d1 - near.d0 + 1;
        const separation = next.d0 - near.d1 - 1;
        const ordinarySliver = width < 8 * S && separation >= 4 * S && nearLines.length;
        const captionEdgeBleed = seed.source === "caption" && near.d0 <= 4 * S &&
          width < 24 * S && separation >= 8 * S;
        if ((ordinarySliver || captionEdgeBleed) && !near.frame && !near.image) {
          dbg(`    ${direction.toUpperCase()} NEAR-SLIVER drop [${near.x0}-${near.x1}]`);
          incl.shift();
        } else break;
      }
      for (let i = 0; i + 1 < incl.length; i++) {
        const cur = incl[i], next = incl[i + 1];
        const span = cur.d1 - incl[0].d0 + 1;
        const gap = next.d0 - cur.d1 - 1;
        const nextLines = blockLines(next);
        const protectedBefore = incl.slice(0, i + 1).some(b => b.frame || b.image);
        if (span >= 80 * S && gap >= 8 * S && protectedBefore && nextLines.length &&
            !next.frame && !next.image && next.d1 - next.d0 + 1 <= 36 * S) {
          dbg(`    ${direction.toUpperCase()} TEXT-TAIL stop [${next.x0}-${next.x1}]`);
          stopReason = "text-tail"; farBoundaryD = Math.min(farBoundaryD, next.d0);
          incl.splice(i + 1); break;
        }
      }
      while (incl.length > 1) {
        const far = incl[incl.length - 1], prev = incl[incl.length - 2];
        const narrow = far.d1 - far.d0 < 12 * S;
        const separation = far.d0 - prev.d1;
        const outerPageGap = profile.leftward ? far.x0 : grid.W - 1 - far.x1;
        const genericFarSliver = separation > 40 * S;
        const edgeMarginalSliver = separation >= 24 * S && outerPageGap <= 20 * S;
        if (narrow && (genericFarSliver || edgeMarginalSliver)) {
          if (edgeMarginalSliver && !genericFarSliver)
            dbg(`    ${direction.toUpperCase()} EDGE-MARGINAL-SLIVER drop` +
              ` [${far.x0}-${far.x1}]`);
          farBoundaryD = Math.min(farBoundaryD, far.d0); incl.pop();
        } else break;
      }
      const gapPt = incl.length ? incl[0].d0 / S : Infinity;
      const farBlankPx = incl.length
        ? Math.max(0, farBoundaryD - incl[incl.length - 1].d1 - 1) : 0;
      return { ...profile, incl, stopReason, bodyStops, farBlankPx, gapPt,
        frameProtected: incl.some(block => block.frame) };
    };

    const buildSideCandidate = (direction, seed, index, total) => {
      const side = scanSide(direction, seed);
      const sideGapLimitPt = seed.source === "caption" ? 48 : SIDE_MAX_GAP_PT;
      const gapText = Number.isFinite(side.gapPt) ? side.gapPt.toFixed(1) : "inf";
      dbg(`  Fig${num}: ${direction.toUpperCase()} seed ${index + 1}/${total}` +
        ` ${seed.source} y=[${seed.by0.toFixed(0)},${seed.by1.toFixed(0)}]` +
        ` gap=${gapText}pt`);
      if (side.gapPt > sideGapLimitPt || !side.incl.length) {
        diagnosticAttempt(direction, seed.source, index, "not-generated",
          [!side.incl.length ? "no-block" : "gap"], {
            gapPt: side.gapPt, stopReason: side.stopReason,
            seedBoxPt: { x0: seed.edgePt, y0: seed.by0, x1: seed.edgePt, y1: seed.by1 },
          });
        dbg(`  Fig${num}: ${direction.toUpperCase()} REJECT ` +
          (!side.incl.length ? "no-block" : "gap"));
        return null;
      }

      let fx0 = Math.min(...side.incl.map(b => b.x0));
      let fx1 = Math.max(...side.incl.map(b => b.x1));
      if (direction === "left") fx1 = Math.min(fx1, side.edgePx - 1);
      else fx0 = Math.max(fx0, side.edgePx + 1);
      if (fx1 <= fx0) {
        diagnosticAttempt(direction, seed.source, index, "not-generated", ["empty-width"]);
        return null;
      }

      const rowHasInk = y => {
        for (let x = Math.max(0, Math.ceil(fx0));
             x <= Math.min(grid.W - 1, Math.floor(fx1)); x += 2)
          if (inkAt(grid, x, y)) return true;
        return false;
      };
      const sparseVectorCaption = seed.source === "caption" &&
        !side.incl.some(block => block.image);
      const verticalSeedY0 = sparseVectorCaption ? labelT : side.sy0;
      const verticalSeedY1 = sparseVectorCaption ? labelB : side.sy1;
      const seedInkRows = [];
      for (let y = verticalSeedY0; y <= verticalSeedY1; y++)
        if (rowHasInk(y)) seedInkRows.push(y);
      if (!seedInkRows.length) {
        diagnosticAttempt(direction, seed.source, index, "not-generated", ["seed-no-ink"]);
        return null;
      }

      const sideBoxPt = { left: fx0 / S, w: (fx1 - fx0) / S };
      const xobjectProtects = u => seed.source === "image" && pg.images.some(im => {
        const vertical = Math.min(im.top + im.h, u.top + u.h) - Math.max(im.top, u.top);
        return vertical > 0.5 * u.h && ox(im, u) > 0.5 * u.w;
      });
      const forbid = [];
      for (const u of lines) {
        if (ox(u, sideBoxPt) <= 0.5 * u.w) continue;
        const owner = ownerByPart.get(u);
        if (owner === cap || ownCaptionLines.has(u)) continue;
        const otherCaption = !!owner && owner !== cap;
        const marginal = u.top < 56 || u.top + u.h > pg.h - 56;
        const body = stoppers.has(u);
        if (!otherCaption && !body && !marginal) continue;
        const cy = (u.top + u.h / 2) * S;
        const frameProtects = side.frameProtected &&
          cy >= verticalSeedY0 && cy <= verticalSeedY1;
        if (!otherCaption && !marginal && body && (xobjectProtects(u) || frameProtects)) continue;
        forbid.push([Math.max(0, Math.round(u.top * S) - 2),
          Math.min(grid.H - 1, Math.round((u.top + u.h) * S) + 2)]);
      }
      const inForbid = y => forbid.some(([a, b]) => y >= a && y <= b);
      /* Vector plots can have grid/mark rows more than 12pt apart. Caption-seeded
         side candidates start from labelBox rows, so permit a wider blank bridge;
         body/caption/header forbid intervals still terminate the expansion. */
      const tol = Math.round((sparseVectorCaption ? 24 : 12) * S);
      let fy0 = seedInkRows[0], fy1 = seedInkRows[seedInkRows.length - 1];
      let y = fy0 - 1, blank = 0, lastInk = fy0;
      while (y >= 0 && blank < tol && !inForbid(y)) {
        if (rowHasInk(y)) { lastInk = y; blank = 0; } else blank++;
        y--;
      }
      fy0 = lastInk;
      y = fy1 + 1; blank = 0; lastInk = fy1;
      while (y < grid.H && blank < tol && !inForbid(y)) {
        if (rowHasInk(y)) { lastInk = y; blank = 0; } else blank++;
        y++;
      }
      fy1 = lastInk;
      if (fy1 <= fy0) {
        diagnosticAttempt(direction, seed.source, index, "not-generated", ["empty-height"]);
        return null;
      }

      const outsideSeedStops = lines.filter(u => {
        if (!stoppers.has(u) || ownerByPart.get(u) === cap || ownCaptionLines.has(u) ||
            xobjectProtects(u) || ox(u, sideBoxPt) <= 0.5 * u.w) return false;
        const cy = (u.top + u.h / 2) * S;
        return cy >= fy0 && cy <= fy1 &&
          (cy < verticalSeedY0 || cy > verticalSeedY1);
      }).length;
      const bodyStops = side.bodyStops + outsideSeedStops;
      const raster = hasImageIn(fy0, fy1, fx0 / S, fx1 / S);
      const overlap = Math.max(0, Math.min(fy1, capB) - Math.max(fy0, capT));
      const anchorOverlap = overlap /
        Math.max(1, Math.min(fy1 - fy0, capB - capT));
      const verticalGapPx = fy1 < capT ? capT - fy1 : fy0 > capB ? fy0 - capB : 0;
      const aligned = anchorOverlap >= 0.25 || verticalGapPx <= 16 * S;
      const metrics = measureCandidate(direction, fx0, fx1, fy0, fy1, raster,
        side.stopReason, bodyStops, side.farBlankPx, side.gapPt);
      const aspect = metrics.widthPt / Math.max(1, metrics.heightPt);
      const reject = [];
      if (side.gapPt > sideGapLimitPt) reject.push("gap");
      if (metrics.widthPt < 24 || metrics.widthRatio < 0.15) reject.push("thin-width");
      if (metrics.heightRatio < 0.09) reject.push("short-height");
      if (metrics.areaRatio < 0.008) reject.push("small-area");
      if (metrics.areaRatio > 0.65 || metrics.widthRatio > 0.82) reject.push("huge");
      if (metrics.inkDensity < 0.002) reject.push("sparse");
      if (metrics.bodyStops > 1) reject.push("body");
      if (aspect < 0.50) reject.push("text-sliver");
      if (!aligned) reject.push("unaligned");
      const valid = reject.length === 0;
      dbg(`  Fig${num}: ${direction.toUpperCase()} REGION x[${fx0}-${fx1}]` +
        ` y[${fy0}-${fy1}] anchor=${anchorOverlap.toFixed(2)}` +
        ` vgap=${(verticalGapPx / S).toFixed(1)}pt aspect=${aspect.toFixed(2)}` +
        `${raster ? " raster" : ""}`);
      let outX0 = Math.max(0, fx0 - 10), outX1 = Math.min(grid.W, fx1 + 10);
      if (direction === "left") outX1 = Math.min(outX1, side.edgePx - 1);
      else outX0 = Math.max(outX0, side.edgePx + 1);
      if (outX1 <= outX0) {
        diagnosticAttempt(direction, seed.source, index, "not-generated", ["clamped-empty"]);
        return null;
      }
      const outY0 = Math.max(0, fy0 - 8), outY1 = Math.min(grid.H, fy1 + 4);
      const candidate = { direction, seedSource: seed.source, anchorOverlap,
        rejectReason: reject.join(","), valid,
        fig: { num, raster_: raster, page: pg.num,
          x0: outX0, x1: outX1,
          y0: outY0, y1: outY1,
          h_: Math.round(outY1 - outY0), caption: capText, captionBox },
        metrics, score: figureScore(metrics) };
      registerDiagnosticCandidate(candidate, direction, seed.source, index,
        { x0: fx0, y0: fy0, x1: fx1, y1: fy1 }, {
          seedBoxPt: direction === "left"
            ? { x0: 0, y0: seed.by0, x1: seed.edgePt, y1: seed.by1 }
            : { x0: seed.edgePt, y0: seed.by0, x1: pg.w, y1: seed.by1 },
        });
      return candidate;
    };

    let upCandidate = null, legacyBelowCandidate = null, legacyDiagnosticCandidate = null;

    if (incl.length) {
      const ry0 = incl[incl.length - 1][0], ry1 = incl[0][1];
      /* 영역이 래스터 이미지(XObject)와 겹치는지 — 중복 번호 dedup에서 우선순위로만 사용 */
      const raster = incl.some(([a, b]) => hasImage(a, b));
      /* 4) 좌우 잉크 연결 확장 (본문 줄/다른 캡션 구간 진입 금지) */
      const rowsHasInk = x => {
        for (let yy = ry0; yy <= ry1; yy += 2) if (inkAt(grid, x, yy)) return true;
        return false;
      };
      const forbid = [];
      for (const u of lines) {
        const c = (u.top + u.h / 2) * S;
        if (c < ry0 || c > ry1) continue;
        const owner = ownerByPart.get(u);
        let bodyish = stoppers.has(u) || (!!owner && owner !== cap);
        if (!bodyish && u.font === dom && u.h >= 6 && u.w >= 100) {
          const nb = neighborsOf(u, lines);
          bodyish = nb.above && nb.below;  // 연속 문단의 내부 줄 (본문 폰트만)
        }
        if (bodyish) forbid.push([Math.round(u.left * S), Math.round((u.left + u.w) * S)]);
      }
      const inForbid = x => forbid.some(([a, b]) => x >= a && x <= b);
      const tol = Math.round(12 * S);
      const eR = Math.min(grid.W, Math.round(exR * S)), eL = Math.max(0, Math.round(exL * S));
      let xx = rx1, gap2 = 0, lastInk = rx1;
      while (xx < eR && gap2 < tol && !inForbid(xx)) {
        if (rowsHasInk(xx)) { lastInk = xx + 1; gap2 = 0; } else gap2++;
        xx++;
      }
      let nrx1 = Math.max(rx1, lastInk);
      xx = rx0 - 1; gap2 = 0; lastInk = rx0;
      while (xx >= eL && gap2 < tol && !inForbid(xx)) {
        if (rowsHasInk(xx)) { lastInk = xx; gap2 = 0; } else gap2++;
        xx--;
      }
      let nrx0 = Math.min(rx0, lastInk);
      /* 확장 구간이 본문 텍스트 줄(본문 폰트)을 여러 개 물었다면 확장 취소 (슬리버 방지) */
      const textInStrip = (a, b) => lines.filter(u => {
        const c = (u.top + u.h / 2) * S;
        if (c < ry0 || c > ry1 || u.h < 6 || u.font !== dom) return false;
        const ul = u.left * S, ur = (u.left + u.w) * S;
        return Math.min(ur, b) - Math.max(ul, a) > 4;
      }).length;
      if (nrx0 < rx0 && textInStrip(nrx0, rx0) >= 3) nrx0 = rx0;
      if (nrx1 > rx1 && textInStrip(rx1, nrx1) >= 3) nrx1 = rx1;
      /* 5) x 타이트닝: 실제 잉크 범위로 좁히기 */
      let fx0 = nrx1, fx1 = nrx0;
      for (let x = nrx0; x < nrx1; x++) {
        for (let yy = ry0; yy <= ry1; yy += 2) {
          if (inkAt(grid, x, yy)) { fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); break; }
        }
      }
      if (fx0 > fx1) { fx0 = nrx0; fx1 = nrx1; }
      fx0 = Math.min(fx0, Math.round(capbox.left * S));
      fx1 = Math.max(fx1, Math.round((capbox.left + capbox.w) * S));
      /* 나란한 컬럼 병합 방지 (v2.10.1) — 같은 baseline(캡션 라인 기준)의 **다른 컬럼** 형제 figure
       * 캡션이 있고, 이 figure의 x범위가 그 형제 캡션 컬럼으로 **실제 침범**했으면(★crossing guard),
       * 자기 캡션 가장자리+margin으로 되돌린다. 병합 블록은 전폭이어도 크롭은 x-slice라 컬럼이 분리된다.
       * crossing guard가 핵심 — narrow 캡션 형제(Structural Fig9 "F I G U R E 9")가 자기 컬럼을 침범하지
       * 않으면 미발동(그 figure를 과클립하지 않음). 임베디드 형제(Aegaeon 15/16)는 이미 sibL/sibR로
       * 분리돼 fx가 형제 캡션을 안 넘어 crossing guard에서 자연 배제된다. pdf2.0 6/7·Structural 5/10.
       * (baseline이 어긋난 나란한 형제(Dong 3@p6)는 여기서 안 잡히고 페이지 말미 offset 후처리가 담당.) */
      const capBaseY = cap.top + cap.h / 2, capRpt = capbox.left + capbox.w;
      const sameBaselineClamps = diag ? [] : null;
      for (const oc of caps) {
        if (oc === cap || Math.abs((oc.top + oc.h / 2) - capBaseY) > SAME_BASELINE_PT) continue;
        const ocL = oc.left, ocR = oc.left + oc.w;
        const before = diag ? { x0: fx0, y0: ry0, x1: fx1, y1: ry1 } : null;
        if (ocL > capRpt) {                                  // 형제가 우측 컬럼
          if (fx1 > ocL * S) fx1 = Math.min(fx1, Math.round((capRpt + SIBLING_COL_MARGIN) * S));
        } else if (ocR < capbox.left) {                      // 형제가 좌측 컬럼
          if (fx0 < ocR * S) fx0 = Math.max(fx0, Math.round((capbox.left - SIBLING_COL_MARGIN) * S));
        }
        if (diag && (before.x0 !== fx0 || before.x1 !== fx1)) {
          sameBaselineClamps.push({
            counterpartAnchorId: diag.registerAnchor(pg, oc),
            counterpartNum: infoByAnchor.get(oc)?.num,
            beforeBoxPx: before,
            afterBoxPx: { x0: fx0, y0: ry0, x1: fx1, y1: ry1 },
          });
        }
      }
      dbg(`  Fig${num}: REGION y[${ry0}-${ry1}] x[${fx0}-${fx1}]${raster ? " raster" : ""}`);
      /* region은 그림 영역만 (캡션 제외). 캡션은 captionBox/caption 텍스트로 별도 반환 */
      const metrics = measureCandidate("up", fx0, fx1, ry0, ry1, raster, upStopReason,
        upBodyStops, upFarBlankPx);
      upCandidate = {
        direction: "up",
        valid: true,
        fig: { num, raster_: raster, page: pg.num,
          x0: fx0 - 10, x1: fx1 + 10, y0: ry0 - 8, y1: ry1 + 4,
          h_: Math.round(capBottom * S) - ry0, caption: capText, captionBox },
        metrics,
        score: figureScore(metrics)
      };
      const upCandidateId = registerDiagnosticCandidate(upCandidate, "up", "scan", 0,
        { x0: fx0, y0: ry0, x1: fx1, y1: ry1 }, { seedBoxPt: null });
      if (diag) for (const clamp of sameBaselineClamps) diag.add("relation", {
        page: pg.num, pass, decision: "clamp",
        claimantCandidateId: upCandidateId,
        counterpartAnchorId: clamp.counterpartAnchorId,
        claimantNum: num, counterpartNum: clamp.counterpartNum,
        nums: [num, clamp.counterpartNum],
        beforeBoxPx: clamp.beforeBoxPx, afterBoxPx: clamp.afterBoxPx,
        reasons: ["same-baseline-sibling-column"],
      });
    } else {
      diagnosticAttempt("up", "scan", 0, "not-generated", ["no-block"], {
        stopReason: upStopReason,
      });
      /* caption-above 레이아웃: 아래쪽 이미지 */
      const below = pg.images.filter(im =>
        im.top >= capBottom - 4 && im.top - capBottom < 40 &&
        ox(im, capbox) > 0.3 * Math.min(im.w, capbox.w));
      if (below.length) {
        const yb = Math.max(...below.map(im => im.top + im.h));
        const bx0 = Math.min(x0, ...below.map(im => im.left));
        const bx1 = Math.max(x1, ...below.map(im => im.left + im.w));
        legacyBelowCandidate = { num, raster_: true, page: pg.num,
          x0: Math.round(bx0*S) - 10, x1: Math.round(bx1*S) + 10,
          y0: Math.round(capBottom*S) + 2, y1: Math.round(yb*S) + 4,
          h_: Math.round((yb - cap.top)*S), caption: capText, captionBox };
        if (diag) {
          legacyDiagnosticCandidate = {
            direction: "down", seedSource: "legacy-image", valid: true,
            fig: legacyBelowCandidate, metrics: null, score: null,
          };
          registerDiagnosticCandidate(legacyDiagnosticCandidate, "down", "legacy-image", 0,
            { x0: Math.round(bx0 * S), y0: Math.round(capBottom * S),
              x1: Math.round(bx1 * S), y1: Math.round(yb * S) }, {
              seedBoxPt: { x0: bx0, y0: capBottom, x1: bx1, y1: yb },
            });
        }
      } else {
        diagnosticAttempt("down", "legacy-image", 0, "not-generated", ["no-nearby-image"]);
      }
    }

    const downClose = downGapPt <= 14;
    const upM = upCandidate && upCandidate.metrics;
    const signals = {
      /* 장문 캡션+빈 up은 side-caption일 수 있다(Carolyn p2). Phase 1의 empty 재시도는 맨 라벨만. */
      empty: !upCandidate && bareLabel,
      bareDown: bareLabel,
      tiny: !!upM && (upM.areaRatio < 0.002 || upM.heightRatio < 0.012),
      slender: !!upM && upM.widthRatio < 0.10 && upM.heightRatio > 0.12,
      huge: !!upM && bareLabel && (upM.areaRatio > 0.65 || upM.heightRatio > 0.82),
      body: !!upM && upM.stopReason === "body" && upStopNstop >= 2,
      otherCap: !!upM && bareLabel && upM.stopReason === "other-cap"
    };
    const activeSignals = Object.keys(signals).filter(k => signals[k]);
    const hardLong = capInfo.hard && capNorm.length > 16 && !!upM &&
      upM.areaRatio < 0.002 && upM.heightRatio < 0.012 &&
      upM.stopReason === "header" && upM.bodyStops === 0 &&
      upM.farClosed && !upM.raster;
    /* Phase 1 is limited to a standalone label immediately above its figure.
       Multi-line captions can be followed by framed prose or prompt examples that
       score like figures. Long hard captions enter only for the proven tiny/header signature. */
    const suspicious = downClose &&
      ((bareLabel && activeSignals.length > 0) || hardLong);
    const gapText = Number.isFinite(downGapPt) ? downGapPt.toFixed(1) : "inf";
    dbg(`  Fig${num}: SUSP bare=${bareLabel ? 1 : 0} hardLong=${hardLong ? 1 : 0}` +
      ` downGap=${gapText}pt` +
      ` upArea=${upM ? upM.areaRatio.toFixed(3) : "none"}` +
      ` near=${downClose ? 1 : 0}` +
      ` upStopN=${upStopNstop || 0}` +
      ` upWH=${upM ? `${upM.widthRatio.toFixed(3)}/${upM.heightRatio.toFixed(3)}` : "none"}` +
      ` flags=${activeSignals.length ? activeSignals.join(",") : "none"}`);

    if (legacyBelowCandidate) {
      /* 기존 이미지 전용 폴백은 산출을 byte-for-byte 보존한다. */
      if (diag && legacyDiagnosticCandidate) {
        diagnosticAttempt("left", "none", 0, "not-evaluated", ["legacy-image-bypass"]);
        diagnosticAttempt("right", "none", 0, "not-evaluated", ["legacy-image-bypass"]);
        diag.emitCandidate(legacyDiagnosticCandidate, {
          decision: "chosen", reasons: ["legacy-image-bypass"],
        });
        diag.add("selection", {
          anchorId, captionPage: pg.num, candidatePage: pg.num, pass, num,
          decision: "legacy", consideredCandidateIds: [diag.candidateId(legacyDiagnosticCandidate)],
          chosenCandidateId: diag.candidateId(legacyDiagnosticCandidate),
          reasons: ["legacy-image-bypass"],
        });
      }
      dbg(scoreText("up", upCandidate));
      dbg(`  Fig${num}: SCORE down legacy-image`);
      dbg(`  Fig${num}: CHOSE down legacy-image`);
      legacyBelowCandidate._anchor = cap;   // soft floor 판정이 이 앵커의 자기 fig를 식별 (v2.14.0)
      capInfo.adjacentState_ = {
        selection: "legacy", chosenDirection: "down", selectedFig: legacyBelowCandidate,
        emission: "none", claim: "none",
      };
      figs.push(legacyBelowCandidate);
      continue;
    }

    const downCandidates = suspicious
      ? downSeeds.map((seed, i) => buildDownCandidate(seed, i, downSeeds.length, hardLong)).filter(Boolean)
      : [];
    if (!suspicious) for (let i = 0; i < downSeeds.length; i++)
      diagnosticAttempt("down", downSeeds[i].source, i, "not-evaluated",
        ["down-route-not-suspicious"], {
          downGapPt, bareLabel, hardLong, activeSignals,
          seedBoxPt: {
            x0: downSeeds[i].bx0, y0: capBottom,
            x1: downSeeds[i].bx1, y1: Math.min(pg.h, capBottom + 48),
          },
        });
    const healthyBareUp = bareLabel && upCandidate && upCandidate.valid &&
      Number.isFinite(upCandidate.score.total) && upCandidate.score.total >= 8;
    if (healthyBareUp) dbg(`  Fig${num}: SIDE REJECT healthy-bare-up`);
    if (healthyBareUp) {
      diagnosticAttempt("left", "none", 0, "not-evaluated", ["healthy-bare-up"], {
        upScore: upCandidate.score.total,
      });
      diagnosticAttempt("right", "none", 0, "not-evaluated", ["healthy-bare-up"], {
        upScore: upCandidate.score.total,
      });
    }
    const leftSeeds = healthyBareUp ? [] : sideSeedBounds("left");
    const rightSeeds = healthyBareUp ? [] : sideSeedBounds("right");
    const leftCandidates = leftSeeds
      .map((seed, i) => buildSideCandidate("left", seed, i, leftSeeds.length)).filter(Boolean);
    const rightCandidates = rightSeeds
      .map((seed, i) => buildSideCandidate("right", seed, i, rightSeeds.length)).filter(Boolean);
    const healthyUpForSide = upCandidate && upCandidate.valid &&
      Number.isFinite(upCandidate.score.total) && upCandidate.score.total >= 8.0;
    if (healthyUpForSide) {
      for (const candidate of [...leftCandidates, ...rightCandidates]) {
        if (!candidate.valid || candidate.anchorOverlap >= 0.25) continue;
        candidate.valid = false;
        candidate.rejectReason = [candidate.rejectReason, "detached-with-up"]
          .filter(Boolean).join(",");
        dbg(`  Fig${num}: ${candidate.direction.toUpperCase()} ${candidate.seedSource}` +
          ` REJECT detached-with-up anchor=${candidate.anchorOverlap.toFixed(2)}` +
          ` up=${upCandidate.score.total.toFixed(2)}`);
      }
    }
    const suppressDominatedImageTail = candidates => {
      for (const imageCandidate of candidates.filter(c => c.valid && c.seedSource === "image")) {
        const tighter = candidates.filter(c => c.valid && c.seedSource !== "image" &&
          c.metrics.raster &&
          Number.isFinite(c.score.total) && c.score.total >= 10 &&
          imageCandidate.score.total - c.score.total <= 1.6 &&
          c.metrics.widthPt >= 0.85 * imageCandidate.metrics.widthPt &&
          c.metrics.heightPt <= 0.75 * imageCandidate.metrics.heightPt)
          .reduce((best, c) => !best || c.score.total > best.score.total ? c : best, null);
        if (!tighter) continue;
        imageCandidate.valid = false;
        imageCandidate.rejectReason = [imageCandidate.rejectReason, "text-tail-dominated"]
          .filter(Boolean).join(",");
        dbg(`  Fig${num}: ${imageCandidate.direction.toUpperCase()} image REJECT` +
          ` text-tail-dominated by ${tighter.seedSource}`);
      }
    };
    suppressDominatedImageTail(leftCandidates);
    suppressDominatedImageTail(rightCandidates);
    const alternatives = [...downCandidates, ...leftCandidates, ...rightCandidates];
    if (diag) {
      if (upCandidate) diag.emitCandidate(upCandidate, {
        decision: "considered", reasons: [],
      });
      for (const candidate of alternatives) diag.emitCandidate(candidate, {
        decision: "considered",
        reasons: candidate.diagReasons_ || (candidate.rejectReason
          ? candidate.rejectReason.split(",").filter(Boolean) : []),
      });
    }
    /* soft 애매역 floor 검증용 up-점수 노출 (v2.14.0) — ★ chosen 후보 점수가 아니라 up 후보 점수다.
     * floor 정의가 "up-score < FLOOR"이므로 chose가 down/side여도 up 점수를 봐야 한다. up 후보가
     * 없으면(캡션-위 legacyBelow 등) undefined로 남겨 pass2가 "fig 있으면 유지"(진짜 캡션-위 도형
     * false-negative 방지)로 분기한다. 비-soft 앵커도 기입되나 읽히지 않아 무해(출력 미포함). */
    capInfo.upScore_ = upCandidate && Number.isFinite(upCandidate.score.total)
      ? upCandidate.score.total : undefined;
    dbg(scoreText("up", upCandidate));
    if (!downCandidates.length) dbg(scoreText("down", null));
    else downCandidates.forEach((candidate, i) =>
      dbg(scoreText(downCandidates.length > 1
        ? `down#${i + 1}(${candidate.seedSource})` : "down", candidate)));
    const debugSideScores = (direction, candidates) => {
      if (!candidates.length) dbg(scoreText(direction, null));
      else candidates.forEach((candidate, i) =>
        dbg(scoreText(candidates.length > 1
          ? `${direction}#${i + 1}(${candidate.seedSource})` : direction, candidate)));
    };
    debugSideScores("left", leftCandidates);
    debugSideScores("right", rightCandidates);
    const minScore = 8.0;
    const eligible = downCandidates.filter(c => c.valid && Number.isFinite(c.score.total) &&
      c.score.total >= minScore);
    const bestDown = eligible.reduce((best, candidate) =>
      !best || candidate.score.total > best.score.total ? candidate : best, null);
    /* 맨 라벨의 up이 OTHER-CAP에 닿은 경우는 adjacent_figure 직접 증거다.
       충분히 figure 크기인 유효 down이 있을 때만 작은 양의 우위도 허용한다. */
    const adjacentEvidence = bareLabel && !!upM && upM.stopReason === "other-cap" && !!bestDown &&
      bestDown.metrics.areaRatio >= 0.05 && bestDown.metrics.widthRatio >= 0.30 &&
      bestDown.metrics.heightRatio >= 0.15;
    const policy = { margin: 1.5, minScore,
      marginFor: candidate => candidate.direction === "down" && adjacentEvidence ? 0.6 : 1.5 };
    const decision = chooseCandidate(upCandidate, alternatives, policy);
    const chosen = decision.candidate, chose = decision.direction;
    const eligibleAlternatives = alternatives.filter(c => c.valid && Number.isFinite(c.score.total) &&
      c.score.total >= minScore);
    const bestAlternative = eligibleAlternatives.reduce((best, candidate) =>
      !best || candidate.score.total > best.score.total ? candidate : best, null);
    const delta = bestAlternative && upCandidate && Number.isFinite(upCandidate.score.total)
      ? (bestAlternative.score.total - upCandidate.score.total).toFixed(2) : "n/a";
    dbg(`  Fig${num}: CHOSE ${chose} margin=${decision.margin.toFixed(1)}` +
      ` minAlt=${policy.minScore.toFixed(1)} delta=${delta}` +
      ` seed=${chosen && chosen.seedSource ? chosen.seedSource : "-"}`);
    if (diag) diag.add("selection", {
      anchorId, captionPage: pg.num, candidatePage: pg.num, pass, num,
      decision: chosen ? "chosen" : "none",
      consideredCandidateIds: [upCandidate, ...alternatives]
        .filter(Boolean).map(candidate => diag.candidateId(candidate)),
      chosenCandidateId: diag.candidateId(chosen),
      chosenDirection: chose,
      minScore,
      margin: decision.margin,
      adjacentEvidence,
      delta: delta === "n/a" ? null : Number(delta),
      reasons: chosen ? ["hysteresis-selection"] : ["no-eligible-candidate"],
    });
    if (chosen) {
      chosen.fig.dir_ = chose;
      chosen.fig._anchor = cap;
      capInfo.adjacentState_ = {
        selection: "chosen", chosenDirection: chose, selectedFig: chosen.fig,
        emission: "none", claim: "none",
      };
      figs.push(chosen.fig);
    }
  }
  /* offset side-by-side 컬럼 분리 (v2.10.2) — 같은 baseline 형제는 위 per-candidate clamp(v2.10.1)가
   * 이미 처리한다. 여기서는 baseline이 어긋난 나란한 형제(키 큰/작은 이웃 — Dong Fig4는 Fig3보다
   * 141pt 아래)를 **검출된 up-figure 영역**으로 판정한다: F·G 둘 다 up 후보이고(캡션이 figure 아래
   * 같은 컬럼), 캡션 컬럼이 disjoint하며 두 영역이 세로로 겹치면(=같은 행) F가 침범한 쪽 x를 자기
   * 캡션 가장자리±margin으로 되돌린다.
   * ★ 캡션 앵커가 아니라 **검출된 up-figure**끼리 보는 게 핵심 3중 안전장치:
   *   ① up 한정 — side/down 캡션(figure와 다른 컬럼: Saunders Fig6·ieee tnnls side)이 자기 캡션 컬럼으로
   *      역클램프돼 소멸하는 것 방지. up은 캡션이 figure 아래 같은 컬럼이라 clamp 방향이 항상 정합.
   *   ② 검출된 figure만 — phantom 앵커(본문 상호참조 "Fig. 3." CHOSE none)는 figs에 없어 형제 배제.
   *   ③ 영역 세로 겹침 — stacked(위아래 다른 행: acs·springer) 배제. 진짜 전폭 figure는 옆에 겹치는
   *      up-형제가 없으므로(있으면 전폭이 아님) 자연히 미클램프(ieee tnnls Fig9 무변경).
   * same-baseline은 위 per-candidate가 처리하므로 제외 → v2.10.1 게이트 결과(pdf2.0·Structural·Aegaeon) 보존. */
  for (const F of figs) {
    if (F.dir_ !== "up" || !F.captionBox) continue;
    const fCapL = F.captionBox.x0, fCapR = F.captionBox.x1;
    const fBaseY = (F.captionBox.y0 + F.captionBox.y1) / 2;
    for (const G of figs) {
      if (G === F || G.dir_ !== "up" || !G.captionBox) continue;
      const gBaseY = (G.captionBox.y0 + G.captionBox.y1) / 2;
      if (Math.abs(gBaseY - fBaseY) <= SAME_BASELINE_PT) continue;      // same-baseline → v2.10.1 per-candidate
      if (Math.min(F.y1, G.y1) - Math.max(F.y0, G.y0) <= 0) continue;   // 영역 세로 겹침 없으면 다른 행(stacked)
      const gCapL = G.captionBox.x0, gCapR = G.captionBox.x1;
      const before = diag ? { x0: F.x0, y0: F.y0, x1: F.x1, y1: F.y1 } : null;
      if (gCapL > fCapR) {                                              // G가 우측 컬럼
        if (F.x1 > gCapL * S) F.x1 = Math.min(F.x1, Math.round((fCapR + SIBLING_COL_MARGIN) * S) + 10);
      } else if (gCapR < fCapL) {                                       // G가 좌측 컬럼
        if (F.x0 < gCapR * S) F.x0 = Math.max(F.x0, Math.round((fCapL - SIBLING_COL_MARGIN) * S) - 10);
      }
      if (diag && (before.x0 !== F.x0 || before.x1 !== F.x1)) {
        diag.add("relation", {
          page: pg.num, pass, decision: "clamp",
          claimantCandidateId: diag.figCandidateId(F),
          counterpartCandidateId: diag.figCandidateId(G),
          claimantNum: F.num, counterpartNum: G.num,
          nums: [F.num, G.num],
          beforeBoxPx: before,
          afterBoxPx: { x0: F.x0, y0: F.y0, x1: F.x1, y1: F.y1 },
          reasons: ["offset-sibling-column"],
        });
      }
    }
  }
  if (diag) diag.add("detection-pass", {
    page: pg.num, pass, decision: "completed",
    outputCandidateIds: figs.map(fig => diag.figCandidateId(fig)),
  });
  return figs;
}

/* soft 애매역(promoteSoftAnchors regime=ambiguous) floor 검증 래퍼 (v2.14.0).
 * detectPage를 돌린 뒤, provisional soft 앵커 중 up-점수 < SOFT_UP_FLOOR(또는 아무 fig도 못 낸 것)를
 * 강등하고 detectPage를 재실행한다 — 강등된 phantom 앵커가 이웃(other-cap stop·sibling-clamp)에 남긴
 * 오염을 재실행이 복구한다. **재실행 후 재-floor 검사(bounded loop)**: 앵커 제거는 up-점수에 비단조다
 * (경쟁 앵커가 사라지면 up 영역이 위로 커져 hugePenalty(-8)를 맞고 점수가 되레 떨어질 수 있다,
 * figureScore hugePenalty vs otherCapPenalty 0.5). 단조성 가정이 깨지므로 "1회 고정"이 아니라, 새로
 * floor 아래로 내려간 survivor도 강등하며 앵커 수 상한까지 반복해 fixpoint에 수렴시킨다.
 * 강등 0이면 재실행 없음 → 전량승격·전량기각 문서와 byte-identical(provisional 앵커가 없으므로).
 * ★ 강등 되돌림은 승격의 완전 역연산 + assembleAnchors 재조립(promoteSoftAnchors 미러) — 누락 시
 *   stale anchors가 강등 라인을 물고 있어 재실행이 오염 상태를 본다. */
function detectPageWithFloor(pd, dom, grid, dbg, diag) {
  const cd = pd.captionData;
  const provisionalSoft = () => cd.softSlots.filter(c => {
    const info = cd.infoByAnchor.get(c.line);
    return info && info.soft && info.provisional;
  });
  let detectPass = 0;
  let figs = detectPage(pd, pd.lines, dom, grid, dbg, cd, diag, detectPass);
  if (!provisionalSoft().length) {                        // 애매역 아님 → 단일 실행(현행 경로)
    if (diag) diag.add("floor-pass", {
      page: pd.num, pass: detectPass, decision: "active",
      outputCandidateIds: figs.map(fig => diag.figCandidateId(fig)),
      reasons: ["no-provisional-soft-anchor"],
    });
    return figs;
  }
  const bound = cd.softSlots.length + 1;                  // 매 회 ≥1 강등 → 앵커 수 상한서 종료
  for (let floorPass = 0; floorPass < bound; floorPass++) {
    const demote = [];
    for (const c of provisionalSoft()) {
      const info = cd.infoByAnchor.get(c.line);
      const up = info.upScore_;                            // up 후보 점수 (undefined=up 후보 없음)
      // ★ 이 앵커가 낸 자기 fig를 _anchor로 식별한다 (num으로 찾으면 같은 페이지 동일 num의 다른
      //   앵커 fig를 오귀속해 phantom을 못 걸러낸다 — 적대검증 Finding 1).
      const fig = figs.find(f => f._anchor === c.line);
      // up 후보 있으면 floor로 판정. 없으면(캡션-위 legacyBelow 등) 자기 fig 존재 시 유지(진짜 도형 보호).
      const keep = up === undefined ? !!fig : up >= SOFT_UP_FLOOR;
      if (!keep) demote.push({ c, up, hasFig: !!fig });
    }
    if (!demote.length) break;
    for (const { c, up, hasFig } of demote) {
      if (diag) diag.add("floor-decision", {
        page: pd.num, pass: detectPass,
        anchorId: diag.registerAnchor(pd, c.line),
        candidateId: diag.figCandidateId(figs.find(f => f._anchor === c.line)),
        num: c.num, upScore: up, hasFig, floor: SOFT_UP_FLOOR,
        decision: "demoted",
        reasons: [up === undefined ? "no-up-and-no-output" : "up-below-soft-floor"],
      });
      cd.slots[c.index] = undefined;                       // 승격 역연산 (희소 배열 구멍)
      cd.ownerByPart.delete(c.line);
      cd.infoByAnchor.delete(c.line);
      dbg(`  [floor] DEMOTE p${pd.num} num=${c.num} up=${up === undefined ? "-" : up.toFixed(2)}` +
          ` fig=${hasFig ? 1 : 0} < ${SOFT_UP_FLOOR}`);
    }
    if (diag) diag.add("floor-pass", {
      page: pd.num, pass: detectPass, decision: "superseded",
      outputCandidateIds: figs.map(fig => diag.figCandidateId(fig)),
      demotedAnchorIds: demote.map(({ c }) => diag.registerAnchor(pd, c.line)),
      reasons: ["soft-floor-retry"],
    });
    cd.anchors = assembleAnchors(cd.slots, cd.embedded);   // ★ 재조립 필수 (line ~604 미러)
    detectPass++;
    figs = detectPage(pd, pd.lines, dom, grid, dbg, cd, diag, detectPass); // 이웃 오염 복구 재실행
  }
  if (diag) diag.add("floor-pass", {
    page: pd.num, pass: detectPass, decision: "active",
    outputCandidateIds: figs.map(fig => diag.figCandidateId(fig)),
    reasons: ["soft-floor-fixpoint"],
  });
  return figs;
}

const adjacentBoxGapPt = (a, b) => {
  const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
  const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
  return dx === 0 && dy === 0 ? 0 : Math.hypot(dx, dy);
};

/* PB-4B 12-A composition 관측. 아래 값은 25행 fit에서 A/B가 일치한 관측 파라미터일 뿐 public
 * resolver threshold가 아니다. decision은 계속 abstain이며 반례가 생기면 ambiguous로 보존한다. */
function observeAdjacentComposition(regions, pageHeightPt, repeatedLineKeys) {
  const furniture = new Map();
  for (const region of regions) {
    const reasons = [];
    const box = region.bboxPt;
    const lineRefs = region.lineRefs;
    if (lineRefs.some(line => line.kind === "header") && box.y1 <= 56)
      reasons.push("L-header");
    if (lineRefs.some(line => line.kind === "footer") && box.y0 >= pageHeightPt - 56)
      reasons.push("L-footer");
    if (lineRefs.some(line => line.kind === "body")) reasons.push("L-body");
    if (repeatedLineKeys && lineRefs.length &&
        lineRefs.every(line => repeatedLineKeys.has(
          `${line.textHash}|${Math.round(line.bboxPt.y0)}`)))
      reasons.push("R-repeat");
    const width = box.x1 - box.x0, height = box.y1 - box.y0;
    const minDim = Math.min(width, height);
    const elong = Math.max(width, height) / Math.max(minDim, 1e-9);
    const edge = region.edgeDistancePt;
    const minEdge = Math.min(edge.top, edge.right, edge.bottom, edge.left);
    if (minDim <= 2.5) reasons.push("S-hairline");
    if (elong >= 25 && minEdge <= 25) reasons.push("S-marginstrip");
    const touch = region.pageEdgeTouch;
    if (!lineRefs.length && (touch.top || touch.right || touch.bottom || touch.left))
      reasons.push("S-edgeblock");
    furniture.set(region.regionId, reasons);
  }
  const pool = regions.filter(region => !(furniture.get(region.regionId) || []).length);
  const subtractive = pool.map(region => region.regionId);
  const accreted = [];
  if (pool.length) {
    const seed = pool.reduce((best, region) => {
      if (!best) return region;
      const signal = region.imageAreaSumRatio * adjacentArea(region.bboxPx);
      const bestSignal = best.imageAreaSumRatio * adjacentArea(best.bboxPx);
      if (signal !== bestSignal) return signal > bestSignal ? region : best;
      return adjacentArea(region.bboxPx) > adjacentArea(best.bboxPx) ? region : best;
    }, null);
    const selected = [seed], left = pool.filter(region => region !== seed);
    for (let grew = true; grew;) {
      grew = false;
      for (let index = left.length - 1; index >= 0; index--) {
        if (!selected.some(region =>
          adjacentBoxGapPt(region.bboxPt, left[index].bboxPt) <= 30)) continue;
        selected.push(left[index]);
        left.splice(index, 1);
        grew = true;
      }
    }
    accreted.push(...selected.map(region => region.regionId).sort());
  }
  const a = [...subtractive].sort();
  const confirmed = a.length > 0 && JSON.stringify(a) === JSON.stringify(accreted);
  return {
    composition: confirmed ? "confirmed" : "ambiguous",
    regionIds: confirmed ? a : [],
    regionCount: confirmed ? a.length : null,
    subtractiveRegionIds: a,
    accretionRegionIds: accreted,
    furniture: [...furniture.entries()]
      .filter(([, reasons]) => reasons.length)
      .map(([regionId, reasons]) => ({ regionId, reasons })),
  };
}

/* PB-4B 12-A `strong` 계측 (v2.18.0). Q6 전수 라운드에서 12-B 발화 28행 중 오발 2행이
 * composition·unclaimed 세 가드를 모두 통과한 원인은 "N−1 선택이 애초에 그림인가"를 보는 항이
 * 없다는 것이었다(Weiss p1 = 순수 본문 텍스트, science-1247125 p2 = Box 내부 소형 그림).
 * 여기서는 그 두 축을 **관측값으로만** 방출한다. `strong` tri-state는 계속 null이고 임계는 없다
 * (§13 threshold 잠금). 원자료는 이미 region record에 있어 새 렌더·새 계측이 없다.
 * raster 점유(rasterCoverage)는 정답 4행이 0이라 판별에 쓸 수 없다는 실측을 같이 남긴다. */
/* 지면 장식 띠 (v2.19.3) — 머리글/꼬리말 띠가 figure로 방출되던 결함(Sanesi 10@p13 = 폭 전면·
 * 높이 31pt의 러닝헤더)을 막는다. 같은 취지의 가드가 side 후보에는 있고(heightRatio < 0.09)
 * up 후보에는 아예 없었다 — up은 valid:true 하드코딩이고 chooseCandidate가 up.valid를 읽지도
 * 않으므로 후보 단계에서 막으면 무발동이거나 healthyBareUp·upScore_ 경로가 함께 뒤집힌다.
 * 두 조건을 AND로 쓴다: 현상이 "폭 전면 얇은 띠"이므로 폭 조건이 빠지면 규칙이 현상보다 넓어진다
 * (전수 실측: 폭 조건 없이 FP 11 / 부수 7, 폭 0.8 이상이면 FP 4 / 부수 2, 정답 손실은 둘 다 0).
 * 높이 0.05는 가장 가까운 정답행(Penn 1@p29 = 0.0557)과 4.5pt 여유를 둔 값이다 — 0.055는 여유가
 * 0.55pt로 알려진 헤드리스↔GPU bbox 변동폭(~0.9pt)보다 작아 환경에 따라 판정이 뒤집힌다.
 * 비율 단위인 이유: 같은 취지의 기존 side 가드가 heightRatio 기준이라 그 선례를 따른다. */
const FURNITURE_STRIP_MAX_HEIGHT = 0.05;
const FURNITURE_STRIP_MIN_WIDTH = 0.80;

/* PB-4B 12-B 잠정 문턱 (v2.19.0). Q6 전수 라운드에서 정답 26행과 오발 2행 사이에 빈 구간이
 * 있었고(textCoverage 0.29↔0.86, selectionAreaRatio 0.42↔0.014) 캡션이 다음 장으로 밀리는 원인
 * 자체가 "그림이 페이지를 거의 채웠다"라서 면적 하한은 현상의 정의에서 나온다. 불통과는 abstain
 * (=현재 동작)이므로 조여서 틀리면 현상 유지, 기존 상자를 망가뜨리는 방향으로는 실패하지 않는다. */
const ADJ_TEXT_COVERAGE_MAX = 0.50;   // 정답 최대 0.2895 ↔ 오발 0.8551의 기하 중간
const ADJ_SELECTION_AREA_MIN = 0.30;  // 정답 최소 0.4241의 71%, 오발 0.0142의 21배
const ADJ_OUTSET_PX = 10;             // same-page legacy-image 후보의 x 여백과 동일한 값 (새 상수 아님)

function observeAdjacentStrength(regions, selectedIds, pageAreaPt) {
  const selected = regions.filter(region => selectedIds.includes(region.regionId));
  if (!selected.length) return null;
  let areaSum = 0, lineAreaSum = 0, inkWeighted = 0, rasterWeighted = 0, lineCount = 0;
  for (const region of selected) {
    const area = adjacentArea(region.bboxPt);
    areaSum += area;
    lineCount += region.lineRefs.length;
    for (const line of region.lineRefs) lineAreaSum += adjacentArea(line.bboxPt);
    inkWeighted += (region.inkDensityObserved_ || 0) * area;
    rasterWeighted += region.imageAreaSumRatio * area;
  }
  const denom = Math.max(areaSum, 1e-9);
  return {
    selectionAreaRatio: areaSum / Math.max(pageAreaPt, 1e-9),
    textCoverage: lineAreaSum / denom,
    rasterCoverage: rasterWeighted / denom,
    inkDensity: inkWeighted / denom,
    lineCount,
  };
}

/* ===================== PB-4A/B N−1 association observer =====================
 * same-page public 결과와 active claim을 scalar snapshot으로 받은 뒤에만 실행한다. 별도 adjacent
 * namespace에 raw XObject/ink/line/claim 관계를 기록한다. PB-4B 12-A부터 렌더·합성·guard 계산은
 * graph 유무와 무관하게 동일하고 diag는 기록에만 쓰며, 선택·방출·crop은 여전히 절대 수정하지 않는다. */
async function observeAdjacentPages(pageData, dom, diag, opts, checkAborted, snapshots, ownedClaims,
  captionBySnapshot) {
  const resolved = [];                       // 12-B가 새로 방출할 figure (없으면 빈 배열)
  if (!snapshots.length) return resolved;
  const emittedNums = new Set(ownedClaims.map(claim => String(claim.num)));
  const byTarget = new Map();
  for (const snapshot of snapshots) {
    if (!byTarget.has(snapshot.candidatePage)) byTarget.set(snapshot.candidatePage, []);
    byTarget.get(snapshot.candidatePage).push(snapshot);
  }
  const targetPages = new Set(byTarget.keys());
  const lineKeysByTarget = new Map([...targetPages].map(page => [page,
    new Set(pageData[page - 1].lines.map(line =>
      `${diagnosticTextHash(line.s)}|${Math.round(line.top)}`))]));
  for (const [targetPage, anchors] of [...byTarget.entries()].sort((a, b) => a[0] - b[0])) {
    checkAborted();
    const pd = pageData[targetPage - 1];
    const anchorIds = anchors.map(anchor => anchor.anchorId).sort();
    let canvas = null, grid = null, imageBoxes = [], operatorError = null;
    const releaseOwnedCanvas = () => {
      if (canvas && !opts.renderPage) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
    try {
      imageBoxes = await getImageBoxes(pd.page, pd.h, error => { operatorError = error; });
      checkAborted();
      if (operatorError) throw operatorError;
      if (opts.renderPage) {
        checkAborted();
        canvas = await opts.renderPage(targetPage, S);
        checkAborted();
      } else {
        const vp = pd.page.getViewport({ scale: S });
        canvas = document.createElement("canvas");
        canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        checkAborted();
        const task = pd.page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
        const onAbort = () => task.cancel();
        if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
        try {
          await task.promise;
        } finally {
          if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        }
        checkAborted();
      }
      grid = makeInk(canvas, !opts.renderPage);   // 카나리아는 엔진 소유 캔버스에서만 (B7)
    } catch (error) {
      releaseOwnedCanvas();
      if (opts.signal && opts.signal.aborted)
        throw new DOMException("figure 추출이 취소됨", "AbortError");
      /* 죽은 캔버스는 "이 PDF가 특이하다"가 아니라 실행 환경 실패다 (B7). unobservable로 삼키면
       * 12-B 방출이 조용히 사라져 실제 회귀와 구별되지 않는다 — 관측 계층이라도 그대로 올린다. */
      if (isFigRenderError(error)) throw error;
      diag?.add("adjacent-page-render", {
        page: targetPage, observation: "n-1", captionPages: [...new Set(anchors.map(a => a.captionPage))],
        anchorIds, decision: "unobservable", reasons: ["page-render-or-operator-failure"],
        errorName: error && error.name || "Error",
      });
      for (const anchor of anchors) diag?.add("adjacent-observation", {
        ...anchor, rawRegionIds: [], rawRegionCount: null, anchorRegionRelationIds: [],
        regionIds: [], regionCount: null,
        single: null, composition: null, strong: null, strongMetrics: null,
        unclaimed: null, multiPage: null,
        captionCompetition: null, captionCompetitionAnchorIds: [],
        competingSelectionAnchorIds: [], ownedIntersectionRegionIds: [],
        replacementClass: "unobservable", decision: "abstain",
        reasons: ["adjacent-page-unobservable"],
      });
      continue;
    }

    try {
      diag?.add("adjacent-page-render", {
        page: targetPage, observation: "n-1", captionPages: [...new Set(anchors.map(a => a.captionPage))],
        anchorIds, widthPt: pd.w, heightPt: pd.h,
        widthPx: grid.W, heightPx: grid.H, scale: S, imageCount: imageBoxes.length,
        decision: "observed", reasons: ["graph-only-adjacent-render"],
      });

      const xobjects = imageBoxes
        .map(box => ({
          kind: "filtered-xobject",
          bboxPx: {
            x0: Math.max(0, Math.round(box.left * S)),
            y0: Math.max(0, Math.round(box.top * S)),
            x1: Math.min(grid.W, Math.round((box.left + box.w) * S)),
            y1: Math.min(grid.H, Math.round((box.top + box.h) * S)),
          },
        }))
        .filter(seed => adjacentArea(seed.bboxPx) > 0)
        .sort((a, b) => a.bboxPx.y0 - b.bboxPx.y0 || a.bboxPx.x0 - b.bboxPx.x0 ||
          a.bboxPx.y1 - b.bboxPx.y1 || a.bboxPx.x1 - b.bboxPx.x1);
      const inkBands = adjacentInkBands(grid);
      const seeds = [
        ...xobjects.map((seed, index) => ({
          ...seed, seedId: `adj/p${targetPage}/xobject/${index}`,
          imageId: `xobject/${index}`,
        })),
        ...inkBands.map((seed, index) => ({
          ...seed, seedId: `adj/p${targetPage}/ink-band/${index}`,
        })),
      ];
      for (const seed of seeds) {
        const box = seed.bboxPx;
        diag?.add("adjacent-seed", {
          seedId: seed.seedId, page: targetPage, kind: seed.kind,
          bboxPx: box, bboxPt: adjacentPxBoxToPt(box),
          edgeDistancePt: Math.min(box.x0, box.y0, grid.W - box.x1, grid.H - box.y1) / S,
          imageId: seed.imageId || null,
          imageFilterMinWidthPt: seed.kind === "filtered-xobject" ? 10 : null,
          imageFilterMinHeightPt: seed.kind === "filtered-xobject" ? 10 : null,
          rowStart: seed.rowStart ?? null, rowEnd: seed.rowEnd ?? null,
          rowInkMax: seed.rowInkMax ?? null, inkPixels: seed.inkPixels ?? null,
          inkDensity: seed.inkDensity ?? null,
          threshold: seed.threshold ?? null, separatorPx: seed.separatorPx ?? null,
          decision: "observed", reasons: ["raw-adjacent-seed"],
        });
      }

      const regions = adjacentRegions(seeds).map((region, index) => ({
        ...region, regionId: `adj/p${targetPage}/region/${index}`,
      }));
      const pageClaims = ownedClaims.filter(claim => claim.page === targetPage);
      const claimRelationsByRegion = new Map(regions.map(region => [region.regionId, []]));
      for (const region of regions) for (const claim of pageClaims) {
        const intersection = adjacentIntersection(region.bboxPx, claim.outputBoxPx);
        if (!intersection) continue;
        const regionArea = adjacentArea(region.bboxPx), claimArea = adjacentArea(claim.outputBoxPx);
        claimRelationsByRegion.get(region.regionId).push({
          claim, intersection, regionArea, claimArea,
        });
      }
      const stoppers = new Set(pd.lines.filter(line => {
        if (line.font !== dom) return false;
        const nb = neighborsOf(line, pd.lines);
        return (line.w >= 190 && (nb.above || nb.below)) ||
          (line.w >= 100 && nb.above && nb.below);
      }));
      for (const region of regions) {
        const box = region.bboxPx, boxPt = adjacentPxBoxToPt(box);
        const lineRefs = [];
        for (let index = 0; index < pd.lines.length; index++) {
          const line = pd.lines[index];
          const lineBox = {
            x0: line.left, y0: line.top, x1: line.left + line.w, y1: line.top + line.h,
          };
          if (adjacentIntersection(boxPt, lineBox) <= 0) continue;
          let kind = "other";
          if (pd.captionData.ownerByPart.has(line) || isCaption(line) != null) kind = "figure-caption";
          else if (isTableCaption(line)) kind = "table-caption";
          else if (line.top + line.h <= 56) kind = "header";
          else if (line.top >= pd.h - 56) kind = "footer";
          else if (stoppers.has(line)) kind = "body";
          lineRefs.push({
            lineIndex: index, kind, bboxPt: {
              x0: line.left, y0: line.top, x1: line.left + line.w, y1: line.top + line.h,
            }, textHash: diagnosticTextHash(line.s),
          });
        }
        const area = adjacentArea(box);
        const imageRefs = region.seeds.filter(seed => seed.kind === "filtered-xobject")
          .map(seed => seed.imageId);
        const inkPixels = region.seeds.reduce((sum, seed) => sum + (seed.inkPixels || 0), 0);
        const edgeDistancePt = {
          top: box.y0 / S, right: (grid.W - box.x1) / S,
          bottom: (grid.H - box.y1) / S, left: box.x0 / S,
        };
        const pageEdgeTouch = {
          top: box.y0 <= 0, bottom: box.y1 >= grid.H,
          left: box.x0 <= 0, right: box.x1 >= grid.W,
        };
        region.bboxPt = boxPt;
        region.lineRefs = lineRefs;
        region.inkDensityObserved_ = inkPixels / Math.max(1, area);   // strong 관측용 (v2.18.0)
        region.edgeDistancePt = edgeDistancePt;
        region.pageEdgeTouch = pageEdgeTouch;
        region.imageAreaSumRatio = region.seeds
          .filter(seed => seed.kind === "filtered-xobject")
          .reduce((sum, seed) => sum + adjacentArea(seed.bboxPx), 0) / Math.max(1, area);
        diag?.add("adjacent-region", {
          regionId: region.regionId, page: targetPage,
          seedIds: region.seeds.map(seed => seed.seedId),
          sourceKinds: region.sourceKinds, bboxPx: box, bboxPt: boxPt,
          widthRatio: (box.x1 - box.x0) / grid.W,
          heightRatio: (box.y1 - box.y0) / grid.H,
          areaRatio: area / Math.max(1, grid.W * grid.H),
          inkDensity: inkPixels / Math.max(1, area),
          imageRefs, imageAreaSumRatio: region.imageAreaSumRatio,
          lineRefs,
          tableBodyContext: "unobservable",
          edgeDistancePt,
          pageEdgeTouch,
          rawClaimState: claimRelationsByRegion.get(region.regionId).length
            ? "owned-intersection" : "no-owned-intersection",
          strong: null, strongReason: "unclassified-pb4a",
          decision: "observed", reasons: ["raw-overlap-cluster"],
        });
      }
      for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i], b = regions[j];
        const intersection = adjacentIntersection(a.bboxPx, b.bboxPx);
        if (!intersection) continue;
        const areaA = adjacentArea(a.bboxPx), areaB = adjacentArea(b.bboxPx);
        diag?.add("adjacent-region-relation", {
          regionIds: [a.regionId, b.regionId], page: targetPage,
          intersectionPx2: intersection,
          iou: intersection / Math.max(1, areaA + areaB - intersection),
          aContainment: intersection / Math.max(1, areaA),
          bContainment: intersection / Math.max(1, areaB),
          decision: "observed", reasons: ["positive-intersection"],
        });
      }

      for (const region of regions) for (const relation of claimRelationsByRegion.get(region.regionId)) {
        const { claim, intersection, regionArea, claimArea } = relation;
        diag?.add("adjacent-claim-relation", {
          regionId: region.regionId, claimCandidateId: claim.candidateId,
          claimAnchorId: claim.anchorId, claimNum: claim.num,
          nums: [...new Set([...anchors.map(anchor => anchor.num), claim.num])], page: targetPage,
          intersectionPx2: intersection,
          iou: intersection / Math.max(1, regionArea + claimArea - intersection),
          regionContainment: intersection / Math.max(1, regionArea),
          claimContainment: intersection / Math.max(1, claimArea),
          decision: "observed", reasons: ["positive-owned-claim-intersection"],
        });
      }
      const repeatedLineKeys = new Set();
      for (const [page, keys] of lineKeysByTarget)
        if (page !== targetPage) for (const key of keys) repeatedLineKeys.add(key);
      const composition = observeAdjacentComposition(
        regions, pd.h, targetPages.size > 1 ? repeatedLineKeys : null);
      const strengthMetrics = observeAdjacentStrength(
        regions, composition.regionIds, (grid.W / S) * (grid.H / S));
      const targetAnchors = (pd.captionData.anchors || []).map(cap => {
        const info = pd.captionData.infoByAnchor.get(cap);
        return {
          anchorId: diag ? diag.registerAnchor(pd, cap) : null,
          num: info && info.num,
        };
      });
      for (const anchor of anchors) {
        const relationIds = [];
        for (const region of regions) {
          const relationId = `${anchor.anchorId}/adjacent/${region.regionId}`;
          relationIds.push(relationId);
          diag?.add("adjacent-anchor-region", {
            relationId, anchorId: anchor.anchorId, num: anchor.num,
            captionPage: anchor.captionPage, candidatePage: anchor.candidatePage,
            regionId: region.regionId, page: targetPage,
            edgeDistancePt: {
              top: region.bboxPx.y0 / S, right: (grid.W - region.bboxPx.x1) / S,
              bottom: (grid.H - region.bboxPx.y1) / S, left: region.bboxPx.x0 / S,
            },
            rawClaimState: claimRelationsByRegion.get(region.regionId).length
              ? "owned-intersection" : "no-owned-intersection",
            decision: "observed", reasons: ["threshold-free-page-edge-association"],
          });
        }
        const selectedRegionSet = new Set(composition.regionIds);
        const ownedIntersectionRegionIds = regions
          .filter(region => selectedRegionSet.has(region.regionId) &&
            claimRelationsByRegion.get(region.regionId).length)
          .map(region => region.regionId);
        const captionCompetitionAnchorIds = targetAnchors
          .filter(other => String(other.num) !== String(anchor.num))
          .map(other => other.anchorId).filter(Boolean).sort();
        /* 12-A에는 adjacent selection 자체가 없으므로 세 번째 guard의 현재 관측값은 0이다.
         * resolver가 생기면 같은 target page에서 먼저 확정된 다른 selection ID가 여기에 들어간다. */
        const competingSelectionAnchorIds = [];
        const captionCompetition = captionCompetitionAnchorIds.length > 0;
        const unclaimed = ownedIntersectionRegionIds.length > 0 || captionCompetition ||
          competingSelectionAnchorIds.length > 0
          ? false
          : composition.composition === "confirmed" ? true : null;
        diag?.add("adjacent-observation", {
          ...anchor,
          rawRegionIds: regions.map(region => region.regionId),
          rawRegionCount: regions.length, anchorRegionRelationIds: relationIds,
          regionIds: composition.regionIds, regionCount: composition.regionCount,
          single: null, composition: composition.composition,
          compositionSubtractiveRegionIds: composition.subtractiveRegionIds,
          compositionAccretionRegionIds: composition.accretionRegionIds,
          compositionFurniture: composition.furniture,
          strong: null, strongMetrics: strengthMetrics, unclaimed, multiPage: null,
          captionCompetition, captionCompetitionAnchorIds,
          competingSelectionAnchorIds, ownedIntersectionRegionIds,
          replacementClass: "observation-only-pb4b-12a",
          decision: "abstain",
          reasons: [
            "observation-only", "single-deprecated", "strong-unclassified",
            composition.composition === "confirmed"
              ? "composition-consensus" : "composition-ambiguous",
            unclaimed === true ? "unclaimed-three-guards-clear"
              : unclaimed === false ? "unclaimed-guard-blocked" : "unclaimed-unclassified",
            "multi-page-unobserved",
          ],
        });
        /* ---- 12-B 최소 안전 행동: A/B 상태 한정 신규 방출. replace는 12-C로 계속 잠금 ---- */
        const caption = captionBySnapshot && captionBySnapshot.get(anchor) || null;
        const gate = {
          unclaimed: unclaimed === true,
          composition: composition.composition === "confirmed",
          emission: ["none", "dropped", "inactive"].includes(String(anchor.currentEmission)),
          sameNumFree: !emittedNums.has(String(anchor.num)),
          textCoverage: !!strengthMetrics &&
            strengthMetrics.textCoverage <= ADJ_TEXT_COVERAGE_MAX,
          selectionArea: !!strengthMetrics &&
            strengthMetrics.selectionAreaRatio >= ADJ_SELECTION_AREA_MIN,
          captionKnown: !!(caption && caption.box),
        };
        const blocked = Object.entries(gate)
          .filter(([, pass]) => !pass).map(([key]) => `blocked-${key}`);
        let outputBoxPx = null;
        if (!blocked.length) {
          const selectedRegions = regions
            .filter(region => selectedRegionSet.has(region.regionId));
          const union = {
            x0: Math.min(...selectedRegions.map(region => region.bboxPx.x0)),
            y0: Math.min(...selectedRegions.map(region => region.bboxPx.y0)),
            x1: Math.max(...selectedRegions.map(region => region.bboxPx.x1)),
            y1: Math.max(...selectedRegions.map(region => region.bboxPx.y1)),
          };
          /* 합성 union은 잉크 경계라 same-page 상자보다 타이트하다. 여백은 same-page와 같은 10px을
           * 쓰되 페이지 변과 furniture(머리글·꼬리말·장식 띠)로 클램프해 넘침을 막는다. */
          const furnitureIds = new Set(composition.furniture.map(entry => entry.regionId));
          const furnitureBoxes = regions
            .filter(region => furnitureIds.has(region.regionId)).map(region => region.bboxPx);
          const box = {
            x0: Math.max(0, union.x0 - ADJ_OUTSET_PX),
            y0: Math.max(0, union.y0 - ADJ_OUTSET_PX),
            x1: Math.min(grid.W, union.x1 + ADJ_OUTSET_PX),
            y1: Math.min(grid.H, union.y1 + ADJ_OUTSET_PX),
          };
          for (const fb of furnitureBoxes) {
            if (adjacentIntersection(union, fb) > 0) continue;   // 원래도 겹쳤으면 여백 탓이 아니다
            if (adjacentIntersection(box, fb) <= 0) continue;    // 확장해도 안 닿으면 둘 필요 없다
            if (fb.y1 <= union.y0) box.y0 = Math.max(box.y0, fb.y1);
            if (fb.y0 >= union.y1) box.y1 = Math.min(box.y1, fb.y0);
            if (fb.x1 <= union.x0) box.x0 = Math.max(box.x0, fb.x1);
            if (fb.x0 >= union.x1) box.x1 = Math.min(box.x1, fb.x0);
          }
          outputBoxPx = {
            x0: Math.round(box.x0), y0: Math.round(box.y0),
            x1: Math.round(box.x1), y1: Math.round(box.y1),
          };
          /* same-page에서 막은 지면 장식 띠가 이 경로로 새어나가지 않게 같은 바닥을 적용한다
           * (v2.19.3). same-page 거부는 claim을 inactive로 만들어 그 anchor를 12-B 대상으로
           * 승격시키므로, 이 가드가 없으면 띠를 N−1에서 다시 방출할 수 있다. */
          const outHeightRatio = (outputBoxPx.y1 - outputBoxPx.y0) / Math.max(1, grid.H);
          const outWidthRatio = (outputBoxPx.x1 - outputBoxPx.x0) / Math.max(1, grid.W);
          if (outHeightRatio < FURNITURE_STRIP_MAX_HEIGHT &&
              outWidthRatio >= FURNITURE_STRIP_MIN_WIDTH) {
            blocked.push("blocked-furnitureStrip");
            outputBoxPx = null;
          }
          if (outputBoxPx) emittedNums.add(String(anchor.num));   // 같은 num 두 앵커의 F8 중단 방지
          if (outputBoxPx) resolved.push({
            num: anchor.num, page: targetPage,
            x0: outputBoxPx.x0, y0: outputBoxPx.y0, x1: outputBoxPx.x1, y1: outputBoxPx.y1,
            caption: caption.text, captionBox: caption.box,
            captionPage: anchor.captionPage,     // page ≠ captionPage일 때만 소비자에 방출된다
            cropPng_: opts.cropImages === false ? null : makeCropPng(canvas, outputBoxPx),
          });
        }
        diag?.add("adjacent-resolution", {
          anchorId: anchor.anchorId, num: anchor.num,
          captionPage: anchor.captionPage, candidatePage: anchor.candidatePage,
          regionIds: composition.regionIds,
          strongMetrics: strengthMetrics,
          thresholds: {
            textCoverageMax: ADJ_TEXT_COVERAGE_MAX,
            selectionAreaMin: ADJ_SELECTION_AREA_MIN,
            provisional: true,
          },
          outputBoxPx, outputBoxPt: outputBoxPx ? adjacentPxBoxToPt(outputBoxPx) : null,
          replacementClass: "new-emission-pb4b-12b",
          decision: blocked.length ? "abstain" : "emitted",
          reasons: blocked.length ? blocked : ["provisional-threshold-pass"],
        });
      }
    } finally {
      releaseOwnedCanvas();
    }
  }
  return resolved;
}

/* ===================== 메인 파이프라인 ===================== */
async function extract(data, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const dbg = opts.debug || (() => {});
  const diag = makeDiagnosticRecorder(opts.onDiagnostic);
  const maxPages = opts.maxPages;   // 미지정 시 전체 페이지 스캔 (기본 상한 없음)
  /* v2.19.1: 진단 전용 — false면 크롭 생성·PNG 직렬화를 통째로 건너뛴다. 크롭은 감지 **이후**
   * 단계라 manifest 출력은 완전히 동일하고, PNG 인코딩·전송·저장 비용만 사라진다.
   * 이 모드에서는 cropDataURL/cropBlob이 사용 불가이고 크롭 카나리아도 돌지 않는다. */
  const wantCropImages = opts.cropImages !== false;
  /* 협조적 취소 (PDFViewer#12): 페이지 단위로 signal 체크 — 문서 교체 시 호스트가 abort */
  const checkAborted = () => {
    if (opts.signal && opts.signal.aborted)
      throw new DOMException("figure 추출이 취소됨", "AbortError");
  };
  checkAborted();

  const pdf = opts.pdfDocument || await pdfjsLib.getDocument({ data }).promise;
  checkAborted();
  let title = null;
  try {
    const meta = await pdf.getMetadata();
    title = (meta.info && meta.info.Title && meta.info.Title.trim()) || null;
  } catch (e) { /* 무시 */ }

  const nPages = maxPages ? Math.min(pdf.numPages, maxPages) : pdf.numPages;
  /* 1차: 전체 텍스트 → 라인/도미넌트 폰트 */
  const pageData = [];
  const fontW = {};
  for (let p = 1; p <= nPages; p++) {
    checkAborted();
    onProgress(`텍스트 분석… ${p}/${nPages}`);
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const lines = buildLines(tc, vp.height);
    const captionData = captionAnchors(lines, dbg);
    for (const l of lines) fontW[l.font] = (fontW[l.font] || 0) + l.w;
    pageData.push({ page, num: p, w: vp.width, h: vp.height, lines, captionData });
  }
  /* 1.5차: 문서 수준 게이트로 soft 캡션 앵커 승격 (v2.9.1). 여기서만 판단할 수 있다 —
   * captionAnchors는 페이지별이고 문서의 hard 앵커 총수는 1차 패스가 끝나야 확정된다.
   * 승격분은 아래 2차 패스의 prefilter(anchors.length)를 자동으로 통과한다. */
  promoteSoftAnchors(pageData, dbg, diag);
  if (diag) for (const pd of pageData) {
    const activeAnchorIds = pd.captionData.anchors.map(cap => diag.registerAnchor(pd, cap));
    diag.add("page-text", {
      page: pd.num, widthPt: pd.w, heightPt: pd.h, lineCount: pd.lines.length,
      activeAnchorCount: activeAnchorIds.length, activeAnchorIds,
      decision: activeAnchorIds.length ? "anchor-prerequisite-met" : "anchor-prerequisite-absent",
    });
  }
  const dom = Object.entries(fontW).sort((a, b) => b[1] - a[1])[0]?.[0];
  /* 2차: 캡션 있는 페이지만 렌더 + 감지 */
  const allFigs = [];
  for (const pd of pageData) {
    checkAborted();
    if (!pd.captionData.anchors.length) continue;
    onProgress(`figure 감지… p.${pd.num}`);
    pd.images = await getImageBoxes(pd.page, pd.h);
    /* 페이지 렌더: 호스트(Margin 등)가 renderPage(pageNum, scale)를 주입하면 그걸 사용 */
    let canvas;
    if (opts.renderPage) {
      canvas = await opts.renderPage(pd.num, S);
    } else {
      const vp = pd.page.getViewport({ scale: S });
      canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      /* abort 시 진행 중 렌더도 즉시 취소 — 페이지 경계까지 안 기다림 (PDFViewer#12 in-flight).
       * 렌더 시작 직전 재확인: 앞선 await(getImageBoxes 등) 도중 이미 abort된 경우, 그 abort는
       * 아래 리스너보다 먼저 방출돼 onAbort가 안 불리므로 여기서 걸러 불필요한 렌더를 건너뛴다. */
      checkAborted();
      const task = pd.page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
      const onAbort = () => task.cancel();
      if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
      try {
        await task.promise;
      } catch (e) {
        if (opts.signal && opts.signal.aborted)
          throw new DOMException("figure 추출이 취소됨", "AbortError");
        throw e;   // 취소 아닌 실제 렌더 오류는 그대로 전파
      } finally {
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      }
    }
    /* 이 아래 페이지 본문은 **전부 동기**다 (detectPageWithFloor·dedup·makeCropPng). Chromium은
     * task 경계에서만 백킹 스토어를 버리므로, makeInk가 살아 있다고 확인한 캔버스는 크롭을 다 뜰
     * 때까지 죽지 않는다 — 크롭 카나리아가 1픽셀 검사로 충분한 근거다 (B7).
     * **여기에 await를 추가하면 그 보장이 깨진다** — 백지 PNG 구멍이 조용히 다시 열린다. */
    const releasePageCanvas = () => {   // 호스트 주입 캔버스는 우리 소유가 아니다
      if (!opts.renderPage && canvas) { canvas.width = 0; canvas.height = 0; }
    };
    try {
      const grid = makeInk(canvas, !opts.renderPage);   // 카나리아는 엔진 소유 캔버스에서만
      if (diag) diag.add("page-render", {
        page: pd.num, widthPx: grid.W, heightPx: grid.H, scale: S,
        imageCount: pd.images.length, decision: "same-page-detect",
      });
      let figs = detectPageWithFloor(pd, dom, grid, dbg, diag);
      /* 중복 번호 dedup은 (num, page) 인스턴스 단위 (PDFViewer#14) — 합본 논문·부록 번호 재시작에서
       * 같은 번호가 다른 페이지에 재등장하는 figure를 보존한다. 경쟁은 같은 페이지 안에서만 발생하므로
       * dedup·최소 크기 필터를 페이지 단위로 끝내고, 살아남은 figure만 즉시 크롭해 보관한다.
       * 페이지 전체 캔버스는 여기서 참조를 버림 — 스캔 중 동시 상주 최대 1장 (PDFViewer#12). */
      /* 지면 장식 띠 거부 (v2.19.3) — **dedup 앞**에서 판정한다. 뒤에 두면 띠가 우승자로 뽑힌 뒤
       * 죽고, 같은 num의 진짜 후보는 이미 버려져 복구할 길이 없다(래스터 띠는 raster_ 가산점
       * 1e9으로 비-래스터 진짜 figure를 무조건 이긴다 — 머리글 띠에 로고가 흔하다). */
      const strip = f => {
        const heightRatio = (f.y1 - f.y0) / Math.max(1, grid.H);   // canvas는 해제될 수 있어 grid가 정본
        const widthRatio = (f.x1 - f.x0) / Math.max(1, grid.W);
        return heightRatio < FURNITURE_STRIP_MAX_HEIGHT && widthRatio >= FURNITURE_STRIP_MIN_WIDTH;
      };
      const kept = figs.filter(f => !strip(f));
      const beforeStrip = figs;   // dedup 사유 계산은 거부 전 모집단으로 해야 한다 (v2.19.4)
      if (diag) {
        for (const f of figs) {
          if (!strip(f)) continue;
          /* 거부된 후보에도 dedup 레코드를 남긴다 — 안 남기면 같은 num의 진짜 후보가
           * "sole-identity-candidate"로 기록돼 **경쟁자를 방금 잃은 바로 그 상황**에 거짓 사유가
           * 붙고, 그래프만 보고는 띠가 밀어냈다가 죽은 이력을 복원할 수 없다 (v2.19.4). */
          diag.add("dedup", {
            page: pd.num, num: f.num,
            candidateId: diag.figCandidateId(f),
            winnerCandidateId: diag.figCandidateId(f),
            rankScore: (f.raster_ ? 1e9 : 0) + f.h_,
            decision: "dropped", reasons: ["furniture-strip"],
          });
          diag.add("emission", {
            page: pd.num, num: f.num, candidateId: diag.figCandidateId(f),
            decision: "dropped",
            heightRatio: +((f.y1 - f.y0) / Math.max(1, grid.H)).toFixed(4),
            widthRatio: +((f.x1 - f.x0) / Math.max(1, grid.W)).toFixed(4),
            maxHeightRatio: FURNITURE_STRIP_MAX_HEIGHT, minWidthRatio: FURNITURE_STRIP_MIN_WIDTH,
            reasons: ["furniture-strip"],
          });
          diag.add("claim", {
            page: pd.num, num: f.num, candidateId: diag.figCandidateId(f),
            decision: "inactive", reasons: ["furniture-strip"],
          });
        }
      }
      for (const f of figs) {
        if (!strip(f)) continue;
        const info = pd.captionData.infoByAnchor.get(f._anchor);
        if (info && info.adjacentState_ && info.adjacentState_.selectedFig === f) {
          info.adjacentState_.emission = "dropped";
          info.adjacentState_.claim = "inactive";
        }
      }
      figs = kept;
      const best = {};
      for (const f of figs) {
        const score = (f.raster_ ? 1e9 : 0) + f.h_;
        if (!(f.num in best) || score > best[f.num].score) best[f.num] = { score, f };
      }
      if (diag) {
        for (const f of figs) {
          const winner = best[f.num].f;
          const sameIdentityCount = beforeStrip.filter(other => other.num === f.num).length;
          diag.add("dedup", {
            page: pd.num, num: f.num,
            candidateId: diag.figCandidateId(f),
            winnerCandidateId: diag.figCandidateId(winner),
            rankScore: (f.raster_ ? 1e9 : 0) + f.h_,
            decision: f === winner ? "kept" : "dropped",
            reasons: [sameIdentityCount === 1 ? "sole-identity-candidate"
              : f === winner ? "raster-height-winner" : "lower-raster-height-rank"],
          });
        }
      }
      for (const f of figs) {
        const info = pd.captionData.infoByAnchor.get(f._anchor);
        if (!info || !info.adjacentState_ || info.adjacentState_.selectedFig !== f) continue;
        info.adjacentState_.emission = "none";
        info.adjacentState_.claim = "none";
      }
      const emittedThisPage = diag ? [] : null;
      for (const { f } of Object.values(best)) {
        const widthPx = f.x1 - f.x0, heightPx = f.y1 - f.y0;
        if (widthPx < 30 || heightPx < 30) {
          const info = pd.captionData.infoByAnchor.get(f._anchor);
          if (info && info.adjacentState_ && info.adjacentState_.selectedFig === f) {
            info.adjacentState_.emission = "dropped";
            info.adjacentState_.claim = "inactive";
          }
          if (diag) {
            diag.add("emission", {
              page: pd.num, num: f.num, candidateId: diag.figCandidateId(f),
              decision: "dropped", widthPx, heightPx, minWidthPx: 30, minHeightPx: 30,
              reasons: ["minimum-size"],
            });
            diag.add("claim", {
              page: pd.num, num: f.num, candidateId: diag.figCandidateId(f),
              decision: "inactive", reasons: ["minimum-size"],
            });
          }
          continue;
        }
        if (wantCropImages) f.cropPng_ = makeCropPng(canvas, f);
        allFigs.push(f);
        const info = pd.captionData.infoByAnchor.get(f._anchor);
        if (info && info.adjacentState_ && info.adjacentState_.selectedFig === f) {
          info.adjacentState_.emission = "emitted";
          info.adjacentState_.claim = "owned";
        }
        if (diag) emittedThisPage.push(f);
        if (diag) {
          const outputBoxPx = { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 };
          diag.add("emission", {
            page: pd.num, num: f.num, candidateId: diag.figCandidateId(f),
            decision: "emitted", widthPx, heightPx, outputBoxPx,
            outputBoxPt: diag.pxBoxToPt(outputBoxPx),
            reasons: ["dedup-and-size-pass"],
          });
          diag.add("claim", {
            page: pd.num, num: f.num, candidateId: diag.figCandidateId(f),
            decision: "owned", outputBoxPx, outputBoxPt: diag.pxBoxToPt(outputBoxPx),
            reasons: ["active-emitted-output"],
          });
        }
      }
      if (diag) for (let i = 0; i < emittedThisPage.length; i++) {
        const a = emittedThisPage[i];
        const areaA = Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);
        for (let j = i + 1; j < emittedThisPage.length; j++) {
          const b = emittedThisPage[j];
          const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
          const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
          const intersection = ix * iy;
          if (!intersection) continue;
          const areaB = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
          const union = areaA + areaB - intersection;
          diag.add("claim-relation", {
            page: pd.num, decision: "contested",
            claimantCandidateId: diag.figCandidateId(a),
            counterpartCandidateId: diag.figCandidateId(b),
            claimantNum: a.num, counterpartNum: b.num, nums: [a.num, b.num],
            intersectionPx2: intersection,
            iou: union > 0 ? intersection / union : 0,
            claimantContainment: areaA > 0 ? intersection / areaA : 0,
            counterpartContainment: areaB > 0 ? intersection / areaB : 0,
            reasons: ["distinct-identity-overlap-keep", "active-emitted-claims"],
          });
        }
      }
    } finally {
      /* 정상·예외 어느 경로로 빠져나가도 페이지 캔버스 백킹 스토어를 반환한다 (B7) —
       * 크롭이 이미 PNG로 직렬화돼 더 볼 일이 없고, GC를 기다리는 사이 다음 페이지
       * 캔버스와 동시 상주하는 것을 없앤다. adjacent 경로의 releaseOwnedCanvas와 같은 처리. */
      releasePageCanvas();
    }
  }
  /* N−1 observer 입력은 same-page lifecycle이 모두 끝난 이 지점에서 scalar로 동결한다.
   * 이후 public figure 내부 필드 삭제와 adjacent 재렌더가 서로 영향을 주지 않는다. */
  /* 12-A/12-B eligibility는 기존 output이 없는 A/B 상태만이다. owned C 상태의 dominated/replace는
   * 12-C로 보류됐으므로 렌더하지 않는다. 이 필터 뒤 0건이면 observer가 즉시 반환한다. */
  /* 캡션 텍스트·박스는 diag record로 나가면 안 되는 원문이라 snapshot에 싣지 않고 별도 map으로
   * 넘긴다 (12-B 방출이 caption page 좌표계 값을 그대로 재사용한다). */
  const adjacentCaptionBySnapshot = new Map();
  const adjacentSnapshots = pageData.flatMap(pd => pd.num <= 1 ? [] :
    pd.captionData.anchors.map(cap => {
      const anchorId = diag ? diag.registerAnchor(pd, cap) : null;
      const info = pd.captionData.infoByAnchor.get(cap);
      const local = info && info.adjacentState_ || {
        selection: "none", chosenDirection: null, selectedFig: null,
        emission: "none", claim: "none",
      };
      const state = diag ? diag.anchorState(anchorId) : {
        chosenCandidateId: null,
        chosenDirection: local.chosenDirection,
        selection: local.selection,
        emission: local.emission,
        claim: local.claim,
      };
      const snapshot = {
        anchorId, num: info && info.num,
        captionPage: pd.num, candidatePage: pd.num - 1,
        currentSelection: state.selection,
        currentChosenCandidateId: state.chosenCandidateId,
        currentChosenDirection: state.chosenDirection,
        currentEmission: state.emission,
        currentClaimState: state.claim,
      };
      adjacentCaptionBySnapshot.set(snapshot, {
        text: info && info.captionTextObserved_ || (cap && cap.s) || "",
        box: info && info.captionBoxObserved_ || null,
      });
      return snapshot;
    })).filter(snapshot => snapshot.currentClaimState !== "owned");
  const adjacentOwnedClaims = allFigs.map(f => ({
    candidateId: diag ? diag.figCandidateId(f) : null,
    anchorId: diag ? diag.registerAnchor(
      pageData[f.page - 1], f._anchor) : null,
    num: f.num, page: f.page,
    outputBoxPx: { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 },
    outputBoxPt: adjacentPxBoxToPt({ x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 }),
  }));
  /* 12-B resolver는 정규화 **전에** 돌려야 신규 방출 figure가 같은 필드 정규화와 suspectedMissing
   * 재계산을 그대로 통과한다. 방출이 0건이면 이전 버전과 완전히 동일한 경로다. */
  checkAborted();
  const adjacentResolved = await observeAdjacentPages(
    pageData, dom, diag, opts, checkAborted, adjacentSnapshots, adjacentOwnedClaims,
    adjacentCaptionBySnapshot);
  /* 중단 조건(F8): resolver는 기존 num을 건드리지 않는다 — 같은 num이 이미 방출됐으면 gate에서
   * 걸러지므로 여기 도달하면 안 된다. 도달했다면 파일명 규칙까지 흔들리므로 즉시 실패시킨다. */
  for (const fig of adjacentResolved) {
    if (allFigs.some(f => String(f.num) === String(fig.num)))
      throw new Error(`PB-4B 12-B 중단: num ${fig.num}이 이미 방출됨 (replace는 12-C 잠금)`);
    allFigs.push(fig);
  }
  const figures = allFigs
    .sort((a, b) => a.page - b.page ||
                    String(a.num).localeCompare(String(b.num), undefined, { numeric: true }));
  for (const f of figures) {
    f.bboxPx = { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 };
    f.bboxPt = { x0: +(f.x0 / S).toFixed(1), y0: +(f.y0 / S).toFixed(1),
                 x1: +(f.x1 / S).toFixed(1), y1: +(f.y1 / S).toFixed(1) };
    f.captionBoxPt = { x0: +f.captionBox.x0.toFixed(1), y0: +f.captionBox.y0.toFixed(1),
                       x1: +f.captionBox.x1.toFixed(1), y1: +f.captionBox.y1.toFixed(1) };
    delete f.captionBox;
    delete f.raster_;
    delete f.dir_;
    delete f._anchor;   // soft floor 판정용 내부 태그 — 출력 미포함 (v2.14.0)
    f.confidence = 1.0; // 당분간 고정 (Margin FigureEntry.confidence 대응)
  }
  checkAborted(); // 마지막 페이지 렌더 중 abort돼도 완료 결과를 반환하지 않도록 최종 체크
  /* 후처리: 번호 공백 추론 — resolver 이후의 최종 figures만 읽어야 stale이 되지 않는다.
   * 부록 번호("A.1", "B.2")·로마숫자는
   * 1부터 시작한다는 가정이 안 통해 제외한다. (Dong-2025 유래) */
  checkAborted();
  const intNums = new Set(figures.map(f => String(f.num)).filter(n => /^\d+$/.test(n)).map(Number));
  const suspectedMissing = [];
  if (intNums.size) {
    const maxN = Math.max(...intNums);
    for (let n = 1; n <= maxN; n++) if (!intNums.has(n)) suspectedMissing.push(String(n));
  }
  if (diag) {
    diag.add("document-end", {
      decision: "complete", numPages: pdf.numPages, scannedPages: nPages,
      emittedFigures: figures.length, suspectedMissing,
    });
    diag.finish();
  }
  return { title, numPages: pdf.numPages, figures, suspectedMissing, engineVersion: VERSION };
}

/* ===================== 크롭 헬퍼 ===================== */
/* 스캔 루프 안에서 페이지 캔버스로부터 그림 영역만 잘라내 **즉시 PNG로 직렬화**한다 (v2.19.1, B7).
 * 캔버스로 들고 있으면 문서 스캔이 끝날 때까지(수십 초) Chrome이 백킹 스토어를 회수할 수 있는
 * 상태로 남는다 — 실제 전수 실행에서 그 창 동안 한 논문 크롭 전량이 백지가 됐다. PNG 문자열은
 * 평범한 JS 데이터라 회수 대상이 아니고, 압축돼 있어 논문당 상주도 130MB → 수MB로 떨어진다. */
function makeCropPng(pageCanvas, f) {
  const cw = f.x1 - f.x0, ch = f.y1 - f.y0;
  /* 기하 사전조건 — 도달 불가여야 한다(최소 크기 30px 필터·furniture 클램프). 일반 Error로 두는
   * 게 중요하다: FigRenderError로 던지면 배치 러너가 메모리 압력으로 오인해 논문마다 Chrome을
   * 재시작하고, 결정적 기하 버그가 일시적 장애로 위장된다. */
  if (cw <= 0 || ch <= 0) throw new Error(`크롭 영역이 비어 있습니다 (${cw}×${ch})`);
  const c2 = document.createElement("canvas");
  c2.width = cw; c2.height = ch;
  const ctx = c2.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(pageCanvas, f.x0, f.y0, cw, ch, 0, 0, cw, ch);
  /* 카나리아: 흰 배경을 칠했으므로 살아 있는 캔버스라면 (0,0)은 반드시 불투명하다. 1픽셀로
   * 충분한 이유는 호출부(페이지 루프) 주석 참고 — makeInk 이후 여기까지 await가 없다. */
  if (ctx.getImageData(0, 0, 1, 1).data[3] !== 255)
    throw figRenderError(`크롭 캔버스가 비어 있습니다 (${cw}×${ch} — 메모리 부족으로 캔버스가 회수됐을 수 있습니다)`);
  const png = c2.toDataURL("image/png");
  c2.width = 0; c2.height = 0;   // 백킹 스토어 즉시 반환
  return png;
}
/* v2.19.1: 크롭은 스캔 중 PNG data URL로 직렬화된다 — 아래 둘은 `f.cropPng_`를 읽는 접근자.
 * `cropCanvas` 접근자와 `figure.cropCanvas` 필드는 제거됐다 ([BREAKING], B7) — 크롭 캔버스를
 * 문서 끝까지 살려 두는 구조 자체가 결함의 원인이었다. */
const cropDataURL = f => {
  if (typeof f.cropPng_ !== "string")
    throw new Error("크롭 이미지가 없습니다 — extract를 cropImages:false(진단 전용)로 호출했습니다.");
  return f.cropPng_;
};
/* base64를 직접 디코드한다 — `fetch(dataUrl)`가 한 줄이고 off-thread지만, 유일한 소비자인
 * Margin은 확장 CSP(connect-src) 아래라 data: fetch가 막힐 수 있다. 바이트는 동일하다. */
const cropBlob = async f => {
  const url = cropDataURL(f);
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: "image/png" });
};

return { VERSION, extract, cropDataURL, cropBlob, isCaption, isTableCaption, buildLines };

})();

/* Margin(Vite/TS)에서 side-effect import 후 전역으로 접근할 수 있도록 노출 */
if (typeof globalThis !== "undefined") globalThis.FigExtract = FigExtract;
