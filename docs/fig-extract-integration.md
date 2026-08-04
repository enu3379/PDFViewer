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
import { FigExtract, toFigureEntries, toFigureEntry } from "../core/fig-engine";

// 뷰어가 이미 문서를 로드했으므로 재파싱 없이 PDFDocumentProxy를 넘긴다 (data는 null)
const res = await FigExtract.extract(null, {
  pdfDocument: pdfHost.pdfDocument,
  signal: abortController.signal,   // 문서 교체 시 필수 — 아래 §주의사항 취소
  // renderPage: … ← **주입하면 죽은 캔버스 검사(FigRenderError)가 꺼진다.** 아래 §주의사항
  //   FigRenderError 참조. 렌더 캐시 재사용 이득과 백지 크롭 보호를 맞바꾸는 선택이므로
  //   지금은 주입하지 않는다.
});
const seeds = toFigureEntries(res, (p) => pageHeights[p]);
// seeds: FigureEntry에서 doc·captionAnchor가 빠지고 captionPage가 더해진 형태.
// 영속화는 반드시 toFigureEntry()로 — captionPage를 떨어뜨린다 (아래 §cross-page 캡션)
const entries = seeds.map((seed) =>
  toFigureEntry(seed, docId, anchorFoundIn(seed.captionPage, seed.captionText)));
