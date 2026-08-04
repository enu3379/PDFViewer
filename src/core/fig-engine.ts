/**
 * fig-engine.ts — vendored figure 감지 엔진(fig-extract.js)의 타입 래퍼 + FigureEntry 변환.
 *
 * 엔진 파일은 별도 저장소(figure-preview-test)에서 관리되며 이 repo에서는 수정하지 않는다.
 * 통합 규약·갱신 절차: docs/fig-extract-integration.md
 */
import * as pdfjs from "pdfjs-dist";
import "./fig-extract.js";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type { DocId, FigureEntry, PdfRect } from "./types";

/* 엔진은 전역 pdfjsLib(OPS·getDocument)에 의존 — 번들 환경에서는 여기서 주입한다 */
const globalScope = globalThis as Record<string, unknown>;
if (!globalScope.pdfjsLib) globalScope.pdfjsLib = pdfjs;

/**
 * 벤더링된 `src/core/fig-extract.js`의 버전.
 *
 * `test/fig-engine.test.ts`가 이 상수를 런타임 `FigExtract.VERSION`과 대조한다. **그 핀이 지키는
 * 것은 상수 ↔ 엔진 파일, 그 한 쌍뿐이다** — 어느 쪽을 먼저 바꿔도 깨지지만, **이 파일의 타입과
 * 주석이 어느 버전을 기준으로 쓰였는지는 기계가 검사할 수 없다.** 지금이 정확히 그 사각이다
 * (아래 ⚠). 타입 ↔ 엔진 정합은 `docs/fig-extract-integration.md` §갱신 절차가 지키는 사람의 몫이고,
 * 핀은 "그 절차를 다시 읽어라"는 알람일 뿐이다.
 */
export const VENDORED_ENGINE_VERSION = '2.26.2';

/** pt 단위, 좌상단 원점 사각형 (엔진 좌표계) */
export interface EngineBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface EngineFigure {
  num: string;                  // "1", "3.1", "A.1", "IV" …
  page: number;                 // 1-based — **그림이 실제로 있는 페이지**
  confidence: number;           // 현재 1.0 고정
  caption: string;              // 캡션 전체 텍스트 (여러 줄 병합)
  bboxPt: EngineBox;            // 그림 영역만 — 캡션 제외. `page` 좌표계
  captionBoxPt: EngineBox;      // 캡션 블록 영역. **`captionPage ?? page` 좌표계** (아래 참조)
  bboxPx: EngineBox;            // 분석 렌더 픽셀 (pt × 2.2)
  /**
   * v2.19.0 12-B: 캡션이 그림과 **다른 페이지**에 있을 때만 존재한다. 같은 페이지면 엔진이 아예
   * 실어 보내지 않으므로 `undefined`가 "캡션도 `page`에 있다"는 뜻이다.
   *
   * 방향은 **구조적으로 한쪽뿐이다**: 12-B는 캡션 페이지의 앵커에 대해 `candidatePage = 캡션 페이지 − 1`
   * 후보만 만든다. 즉 `captionPage === page + 1`이 항상 성립한다 — 관측된 경향이 아니라 후보 생성
   * 규칙의 귀결이다. 그러므로 `Math.abs(captionPage - page)`나 앞/뒤 양방향 탐색 같은 일반화를
   * 넣지 말 것(엔진이 방향을 넓히면 이 주석과 타입이 먼저 바뀐다).
   *
   * 식별 키는 여전히 `(num, page)`이고 `page`는 그림 페이지다 — 페이지 점프·region은 `page`,
   * **캡션 텍스트 검색과 `captionBoxPt` 좌표 변환은 `captionPage ?? page`**를 써야 한다.
   * (`toPdfRect(f.captionBoxPt, …)`에 그림 페이지 높이를 넣으면 조용히 틀린다.)
   */
  captionPage?: number;
  // `cropCanvas` 필드와 `cropCanvas()` 접근자는 엔진 v2.19.1이 제거했다 ([BREAKING]). 이미지는
  // cropDataURL()/cropBlob()으로만 받으며, 소비자가 캔버스 수명을 관리할 필요는 없어졌다.
  // ⚠ **선언에 없지만 런타임에서 load-bearing인 필드는 여전히 있다**: v2.19.1+는 크롭을 스캔 중
  //   PNG로 직렬화해 `cropPng_`에 싣고, `cropDataURL`/`cropBlob`은 그 필드를 읽는 순수 접근자다
  //   (v2.14.0에서는 같은 역할을 `cropCanvas`가 했다). 즉 엔진이 준 figure 객체를 **그대로**
  //   넘겨야 한다 — 선언된 필드만으로 재구성하거나 structuredClone/JSON 왕복을 거치면 타입은
  //   통과하고 런타임에서 throw한다. (docs/fig-extract-integration.md §주의사항)
}
// v2.5.0: figure 식별 키 = (num, page). 같은 num이 다른 페이지에 복수 등장 가능
// (합본 논문·부록 번호 재시작 — #14). num 단독을 키로 쓰지 말 것 (toFigureEntries의
// `fig{num}-p{page}` ID가 올바른 형태).

