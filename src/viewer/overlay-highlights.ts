import type { PageViewport } from 'pdfjs-dist/types/src/display/display_utils';
import type { Highlight, Memo, PenColor } from '../core/types';

export type HighlightOverlayCallbacks = {
  onHighlightClick: (highlightId: string) => void;
};

type PageAccess = {
  getPageDiv(pageNumber: number): HTMLElement | null;
  getPageViewport(pageNumber: number): PageViewport | null;
};

const COLOR_CLASS: Record<PenColor, string> = {
  amber: 'amber',
  teal: 'teal',
  pink: 'pink',
  blue: 'blue'
};

export class HighlightOverlay {
  #pageAccess: PageAccess;
  #callbacks: HighlightOverlayCallbacks;
  #highlights: Highlight[] = [];
  #memos: Memo[] = [];
  #lost = new Set<string>();
  #renderedPages = new Set<number>();
  #activeId: string | null = null;

  constructor(pageAccess: PageAccess, callbacks: HighlightOverlayCallbacks) {
    this.#pageAccess = pageAccess;
    this.#callbacks = callbacks;
  }

  setData(highlights: Highlight[], memos: Memo[], lost: Set<string>): void {
    this.#highlights = highlights;
    this.#memos = memos;
    this.#lost = lost;
  }

  /** 편집 중(작성/수정)인 하이라이트를 강조 표시한다. null이면 강조 해제. */
  setActive(highlightId: string | null): void {
    if (this.#activeId === highlightId) return;
    const affectedPages = new Set<number>();
    for (const id of [this.#activeId, highlightId]) {
      if (!id) continue;
      const highlight = this.#highlights.find((candidate) => candidate.id === id);
      if (highlight) affectedPages.add(highlight.anchor.page);
    }
    this.#activeId = highlightId;
    for (const page of affectedPages) this.renderPage(page);
  }

  renderAll(): void {
    const pages = new Set([
      ...this.#renderedPages,
      ...this.#highlights.map((highlight) => highlight.anchor.page)
    ]);
    for (const page of pages) {
      this.renderPage(page);
    }
  }

  renderPage(pageNumber: number): void {
    const pageDiv = this.#pageAccess.getPageDiv(pageNumber);
    const viewport = this.#pageAccess.getPageViewport(pageNumber);
    if (!pageDiv || !viewport) return;

    const layer = this.#ensureLayer(pageDiv);
    layer.innerHTML = '';
    this.#renderedPages.add(pageNumber);

    const pageHighlights = this.#highlights.filter(
      (highlight) => highlight.anchor.page === pageNumber && !this.#lost.has(highlight.id)
    );
    for (const highlight of pageHighlights) {
      this.#renderHighlight(layer, viewport, highlight);
    }
  }

  getFirstElement(highlightId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`.mgn-hl-rect[data-hid="${CSS.escape(highlightId)}"]`)
      ?? document.querySelector<HTMLElement>(`.mgn-dot[data-hid="${CSS.escape(highlightId)}"]`);
  }

  #ensureLayer(pageDiv: HTMLElement): HTMLElement {
    let layer = pageDiv.querySelector<HTMLElement>('.mgn-hl-layer');
    if (layer) return layer;

    layer = document.createElement('div');
    layer.className = 'mgn-hl-layer';
    layer.addEventListener('click', (event) => {
      const target = (event.target as Element).closest<HTMLElement>('[data-hid]');
      if (!target) return;
      event.stopPropagation();
      this.#callbacks.onHighlightClick(target.dataset.hid ?? '');
    });
    pageDiv.append(layer);
    return layer;
  }

  #renderHighlight(layer: HTMLElement, viewport: PageViewport, highlight: Highlight): void {
    const color = COLOR_CLASS[highlight.color];
    const active = highlight.id === this.#activeId;
    const viewportRects = highlight.anchor.quads
      .map((quad) => normalizeViewportRect(viewport.convertToViewportRectangle(quad)))
      .filter((rect) => rect[2] - rect[0] > 0 && rect[3] - rect[1] > 0);

    for (const rect of viewportRects) {
      const [left, top, right, bottom] = rect;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `mgn-hl-rect mgn-hl-${color}${active ? ' editing' : ''}`;
      el.dataset.hid = highlight.id;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${right - left}px`;
      el.style.height = `${bottom - top}px`;
      layer.append(el);
    }

    const first = viewportRects[0];
    if (!first) return;
    const hasMemo = this.#memos.some((memo) => memo.id === highlight.memoId);
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `mgn-dot mgn-dot-${color} ${hasMemo ? 'solid' : 'hollow'}${active ? ' editing' : ''}`;
    dot.dataset.hid = highlight.id;
    dot.style.top = `${first[1] + 4}px`;
    dot.title = hasMemo ? '메모 보기' : '메모 이어쓰기';
    layer.append(dot);
  }
}

function normalizeViewportRect(rect: number[]): [number, number, number, number] {
  const [x1, y1, x2, y2] = rect;
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}