```

## 현재 통합 상태

- `tab-figures.ts`가 구현됨: PDF.js 문서 객체가 준비되면 엔진 스캔을 즉시 시작 → 프리뷰 카드(크롭 이미지·캡션 텍스트)
  렌더, 카드 클릭 시 해당 페이지 점프. 결과는 **세션 메모리만** (storage 저장 안 함).
- 미구현 (M3 잔여, Margin 측): `toFigureEntries()`로 FigureEntry 생성 후 storage 저장,
  captionAnchor 계산, 본문 mentions 스캔·참조 링크 주입(§5.4), 수동 크롭 연동(§6).
- 엔진은 전역 `pdfjsLib`(OPS 등)에 의존하는데, 번들 환경에서는 `fig-engine.ts`가
  pdfjs-dist import를 전역에 주입해 해결한다 — 엔진 사용 전 `fig-engine.ts`를 거치면 됨.

### v2.19.4 벤더링 — 완료 (2026-07-28)

엔진 `fig-extract.js` v2.19.4(엔진 SHA `af44f5a`)를 `src/core/fig-extract.js`로 벤더링하고
`VENDORED_ENGINE_VERSION`을 함께 갱신했다. 소비자 측 대응(`fig-engine.ts`·`tab-figures.ts`·테스트·
이 문서)은 같은 변경에 포함돼 있다.

#### 부분집합 원칙과 이번에 그 원칙이 적용되지 않는 이유

운영 원칙은 **선언 타입은 벤더링 런타임이 실제로 제공하는 것의 부분집합으로 유지한다**이다 —
제거는 먼저 반영하고, 추가는 벤더링과 **함께** 반영한다. 근거는 "좁히는 게 안전해서"가 아니라
**두 방향의 실패 방식이 다르기 때문**이다.

- **좁히기는 컴파일 타임에 요란하게 실패한다** — 누군가 그 필드를 쓰고 있었다면 그 PR에서 즉시 타입
  에러가 난다. 단, 런타임이 여전히 그 필드에 의존한다면(v2.14.0의 `cropCanvas`, v2.19.1+의
  `cropPng_`가 정확히 그렇다) 그 사실을 **다른 곳에 남겨야 한다**.
- **넓히기는 런타임에 조용히 실패한다** — 컴파일도 되고 배포도 되고 아무 일도 안 일어난다.

이번 벤더링은 **추가와 파일 복사를 한 변경에 담았다** — 원칙의 "함께"에 해당한다.
`ExtractOptions.cropImages`·`onDiagnostic`은 이제 런타임 v2.19.4가 실제로 지원한다.

**핀이 지키는 범위는 좁다.** `VENDORED_ENGINE_VERSION` 핀이 검사하는 것은 **상수 ↔ 엔진 파일**
한 쌍뿐이다 — 어느 쪽을 먼저 바꿔도 깨지므로 그 둘의 스큐는 잡힌다. 그러나 **선언 타입이 어느
버전 기준으로 쓰였는지는 어떤 테스트도 알 수 없다.** 타입만 새 계약으로 앞서 나간 상태는 초록으로
통과한다. 그래서 타입 변경은 반드시 파일 복사와 같은 커밋에 두어야 하고, 이 규칙을 지키는 것은
아래 §갱신 절차를 읽는 사람의 몫이다.



#### 이미 반영된 것 (구 §다음 벤더링 할 일)

| 항목 | 상태 |
|---|---|
| `EngineFigure.captionPage?: number` + `toFigureEntries` 보존 (v2.19.0 12-B) | 완료 — 아래 참조 |
| `ExtractOptions.cropImages?: boolean` (v2.19.1 진단 전용) | 완료 (선언만 — 호출부 없음) |
| `ExtractOptions.onDiagnostic?: (records: unknown[]) => void` (v2.15.0) | 완료 (선언만 — 호출부 없음) |
| `tab-figures.ts`의 `FigRenderError` 분기 문구 | 완료 (판별식은 엔진과 동일하게 `name`만 본다) |
| v2.14.0 크롭 캔버스 수명 경고 (`cropCanvas` load-bearing) | 무효화 — v2.19.1이 PNG 직렬화로 대체 |
| `toFigureEntry()` — seed→영속 엔트리 경계 (백로그에 없던 신규) | 완료 — `captionPage` 누출 차단 |

**`captionPage`의 스키마 결정** (미뤄져 있던 진짜 쟁점): `FigureEntry`는 넓히지 **않았다**.
`FigureEntry.captionAnchor.page`가 이미 목적지 필드이기 때문이다. 대신 `FigureSeed`가
`captionPage: number`를 나른다 — 그 값을 계산하는 데 필요한 정보를 seed가 나르고 호출 측이
`captionAnchor`로 접는 구조다. 엔진의 optional을 그대로 흘리지 않고 **경계에서 `?? page`로
정규화**해 항상 존재하는 `number`로 만든다: optional을 흘리면 호출 측이 보정을 잊어도 컴파일이
통과하고 captionAnchor 검색이 그림 페이지에서 **오류 없이 조용히 실패**하는데, 그게 애초에 이
항목이 백로그에 오른 이유였다.

### 벤더링과 무관한 선재 결함

- ~~`tab-figures.ts`에 `AbortController` 배선이 없다~~ → **해소 (#34)**. `setDocument`가 진행 중인
  스캔을 실제로 abort하고, `#scan`이 엔진에 `signal`을 넘긴다. 취소로 인한 거절은 정상 흐름이라
  에러 UI를 띄우지 않는다(엔진이 던지는 이름에 기대지 않고 `signal.aborted`만 본다).
  abort가 `setDocument`에만 있는 이유는 **문서 교체만이 진행 중인 스캔을 무효화하는 사건**이기
  때문이다 — 재시도는 종료 상태 `'error'`에서만 진입하므로 그때 취소할 스캔이 없다.
  - **취소는 협조적이므로 중첩이 0이 되는 것은 아니다**: 엔진은 페이지 경계의 `checkAborted()`와
    진행 중 렌더의 `RenderTask.cancel()`에서만 멈춘다. 문서를 바꾼 뒤에도 나가는 스캔이 **약 1페이지
    분량**(페이지 캔버스 1장 + 그 페이지까지의 크롭)을 더 들고 있을 수 있다. "스캔 두 개가 끝까지"
    대비 이득이 목적이고, 0이 목표가 아니다.
  - ⚠ **엔진 쪽 미해결 — v2.19.4에서도 그대로다** (2026-07-28 upstream `fig-extract.js:3559` 확인:
    `const tc = await page.getTextContent();`, signal과 race시키지 않는다): 1차 패스의 `await page.getTextContent()`
    안에서 문서가 destroy되면(#35) 그 promise가 **영원히 settle되지 않는다** — pdf.js worker의
    `GetTextContent` 핸들러가 `task.terminated`면 sink를 error 처리하지 않고 빠지고,
    `PDFPageProxy._destroy()`는 operator-list 스트림만 취소해 텍스트 스트림은 추적하지 않는다.
    결과적으로 그 스캔의 async frame이 pinned돼 페이지 텍스트 메타데이터가 영구 상주한다(크롭
    캔버스는 아니다 — 2차 패스의 `getOperatorList`는 정상 거절한다). 문서 교체마다 반복되므로
    **단조 증가**다. 근본 해결은 엔진이 `getTextContent`를 abort signal과 race시키는 것이고,
    Margin 쪽에서는 막을 수 없다.
- ~~이전 `PDFDocumentProxy`를 `destroy()`하지 않는다~~ → **해소 (#35)**. `PdfHost.#setDocument`가
  **뷰어·linkService를 새 문서로 전환한 뒤** 이전 문서를 `destroy()`한다(순서 반대면 뷰어가 방금
  파괴된 문서를 렌더하려 한다). 정리 실패는 `console.warn`으로 삼켜 새 문서 로드를 막지 않는다.
  - **로드 실패 시에는 이전 문서가 잠시 남는다**: `#setDocument`에 도달하지 못하므로 정리가 다음
    성공 로드로 밀린다. `#doc`은 성공에서만 전진하므로 **누적되지 않고 최대 1개**다.
    실패 시점에 정리하지 않는 이유는 "화면에 떠 있어서"가 아니다(`setLoading`이 이미 뷰어를
    감췄다) — **`viewer.setDocument(null)`을 부르지 않았으므로 `PDFViewer`·`PDFLinkService`가
    여전히 그 문서를 가리키고 page view도 마운트된 채 재렌더 가능**하기 때문이다. 창 크기 변경 →
    `refreshFitWidthIfNeeded` → `viewer.update()` → `PDFPageView.draw()` 경로가 파괴된 페이지를
    렌더하려 하며 터진다.
  - **실패한 로드 자신의 `PDFDocumentLoadingTask`·전용 워커는 별도로 정리한다**: pdf.js는 실패 시
    promise만 reject하고 task를 회수하지 않아, 파일 없음·권한 거부가 반복되면 **워커 스레드가
    단조 증가**한다. `#awaitLoad`가 실패 경로에서 `loadingTask.destroy()`를 부른다.
  - ⚠ **`GlobalWorkerOptions.workerPort`를 설정하면 이 정리가 위험해진다**: pdf.js가
    `PDFWorker.fromPort`로 모든 문서가 공유하는 싱글턴 워커를 넘기므로, 한 문서를 destroy하면
    나머지 문서의 워커까지 종료된다. 문서당 워커 1개가 전제다.

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
  → Margin 측 배선 완료(#34): `FiguresTab.setDocument()`가 이전 스캔을 abort하고 `#scan`이 `signal`을
  전달한다. **취소는 정상 흐름이므로 소비자는 `AbortError`를 에러 UI로 취급하지 말 것** — 문서를
  바꿀 때마다 실패 메시지가 번쩍인다.
- **크롭 이미지 수명/메모리** (#12 → 엔진 백로그 B7, **v2.19.1에서 재설계 · `[BREAKING]`**):
  크롭은 이제 스캔 중 **PNG로 즉시 직렬화**되고 캔버스는 그 자리에서 반환된다. `figure.cropCanvas`
  필드와 `cropCanvas()` 접근자는 **제거**됐고, 이미지는 `cropDataURL(fig)` / `cropBlob(fig)`로만 받는다
  (두 함수의 시그니처는 불변 — 단 `cropDataURL`은 `cropImages:false`로 추출한 figure에 대해 **throw**
  한다. v2.14.0에서는 throw하지 않았다). **소비자가 캔버스 수명을 관리할 필요가 없어졌다** —
  v2.5.1~v2.19.0의 "프리뷰 생성 후 참조를 버려라"는 지침은 폐기다.
  - 왜 바꿨나: 크롭 캔버스를 문서 스캔이 끝날 때까지(수십 초) 들고 있으면 Chrome이 메모리 압력을
    받을 때 백킹 스토어를 **예외 없이 회수**한다. 회수된 캔버스는 그리기가 전부 무성과로 끝나고
    읽으면 전면 투명이라, 엔진 배치 실행에서 한 논문 크롭 23장이 통째로 백지 PNG가 됐다.
    PNG 문자열은 회수 대상이 아니고, 논문당 상주도 최대 130MB → 수MB로 떨어진다.
  - 페이지 전체 캔버스도 스캔 중 동시 상주 최대 1장이고 페이지가 끝나면 즉시 반환된다.
  - 페이지 렌더 LRU·object URL revoke는 여전히 Margin 몫이다.
- **`opts.releasePages`** (v2.26.2+, `[필드 추가]` — **Margin이 켤지 판단해야 하는 유일한 항목**):
  엔진은 스캔이 끝난 페이지의 pdf.js 캐시(디코드된 이미지)를 `page.cleanup()`으로 반환한다.
  **출력은 불변**이다 — 비우는 것은 캐시뿐이고 이후 다시 필요하면 pdf.js가 재파싱한다.
  - 왜 필요했나: 엔진이 `page.cleanup()`을 한 번도 부르지 않아 **문서를 다 훑을 때까지 전 페이지의
    디코드 결과가 함께 상주**했다(40MB PDF 한 편이 렌더러 2.4GB, 130MB가 3.9GB). 게다가 pdf.js는
    operator list와 display에 **다른 캐시 키**를 쓰므로 캡션 페이지마다 같은 이미지가 두 번 디코드돼
    **두 벌이 동시에** 남아 있었다. 렌더 직전에 한 벌을 놓아주는 것이 절감의 큰 몫이다.
  - **기본값은 Margin에서 꺼져 있다.** `pdfDocument`로 넘긴 문서는 사용자가 지금 보고 있는 뷰어의
    살아 있는 문서라, 엔진이 그 캐시를 비우면 뷰어의 다음 렌더가 재파싱을 물고, 뷰어가 그 페이지를
    렌더하는 중이면 pdf.js가 지연 정리를 걸어 5초 뒤에 지운다. 그래서 **호스트가 명시적으로 켜야만**
    적용된다(엔진이 직접 연 문서는 이 값과 무관하게 항상 해제 — 배치 러너·frontend가 그 경우다).
  - **켜는 것을 권하는 조건**: 위 `FigRenderError`를 자주 만나는 환경. 엔진 repo 실측(330편 배치,
    `--jobs 2`)에서 렌더러 private 피크 5,407 → 4,707MB, `FigRenderError` 7건 → 1건이었다.
    대가는 스캔 후 사용자가 그 페이지를 다시 볼 때 한 번 더 파싱하는 것뿐이다.
  - 이번 벤더링에서는 **선언만 추가하고 호출부는 두지 않았다** — 켜는 판단은 Margin의 UX 트레이드오프
    (스캔 후 첫 렌더 지연 vs 메모리)라 별도 `feat:` 변경으로 분리한다.
- **`FigRenderError`** (v2.19.1+): **엔진이 직접 렌더한** 페이지 캔버스의 불투명 픽셀이 절반 미만이거나
  크롭 캔버스가 투명하면 `extract()`가 `name === 'FigRenderError'`인 오류로 reject한다 — 렌더 결과가
  존재하지 않는다는 뜻이다(위 메모리 압력 상황). pdf.js가 페이지를 불투명 흰색으로 채우고 시작하므로
  정상 렌더의 기대 투명 비율은 0이다. **`renderPage`로 캔버스를 주입하면 이 불변식이 없어 검사가
  적용되지 않는다** — Margin이 렌더 캐시를 주입하기 시작하면 이 보호도 함께 사라진다는 뜻이다.
  조용히 빈 그림을 내놓는 대신 실패시킨다는 판단이며, **일시적 조건이라 재시도가 유효하다**.
  - ⚠ **벤더링 후 사용자에게 보이는 변화는 "문구가 친절해진다"가 아니다.** 이 오류는 페이지 루프
    **안에서** 던져져 `extract()` 전체를 reject시킨다 — **부분 결과가 없다.** 앞 20페이지에서
    figure를 정상적으로 다 잡았어도 21페이지에서 캔버스가 회수되면 목록은 **0건**이고 에러 카드만
    남는다. v2.14.0에서는 같은 상황에서 목록은 전부 나오고 해당 카드만 백지였다. 즉 실패 모드가
    **"일부 백지" → "전부 없음"으로 옮겨간다.** 조용한 오염보다 낫다는 판단이지만, 사용자가 보는
    최악의 순간은 더 나빠진다.
  - 재시도는 **백오프 없이 즉시 전량 재스캔**이다(`ensureScanned` → `#scan` → `extract`). 메모리
    압력이 아직 가시지 않았으면 같은 지점에서 다시 죽으면서 스캔 비용만 한 번 더 든다. 그래서
    문구가 "다른 탭을 닫고"를 먼저 말한다 — 사용자가 조건을 바꾸도록 유도하는 것이 유일한 완화다.
  - `tab-figures.ts`가 `error.name === 'FigRenderError'`를 분기해 "메모리가 부족했을 수 있어요. 다른
    탭을 닫고 다시 시도해 주세요." 문구를 띄운다(그 외 실패는 일반 문구). 판별식은 엔진과 똑같이
    `name`만 본다 — `instanceof Error`를 덧붙이면 소비자가 공급자보다 좁아진다.
  - `#scan()`이 `signal`을 넘겨 문서 교체 시 이전 스캔을 실제로 중단시키므로(#34) 호스트가 스스로
    이 오류의 발생 확률을 올리던 문제는 해소됐다.
- **cross-page 캡션** (v2.19.0 12-B): 캡션이 다음 장 상단이고 그림이 앞 페이지면 엔진이
  `figure.captionPage`를 함께 방출한다(같은 페이지면 필드 자체가 없다 — 실측상 항상 `page + 1`).
  **`figure.page`는 그림 페이지이고 식별 키는 여전히 `(num, page)`다.** 페이지 점프·`region`은
  `page`, **캡션 텍스트 검색과 `captionBoxPt` 좌표 변환은 `captionPage`** 기준이다
  (`toPdfRect(captionBoxPt, …)`에 그림 페이지 높이를 넣으면 조용히 틀린다).
  `toFigureEntries()`가 `captionPage ?? page`로 정규화해 `FigureSeed.captionPage: number`로 넘기므로
  소비자는 optional을 다룰 필요가 없다 — 그 값이 `FigureEntry.captionAnchor.page`가 된다.
  - **방향은 구조적으로 한쪽뿐이다**: 12-B는 캡션 페이지 앵커에 대해 `candidatePage = 캡션 페이지 − 1`
    후보만 만들므로 `captionPage === page + 1`이 항상 성립한다. 관측된 경향이 아니라 후보 생성 규칙의
    귀결이다 — `Math.abs()`나 앞/뒤 양방향 탐색 같은 일반화를 넣지 말 것.
  - ⚠ **`captionPage`는 seed 전용이다. 영속 스키마(`FigureEntry`)에 넣지 말 것** —
    `captionAnchor.page`와 중복이고 `store.saveDoc`은 화이트리스트 없이 통째로 저장한다.
    TS strict도 스프레드(`{ ...seed, doc, captionAnchor }`)에는 초과 속성 검사를 하지 않으므로
    컴파일이 막아주지 않는다. **`toFigureEntry(seed, doc, captionAnchor)`를 거칠 것** — 필드를 명시
    나열해 seed 전용 필드를 떨어뜨리고, `test/fig-engine.test.ts`가 반환 키 집합을 고정한다.
- **pdf.js 버전**: 엔진은 pdfjs-dist 4.10.38(프로젝트 고정 버전) 기준으로 테스트 샘플 검증됨.
- **confidence**: 현재 1.0 고정 (플레이스홀더). 추후 감지 경로별 실측 값으로 교체 예정.
- **Table 미지원**: 엔진은 figure만 감지한다. Table region은 v1에서 수동 크롭으로 처리.
- **텍스트 레이어 없는 PDF(스캔본)**: 캡션을 찾지 못해 figures가 빈 배열 — 정상 동작.
- **캡션 앵커·다방향 한계**: "Figure N" 표기가 아예 없는 문서는 구조적 미탐지다. v2.8.0부터 캡션 위·아래·좌·우 figure 후보를 지원하지만, side caption의 세로 정렬 증거가 약하거나 기존 상향 후보가 강하면 보수적으로 미탐지/기존 영역을 유지할 수 있다. 캡션이 다음 장 상단에 있고 그림이 앞 페이지에 있는 레이아웃은 **v2.19.0 12-B에서 지원**한다(그 경우 `page`≠`captionPage` — 위 §cross-page 캡션) (엔진 repo ALGORITHM.md §알려진 한계).
- **캡션 표기 확대 (v2.9.x)**: 번호 뒤 구분자가 없는 표기(RSC·Springer `Fig. 1 본문…`, Wiley 자간 분리 `F I G U R E 1 본문…`)를 **문서 수준 게이트를 통과한 문서에서만** 앵커로 승격한다 — 한 문서가 캡션 관습을 하나만 쓴다는 전제라, hard 앵커가 이미 잡히는 문서에는 적용되지 않는다(표기가 섞인 문서는 미적용). 나란한 figure의 캡션이 8pt 미만 간격으로 한 줄에 붙은 경우도 분해해 각각 앵커한다.
- **번호 글리프에 ToUnicode 매핑이 없는 PDF는 원리상 미탐지**: 번호가 화면에는 정상으로 보이는데 텍스트 레이어에 문자가 없는 문서가 있다(Wiley 일부). 엔진이 아니라 PDF 쪽 문제라 사용자 눈에는 "번호가 멀쩡히 보이는데 안 잡힌다"로 보인다 — 문의가 오면 수동 크롭 안내가 맞다.
- **영역 경계 정밀화 (v2.10.x)**: figure/table·나란한 컬럼 경계 판정을 개선했다 — table 캡션을 **경계로만** 인식해 인접 figure 크롭에서 table을 제외(v2.10.0, table 자체 방출은 없음), 좌우로 나란한 두 figure가 서로를 통째로 크롭하던 것을 각자 캡션 컬럼으로 분리(v2.10.1 같은 baseline, v2.10.2 baseline 어긋난 offset). 출력 필드·좌표계·(num,page) 식별자 불변 — bbox가 더 타이트해질 뿐이라 소비자 코드 변경은 불요.
- **캡션 문법 확대 (v2.11.0)**: 보충·부록 캡션의 inline 표기를 새로 잡는다 — `Fig. S1.`·`Figure S1:`·`Figure A1.`(문자접두 번호), `Supplemental`/`Supporting Figure N`(접두), `FIG. 3 (color online).`·`Figure 1 (저자명).`(괄호 한정구). 전부 **점형 canonical**(`S.N`·`A.N`)으로 방출하므로 `num` 필드에 `"S.1"`·`"A.1"` 형태가 더 자주 등장한다(v2.6.0의 `ED.N`·prefix `S.N`과 동일한 표기 규약 — 새 값 형태 아님). 출력 필드·좌표계·(num,page) 식별자·manifest 스키마 불변, 소비자 코드 변경 불요. ~~주의: 한 물리 figure의 캡션에 다른 계열 라벨이 중첩된 오제출 문서(예: Extended Data 캡션 본문에 `Figure S1.`)는 같은 그림을 `ED.N`+`S.N` 두 번 방출할 수 있다~~ → **v2.16.0에서 해소**: 줄의 identity(첫 라벨)가 ED면 같은 줄의 S 라벨은 형제 앵커로 만들지 않는다(표기 관습 근거, 임계 없음). 유령 `S.N`과 그로 인한 ED 영역 축소가 함께 사라졌다.
- **전면 figure 크롭 개선 (v2.12.0)**: Nature Extended Data류 **전면(full-page) figure**가 과대 패널티에 눌려 페이지 일부만 크롭되던 것을 해소했다 — 전면 figure의 크롭 영역이 더 정확(전체)해진다. 출력 필드·좌표계·(num,page)·manifest 스키마 불변, 소비자 코드 변경 불요(bbox가 truth에 더 가까워질 뿐).
- **감지 품질 개선만 있고 소비자 코드 변경이 불요한 버전들** — 출력 필드·좌표계·`(num,page)` 식별자 전부 불변이고 bbox/검출률만 좋아진다:
  v2.13.0(수평 잉크 커버리지 판별자로 전면 figure 오발 해소) · v2.13.1(폭 바닥 가드) ·
  v2.14.0(soft 캡션 문서 게이트 강건화 — 혼합 관습 문서의 캡션 몰살 해소) ·
  v2.16.0(중첩 라벨 계열 경합 — 한 캡션 줄의 `ED.N`+`S.N` 이중 방출 억제) ·
  v2.19.2(캡션 라벨 앞 삼각 조판 글리프 허용) · v2.19.3/.4(머리글 장식 띠 오방출 거부).
  v2.17.0·v2.18.0은 진단 관측 전용으로 `[계약 무변경]`이다.
- 엔진은 백그라운드 탭에서 크롬 타이머 스로틀링의 영향을 받는다(분석이 수십 배 느려짐).
  전체 문서 스캔은 사용자가 뷰어를 보고 있는 동안 idle로 돌리는 것을 권장.

## fig extractor 작업자를 위한 갱신 절차

1. 엔진 전용 별도 repo에서 새 버전 검증 완료 후 (엔진 repo `docs/DEV.md` §버전 릴리스 절차)
2. **복사 전에 엔진 repo가 clean한지 확인** — `git -C <엔진repo> status --porcelain`이 비어 있어야 하고,
   `git -C <엔진repo> rev-parse --short=7 HEAD`로 **7자리 SHA**를 적어 둔다.
   더티한 작업 트리를 복사하면 **어느 커밋에도 존재하지 않는 엔진이 벤더링되는데 두 파일 diff는
   0건이라 아무 검사에도 안 걸린다** — 나중에 그 코드를 되짚을 방법이 없어진다.
3. `fig-extract.js`를 `src/core/`에 **그대로 복사** — v2.3.0부터 엔진 파일에 globalThis 노출이 포함되어
   byte-identical 복사면 됨. 복사 후 두 파일 diff가 0건인지 확인
4. **`fig-engine.ts`의 `VENDORED_ENGINE_VERSION`을 같은 커밋에서 새 버전으로 갱신** —
   `test/fig-engine.test.ts`의 버전 핀이 3과 4 사이 상태를 실패로 만든다. 이 실패가
   "계약 태그를 다시 읽어라"는 신호다. **핀이 지키는 것은 상수 ↔ 엔진 파일 한 쌍뿐이고,
   타입·주석이 어느 버전 기준인지는 검사하지 못한다** — 그건 아래 5가 하는 사람의 일이다.
5. 엔진 헤더 체인지로그의 계약 태그 확인 — `[필드 추가]`/`[BREAKING]`이면 `fig-engine.ts` 타입과
   이 문서의 계약 서술을 함께 갱신. (`fig-extract.d.ts`는 `export {}` 스텁이라 갱신할 것이 없다 —
   타입은 전부 `fig-engine.ts`에 있다.)
   엔진의 실제 export 목록(파일 끝 `return { … }`)도 확인할 것 — v2.19.1의 `cropCanvas` 제거처럼
   손으로 쓴 `FigExtractApi`와 갈라질 수 있다(`test/fig-engine.test.ts`가 뷰어가 부르는 세 함수의
   존재만 지킨다).
6. 이 문서 §주의사항이 새 버전과 어긋나지 않는지 확인 (예: confidence 실측화 시 해당 항목 갱신)
7. `npm run typecheck && npm test && npm run build` 확인 후 그림·표 탭에서 샘플 PDF 1개 스모크 테스트
8. 커밋 메시지에 엔진 버전과 **2에서 적어 둔 엔진 SHA**를 명시
   (예: `chore: bump fig-extract to v2.19.4` + 본문에
   `engine: onetwothr1/PDFViewer-Figure-Extract@1783140`).
   엔진 repo는 알고리즘과 무관한 커밋(truth·docs)으로도 전진하므로 **버전 문자열만으로는 어느
   커밋을 복사했는지 특정되지 않는다** — 같은 v2.19.4가 여러 SHA에 걸쳐 있다.
   **7자리로 적는다** — 추적에 필요한 것은 "어느 커밋을 복사했나"이고 이 저장소 규모에서
   7자리면 충분히 유일하다. 충돌하면 git이 더 긴 약칭을 요구하므로 그때 늘리면 된다.
