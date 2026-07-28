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

### 벤더링본 v2.14.0 vs 선언 타입 (2026-07-28 현재)

`src/core/fig-extract.js`는 **v2.14.0**이고, `fig-engine.ts` 타입은 여기에 **v2.19.1의 *제거*만
반영**한 상태다 — v2.19.1 계약 전체를 반영한 것이 **아니다**.

운영 원칙: **선언 타입은 벤더링 런타임이 실제로 제공하는 것의 부분집합으로 유지한다.**
제거는 지금 반영하고, 추가는 벤더링과 함께 반영한다.

근거는 "좁히는 게 안전해서"가 아니라 **두 방향의 실패 방식이 다르기 때문**이다.
- **좁히기는 컴파일 타임에 요란하게 실패한다** — 누군가 그 필드를 쓰고 있었다면 그 PR에서 즉시 타입
  에러가 난다. 단, 런타임이 여전히 그 필드에 의존한다면(아래 `cropCanvas`가 정확히 그렇다) 그
  사실을 **다른 곳에 남겨야 한다**. 그래서 이 절이 존재한다.
- **넓히기는 런타임에 조용히 실패한다** — 컴파일도 되고 배포도 되고 아무 일도 안 일어난다. 누구도
  알아차릴 계기가 없다. 전체 v2.19.1 계약을 미리 선언하면 벤더링 시점에 "이 필드를 이제 처리해야
  한다"고 강제하는 **컴파일 에러라는 유일한 강제 장치**까지 없어진다.

이 원칙은 **필드·옵션 같은 구조에만** 적용된다. 동작 서술(주석·문서)은 별도로, 벤더링본에서
성립하지 않으면 그 사실을 명시한다. 버전 스큐 자체는 `fig-engine.ts`의 `VENDORED_ENGINE_VERSION`
상수와 이를 검사하는 테스트가 지킨다 — 벤더링하면 테스트가 깨지고, 그게 이 목록으로 돌아오라는 신호다.

그래서 v2.15.0~v2.19.1이 **추가한** 것들(`captionPage`, `onDiagnostic`, `cropImages`)은 아직 타입에
없고 아래 §다음 벤더링 할 일에 있다.

**현재 실제로 돌아가는 코드(v2.14.0)의 크롭 동작** — 아래 §주의사항의 v2.19.1 서술과 다르다:

- `fig-extract.js:2333`이 figure마다 `cropCanvas`를 만들고, `:2377`의 `cropDataURL`은 **그 캔버스를
  읽는 순수 접근자**다. 즉 `cropCanvas`는 타입에서 사라졌어도 **런타임에서는 여전히 load-bearing**이다.
  → 엔진이 준 figure 객체를 **그대로** `cropDataURL`에 넘겨야 한다. 선언된 필드만으로 재구성하거나
  `structuredClone`·`JSON.parse(JSON.stringify(...))`를 거치면 타입 검사는 통과하고 런타임에서
  `Cannot read properties of undefined (reading 'toDataURL')`로 죽는다. M3의 storage 저장 작업이
  정확히 이 함정을 부른다.
- `tab-figures.ts:72`가 `result.figures`를 세션 내내 보관하고 `:110`은 스캔이 **다 끝난 뒤** 렌더에서야
  `cropDataURL`을 부른다 — v2.5.1~v2.19.0의 "프리뷰 생성 후 참조를 버려라" 지침이 여기서는 지켜지지
  않는다. 그래서 백로그 B7이 기술한 실패(Chrome이 캔버스 백킹 스토어를 회수 → 전면 투명)가
  **이 확장에서도 일어날 수 있고**, v2.14.0에는 `FigRenderError`가 없으므로 증상은 **오류도 재시도
  버튼도 없이 프리뷰 카드가 백지로 뜨는 것**이다. 벤더링 전까지는 이 상태다.

#### 다음 벤더링 할 일

1. 엔진 repo(**PDFViewer-Figure-Extract** — 로컬 체크아웃 이름은 `figure-preview-test`)의
   `fig-extract.js`(v2.19.1+) → `src/core/fig-extract.js` 복사 (PB-5, byte-identical 확인).
