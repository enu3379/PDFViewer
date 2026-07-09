# Margin — 크롬 확장 구현 계획서 (v1)

> 이 문서는 코딩 에이전트(Codex / Claude Code)에게 그대로 전달하는 실행 스펙이다.
> 함께 제공되는 `margin-demo.html`(정적/인터랙티브 데모)이 **UI 레이아웃·CSS 토큰·상호작용 규칙의 원본**이며, 이 문서와 충돌하면 이 문서가 우선한다.
> 원칙: YAGNI. 아래 "비목표" 절에 있는 것은 구현하지 않는다. 라이브러리는 명시된 것만 쓴다.

## 에이전트 작업 지침

1. 마일스톤 M0→M6 순서로 구현한다. 각 마일스톤의 수용 기준을 모두 통과한 뒤 다음으로 넘어간다.
2. 마일스톤마다 `npm run build` 후 `chrome://extensions` → "압축해제된 확장 프로그램 로드"로 수동 확인한다.
3. `margin-demo.html`의 CSS 변수·색·간격·문구를 이식한다(재발명 금지). 데모의 JS는 참고용이며, 본 구현은 아래 모듈 구조를 따른다.
4. 순수 로직(앵커링, 감지, 파싱)은 vitest 유닛 테스트를 작성한다. UI는 수동 QA 시나리오(§14)로 검증한다.
5. 커밋은 마일스톤 단위 이상으로 쪼갠다. 커밋 메시지에 마일스톤 번호를 붙인다.

---

## 0. 제품 정의와 UX 계약

**한 줄 정의**: 크롬에서 논문 PDF를 열면 자체 경량 뷰어로 대체 렌더링되고, 우측 패널 하나에서 그림·표 프리뷰 / 하이라이트·메모 / 목차를 처리하며, 메모는 PDF와 분리 저장되어 허브 페이지에서 관리·역참조되는 확장 프로그램.

### 설계 헌법 (3원칙)

- **단일 표면**: 프리뷰·메모 작성·확인·크롭 확정까지 모든 상호작용 결과는 우측 패널 안에서 일어난다. 본문 위 플로팅 팝업/툴팁/미니툴바 금지.
- **클릭·드래그만 반응**: 호버는 커서 모양 변경까지만. 링크에 마우스를 올려도 아무 UI도 뜨지 않는다.
- **본문 최소 개입**: 렌더된 PDF 위에 얹는 레이어는 (a) 참조 링크, (b) 하이라이트, (c) 여백 점, (d) 크롭 모드 오버레이(모드 중에만) — 이것이 전부다.

### 상호작용 규칙 R1–R12 (데모에서 검증 완료 — 그대로 구현)

- R1. 본문의 `Figure N` / `Table N` 참조를 클릭하면 패널이 열리고 그림·표 탭에 해당 프리뷰가 뜬다. 클릭 전 스타일은 파란색 + 점선 밑줄, 활성(현재 표시 중) 참조는 연한 파란 배경.
- R2. 드래그로 텍스트를 선택해 놓으면 **항상** 하이라이트가 즉시 저장된다. 패널이 열려 있으면 메모 탭이 작성 모드로 전환되고 선택 문장이 자동 인용된다. 패널이 닫혀 있으면 아무것도 뜨지 않고 여백에 빈 점만 남는다(조용한 저장).
- R3. 여백 점 또는 하이라이트를 클릭하면: 메모가 있으면 메모 탭에서 해당 카드로 포커스(링 표시), 없으면 그 하이라이트에 대한 작성 모드가 열린다. 빈 점 = 메모 없음, 채워진 점 = 메모 있음. 점 색 = 형광펜 색.
- R4. 메모 삭제는 연결된 하이라이트도 함께 지운다(주석은 하나의 단위). 메모 없는 하이라이트는 작성 모드의 "하이라이트 삭제"로 지운다.
- R5. 핀 ON(기본)이면 패널이 유지된다. 핀 OFF면 패널에서 시작한 점프(원문 위치로 / 언급 클릭 / 메모 카드 클릭) 직후 패널이 자동으로 닫힌다. 패널이 닫히면 우측 가장자리 26px 스트립(‹)으로 다시 연다.
- R6. **[신규] 그림 아래 캡션의 라벨 토큰("Figure 1:")을 클릭해도 R1과 동일하게 동작한다.**
- R7. 그림·표 탭의 "본문 언급 N" 목록에는 캡션 자체는 포함하지 않는다(정의부는 언급이 아님). 각 항목은 스니펫 + 페이지 번호, 클릭 시 해당 문단으로 스크롤 + 플래시.
- R8. **[신규] 수동 크롭**: 그림·표 탭의 "영역 지정" 버튼으로 진입. 드래그한 사각형의 미리보기와 저장/취소 버튼은 **패널 안에** 나타난다. 커서 근처에 확인 UI를 띄우지 않는다.
- R9. Esc는 항상 현재 모드(크롭 모드, 작성 모드)를 취소한다.
- R10. 점프(패널→본문, 허브→뷰어)는 대상 요소를 스크롤 후 1.4초 플래시로 표시한다.
- R11. 메모 텍스트의 `[[이름]]`은 노트 링크, `#태그`는 태그로 파싱·렌더된다. 허브에서 `[[이름]]`별 스텁과 역참조 목록을 보여준다.
- R12. 허브는 별도 확장 페이지(hub.html)다. 뷰어 툴바의 허브 버튼과 확장 아이콘 컨텍스트 메뉴에서 연다. 허브의 "PDF에서 이 위치 열기"는 뷰어를 열고 해당 주석으로 딥링크 점프한다.

