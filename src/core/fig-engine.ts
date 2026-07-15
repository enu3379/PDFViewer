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
  cropCanvas: HTMLCanvasElement; // v2.5.1+: 그림 영역만의 크롭 렌더 (scale 2.2). 엔진은 페이지 전체
                                // 캔버스를 보관하지 않는다 (#12). 프리뷰 생성 후 참조를 버리면 GC 회수
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
  extract(data: Uint8Array | null, opts?: ExtractOptions): Promise<EngineResult>;
  cropCanvas(fig: EngineFigure): HTMLCanvasElement;
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