2. **`EngineFigure`에 `captionPage?: number` 추가 + `toFigureEntries`에서 보존** (v2.19.0 12-B).
   **미룬 이유는 부분집합 원칙이 아니라 스키마 결정이다** — 이 필드는 소비자가 *읽는* 값이고
   v2.14.0은 cross-page figure를 아예 방출하지 않으므로 지금 선언해도 `undefined`가 정직한 답이다
   (`cropImages`/`onDiagnostic`처럼 "껐는데 안 꺼지는" 거짓이 아니다). 진짜 이유는 보존하려면
   `FigureSeed`/`FigureEntry` 스키마를 넓혀야 하고 그건 M3 설계와 함께 정할 일이라는 것이다.
   방치 시 결과: 캡션이 다음 장 상단이고 그림이 앞 페이지면 엔진이 `page`(그림) ≠ `captionPage`로
   방출하는데 `toFigureEntries`가 명시적 리터럴을 만들며 이 필드를 **버려서**, M3의 captionAnchor
   계산이 그림 페이지에서 캡션을 찾다가 **오류 없이 조용히 실패**한다.
3. `ExtractOptions`에 `cropImages?: boolean`(v2.19.1 진단 전용) 추가. **벤더링 전에는 넣지 말 것** —
   v2.14.0은 이 옵션을 무시하므로 타입만 먼저 있으면 "껐는데 안 꺼지는" 오용을 부른다.
4. `ExtractOptions`에 `onDiagnostic?: (records: unknown[]) => void` 추가 (v2.15.0 `[필드 추가]`).
   v2.14.0에서는 무시돼 record가 조용히 안 온다 — 역시 벤더링과 함께.
5. `tab-figures.ts`에서 `error.name === 'FigRenderError'`를 분기해 "메모리가 부족했을 수 있어요 —
   다시 시도해 주세요" 문구를 노출 (현재는 일반 실패 문구 + 재시도 버튼).

### 벤더링과 무관한 선재 결함 (지금도 유효)

- **`tab-figures.ts`에 `AbortController` 배선이 없다.** §취소가 "호스트는 문서 교체 시 반드시 signal을
  abort해야 한다"고 요구하는데 `#scan()`은 `signal`을 넘기지 않는다. `setDocument`는 `#scanGeneration`을
  올려 **결과만 버리고 작업은 안 멈춘다**. 문서를 빠르게 갈아타면 스캔 두 개가 동시에 돌아 크롭 세트가
  두 벌 상주한다 — 백로그 B7이 기술한 메모리 압력을 호스트가 스스로 만들고 있다.
  **엔진 버전과 무관하게 지금 v2.14.0에서도 유효한 결함**이라 벤더링을 기다릴 이유가 없다.

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
- **`FigRenderError`** (v2.19.1+): **엔진이 직접 렌더한** 페이지 캔버스의 불투명 픽셀이 절반 미만이거나
  크롭 캔버스가 투명하면 `extract()`가 `name === 'FigRenderError'`인 오류로 reject한다 — 렌더 결과가
  존재하지 않는다는 뜻이다(위 메모리 압력 상황). pdf.js가 페이지를 불투명 흰색으로 채우고 시작하므로
  정상 렌더의 기대 투명 비율은 0이다. **`renderPage`로 캔버스를 주입하면 이 불변식이 없어 검사가
  적용되지 않는다** — Margin이 렌더 캐시를 주입하기 시작하면 이 보호도 함께 사라진다는 뜻이다.
  조용히 빈 그림을 내놓는 대신 실패시킨다는 판단이며, **일시적 조건이라 재시도가 유효하다**.
  `tab-figures.ts`의 기존 try/catch → 에러 상태 → "다시 시도" 경로가 **오류를 처리하기에는** 충분하다
  (상태 기계 추적 결과 스캔이 멈춰 있는 경로 없음). 다만 두 가지가 남는다: ① 메시지가 일반 문구라
  "메모리가 부족했을 수 있으니 다시 시도해 보세요"를 알리려면 `error.name` 분기가 필요하고,
  ② `#scan()`이 `signal`을 넘기지 않아 문서 교체 시 이전 스캔이 계속 돌면서 **이 오류의 발생 확률을
  호스트가 스스로 올리고 있다**. ①은 위 §다음 벤더링 할 일, ②는 위 §벤더링과 무관한 선재 결함에 있다.
