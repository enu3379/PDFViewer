import { rangeFromOffsets, type PageTextIndex } from './text-index';
import type { FigureEntry } from './types';

const REF_RE = /\b(Fig(?:ure)?s?|Tab(?:le)?s?)\.?\s*([A-Za-z]?\d+(?:\.\d+)*(?:[a-zA-Z])?)/gi;

export type FigureReference = {
  key: string;
  figId: string;
  page: number;
  start: number;
  end: number;
  quote: string;
  yPdf?: number;
  isCaptionLabel: boolean;
};

type TextIndexLike = Pick<PageTextIndex, 'page' | 'text'>;

export function scanFigureReferences(
  index: TextIndexLike,
  figures: FigureEntry[],
  yForOffset?: (offset: number) => number | undefined
): FigureReference[] {
  if (!figures.length || !index.text) return [];

  const byRef = buildFigureLookup(figures);
  const refs: FigureReference[] = [];
  REF_RE.lastIndex = 0;

  for (let match = REF_RE.exec(index.text); match; match = REF_RE.exec(index.text)) {
    const kind = normalizeKind(match[1]);
    const num = normalizeNum(match[2]);
    const figure = byRef.get(`${kind}:${num}`);
    if (!figure) continue;

    const start = match.index;
    const end = start + match[0].length;
    const isCaptionLabel = isInsideCaptionLabel(index.page, start, end, figure);
    refs.push({
      key: referenceKey(figure.id, index.page, start, end),
      figId: figure.id,
      page: index.page,
      start,
      end,
      quote: match[0],
      yPdf: yForOffset?.(start),
      isCaptionLabel
    });
  }

  return refs;
}

export function figureMentions(references: FigureReference[]): FigureReference[] {
  return references.filter((reference) => !reference.isCaptionLabel);
}

export function referenceKey(figId: string, page: number, start: number, end: number): string {
  return `${figId}:${page}:${start}:${end}`;
}

export function injectFigureReferenceLinks(
  pageDiv: HTMLElement,
  index: PageTextIndex,
  references: FigureReference[],
  activeFigureId: string | null = null
): number {
  const textLayer = pageDiv.querySelector<HTMLElement>('.textLayer');
  if (!textLayer || pageDiv.dataset.mgnRefs === '1') {
    updateReferenceLinkActive(pageDiv, activeFigureId);
    return 0;
  }

  const pageRefs = references
    .filter((reference) => reference.page === index.page)
    .filter((reference) => referenceFitsSingleSpan(index, reference.start, reference.end))
    .sort((a, b) => b.start - a.start);

  let count = 0;
  for (const reference of pageRefs) {
    const range = rangeFromOffsets(index, reference.start, reference.end);
    if (!range) continue;
    const common = range.commonAncestorContainer;
    const commonElement = common.nodeType === Node.TEXT_NODE ? common.parentElement : common as Element | null;
    if (commonElement?.closest('a')) {
      range.detach();
      continue;
    }

    const link = document.createElement('a');
    link.className = 'mgn-ref';
    link.href = '#';
    link.dataset.fig = reference.figId;
    link.dataset.refKey = reference.key;
    link.dataset.page = String(reference.page);
    link.dataset.start = String(reference.start);
    link.dataset.end = String(reference.end);
    if (reference.isCaptionLabel) link.dataset.cap = '1';
    if (reference.figId === activeFigureId) link.classList.add('on');
    link.append(range.extractContents());
    range.insertNode(link);
    range.detach();
    count += 1;
  }

  pageDiv.dataset.mgnRefs = '1';
  return count;
}

export function updateReferenceLinkActive(root: ParentNode, activeFigureId: string | null): void {
  for (const link of root.querySelectorAll<HTMLElement>('a.mgn-ref[data-fig]')) {
    link.classList.toggle('on', Boolean(activeFigureId) && link.dataset.fig === activeFigureId);
  }
}

function buildFigureLookup(figures: FigureEntry[]): Map<string, FigureEntry> {
  const lookup = new Map<string, FigureEntry>();
  for (const figure of figures) {
    lookup.set(`${figure.kind}:${normalizeNum(figure.num)}`, figure);
  }
  return lookup;
}

function normalizeKind(value: string): FigureEntry['kind'] {
  return value.toLocaleLowerCase().startsWith('tab') ? 'table' : 'figure';
}

function normalizeNum(value: string): string {
  return value.toLocaleLowerCase();
}

function isInsideCaptionLabel(page: number, start: number, end: number, figure: FigureEntry): boolean {
  const anchor = figure.captionAnchor;
  return Boolean(anchor && anchor.page === page && start >= anchor.start && end <= anchor.end);
}

function referenceFitsSingleSpan(index: PageTextIndex, start: number, end: number): boolean {
  return index.spans.some((span) => start >= span.start && end <= span.end);
}
