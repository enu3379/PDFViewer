/**
 * fig-engine.ts — vendored figure 감지 엔진(fig-extract.js)의 타입 래퍼 + FigureEntry 변환.
 *
 * 엔진 파일은 별도 저장소(figure-preview-test)에서 관리되며 이 repo에서는 수정하지 않는다.
 * 통합 규약·갱신 절차: docs/fig-extract-integration.md
 */
import * as pdfjs from "pdfjs-dist";
import "./fig-extract.js";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type { FigureEntry, PdfRect } from "./types";

/* 엔진은 전역 pdfjsLib(OPS·getDocument)에 의존 — 번들 환경에서는 여기서 주입한다 */
const globalScope = globalThis as Record<string, unknown>;
if (!globalScope.pdfjsLib) globalScope.pdfjsLib = pdfjs;

/**
 * 벤더링된 `fig-extract.js`의 버전. **이 파일의 타입과 주석은 이 버전을 기준으로 쓰여 있다.**
 *
 * 엔진을 새로 벤더링하면 이 상수도 함께 올려야 하고, 그 시점에
 * `docs/fig-extract-integration.md` §다음 벤더링 할 일을 처리해야 한다.
 * `test/fig-engine.test.ts`가 불일치를 실패로 만들어 벤더링 PR이 스스로 알리게 한다 —
 * 버전 스큐를 문서 문단이 아니라 테스트가 지키게 하려는 것이다.
 */
export const VENDORED_ENGINE_VERSION = '2.14.0';

/** pt 단위, 좌상단 원점 사각형 (엔진 좌표계) */
export interface EngineBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface EngineFigure {
  num: string;                  // "1", "3.1", "A.1", "IV" …
  page: number;                 // 1-based
  confidence: number;           // 현재 1.0 고정
  caption: string;              // 캡션 전체 텍스트 (여러 줄 병합)
  bboxPt: EngineBox;            // 그림 영역만 — 캡션 제외
  captionBoxPt: EngineBox;      // 캡션 블록 영역
  bboxPx: EngineBox;            // 분석 렌더 픽셀 (pt × 2.2)
  // `cropCanvas` 필드는 엔진 v2.19.1이 제거했고([BREAKING]) 선언에서도 뺐다. 이미지는
  // cropDataURL()/cropBlob()으로 받는다.
  // ⚠ **현재 벤더링본은 v2.14.0이라 런타임에는 `cropCanvas`가 여전히 있고, `cropDataURL`은 그
  //   필드를 읽는 순수 접근자다.** 즉 엔진이 준 figure 객체를 그대로 넘겨야 한다 — 선언된 필드만으로
  //   재구성하거나 structuredClone/JSON 왕복을 거치면 타입은 통과하고 런타임에서 죽는다.
  //   (v2.19.1을 벤더링하면 이 주의는 사라진다. docs/fig-extract-integration.md §벤더링본 v2.14.0)
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
}

export interface FigExtractApi {
  VERSION: string;
  /** AbortError(취소) 외에 `name === 'FigRenderError'`로 reject될 수 있다 — 렌더 결과가 존재하지
   *  않는 경우다(메모리 압력을 받은 Chrome이 캔버스 백킹 스토어를 회수). 조용히 빈 그림을 내놓는
   *  대신 실패시킨다. 일시적 조건이므로 재시도가 유효하다 — FiguresTab의 "다시 시도" 경로가 적용된다.
   *  ⚠ **엔진 v2.19.1+ 에서만 발생한다. 현재 벤더링본 v2.14.0은 이 오류를 던지지 않으므로,
   *    지금 `e.name === 'FigRenderError'` 분기를 쓰면 죽은 코드다** — 같은 상황에서 v2.14.0은
   *    오류 없이 백지 프리뷰를 낸다. 분기는 벤더링과 함께 넣을 것. */
  extract(data: Uint8Array | null, opts?: ExtractOptions): Promise<EngineResult>;
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
 * captionText를 해당 페이지 S_p에서 검색하면 오프셋을 얻을 수 있다.
 */
export type FigureSeed = Omit<FigureEntry, "doc" | "captionAnchor">;

export function toFigureEntries(
  res: EngineResult,
  getPageHeightPt: (pageNum: number) => number,
): FigureSeed[] {
  return res.figures.map((f) => ({
    id: `fig${f.num}-p${f.page}`,
    kind: "figure" as const,
    num: f.num,
    label: `Figure ${f.num}`,
    page: f.page,
    captionText: f.caption,
    region: { page: f.page, rect: toPdfRect(f.bboxPt, getPageHeightPt(f.page)) },
    regionSource: "auto" as const,
    confidence: f.confidence,
  }));
}
