import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { PageViewport } from 'pdfjs-dist/types/src/display/display_utils';
import { normalizePdfRect } from '../core/anchor';
import type { PdfRect } from '../core/types';

const TEXT_ALIGN = 1 / 8;
const REGION_ALIGN = 1 / 2;
const LARGE_REGION_ALIGN = 1 / 8;
const LARGE_REGION_RATIO = 3 / 4;

export type JumpAccess = {
  container: HTMLElement;
  viewer: PDFViewer;
  getPageDiv(pageNumber: number): HTMLElement | null;
  getPageViewport(pageNumber: number): PageViewport | null;
};

export type ScrollDeltaInput = {
  containerTop: number;
  containerHeight: number;
  pageTop: number;
  targetY: number;
  alignRatio: number;
};

export function computeScrollDelta(input: ScrollDeltaInput): number {
  return input.pageTop + input.targetY - (input.containerTop + input.containerHeight * input.alignRatio);
}

export async function jumpToText(access: JumpAccess, pageNumber: number, yPdf?: number): Promise<void> {
  access.viewer.scrollPageIntoView({ pageNumber });
  await nextFrame();
  if (typeof yPdf === 'number' && Number.isFinite(yPdf)) {
    alignToViewportY(access, pageNumber, pdfYToViewportY(access, pageNumber, yPdf), TEXT_ALIGN);
    flashTextBand(access, pageNumber, yPdf);
  }
}

export async function jumpToRegion(access: JumpAccess, pageNumber: number, rect: PdfRect): Promise<void> {
  access.viewer.scrollPageIntoView({ pageNumber });
  await nextFrame();
  const viewport = access.getPageViewport(pageNumber);
  if (!viewport) return;

  const viewportRect = normalizeViewportRect(viewport.convertToViewportRectangle(normalizePdfRect(rect)));
  const height = viewportRect[3] - viewportRect[1];
  const align = height > access.container.clientHeight * LARGE_REGION_RATIO ? LARGE_REGION_ALIGN : REGION_ALIGN;
  const targetY = align === REGION_ALIGN ? viewportRect[1] + height / 2 : viewportRect[1];
  alignToViewportY(access, pageNumber, targetY, align);
  flashRegion(access, pageNumber, viewportRect);
}

function alignToViewportY(access: JumpAccess, pageNumber: number, targetY: number | undefined, alignRatio: number): void {
  if (targetY === undefined) return;
  const pageDiv = access.getPageDiv(pageNumber);
  if (!pageDiv) return;

  const delta = computeScrollDelta({
    containerTop: access.container.getBoundingClientRect().top,
    containerHeight: access.container.clientHeight,
    pageTop: pageDiv.getBoundingClientRect().top,
    targetY,
    alignRatio
  });
  access.container.scrollTop = clamp(
    access.container.scrollTop + delta,
    0,
    Math.max(0, access.container.scrollHeight - access.container.clientHeight)
  );
}

function pdfYToViewportY(access: JumpAccess, pageNumber: number, yPdf: number): number | undefined {
  const viewport = access.getPageViewport(pageNumber);
  return viewport?.convertToViewportPoint(0, yPdf)[1];
}

function flashTextBand(access: JumpAccess, pageNumber: number, yPdf: number): void {
  const pageDiv = access.getPageDiv(pageNumber);
  const targetY = pdfYToViewportY(access, pageNumber, yPdf);
  if (!pageDiv || targetY === undefined) return;

  const band = document.createElement('div');
  band.className = 'mgn-jump-flash mgn-jump-flash-text';
  band.style.top = `${Math.max(0, targetY - 10)}px`;
  pageDiv.append(band);
  removeAfterAnimation(band);
}

function flashRegion(access: JumpAccess, pageNumber: number, rect: [number, number, number, number]): void {
  const pageDiv = access.getPageDiv(pageNumber);
  if (!pageDiv) return;

  const [left, top, right, bottom] = rect;
  const region = document.createElement('div');
  region.className = 'mgn-jump-flash mgn-jump-flash-region';
  region.style.left = `${left}px`;
  region.style.top = `${top}px`;
  region.style.width = `${right - left}px`;
  region.style.height = `${bottom - top}px`;
  pageDiv.append(region);
  removeAfterAnimation(region);
}

function removeAfterAnimation(element: HTMLElement): void {
  element.addEventListener('animationend', () => element.remove(), { once: true });
  window.setTimeout(() => element.remove(), 1600);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function normalizeViewportRect(rect: number[]): [number, number, number, number] {
  const [x1, y1, x2, y2] = rect;
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