export interface EngineResult {
  title: string | null;         // PDF 메타데이터 Title
  numPages: number;
  engineVersion: string;
  figures: EngineFigure[];      // 정렬: page 오름차순 → num 자연순 (결정적)
  /** v2.4.0+: 감지된 정수 번호 1..최대 중 빠진 번호 (미탐지 의심) — 무시해도 됨 */
  suspectedMissing: string[];
}

export interface ExtractOptions {
  onProgress?: (msg: string) => void;
  debug?: (msg: string) => void;
  maxPages?: number;            // v2.5.1+: 스캔 페이지 상한 (미지정 시 전체 페이지)
  /** 이미 로드된 문서 재사용 (지정 시 data는 null 가능) */
  pdfDocument?: PDFDocumentProxy;
  /** 호스트의 페이지 렌더 캐시 주입 (미지정 시 엔진이 자체 렌더) */
  renderPage?: (pageNum: number, scale: number) => Promise<HTMLCanvasElement>;
  /** v2.5.0+: 협조 취소 — 페이지 단위 체크, abort 시 AbortError로 reject (#12 문서 교체 대응).
   *  v2.5.1+: abort 시 진행 중 페이지 렌더도 RenderTask.cancel()로 즉시 중단 */
  signal?: AbortSignal;
  /**
   * v2.15.0+ `[필드 추가]`: 진단 전용. 명시적으로 준 실행에서만 anchor→candidate→selection→
   * dedup→emission의 scalar record 배열을 **문서 끝에 한 번** 전달한다. 미지정 시 recorder 자체를
   * 만들지 않는다 — 공개 출력은 지정 여부와 무관하게 동일하다. record 스키마는 엔진 repo 내부
   * 계약이라 여기서는 타입을 주지 않는다.
   *
   * ⚠ **record에는 사용자 PDF의 원문이 들어간다.** canvas/PNG/raw pixel은 없지만 앵커·후보마다
   * 캡션 줄 원문이 최대 180자씩 실린다(`fig-extract.js`의 `sourceText: …slice(0, 180)`).
   * Margin은 사용자가 연 임의의 PDF를 다루므로, 이 콜백 출력을 콘솔에 남기거나 밖으로 보내면
   * 문서 내용이 함께 나간다. 로컬 디버깅 외의 용도로 쓰지 말 것.
   */
  onDiagnostic?: (records: unknown[]) => void;
  /**
   * v2.19.1+ 진단 전용. `false`면 크롭 생성·PNG 직렬화를 통째로 생략한다 — `figures` 출력은
   * 완전히 동일하고 인코딩 비용만 사라진다. ⚠ 이 모드로 뽑은 figure에 `cropDataURL`/`cropBlob`을
   * 부르면 **throw**한다. 프리뷰 카드를 그리는 뷰어 경로에서는 쓰지 말 것.
   */
  cropImages?: boolean;
  /**
   * v2.26.2+ `[필드 추가]`: 스캔이 끝난 페이지의 pdf.js 캐시(디코드된 이미지)를
   * `page.cleanup()`으로 반환할지. **출력에는 영향이 없다** — 비우는 것은 캐시뿐이고 이후 다시
   * 필요하면 pdf.js가 재파싱한다.
   *
   * 엔진이 직접 연 문서(`pdfDocument` 미지정)는 이 값과 무관하게 항상 해제한다. 이 옵션은
   * **`pdfDocument`로 넘긴 문서에만** 적용되고 기본값은 `false`다 — Margin이 넘기는 것은
   * 사용자가 지금 보고 있는 뷰어의 살아 있는 문서라, 엔진이 캐시를 비우면 뷰어의 다음 렌더가
   * 재파싱을 물고, 뷰어가 그 페이지를 렌더하는 중이면 pdf.js가 지연 정리를 걸어 5초 뒤에 지운다.
   *
   * 켜면 스캔 중 메모리 피크가 내려간다 — 엔진 repo 실측(330편 배치)에서 렌더러 private 피크가
   * 5,407 → 4,707MB, `FigRenderError` 발생이 7건 → 1건이었다. **`FigRenderError`(#12 → B7)를
   * 자주 만나는 환경이라면 이 옵션이 그 압력을 낮추는 손잡이다.** 대가는 뷰어 렌더 캐시가
   * 비워지는 것뿐이므로, 스캔 후 사용자가 그 페이지를 다시 볼 때 한 번 더 파싱한다.
   */
  releasePages?: boolean;
}