---

## 1. 아키텍처 개요

크롬 내장 PDF 뷰어(PDFium)는 확장이 내부를 수정할 수 없다. 따라서 Hypothesis·Weava와 같은 방식으로 **PDF 내비게이션을 가로채 확장 자체 뷰어 페이지로 대체**한다. PDF.js로 직접 렌더링하므로 텍스트 레이어·좌표·주석을 완전히 통제할 수 있다.

```text
[탐색: https://…/x.pdf, arxiv.org/pdf/…, file://…/x.pdf]
        │  (service worker: declarativeNetRequest 동적 리다이렉트)
        ▼
viewer.html?file=<원본 URL>          hub.html (별도 탭)
 ├─ pdf-host: PDF.js PDFViewer        ├─ 문서별 메모 목록/검색/태그
 ├─ overlay: refs / highlights / dots ├─ [[스텁]] 역참조
 ├─ panel: 목차 / 그림·표 / 메모       └─ 딥링크 → viewer.html?file=…&anno=…
 └─ crop-mode (일시적)
        │
   chrome.storage.local  ←→  core/store.ts (양쪽 페이지가 공유)
```

**콘텐츠 스크립트는 없다.** 모든 코드는 확장 자체 페이지(viewer/hub)와 서비스 워커에서만 실행된다. 웹페이지 DOM을 건드리지 않으므로 가볍고 심사도 단순하다.

### PDF가 열리는 4가지 경로

1. **자동 리다이렉트(주 경로)**: 서비스 워커가 설치 시 DNR 동적 규칙 3개를 등록한다 — (a) `^https://arxiv\.org/pdf/…` 형태의 arXiv PDF URL, (b) `\.pdf`로 끝나는 http(s) URL, (c) `^file://.*\.pdf$` 로컬 PDF URL. 규칙 (c)는 Chrome 확장 세부정보의 "파일 URL에 대한 액세스 허용"이 켜져 있을 때 커밋 전에 동작하며 Windows UNC(`file://server/share/x.pdf`)도 포함한다. 이 자동 동작은 사용자가 토글로 끌 수 있다(§9 자동 열기 토글) — 끄면 PDF가 크롬 내장 뷰어로 열리고 경로 2만 사용된다.
2. **툴바 버튼(폴백)**: 임의 URL(확장자 없는 PDF 등)에서 확장 아이콘 클릭 → 확장자가 명확하거나 GET+헤더 판별로 PDF임이 확인되면 현재 탭을 `viewer.html?file=<url>`로 전환한다. 확정 비PDF는 제자리 토스트, 판별 실패는 낙관적으로 뷰어 전환한다.
3. **뷰어 내 열기**: viewer.html을 file 파라미터 없이 열면 빈 상태 화면(파일 선택 버튼 + 드래그&드롭). `file:` PDF는 "파일 URL 접근 허용" 안내를 함께 표시.
4. **허브 딥링크**: `viewer.html?file=<url>&anno=<id>` 또는 `&fig=<id>` — 로드 완료 후 해당 주석/그림으로 스크롤 + 플래시. 문서가 URL 없이 저장된 경우(로컬 파일) 허브는 "파일 다시 선택" 흐름으로 유도하고 fingerprint 일치를 검증한다.

`?file=` 파싱: `location.search`에서 `file=` 이후 전체 문자열을 취해 `decodeURIComponent`(실패 시 원문 사용). 허용 스킴은 `http:` `https:` `file:` `blob:`만. 그 외는 빈 상태 화면으로.

---

## 2. 기술 스택 — 결정과 근거 (변경 금지)

| 항목 | 결정 | 근거 / 기각한 대안 |
| --- | --- | --- |
| PDF 렌더링 | `pdfjs-dist` 최신 4.x 안정판을 **exact 버전으로 고정** | 텍스트 추출 결과가 버전에 따라 달라 앵커가 흔들린다. 고정 버전을 `DocMeta.pdfjsVersion`에 기록. |
| 뷰어 구성 | `pdfjs-dist/web/pdf_viewer.mjs`의 `PDFViewer` + `EventBus` + `PDFLinkService`(서브클래스) + 동봉 CSS | 가상화(페이지 버퍼링)·줌·텍스트 레이어를 공짜로 얻는다. 공식 viewer.html 전체 포크는 걷어낼 UI가 너무 많아 기각. react-pdf 등 래퍼 기각(불필요한 층). |
| 워커 | `pdf.worker.mjs`를 번들에 동봉, `GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(...)` | MV3는 원격 코드 금지. |
| UI | **Vanilla TypeScript, 프레임워크 없음** | 데모가 바닐라로 충분함을 증명. 오버레이 레이어는 어차피 저수준 DOM. 패널/허브도 innerHTML 렌더 + 이벤트 위임(데모 패턴 유지). |
| 빌드 | Vite 멀티 엔트리(viewer.html, hub.html, sw.ts) + `public/manifest.json` 정적 복사 | crxjs 등 확장 전용 플러그인은 유지보수 리스크로 기각. HMR 없이 `vite build --watch`로 충분. |
| 저장 | `chrome.storage.local` (기본 ~10MB) | 이미지(크롭 결과)를 저장하지 않고 좌표만 저장 → 용량 문제 없음. IndexedDB 기각(YAGNI). `unlimitedStorage` 불요. |
| 테스트 | vitest (core/ 순수 모듈만) | Playwright E2E는 phase 2. |
| 기타 라이브러리 | **없음** | 퍼지 매칭·검색·CSS 프레임워크 전부 불요. |