- **pdf.js 버전**: 엔진은 pdfjs-dist 4.10.38(프로젝트 고정 버전) 기준으로 테스트 샘플 검증됨.
- **confidence**: 현재 1.0 고정 (플레이스홀더). 추후 감지 경로별 실측 값으로 교체 예정.
- **Table 미지원**: 엔진은 figure만 감지한다. Table region은 v1에서 수동 크롭으로 처리.
- **텍스트 레이어 없는 PDF(스캔본)**: 캡션을 찾지 못해 figures가 빈 배열 — 정상 동작.
- **캡션 앵커·다방향 한계**: "Figure N" 표기가 아예 없는 문서는 구조적 미탐지다. v2.8.0부터 캡션 위·아래·좌·우 figure 후보를 지원하지만, side caption의 세로 정렬 증거가 약하거나 기존 상향 후보가 강하면 보수적으로 미탐지/기존 영역을 유지할 수 있다. 캡션이 다음 장 상단에 있고 그림이 앞 페이지에 있는 레이아웃은 **v2.19.0 12-B에서 지원**한다(그 경우 `page`≠`captionPage`) — 벤더링본 v2.14.0에는 아직 없다 (엔진 repo ALGORITHM.md §알려진 한계).
- **캡션 표기 확대 (v2.9.x)**: 번호 뒤 구분자가 없는 표기(RSC·Springer `Fig. 1 본문…`, Wiley 자간 분리 `F I G U R E 1 본문…`)를 **문서 수준 게이트를 통과한 문서에서만** 앵커로 승격한다 — 한 문서가 캡션 관습을 하나만 쓴다는 전제라, hard 앵커가 이미 잡히는 문서에는 적용되지 않는다(표기가 섞인 문서는 미적용). 나란한 figure의 캡션이 8pt 미만 간격으로 한 줄에 붙은 경우도 분해해 각각 앵커한다.
- **번호 글리프에 ToUnicode 매핑이 없는 PDF는 원리상 미탐지**: 번호가 화면에는 정상으로 보이는데 텍스트 레이어에 문자가 없는 문서가 있다(Wiley 일부). 엔진이 아니라 PDF 쪽 문제라 사용자 눈에는 "번호가 멀쩡히 보이는데 안 잡힌다"로 보인다 — 문의가 오면 수동 크롭 안내가 맞다.
- **영역 경계 정밀화 (v2.10.x)**: figure/table·나란한 컬럼 경계 판정을 개선했다 — table 캡션을 **경계로만** 인식해 인접 figure 크롭에서 table을 제외(v2.10.0, table 자체 방출은 없음), 좌우로 나란한 두 figure가 서로를 통째로 크롭하던 것을 각자 캡션 컬럼으로 분리(v2.10.1 같은 baseline, v2.10.2 baseline 어긋난 offset). 출력 필드·좌표계·(num,page) 식별자 불변 — bbox가 더 타이트해질 뿐이라 소비자 코드 변경은 불요.
- **캡션 문법 확대 (v2.11.0)**: 보충·부록 캡션의 inline 표기를 새로 잡는다 — `Fig. S1.`·`Figure S1:`·`Figure A1.`(문자접두 번호), `Supplemental`/`Supporting Figure N`(접두), `FIG. 3 (color online).`·`Figure 1 (저자명).`(괄호 한정구). 전부 **점형 canonical**(`S.N`·`A.N`)으로 방출하므로 `num` 필드에 `"S.1"`·`"A.1"` 형태가 더 자주 등장한다(v2.6.0의 `ED.N`·prefix `S.N`과 동일한 표기 규약 — 새 값 형태 아님). 출력 필드·좌표계·(num,page) 식별자·manifest 스키마 불변, 소비자 코드 변경 불요. 주의: 한 물리 figure의 캡션에 다른 계열 라벨이 중첩된 오제출 문서(예: Extended Data 캡션 본문에 `Figure S1.`)는 같은 그림을 `ED.N`+`S.N` 두 번 방출할 수 있다(candidate suppression 미구현 — 엔진 repo 백로그, n=1 코너).
- **전면 figure 크롭 개선 (v2.12.0)**: Nature Extended Data류 **전면(full-page) figure**가 과대 패널티에 눌려 페이지 일부만 크롭되던 것을 해소했다 — 전면 figure의 크롭 영역이 더 정확(전체)해진다. 출력 필드·좌표계·(num,page)·manifest 스키마 불변, 소비자 코드 변경 불요(bbox가 truth에 더 가까워질 뿐).
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