export interface FigExtractApi {
  VERSION: string;
  /** AbortError(취소) 외에 v2.19.1+는 `name === 'FigRenderError'`로 reject될 수 있다 — 렌더 결과가
   *  존재하지 않는 경우다(메모리 압력을 받은 Chrome이 캔버스 백킹 스토어를 회수). 조용히 빈 그림을
   *  내놓는 대신 실패시킨다. **일시적 조건이라 재시도가 유효하다** — FiguresTab이 이 이름을 분기해
   *  재시도 안내 문구를 띄운다.
   *  ⚠ `opts.renderPage`로 캔버스를 주입하면 불투명 배경 불변식이 없어 이 검사가 **적용되지 않는다**
   *    — Margin이 렌더 캐시를 주입하기 시작하면 이 보호도 함께 사라진다. */
  extract(data: Uint8Array | null, opts?: ExtractOptions): Promise<EngineResult>;
  /** 엔진이 준 figure 객체를 그대로 넘길 것 (`cropPng_` 의존 — EngineFigure 주석 참조).
   *  `cropImages:false`로 추출한 figure에 대해서는 throw한다 (v2.19.1+). */
  cropDataURL(fig: EngineFigure): string;
  cropBlob(fig: EngineFigure): Promise<Blob>;
}

export function requireFigExtract(scope: { FigExtract?: FigExtractApi }): FigExtractApi {
  const api = scope.FigExtract;
  if (!api) {
    throw new Error(
      'FigExtract가 전역에 등록되지 않았습니다. "./fig-extract.js" side-effect import가 실행되었는지 확인하세요.'
    );
  }
  return api;
}

export const FigExtract = requireFigExtract(
  globalThis as unknown as { FigExtract?: FigExtractApi }
);

/**
 * 엔진 좌표(pt, 좌상단 원점) → PDF user space PdfRect [x1, y1, x2, y2] (좌하단 원점).
 * pageHeightPt = 해당 페이지의 pt 높이 (viewport scale 1 기준).
 */
export function toPdfRect(b: EngineBox, pageHeightPt: number): PdfRect {
  return [b.x0, pageHeightPt - b.y1, b.x1, pageHeightPt - b.y0];
}