---

## 3. 데이터 모델과 좌표 규약

### 좌표 규약 (전 모듈 공통)

- **저장은 항상 PDF user space** (원점 좌하단, y 위로 증가, 단위 pt). 화면 표시 시점에만 해당 페이지의 `PageViewport`로 변환한다.
- 변환 유틸: CSS px(페이지 요소 기준 좌표) ↔ PDF는 `viewport.convertToPdfPoint(x, y)`와 `viewport.convertToViewportRectangle([x1,y1,x2,y2])`를 사용한다. 텍스트 레이어와 캔버스는 뷰포트 CSS 크기와 일치하므로 페이지 요소 상대 좌표 = 뷰포트 좌표다.
- 사각형 표기: `PdfRect = [x1, y1, x2, y2]` (PDF space, x1<x2, y1<y2). 저장 전 정규화한다.

### 문서 식별

- `docId = pdfDocument.fingerprints[0]` (내용 기반, URL 변경·미러에도 안정). 충돌 대비로 표시용 메타에 `pageCount`를 함께 저장하되 키는 fingerprint 단독.

### TypeScript 인터페이스 (`core/types.ts`)

```ts
export type DocId = string;               // pdf fingerprint
export type PdfRect = [number, number, number, number];
export type PenColor = 'amber' | 'teal' | 'pink' | 'blue';

export interface DocMeta {
  id: DocId;
  title: string;                          // pdf metadata Title 또는 1p 최대 폰트 라인, 없으면 파일명
  url?: string;                           // 원본 URL (로컬 파일이면 없음)
  pageCount: number;
  pdfjsVersion: string;
  addedAt: number;
  lastOpenedAt: number;
}

export interface Anchor {
  page: number;                           // 1-based
  start: number;                          // 페이지 텍스트 S_p 기준 오프셋 (§4)
  end: number;
  quote: string;                          // S_p.slice(start, end) 원문 그대로
  prefix: string;                         // 앞 32자 (재앵커용)
  suffix: string;                         // 뒤 32자
  quads: PdfRect[];                       // 라인별 사각형, PDF space
}

export interface Highlight {
  id: string;                             // 'h' + nanoid 스타일 랜덤 (Date.now()+rand 조합, 라이브러리 불요)
  doc: DocId;
  color: PenColor;
  anchor: Anchor;
  memoId?: string;
  createdAt: number;
}

export interface Memo {
  id: string;
  doc: DocId;
  anchorType: 'highlight' | 'figure';
  anchorId: string;                       // Highlight.id 또는 FigureEntry.id
  quote: string;                          // 하이라이트 인용문 또는 "Figure 2 — 캡션…"
  page: number;
  text: string;
  tags: string[];                         // text에서 파싱 (#태그)
  links: string[];                        // text에서 파싱 ([[이름]])
  createdAt: number;
  updatedAt: number;
}

export interface FigureEntry {
  id: string;                             // 'fig' | 'tab' + 번호 + '-' + page (문서 내 유일)
  doc: DocId;
  kind: 'figure' | 'table';
  num: string;                            // "1", "2a" …
  label: string;                          // "Figure 1"
  page: number;
  captionText: string;                    // 캡션 전체(여러 줄 병합, 공백 정규화)
  captionAnchor: { page: number; start: number; end: number };
  region: { page: number; rect: PdfRect } | null;   // null = 감지 실패
  regionSource: 'auto' | 'manual';
  confidence: number;                     // manual=1, auto=0~1, 낮으면 UI에 "영역 확인 필요"
}
```

### chrome.storage.local 레이아웃

```text
margin:schemaVersion            = 1
margin:settings                 = { autoIntercept: boolean }   // 기본 true, §9 자동 열기 토글
margin:docs                     = Record<DocId, DocMeta>
margin:doc:<id>:highlights      = Highlight[]
margin:doc:<id>:memos           = Memo[]
margin:doc:<id>:figures         = FigureEntry[]     // manual 영역/사용자 수정 포함
```

- `core/store.ts`: get/set 래퍼 + 문서 단위 로드/세이브(디바운스 500ms) + `schemaVersion` 체크(불일치 시 마이그레이션 함수 자리만 마련, v1은 1 고정).
- 스텁/역참조는 저장하지 않는다 — 항상 memos의 `links`에서 파생 계산(데모와 동일).
- 언급(mentions)·자동 감지 결과 중 region이 auto인 것은 **캐시로만** 취급: 저장하되 pdfjsVersion이 바뀌면 재계산한다. manual region은 항상 보존.

---

## 4. 하이라이트 앵커링 스펙 (`core/anchor.ts`, `core/text-index.ts`)

### 페이지 텍스트 인덱스

