# fig-extract 엔진 통합 규약

figure 감지 엔진(`src/core/fig-extract.js`)의 반입·사용 규약. 엔진 알고리즘은 별도
저장소 **PDFViewer-Figure-Extract**에서 개발·검증되며, 이 repo에는 빌드 산출물처럼 vendoring한다.

엔진 repo 문서 (원격 https://github.com/onetwothr1/PDFViewer-Figure-Extract):
- `docs/DEV.md` — 엔진 개발 진입점 (통합 계약, 릴리스 절차, 로드맵)
- `docs/ALGORITHM.md` — 감지 알고리즘 상세

## 작업 경계

- **엔진(PDFViewer-Figure-Extract) 담당**: 문서에 어떤 figure가 존재하는가(번호·페이지), region bbox(그림 영역만),
  캡션 전체 텍스트, 캡션 블록 bbox. → **문서 내 figure 목록의 단일 진실 공급원은 엔진이다.**
- **Margin 담당**: `fig-engine.ts`(타입 래퍼, `toPdfRect`/`toFigureEntries` 변환),
  captionAnchor(엔진이 준 captionText를 S_p에서 검색해 오프셋 계산), 본문 mentions 스캔·링크 주입(§5.4, `mentions.ts`),
  수동 크롭(§6, `regionSource='manual'`은 항상 엔진 결과보다 우선 보존).
- vendored 엔진 파일은 이 repo에서 직접 수정하지 않는다. 문제 발견 시 엔진 repo에 샘플 PDF와 함께 전달.

## 파일

| 파일 | 역할 |
|---|---|
| `src/core/fig-extract.js` | (vendored) 엔진 본체 (전역 `FigExtract` 등록) |
| `src/core/fig-extract.d.ts` | strict TS에서 위 .js를 side-effect import하기 위한 스텁 |
| `src/core/fig-engine.ts` | 타입 정의 + `toPdfRect`/`toFigureEntries` + 전역 `pdfjsLib` 주입 — 통합 접점은 이 파일 하나 |
| `src/viewer/panel/tab-figures.ts` | 그림·표 탭 UI — PDF 문서 준비 직후 엔진 스캔 시작·프리뷰 카드·페이지 점프 |

## 사용법

```ts
import { FigExtract, toFigureEntries } from "../core/fig-engine";

// 뷰어가 이미 문서를 로드했으므로 재파싱 없이 PDFDocumentProxy를 넘긴다 (data는 null)
const res = await FigExtract.extract(null, {
  pdfDocument: pdfHost.pdfDocument,
  renderPage: (pageNum, scale) => renderCache.getPageCanvas(pageNum, scale), // 선택
});
const seeds = toFigureEntries(res, (p) => pageHeights[p]);
// seeds: FigureEntry에서 doc·captionAnchor만 빠진 형태 — 호출 측이 채워서 저장
```

## 현재 통합 상태

- `tab-figures.ts`가 구현됨: PDF.js 문서 객체가 준비되면 엔진 스캔을 즉시 시작 → 프리뷰 카드(크롭 이미지·캡션 텍스트)
  렌더, 카드 클릭 시 해당 페이지 점프. 결과는 **세션 메모리만** (storage 저장 안 함).
- 미구현 (M3 잔여, Margin 측): `toFigureEntries()`로 FigureEntry 생성 후 storage 저장,
  captionAnchor 계산, 본문 mentions 스캔·참조 링크 주입(§5.4), 수동 크롭 연동(§6).
- 엔진은 전역 `pdfjsLib`(OPS 등)에 의존하는데, 번들 환경에서는 `fig-engine.ts`가
  pdfjs-dist import를 전역에 주입해 해결한다 — 엔진 사용 전 `fig-engine.ts`를 거치면 됨.

## 주의사항

> 이 섹션의 원천 사실은 엔진 repo 문서(`docs/DEV.md` §통합 계약, `docs/ALGORITHM.md` §알려진 한계)가 정본 —
> 벤더링 시 새 버전과 어긋나지 않는지 동기화 확인.

- **좌표계**: 엔진은 pt 단위·좌상단 원점. Margin 저장 규약(PDF user space, 좌하단 원점)으로는
  `toPdfRect()`가 변환한다 (`y' = pageHeight − y`).
- **figure 식별 키 = (num, page)** (v2.5.0+): 같은 `num`이 다른 페이지에 복수 등장할 수 있다
  (합본 논문·부록 번호 재시작 — #14). num 단독을 키로 쓰지 말 것 — `toFigureEntries`의
  `fig{num}-p{page}` ID가 올바른 키다. 결과 정렬은 page 오름차순 → num 자연순 (결정적).
- **suspectedMissing** (v2.4.0+): 감지된 정수 번호 1..최대 중 빠진 번호 목록 (미탐지 의심).
  소비자가 무시해도 되는 보고 필드 — "이 논문에 Fig N이 있을 텐데 못 잡았다" UI에 활용 가능.
- **취소** (v2.5.0+): `opts.signal`(AbortSignal) 전달 시 페이지 단위로 체크해 AbortError로 reject.
  문서 교체 시 이전 스캔 중단에 사용 (#12). v2.5.1+: abort 시 진행 중 페이지 렌더도 `RenderTask.cancel()`로
  즉시 중단 — 페이지 경계까지 기다리지 않는다. **호스트는 문서 교체 시 반드시 signal을 abort해야 한다**
  (엔진은 메커니즘만 제공 — signal 미전달 시 스캔이 끝까지 진행됨).
- **크롭 캔버스 수명/메모리** (#12, v2.5.1+): `figure.cropCanvas`는 그림 영역만의 크롭 렌더(scale 2.2)다.
  엔진은 페이지 전체 캔버스를 보관하지 않는다(스캔 중 동시 상주 최대 1장) — figure마다 페이지 전체
  캔버스를 물던 구조(~9.4MB/페이지 상주)가 사라졌다. 프리뷰 생성 후 `cropCanvas` 참조를 버리면 GC 회수.
  페이지 렌더 LRU·object URL revoke는 여전히 Margin 몫.
- **pdf.js 버전**: 엔진은 pdfjs-dist 4.10.38(프로젝트 고정 버전) 기준으로 테스트 샘플 검증됨.
- **confidence**: 현재 1.0 고정 (플레이스홀더). 추후 감지 경로별 실측 값으로 교체 예정.
- **Table 미지원**: 엔진은 figure만 감지한다. Table region은 v1에서 수동 크롭으로 처리.
- **텍스트 레이어 없는 PDF(스캔본)**: 캡션을 찾지 못해 figures가 빈 배열 — 정상 동작.
- **캡션 앵커·다방향 한계**: "Figure N" 표기가 아예 없는 문서는 구조적 미탐지다. v2.8.0부터 캡션 위·아래·좌·우 figure 후보를 지원하지만, side caption의 세로 정렬 증거가 약하거나 기존 상향 후보가 강하면 보수적으로 미탐지/기존 영역을 유지할 수 있다. 캡션과 figure가 서로 다른 페이지인 레이아웃도 미지원이다 (엔진 repo ALGORITHM.md §알려진 한계).
- **캡션 표기 확대 (v2.9.x)**: 번호 뒤 구분자가 없는 표기(RSC·Springer `Fig. 1 본문…`, Wiley 자간 분리 `F I G U R E 1 본문…`)를 **문서 수준 게이트를 통과한 문서에서만** 앵커로 승격한다 — 한 문서가 캡션 관습을 하나만 쓴다는 전제라, hard 앵커가 이미 잡히는 문서에는 적용되지 않는다(표기가 섞인 문서는 미적용). 나란한 figure의 캡션이 8pt 미만 간격으로 한 줄에 붙은 경우도 분해해 각각 앵커한다.
- **번호 글리프에 ToUnicode 매핑이 없는 PDF는 원리상 미탐지**: 번호가 화면에는 정상으로 보이는데 텍스트 레이어에 문자가 없는 문서가 있다(Wiley 일부). 엔진이 아니라 PDF 쪽 문제라 사용자 눈에는 "번호가 멀쩡히 보이는데 안 잡힌다"로 보인다 — 문의가 오면 수동 크롭 안내가 맞다.
- **영역 경계 정밀화 (v2.10.x)**: figure/table·나란한 컬럼 경계 판정을 개선했다 — table 캡션을 **경계로만** 인식해 인접 figure 크롭에서 table을 제외(v2.10.0, table 자체 방출은 없음), 좌우로 나란한 두 figure가 서로를 통째로 크롭하던 것을 각자 캡션 컬럼으로 분리(v2.10.1 같은 baseline, v2.10.2 baseline 어긋난 offset). 출력 필드·좌표계·(num,page) 식별자 불변 — bbox가 더 타이트해질 뿐이라 소비자 코드 변경은 불요.
- **캡션 문법 확대 (v2.11.0)**: 보충·부록 캡션의 inline 표기를 새로 잡는다 — `Fig. S1.`·`Figure S1:`·`Figure A1.`(문자접두 번호), `Supplemental`/`Supporting Figure N`(접두), `FIG. 3 (color online).`·`Figure 1 (저자명).`(괄호 한정구). 전부 **점형 canonical**(`S.N`·`A.N`)으로 방출하므로 `num` 필드에 `"S.1"`·`"A.1"` 형태가 더 자주 등장한다(v2.6.0의 `ED.N`·prefix `S.N`과 동일한 표기 규약 — 새 값 형태 아님). 출력 필드·좌표계·(num,page) 식별자·manifest 스키마 불변, 소비자 코드 변경 불요. 주의: 한 물리 figure의 캡션에 다른 계열 라벨이 중첩된 오제출 문서(예: Extended Data 캡션 본문에 `Figure S1.`)는 같은 그림을 `ED.N`+`S.N` 두 번 방출할 수 있다(candidate suppression 미구현 — 엔진 repo 백로그, n=1 코너).
- 엔진은 백그라운드 탭에서 크롬 타이머 스로틀링의 영향을 받는다(분석이 수십 배 느려짐).
  전체 문서 스캔은 사용자가 뷰어를 보고 있는 동안 idle로 돌리는 것을 권장.

## fig extractor 작업자를 위한 갱신 절차

1. 엔진 전용 별도 repo에서 새 버전 검증 완료 후 (엔진 repo `docs/DEV.md` §버전 릴리스 절차)
2. `fig-extract.js`를 `src/core/`에 **그대로 복사** — v2.3.0부터 엔진 파일에 globalThis 노출이 포함되어
   byte-identical 복사면 됨. 복사 후 두 파일 diff가 0건인지 확인
3. 엔진 헤더 체인지로그의 계약 태그 확인 — `[필드 추가]`/`[BREAKING]`이면
   `fig-engine.ts`·`fig-extract.d.ts` 타입과 이 문서의 계약 서술을 함께 갱신
4. 이 문서 §주의사항이 새 버전과 어긋나지 않는지 확인 (예: confidence 실측화 시 해당 항목 갱신)
5. `npm run typecheck && npm run build` 확인 후 그림·표 탭에서 샘플 PDF 1개 스모크 테스트
6. 커밋 메시지에 엔진 버전 명시 (예: `chore: bump fig-extract to v2.3.0`)