/**
 * 엔진 결과 → FigureEntry 변환.
 * captionAnchor(S_p 오프셋)와 doc(fingerprint)은 호출 측(text-index를 가진 쪽)이 채운다:
 * captionText를 **`captionPage`의** S_p에서 검색하면 오프셋을 얻을 수 있다.
 */
export type FigureSeed = Omit<FigureEntry, "doc" | "captionAnchor"> & {
  /**
   * 캡션 텍스트가 실제로 있는 페이지 — `FigureEntry.captionAnchor.page`가 될 값이다.
   * 그래서 `FigureEntry` 스키마는 넓히지 않는다: 목적지 필드가 이미 있고, seed는 그 값을
   * 계산하는 데 필요한 정보를 나르기만 한다.
   *
   * **optional이 아니라 항상 채운다** — 엔진의 `captionPage`는 `page`와 다를 때만 존재하는데,
   * 그 optionality를 그대로 흘리면 호출 측이 `?? page` 보정을 잊어도 컴파일이 통과하고
   * captionAnchor 검색이 그림 페이지에서 조용히 실패한다(그게 이 항목이 벤더링 할 일에
   * 올라온 이유다). 경계에서 정규화해 그 실패 방식을 없앤다.
   *
   * ⚠ **영속 스키마(`FigureEntry`)에 넣지 말 것.** `captionAnchor.page`와 중복이고 storage는
   * 화이트리스트 없이 통째로 저장한다(`store.ts` `saveDoc`). TS strict도 스프레드
   * (`{ ...seed, doc, captionAnchor }`)에는 초과 속성 검사를 하지 않으므로 컴파일이 막아주지
   * 않는다 — 그래서 `toFigureEntry()`를 거치라는 것이다.
   */
  captionPage: number;
};

/**
 * `FigureSeed` + 호출 측이 계산한 `doc`·`captionAnchor` → 영속 스키마 `FigureEntry`.
 *
 * **이 함수의 존재 이유는 `captionPage`를 여기서 떨어뜨리는 것이다.** M3의 storage 저장 경로가
 * `{ ...seed, doc, captionAnchor }`를 쓰면 seed 전용 필드가 그대로 chrome.storage에 영속된다
 * (스프레드는 초과 속성 검사를 받지 않는다). 필드를 명시 나열하는 것도 의도적이다 —
 * `FigureEntry`가 나중에 필드를 얻으면 여기서 컴파일 에러가 나 이 경계를 다시 보게 된다.
 *
 * `captionAnchor.page`가 `seed.captionPage`와 같아야 한다는 것은 **호출 측 책임**이다
 * (검색을 어느 페이지 S_p에서 했는지는 여기서 알 수 없다).
 */
export function toFigureEntry(
  seed: FigureSeed,
  doc: DocId,
  captionAnchor: FigureEntry["captionAnchor"],
): FigureEntry {
  return {
    id: seed.id,
    doc,
    kind: seed.kind,
    num: seed.num,
    label: seed.label,
    page: seed.page,
    captionText: seed.captionText,
    captionAnchor,
    region: seed.region,
    regionSource: seed.regionSource,
    confidence: seed.confidence,
  };
}

export function toFigureEntries(
  res: EngineResult,
  getPageHeightPt: (pageNum: number) => number,
): FigureSeed[] {
  return res.figures.map((f) => ({
    id: `fig${f.num}-p${f.page}`,
    kind: "figure" as const,
    num: f.num,
    label: `Figure ${f.num}`,
    /* 식별·점프·region은 모두 그림 페이지 기준이다 (식별 키 = (num, page)) */
    page: f.page,
    captionText: f.caption,
    captionPage: f.captionPage ?? f.page,
    region: { page: f.page, rect: toPdfRect(f.bboxPt, getPageHeightPt(f.page)) },
    regionSource: "auto" as const,
    confidence: f.confidence,
  }));
}