- 페이지 p의 기준 문자열: **`S_p` = 렌더된 텍스트 레이어의 span들을 DOM 순서로 `textContent` 이어붙인 것**(구분자 없음, 정규화 없음). pdf.js의 span 순서는 `getTextContent()` item 순서와 동일하므로 같은 pdfjs 버전에서는 결정적이다.
- `text-index.ts`는 `textlayerrendered` 시점에 페이지별로 `{ S_p, spans: {el, startOffset}[] }`를 만들어 메모리에 캐시한다(문서당 Map, 뷰어 세션 한정).
- 감지(§5)처럼 아직 렌더되지 않은 페이지의 텍스트가 필요할 때는 `page.getTextContent()`의 `items.map(i => i.str).join('')`을 사용한다 — 텍스트 레이어 span 텍스트와 동일한 문자열이 되도록, **줄바꿈·공백을 추가로 삽입하지 않는다**(동일성 유지가 핵심).

### 선택 → Anchor 생성

```text
onMouseUp:
  sel = getSelection(); 유효성: 비어있지 않고, range가 뷰어 페이지 컨테이너 내부
  대상 페이지 = range.startContainer가 속한 pageDiv (여러 페이지에 걸치면 시작 페이지로 클램프하고
                끝을 그 페이지 마지막 span 끝으로 자름 — v1 제한, §12)
  start/end = spans 인덱스 테이블로 컨테이너 텍스트노드 → S_p 오프셋 환산
  quote = S_p.slice(start,end); prefix/suffix = 각 32자
  quads: range.getClientRects() → 같은 줄 rect 병합(수직 겹침 60% 이상이면 병합)
         → 페이지 요소 상대 좌표 → convertToPdfPoint 두 모서리 → PdfRect[]
  quote를 공백 정규화했을 때 2자 미만이면 취소
```

### 로드 시 재앵커

1. `DocMeta.pdfjsVersion`이 현재와 같고 `S_p.slice(start,end) === quote`면 그대로 사용(quads 저장분 사용, 재계산 없음).
2. 불일치 시: `S_p`에서 `quote` 전체 문자열 검색. 다중 매치면 prefix 일치 길이가 가장 긴 후보 채택. 성공 시 오프셋 갱신 + quads 재계산(해당 페이지 텍스트 레이어에서 Range 재구성). 실패 시 하이라이트를 "위치 유실" 상태로 표시(메모 탭 카드에 배지, 본문 렌더 생략) — 삭제는 사용자 몫.
3. 퍼지 매칭(레벤슈타인 등)은 구현하지 않는다(YAGNI, phase 2).

### 렌더링

- 페이지마다 `div.mgn-hl-layer`(absolute, inset 0, pointer-events none)를 pageDiv에 추가. `pagerendered` 이벤트에서 해당 페이지 하이라이트의 quads를 `convertToViewportRectangle`로 투영해 rect div(포인터 이벤트 auto, cursor pointer, `data-hid`)를 그린다. 줌 변경 시 pdf.js가 페이지를 다시 렌더하므로 같은 훅으로 자동 갱신된다.
- 여백 점: pageDiv 우측 `right:14px`, top = 첫 quad의 뷰포트 y. 빈/채움·색·클릭 동작은 R3.
- 색상 토큰(데모와 동일): mark — amber `#FAD57E` teal `#B7E8D4` pink `#F6CBD9` blue `#C3DCF6`, dot — `#BA7517` `#0F6E56` `#993556` `#185FA5`.
- 데모와 달리 텍스트 노드를 `<mark>`로 감싸지 않고 **오버레이 rect 방식**을 쓴다(텍스트 레이어를 오염시키지 않아 재렌더·앵커가 단순해짐). 클릭 판정은 rect가 담당한다.

---

## 5. 참조 링크·캡션·그림 영역 감지

### 5.1–5.3 캡션·영역 감지 → 외부 엔진(fig-extract)으로 대체 [개정]

> 원래 이 절에 있던 자체 감지 휴리스틱(라인 그룹핑·캡션 정규식·여백 밴드법)및 detect.ts 모듈은 구현하지 않는다.
> figure 캡션·영역 감지는 별도 저장소(figure-preview-test)에서 개발·검증되는
> **fig-extract 엔진**(`core/fig-extract.js`, vendored)이 담당한다. 

- 사용: `core/fig-engine.ts`의 `FigExtract.extract()` → `toFigureEntries()`로 `FigureEntry` 생성.
  좌표 변환(`toPdfRect`, 엔진의 좌상단 원점 pt → PDF user space) 포함.
- 시작 시점: Margin 뷰어가 `PDFDocumentProxy`를 확보하는 즉시 엔진 스캔을 시작한다. 그림·표 탭 오픈은
  결과 표시 또는 진행 상태 확인만 담당한다.
- **문서 내 figure 목록(존재·번호·region·captionText)의 단일 진실 공급원은 엔진이다.**
- `captionAnchor`는 엔진이 반환한 `captionText`를 해당 페이지 `S_p`에서 검색해 Margin 측이 채운다.
- 엔진 미감지(figures에 없음) 또는 region 이상 시의 안전망은 §6 수동 크롭 그대로.
- `confidence`는 현재 엔진이 1.0 고정으로 반환(placeholder). 실측 매핑 도입 전까지
  "영역 확인 필요" 배지는 수동 크롭 유도 용도로만 사용.
- 상세 규약(갱신 절차, 좌표계, 제한사항): `docs/fig-extract-integration.md`
- 제한: 엔진은 Table 미지원(v1은 수동 크롭으로 처리), 스캔 PDF(텍스트 레이어 없음)는 figures 빈 배열.

