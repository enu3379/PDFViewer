import type { PageViewport } from 'pdfjs-dist/types/src/display/display_utils';
import type { Anchor, PdfRect } from './types';
import { findTextOffset, type PageTextIndex, rangeFromOffsets } from './text-index';

const CONTEXT_CHARS = 32;

export type RectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export function normalizePdfRect(rect: PdfRect): PdfRect {
  const [x1, y1, x2, y2] = rect;
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

export function contextForRange(text: string, start: number, end: number): Pick<Anchor, 'quote' | 'prefix' | 'suffix'> {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: text.slice(end, Math.min(text.length, end + CONTEXT_CHARS))
  };
}

export function findQuoteWithContext(
  text: string,
  quote: string,
  prefix: string
): { start: number; end: number } | null {
  if (!quote) return null;
  let best: { start: number; end: number; score: number } | null = null;
  let from = 0;

  while (from <= text.length) {
    const start = text.indexOf(quote, from);
    if (start < 0) break;
    const score = commonSuffixLength(text.slice(0, start), prefix);
    if (!best || score > best.score) {
      best = { start, end: start + quote.length, score };
    }
    from = start + Math.max(quote.length, 1);
  }

  return best ? { start: best.start, end: best.end } : null;
}

export function commonSuffixLength(left: string, right: string): number {
  let count = 0;
  while (
    count < left.length &&
    count < right.length &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

export function mergeLineRects(rects: RectLike[]): RectLike[] {
  const sorted = rects
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: RectLike[] = [];

  for (const rect of sorted) {
    const last = merged.at(-1);
    if (!last || verticalOverlapRatio(last, rect) < 0.6) {
      merged.push({ ...rect });
      continue;
    }
    last.left = Math.min(last.left, rect.left);
    last.top = Math.min(last.top, rect.top);
    last.right = Math.max(last.right, rect.right);
    last.bottom = Math.max(last.bottom, rect.bottom);
    last.width = last.right - last.left;
    last.height = last.bottom - last.top;
  }

  return merged;
}

export function createAnchorFromRange(
  range: Range,
  index: PageTextIndex,
  pageDiv: HTMLElement,
  viewport: PageViewport
): Anchor | null {
  const start = findTextOffset(index, range.startContainer, range.startOffset);
  let end = findTextOffset(index, range.endContainer, range.endOffset);
  if (start === null) return null;
  if (end === null || !pageDiv.contains(range.endContainer)) {
    end = index.text.length;
  }

  const normalizedStart = Math.min(start, end);
  const normalizedEnd = Math.max(start, end);
  const { quote, prefix, suffix } = contextForRange(index.text, normalizedStart, normalizedEnd);
  if (quote.replace(/\s+/g, '').length < 2) return null;

  const pageBounds = pageDiv.getBoundingClientRect();
  const pageRects = Array.from(range.getClientRects()).filter((rect) =>
    rect.right > pageBounds.left &&
    rect.left < pageBounds.right &&
    rect.bottom > pageBounds.top &&
    rect.top < pageBounds.bottom
  );
  const quads = rectsToPdfRects(pageRects, pageBounds, viewport);
  if (!quads.length) return null;

  return {
    page: index.page,
    start: normalizedStart,
    end: normalizedEnd,
    quote,
    prefix,
    suffix,
    quads
  };
}

export function repairAnchor(
  anchor: Anchor,
  index: PageTextIndex,
  pageDiv: HTMLElement,
  viewport: PageViewport
): Anchor | null {
  if (index.text.slice(anchor.start, anchor.end) === anchor.quote) {
    return anchor;
  }

  const match = findQuoteWithContext(index.text, anchor.quote, anchor.prefix);
  if (!match) return null;

  const range = rangeFromOffsets(index, match.start, match.end);
  if (!range) return null;

  const repaired = createAnchorFromRange(range, index, pageDiv, viewport);
  range.detach();
  return repaired;
}

function rectsToPdfRects(rects: RectLike[], pageBounds: DOMRect, viewport: PageViewport): PdfRect[] {
  return mergeLineRects(rects).map((rect) => {
    const left = Math.max(rect.left, pageBounds.left) - pageBounds.left;
    const top = Math.max(rect.top, pageBounds.top) - pageBounds.top;
    const right = Math.min(rect.right, pageBounds.right) - pageBounds.left;
    const bottom = Math.min(rect.bottom, pageBounds.bottom) - pageBounds.top;
    const [x1, y1] = viewport.convertToPdfPoint(left, top);
    const [x2, y2] = viewport.convertToPdfPoint(right, bottom);
    return normalizePdfRect([x1, y1, x2, y2]);
  });
}

function verticalOverlapRatio(a: RectLike, b: RectLike): number {
  const overlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return overlap / Math.min(a.height, b.height);
}

