# fig-extract 엔진 통합 규약

figure 감지 엔진(`src/core/fig-extract.js`)의 반입·사용 규약. 엔진 알고리즘은 별도
저장소 **figure-preview-test**에서 개발·검증되며, 이 repo에는 빌드 산출물처럼 vendoring한다.

엔진 repo 문서 (로컬 `C:\Users\kimde\Desktop\figure-preview-test`, 원격 https://github.com/onetwothr1/PDFViewer-Figure-Extract):
- `docs/DEV.md` — 엔진 개발 진입점 (통합 계약, 릴리스 절차, 로드맵)
- `docs/ALGORITHM.md` — 감지 알고리즘 상세

## 작업 경계

- **엔진(figure-preview-test) 담당**: 문서에 어떤 figure가 존재하는가(번호·페이지), region bbox(그림 영역만),
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
- **pdf.js 버전**: 엔진은 pdfjs-dist 4.10.38(프로젝트 고정 버전) 기준으로 테스트 샘플 검증됨.
- **confidence**: 현재 1.0 고정 (플레이스홀더). 추후 감지 경로별 실측 값으로 교체 예정.
- **Table 미지원**: 엔진은 figure만 감지한다. Table region은 v1에서 수동 크롭으로 처리.
- **텍스트 레이어 없는 PDF(스캔본)**: 캡션을 찾지 못해 figures가 빈 배열 — 정상 동작.
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
