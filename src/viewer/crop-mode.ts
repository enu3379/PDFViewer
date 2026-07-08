import type { PageViewport } from 'pdfjs-dist/types/src/display/display_utils';
import { normalizePdfRect } from '../core/anchor';
import type { FigureEntry, PdfRect } from '../core/types';
import { jumpToRegion, type JumpAccess } from './jump';

const MIN_SIZE_PT = 12;

export type CropRegion = {
  page: number;
  rect: PdfRect;
};

type CropModeCallbacks = {
  onPreview(region: CropRegion): void;
  onCancel(): void;
};

type PageAccess = JumpAccess & {
  pageCount(): number;
};

export class CropMode {
  #access: PageAccess;
  #callbacks: CropModeCallbacks;
  #figId: string | null = null;
  #overlays: HTMLElement[] = [];
  #drag: {
    pageNumber: number;
    overlay: HTMLElement;
    viewport: PageViewport;
    startX: number;
    startY: number;
    rectEl: HTMLElement;
  } | null = null;
  #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.active) this.cancel();
  };

  constructor(access: PageAccess, callbacks: CropModeCallbacks) {
    this.#access = access;
    this.#callbacks = callbacks;
  }

  get active(): boolean {
    return this.#figId !== null;
  }

  get figId(): string | null {
    return this.#figId;
  }

  async start(figure: FigureEntry): Promise<void> {
    this.cancel(false);
    this.#figId = figure.id;
    document.body.classList.add('mgn-cropping');
    window.addEventListener('keydown', this.#onKeyDown);
    this.#installOverlays(figure);
    if (figure.region) {
      await jumpToRegion(this.#access, figure.region.page, figure.region.rect);
    } else {
      this.#access.viewer.scrollPageIntoView({ pageNumber: figure.page });
    }
  }

  accept(): void {
    this.#clear(false);
  }

  cancel(emit = true): void {
    const wasActive = this.active;
    this.#clear(false);
    if (emit && wasActive) this.#callbacks.onCancel();
  }

  #installOverlays(figure: FigureEntry): void {
    for (let pageNumber = 1; pageNumber <= this.#access.pageCount(); pageNumber += 1) {
      const pageDiv = this.#access.getPageDiv(pageNumber);
      const viewport = this.#access.getPageViewport(pageNumber);
      if (!pageDiv || !viewport) continue;

      const overlay = document.createElement('div');
      overlay.className = 'mgn-crop-overlay';
      overlay.dataset.page = String(pageNumber);
      overlay.addEventListener('pointerdown', (event) => this.#pointerDown(event, pageNumber, overlay, viewport));
      pageDiv.append(overlay);
      this.#overlays.push(overlay);

      if (figure.region?.page === pageNumber) {
        this.#drawRect(overlay, viewport.convertToViewportRectangle(normalizePdfRect(figure.region.rect)), 'mgn-crop-existing');
      }
    }
  }

  #pointerDown(event: PointerEvent, pageNumber: number, overlay: HTMLElement, viewport: PageViewport): void {
    if (event.button !== 0 || !this.active) return;
    event.preventDefault();
    overlay.setPointerCapture(event.pointerId);
    overlay.querySelector('.mgn-crop-rubber')?.remove();
    const point = this.#eventPoint(event, overlay);
    const rectEl = document.createElement('div');
    rectEl.className = 'mgn-crop-rubber';
    overlay.append(rectEl);
    this.#drag = {
      pageNumber,
      overlay,
      viewport,
      startX: point.x,
      startY: point.y,
      rectEl
    };

    const onMove = (moveEvent: PointerEvent): void => this.#pointerMove(moveEvent);
    const onUp = (upEvent: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.#pointerUp(upEvent);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  #pointerMove(event: PointerEvent): void {
    if (!this.#drag) return;
    const point = this.#eventPoint(event, this.#drag.overlay);
    this.#positionRect(this.#drag.rectEl, this.#drag.startX, this.#drag.startY, point.x, point.y);
  }

  #pointerUp(event: PointerEvent): void {
    if (!this.#drag) return;
    const drag = this.#drag;
    this.#drag = null;
    const point = this.#eventPoint(event, drag.overlay);
    this.#positionRect(drag.rectEl, drag.startX, drag.startY, point.x, point.y);

    const rectPdf = viewportRectToPdfRect(drag.viewport, drag.startX, drag.startY, point.x, point.y);
    const normalized = normalizePdfRect(rectPdf);
    if (normalized[2] - normalized[0] < MIN_SIZE_PT || normalized[3] - normalized[1] < MIN_SIZE_PT) {
      drag.rectEl.remove();
      return;
    }

    drag.rectEl.classList.add('preview');
    this.#callbacks.onPreview({ page: drag.pageNumber, rect: normalized });
  }

  #drawRect(overlay: HTMLElement, viewportRect: number[], className: string): HTMLElement {
    const rectEl = document.createElement('div');
    rectEl.className = className;
    const [x1, y1, x2, y2] = normalizeViewportRect(viewportRect);
    this.#positionRect(rectEl, x1, y1, x2, y2);
    overlay.append(rectEl);
    return rectEl;
  }

  #positionRect(rectEl: HTMLElement, x1: number, y1: number, x2: number, y2: number): void {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    rectEl.style.left = `${left}px`;
    rectEl.style.top = `${top}px`;
    rectEl.style.width = `${Math.abs(x2 - x1)}px`;
    rectEl.style.height = `${Math.abs(y2 - y1)}px`;
  }

  #eventPoint(event: PointerEvent, overlay: HTMLElement): { x: number; y: number } {
    const bounds = overlay.getBoundingClientRect();
    return {
      x: clamp(event.clientX - bounds.left, 0, bounds.width),
      y: clamp(event.clientY - bounds.top, 0, bounds.height)
    };
  }

  #clear(emit: boolean): void {
    document.body.classList.remove('mgn-cropping');
    window.removeEventListener('keydown', this.#onKeyDown);
    for (const overlay of this.#overlays) overlay.remove();
    this.#overlays = [];
    this.#drag = null;
    const hadFigure = this.#figId !== null;
    this.#figId = null;
    if (emit && hadFigure) this.#callbacks.onCancel();
  }
}

function viewportRectToPdfRect(
  viewport: PageViewport,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): PdfRect {
  const [px1, py1] = viewport.convertToPdfPoint(x1, y1);
  const [px2, py2] = viewport.convertToPdfPoint(x2, y2);
  return [px1, py1, px2, py2];
}

function normalizeViewportRect(rect: number[]): [number, number, number, number] {
  const [x1, y1, x2, y2] = rect;
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
