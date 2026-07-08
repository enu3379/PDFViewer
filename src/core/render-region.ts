import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import { normalizePdfRect } from './anchor';
import type { PdfRect } from './types';

const DEFAULT_MAX_CSS_WIDTH = 360;

export async function renderRegionDataURL(
  pdfDocument: PDFDocumentProxy,
  pageNumber: number,
  rect: PdfRect,
  maxCssWidth = DEFAULT_MAX_CSS_WIDTH
): Promise<string | null> {
  const page = await pdfDocument.getPage(pageNumber);
  const normalized = normalizePdfRect(rect);
  const widthPt = Math.max(1, normalized[2] - normalized[0]);
  const cssScale = clamp(maxCssWidth / widthPt, 1, 3);
  const pixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  const scale = cssScale * pixelRatio;
  const viewport = page.getViewport({ scale });

  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = Math.ceil(viewport.width);
  pageCanvas.height = Math.ceil(viewport.height);
  const pageContext = pageCanvas.getContext('2d');
  if (!pageContext) return null;

  await page.render({ canvasContext: pageContext, viewport }).promise;

  const [left, top, right, bottom] = normalizeViewportRect(viewport.convertToViewportRectangle(normalized));
  const cropWidth = Math.max(1, Math.ceil(right - left));
  const cropHeight = Math.max(1, Math.ceil(bottom - top));
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropWidth;
  cropCanvas.height = cropHeight;
  const cropContext = cropCanvas.getContext('2d');
  if (!cropContext) return null;
  cropContext.drawImage(pageCanvas, left, top, right - left, bottom - top, 0, 0, cropWidth, cropHeight);
  return cropCanvas.toDataURL('image/png');
}

function normalizeViewportRect(rect: number[]): [number, number, number, number] {
  const [x1, y1, x2, y2] = rect;
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
