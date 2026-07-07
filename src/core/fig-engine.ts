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
  method: "image" | "pixel";    // 감지 경로 (이미지 XObject 좌표 / 픽셀 블록 분석)
  confidence: number;           // 현재 1.0 고정
  caption: string;              // 캡션 전체 텍스트 (여러 줄 병합)
  bboxPt: EngineBox;            // 그림 영역만 — 캡션 제외
  captionBoxPt: EngineBox;      // 캡션 블록 영역
  bboxPx: EngineBox;            // 분석 렌더 픽셀 (pt × 2.2)
  canvas: HTMLCanvasElement;    // 해당 페이지 전체 렌더 (scale 2.2)
}

export interface EngineResult {
  title: string | null;         // PDF 메타데이터 Title
  numPages: number;
  engineVersion: string;
  figures: EngineFigure[];
}

export interface ExtractOptions {
  onProgress?: (msg: string) => void;
  debug?: (msg: string) => void;
  maxPages?: number;            // 기본 60
  /** 이미 로드된 문서 재사용 (지정 시 data는 null 가능) */
  pdfDocument?: PDFDocumentProxy;
  /** 호스트의 페이지 렌더 캐시 주입 (미지정 시 엔진이 자체 렌더) */
  renderPage?: (pageNum: number, scale: number) => Promise<HTMLCanvasElement>;
}

export interface FigExtractApi {
  VERSION: string;
  extract(data: Uint8Array | null, opts?: ExtractOptions): Promise<EngineResult>;
  cropCanvas(fig: EngineFigure): HTMLCanvasElement;
  cropDataURL(fig: EngineFigure): string;
  cropBlob(fig: EngineFigure): Promise<Blob>;
}

export const FigExtract: FigExtractApi =
  (globalThis as unknown as { FigExtract: FigExtractApi }).FigExtract;

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