### 5.4 참조(멘션) 감지와 링크화 (`core/mentions.ts`)

- ref 정규식: `/\b(Fig(?:ure)?s?|Tab(?:le)?s?)\.?\s*(\d+[a-zA-Z]?)/g` — 각 매치를 `(kind, num)`으로 정규화해 FigureEntry에 매핑. 매핑 안 되는 번호는 무시. "Figures 2 and 3"은 첫 숫자만(문서화된 v1 제한).
- 캡션 자신: 매치 구간이 그 figure의 `captionAnchor` 범위 안이면 **mentions 목록에서 제외**하되, 라벨 토큰은 클릭 가능하게 링크화한다(R6, `data-cap="1"` 부여).
- 본문 멘션 전체 문서 스캔: FigureEntry가 준비된 뒤 백그라운드로 1페이지부터 순차 `getTextContent`(이미 캐시된 페이지는 재사용, 페이지당 idle 처리) → `{figId, page, start, end}[]` 완성 후 목록 갱신. 진행 중에는 "스캔 중 n/N" 표시. 결과는 세션 메모리 캐시.
- 링크 DOM 주입: `textlayerrendered`마다 해당 페이지 매치들에 대해 span 내부 텍스트 노드를 Range로 잘라 `<a class="mgn-ref" data-fig …>`로 감싼다(데모의 wrapRange와 동일 기법, span 경계에 걸치면 조각별로 감싼다). 이미 감싼 페이지는 `dataset.mgnRefs='1'`로 멱등 처리. 단일 span 내 매치만 처리(경계에 걸린 극소수는 v1 제한).
- PDF 자체 하이퍼링크(hyperref) 연동: `PDFLinkService`를 서브클래스해 `goToDestination(dest)`를 오버라이드 — dest를 페이지·좌표로 해석했을 때 어떤 FigureEntry의 region/caption에 들어가면 점프 대신 패널 프리뷰를 연다(R1과 동일 동작). 그 외 dest는 원래 동작. annotation 링크와 우리 regex 링크가 같은 텍스트에 겹치면 annotation을 우선하고 regex 주입을 생략한다.

### 5.5 프리뷰 렌더 (`core/render-region.ts`)

```text
renderRegion(pdfDoc, page, rectPdf, maxCssWidth): HTMLCanvasElement
  scale = clamp(maxCssWidth / rectWidthPt, 1, 3) × devicePixelRatio
  페이지 전체를 오프스크린 캔버스로 렌더(페이지+scale 키 LRU 캐시 3장)
  rect를 뷰포트 좌표로 변환해 drawImage로 크롭 → 반환
```

- 그림·표 탭 프리뷰, 크롭 라이브 미리보기(스로틀 150ms), 허브 썸네일(phase 2) 모두 이 유틸만 사용. 이미지 저장은 하지 않는다.

---

## 6. [신규 A] 수동 크롭 모드 (`viewer/crop-mode.ts`)

상태 머신: `idle → armed(figId) → dragging → preview → idle`

- 진입: 그림·표 탭 상세의 버튼 — region 있으면 "영역 다시 지정", 없으면 "영역 지정". 진입 시 대상 페이지로 스크롤(기존 region 또는 캡션 위치).
- armed: 각 pageDiv에 `div.mgn-crop-overlay`(absolute inset 0, crosshair, z-index 텍스트 레이어 위) 삽입, 뷰어에 `user-select:none`. 기존 region은 파란 외곽선 rect로 표시. 패널에는 안내 카드("드래그해서 영역을 지정하세요 · Esc 취소")가 뜬다.
- dragging: mousedown한 페이지로 클램프, 러버밴드 rect 표시.
- preview: mouseup 시 rect 확정 표시 유지, **패널 카드가 라이브 미리보기(renderRegion) + [저장] [다시 지정] [취소]로 전환**. 커서 근처에는 아무것도 띄우지 않는다(R8).
- 저장: rect 두 모서리 → PDF space 정규화 → `region={page,rect}, regionSource='manual', confidence=1` 저장 → 오버레이 제거, 프리뷰 갱신, 활성 참조 스타일 유지.
- 취소/Esc: 변경 없이 오버레이 제거(R9). 최소 크기 12pt 미만 드래그는 무시.
- 스코프: 기존 FigureEntry의 영역 수정만. "새 그림 수동 추가"는 phase 2(§12).

## 7. [신규 B] 캡션 라벨 클릭

- §5.4에서 캡션 라벨 토큰에 부여한 `a.mgn-ref[data-cap]`가 본문 참조와 동일한 클릭 핸들러를 탄다(R6).
- 스타일은 본문 참조와 동일(파란색+점선) — 일관성 우선. mentions 목록에는 나타나지 않는다(R7).
- 활성 그림의 캡션 라벨에도 활성 배경 스타일을 적용한다.

---

## 8. 패널 3탭 + 허브 (데모 이식 명세)

데모의 레이아웃·CSS·문구를 그대로 옮기되, 아래 차이만 반영한다.

- 공통: 탭 [목차 | 그림·표 | 메모(n)], 핀·닫기(R5), 닫힘 시 우측 26px 스트립. 패널 폭 312px(뷰포트 900px 미만이면 264px).
- 목차 탭: `pdfDocument.getOutline()` 사용. 항목 클릭 → `getDestination`/`getPageIndex`로 해석해 점프. 스크롤 스파이는 outline 항목의 대상 페이지·y를 기준으로 현재 위치 표시. **outline이 없으면 탭에 "이 PDF에는 목차가 없어요"만 표시**(헤딩 휴리스틱 생성은 phase 2).
- 그림·표 탭: 상세(라벨 + p.N 칩 + 프리뷰 캔버스 + 캡션 + [원문 위치로 이동] [메모 달기] **[영역 지정/다시 지정]** + confidence 낮으면 "영역 확인 필요" 배지) → "본문 언급 N" 목록(R7) → "이 문서의 그림·표" 전체 목록(활성 행 표시, 클릭 시 프리뷰 전환).
- 메모 탭: 데모와 동일 — 작성 카드(자동 인용/색 반영/[[·#] 힌트/닫기·저장·삭제), 형광펜 4색 선택(현재 펜 = 조용한 저장에도 적용), 검색, 카드 목록(인용 1줄 + 리치 텍스트 + p.N/링크 n/날짜 + 편집·삭제, 본문 점프). 검색은 단순 includes.
- 허브(hub.html): 상단(제목·총계·검색) + 태그 칩 + **문서별 그룹**(storage의 모든 doc, `DocMeta.title`, "PDF 열기" = url 있으면 딥링크, 없으면 파일 재선택 흐름) + 카드 펼침(연결 [[링크]], [PDF에서 이 위치 열기], 삭제) + "링크된 노트" 스텁 섹션(역참조 목록, "문서에서 보기" 딥링크). 데모 대비 추가: 다중 문서 그룹, 문서 삭제(문서의 모든 데이터 제거, confirm 1회).

---

## 9. manifest와 권한

```jsonc
{
  "manifest_version": 3,
  "name": "Margin",
  "version": "0.1.0",
  "minimum_chrome_version": "121",
  "action": { "default_title": "Margin으로 열기" },
  "background": { "service_worker": "sw.js", "type": "module" },
  "permissions": [
    "storage",
    "declarativeNetRequestWithHostAccess",
    "activeTab",
    "contextMenus",
    "scripting",
    "webNavigation",
    "notifications"
  ],
  "host_permissions": ["http://*/*", "https://*/*", "file:///*"],
  "web_accessible_resources": [
    { "resources": ["viewer.html"], "matches": ["<all_urls>"] }
  ]
}
```

- DNR 규칙은 정적 rules.json 대신 **서비스 워커에서 동적 등록**한다(리다이렉트 대상에 자기 확장 URL이 필요하기 때문):

```ts
const VIEWER = chrome.runtime.getURL('viewer.html');

async function syncInterceptRules() {
  const got = await chrome.storage.local.get('margin:settings');
  const auto = got['margin:settings']?.autoIntercept ?? true;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1, 2, 3] });
  if (!auto) return;                       // OFF: 자동 리다이렉트 없음 → 크롬 내장 뷰어 그대로
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [
      { id: 1, priority: 1,
        condition: { regexFilter: '^https://arxiv\\.org/pdf/[^?#]+', resourceTypes: ['main_frame'] },
        action: { type: 'redirect', redirect: { regexSubstitution: VIEWER + '?file=\\0' } } },
      { id: 2, priority: 1,
        condition: { regexFilter: '^https?://.+\\.pdf([?#].*)?$', isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame'] },
        action: { type: 'redirect', redirect: { regexSubstitution: VIEWER + '?file=\\0' } } },
      { id: 3, priority: 1,
        condition: { regexFilter: '^file://.*\\.pdf$', isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame'] },
        action: { type: 'redirect', redirect: { regexSubstitution: VIEWER + '?file=\\0' } } }
    ]
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'open-hub', title: '메모 허브 열기', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'auto-open', type: 'checkbox',
    title: 'PDF 자동으로 Margin에서 열기', contexts: ['action'] });
  await syncAutoOpenMenuChecked();         // 저장된 autoIntercept 값과 체크 상태 동기화
  await syncInterceptRules();
});
chrome.runtime.onStartup.addListener(() => {
  void syncAutoOpenMenuChecked();
  void syncInterceptRules();
});
chrome.contextMenus.onClicked.addListener(async info => {
  if (info.menuItemId === 'open-hub') chrome.tabs.create({ url: chrome.runtime.getURL('hub.html') });
  if (info.menuItemId === 'auto-open') {
    const current = (await chrome.storage.local.get('margin:settings'))['margin:settings'] ?? {};
    await chrome.storage.local.set({ 'margin:settings': { ...current, autoIntercept: !!info.checked } });
    await syncInterceptRules();
    await syncAutoOpenMenuChecked();
  }
});
chrome.webNavigation.onBeforeNavigate.addListener(handleLocalPdfFallback, {
  url: [{ urlPrefix: 'file://', pathSuffix: '.pdf' }, { urlPrefix: 'file://', pathSuffix: '.PDF' }]
});
chrome.action.onClicked.addListener(routeActionClick);
```

- **자동 열기 토글**: `margin:settings.autoIntercept`(기본 true). 확장 아이콘 우클릭 메뉴의 체크박스 "PDF 자동으로 Margin에서 열기"로 제어한다. 로컬 `file:` PDF도 자동 열기 대상이다: "파일 URL 액세스 허용"이 켜져 있으면 DNR 규칙 3(`^file://.*\.pdf$`)이 커밋 전에 뷰어로 리다이렉트하고, 꺼져 있으면 webNavigation 폴백이 탭을 뷰어로 교체해 권한 안내 상태를 띄운다(pdf.js 공식 확장과 동일 구조, docs/issue-1-open-ux.md §5.2). 자동 열기 토글 OFF면 두 경로 모두 비활성.
- 규칙 2는 `http://*/*`, `https://*/*` 호스트 권한이 있는 오리진에서 발동한다. 확장자 없는 PDF는 액션 클릭 시 GET+헤더 판별 후 뷰어로 전환한다.
- PDF 로드: `pdfjsLib.getDocument({ url })` 기본 사용(작은 논문 PDF 기준 range 스트리밍 불요). `file:` URL은 "파일 URL 접근 허용" 미설정 시 권한 안내 상태를 먼저 표시한다.

---

## 10. 디렉터리 구조와 모듈 책임

```text
margin/
├─ public/manifest.json, icons/
├─ src/
│  ├─ sw.ts                    # DNR 동적 규칙, action 폴백, 컨텍스트 메뉴(허브)
│  ├─ core/
│  │  ├─ types.ts              # §3 인터페이스
│  │  ├─ store.ts              # storage 래퍼, 디바운스 저장, 스키마 버전
│  │  ├─ text-index.ts         # S_p 캐시, 오프셋↔DOM 매핑
│  │  ├─ anchor.ts             # 선택→Anchor, 재앵커, quads 계산
│  │  ├─ fig-extract.js        # [vendored] figure 캡션·영역 감지 엔진 (수정 금지, §5.1–5.3 대체)
│  │  ├─ fig-extract.d.ts      # 위 파일의 side-effect import 스텁
│  │  ├─ fig-engine.ts         # 엔진 타입 래퍼 + FigureEntry 변환 (toPdfRect/toFigureEntries)
│  │  ├─ mentions.ts           # 본문 멘션 스캔·링크화 (§5.4)
│  │  ├─ render-region.ts      # 페이지 렌더 LRU + 크롭 캔버스
│  │  └─ format.ts             # esc, [[]]·#태그 파싱/렌더, 날짜
│  ├─ viewer/
│  │  ├─ viewer.html, viewer.css   # 데모 CSS 이식
│  │  ├─ main.ts               # 부트스트랩: file 파싱→로드→모듈 배선→딥링크 처리
│  │  ├─ pdf-host.ts           # PDFViewer/EventBus/MarginLinkService, 툴바(페이지·줌·허브 버튼)
│  │  ├─ overlay-highlights.ts # hl 레이어, 여백 점, 클릭 라우팅 (R2–R4)
│  │  ├─ overlay-refs.ts       # ref/캡션 링크 주입 (R1, R6)
│  │  ├─ crop-mode.ts          # §6
│  │  └─ panel/panel.ts, tab-toc.ts, tab-figures.ts, tab-memos.ts
│  └─ hub/hub.html, hub.ts, hub.css
└─ test/anchor.test.ts, mentions.test.ts, format.test.ts + fixtures/*.json
```

- 모듈 간 통신은 작은 이벤트 이미터 1개(`core/bus.ts`, on/emit 20줄)로 한다. 전역 상태 객체는 viewer/main.ts가 소유.
- fixtures: 테스트 문서 2종의 특정 페이지 `getTextContent()` 결과를 JSON으로 저장해 mentions/anchor 유닛 테스트에 사용(생성 스크립트 `scripts/make-fixture.mjs` 포함). 엔진(fig-extract)의 회귀 테스트는 엔진 repo의 골든 스냅샷이 담당하므로 이 repo에서는 하지 않는다.

## 11. 마일스톤과 수용 기준

**M0 — 스캐폴드**
- [ ] Vite 멀티 엔트리 빌드로 dist가 나오고, 압축해제 로드 시 에러 없음.
- [ ] 툴바 버튼으로 임의 탭을 viewer.html로 전환, `?file=` 없이 열면 빈 상태 화면.

**M1 — 뷰어 코어**
- [ ] arXiv PDF URL을 file 파라미터로 열면 전 페이지 렌더(가상화), 텍스트 선택 가능, 페이지 표시(n/N)·줌(±, 페이지 폭 맞춤) 동작.
- [ ] 패널 셸(3탭·핀·닫기·엣지 스트립)과 목차 탭(outline) 동작. outline 없는 PDF에서 빈 상태 문구.

**M2 — 하이라이트·메모·저장**
- [ ] R2/R3/R4 전부 동작(패널 열림/닫힘 두 경로), 새로고침 후 하이라이트·메모·점 복원.
- [ ] 줌 변경 후에도 하이라이트/점 위치 정확. [[링크]]·#태그 렌더, 검색 동작.
- [ ] anchor.ts 유닛 테스트: 오프셋 왕복, 재앵커(quote 이동 시나리오) 통과.

**M3 — 그림·표: 감지·프리뷰·언급·캡션 클릭**
- [ ] 테스트 문서 2종에서 Figure/Table 목록이 페이지와 함께 나오고, 본문 참조 클릭(R1)과 캡션 라벨 클릭(R6)으로 프리뷰가 뜬다.
- [ ] 본문 언급 목록이 캡션을 제외하고(R7) 스니펫과 점프를 제공한다.
- [ ] hyperref 링크가 있는 PDF에서 내부 링크 클릭이 점프 대신 패널을 연다.
- [ ] mentions.ts 유닛 테스트: fixture 기준 언급 수 일치. (캡션·영역 감지는 fig-extract 엔진 결과를 그대로 사용 — 엔진 회귀는 엔진 테스트 전용 별도 repo에서 검증)

**M4 — 수동 크롭**
- [ ] R8/R9 전부 동작. 감지 실패 항목에서 [영역 지정]으로 프리뷰를 만들 수 있고, 저장 후 새로고침에도 manual region이 유지된다.

**M5 — 허브**
- [ ] 다중 문서 그룹·검색·태그 칩·스텁 역참조·삭제 동작. "PDF에서 이 위치 열기"가 뷰어를 열어 해당 주석/그림으로 점프(R10, R12).

**M6 — 인터셉트·권한·마감**
- [ ] arxiv.org/pdf/* 탐색이 자동으로 Margin에서 열린다. `.pdf` URL은 권한 허용 후 자동으로 열린다(권한 배너 흐름 포함).
- [ ] "PDF 자동으로 Margin에서 열기"를 끄면 같은 URL이 크롬 내장 뷰어로 열리고, 확장 아이콘 클릭으로만 Margin이 열린다. 다시 켜면 자동 열기 복귀, 설정은 브라우저 재시작 후에도 유지.
- [ ] file: PDF 열기 안내, Esc·포커스 링·키보드 탭 이동 등 접근성 기본, 콘솔 에러 0.

## 12. 비목표 (v1에서 구현 금지) / phase 2 백로그

- 구현 금지: 클라우드 동기화·계정, 스캔 PDF/OCR(텍스트 레이어 없는 페이지는 "하이라이트 불가" 배너만), PDF 파일에 주석 굽기/내보내기, 다크 모드, 다국어, 협업, 크로스 페이지 하이라이트, "Figures 2 and 3" 다중 번호 파싱, 퍼지 재앵커, 헤딩 휴리스틱 목차, 옵시디언 실시간 연동.
- phase 2 백로그(순서 제안): 문서/전체 마크다운 내보내기(옵시디언 호환, 딥링크 URL 포함) → getOperatorList 기반 그림 bbox 정밀화 → 수동 "새 그림 추가" → 허브 썸네일 → webRequest 관찰 기반 content-type 감지 → Playwright E2E.

## 13. 리스크와 대응

- pdf.js 버전 간 텍스트 추출 차이 → exact pin + `pdfjsVersion` 기록 + quote 재검색 폴백(§4). 업그레이드는 의도적 이벤트로 취급.
- 그림 영역 휴리스틱 오탐 → confidence 배지 + 수동 크롭이 1급 폴백(§6). 휴리스틱 튜닝에 시간 쓰지 말 것.
- MV3에서 content-type만으로 오는 PDF 미인터셉트 → 툴바 버튼 폴백 + 백로그의 webRequest 관찰 방식.
- arXiv URL이 `.pdf`로 끝나지 않음 → 전용 regex 규칙 1로 해결(§9).
- 대용량 PDF 메모리 → PDFViewer 기본 가상화에 맡기고, render-region 캐시는 LRU 3장 고정.
- fingerprint 충돌(이론상) → 표시 메타로 pageCount 대조, v1에서는 추가 조치 없음.

## 14. 수동 QA 시나리오

테스트 문서: (A) https://arxiv.org/pdf/2606.12848 (사용자 실사용 문서), (B) https://arxiv.org/pdf/1706.03762 (그림·표·hyperref 링크 다수), (C) 로컬 저장한 (B)의 .pdf 파일.

1. A를 주소창으로 열면 Margin 뷰어로 자동 대체된다. 페이지 이동·줌 정상.
2. 본문 "Figure 2" 클릭 → 패널 그림·표 탭에 프리뷰+캡션, 본문 언급 목록에 캡션 제외 확인(R1, R7). 캡션의 "Figure 2:" 클릭도 동일(R6).
3. 패널 닫고 문장 드래그 → 아무 UI 없이 형광펜+빈 점(R2). 점 클릭 → 작성 모드(R3). 저장 → 점 채워짐. 새로고침 → 복원.
4. 패널 연 상태로 드래그 → 메모 탭 작성 모드 자동 전환, [[테스트]] #체크 입력 저장 → 카드 렌더 확인(R11).
5. 감지 실패 또는 낮은 confidence 그림에서 [영역 지정] → 드래그 → 패널 미리보기 → 저장(R8). Esc 취소 경로 확인(R9). 새로고침 후 유지.
6. 핀 해제 후 언급 항목 클릭 → 점프와 함께 패널 자동 닫힘, 엣지 스트립으로 재오픈(R5).
7. 허브: 태그 칩·검색·스텁 역참조 확인, "PDF에서 이 위치 열기" → 뷰어 딥링크 점프(R12). 메모 삭제 시 하이라이트 동반 삭제(R4).
8. B로 1–7 반복(hyperref 인터셉트 포함). C를 뷰어 빈 상태에서 파일 선택으로 열고 하이라이트 저장 → 재선택 시 fingerprint로 복원 확인.
