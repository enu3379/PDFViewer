import {
  GlobalWorkerOptions,
  getDocument,
  version as pdfjsVersion
} from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';
import {
  EventBus,
  LinkTarget,
  PDFLinkService,
  PDFViewer
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import type { PageViewport } from 'pdfjs-dist/types/src/display/display_utils';
import type { DocId, DocMeta } from '../core/types';

GlobalWorkerOptions.workerSrc = workerSrc;

export type OutlineNode = {
  title: string;
  dest: string | unknown[] | null;
  url: string | null;
  items?: OutlineNode[];
};

export type FlatOutlineItem = {
  id: string;
  title: string;
  depth: number;
  dest: string | unknown[] | null;
  url: string | null;
  page: number | null;
};

type PdfHostElements = {
  container: HTMLDivElement;
  viewer: HTMLDivElement;
};

type PdfHostCallbacks = {
  onPageChange?: (page: number, pageCount: number) => void;
  onScaleChange?: (scale: number, presetValue?: string) => void;
};

export class PdfHost {
  readonly eventBus: EventBus;
  readonly linkService: PDFLinkService;
  readonly viewer: PDFViewer;
  readonly version = pdfjsVersion;

  #doc: PDFDocumentProxy | null = null;
  #callbacks: PdfHostCallbacks;

  constructor(elements: PdfHostElements, callbacks: PdfHostCallbacks = {}) {
    this.#callbacks = callbacks;
    this.eventBus = new EventBus();
    this.linkService = new PDFLinkService({
      eventBus: this.eventBus,
      externalLinkTarget: LinkTarget.BLANK,
      ignoreDestinationZoom: true
    });
    this.viewer = new PDFViewer({
      container: elements.container,
      viewer: elements.viewer,
      eventBus: this.eventBus,
      linkService: this.linkService,
      removePageBorders: true
    });
    this.linkService.setViewer(this.viewer);

    this.eventBus.on('pagesinit', () => {
      this.viewer.currentScaleValue = 'page-width';
      this.#emitPageChange();
      this.#emitScaleChange('page-width');
    });
    this.eventBus.on('pagechanging', (event: { pageNumber: number }) => {
      this.#callbacks.onPageChange?.(event.pageNumber, this.pageCount);
    });
    this.eventBus.on('scalechanging', (event: { scale: number; presetValue?: string }) => {
      this.#callbacks.onScaleChange?.(event.scale, event.presetValue);
    });
  }

  get pdfDocument(): PDFDocumentProxy | null {
    return this.#doc;
  }

  get pageCount(): number {
    return this.#doc?.numPages ?? 0;
  }

  get currentPage(): number {
    return this.viewer.currentPageNumber || 1;
  }

  async loadUrl(url: string): Promise<PDFDocumentProxy> {
    const loadingTask = getDocument({
      url,
      docBaseUrl: url,
      isEvalSupported: false
    });
    const doc = await loadingTask.promise;
    this.#setDocument(doc, url);
    return doc;
  }

  async loadFile(file: File): Promise<PDFDocumentProxy> {
    const data = new Uint8Array(await file.arrayBuffer());
    const loadingTask = getDocument({
      data,
      isEvalSupported: false
    });
    const doc = await loadingTask.promise;
    this.#setDocument(doc);
    return doc;
  }

  async getTitle(fallback: string): Promise<string> {
    if (!this.#doc) return fallback;
    try {
      const metadata = await this.#doc.getMetadata();
      const info = metadata.info as { Title?: unknown };
      const title = info.Title;
      return typeof title === 'string' && title.trim() ? title.trim() : fallback;
    } catch {
      return fallback;
    }
  }

  async getDocMeta(titleFallback: string, url?: string): Promise<DocMeta> {
    if (!this.#doc) throw new Error('PDF document is not loaded.');
    const now = Date.now();
    return {
      id: this.docId,
      title: await this.getTitle(titleFallback),
      url,
      pageCount: this.#doc.numPages,
      pdfjsVersion,
      addedAt: now,
      lastOpenedAt: now
    };
  }

  get docId(): DocId {
    const fingerprint = this.#doc?.fingerprints[0];
    if (!fingerprint) throw new Error('PDF fingerprint is unavailable.');
    return fingerprint;
  }

  getPageDiv(pageNumber: number): HTMLElement | null {
    return (this.viewer.getPageView(pageNumber - 1)?.div as HTMLElement | undefined) ?? null;
  }

  getPageViewport(pageNumber: number): PageViewport | null {
    return (this.viewer.getPageView(pageNumber - 1)?.viewport as PageViewport | undefined) ?? null;
  }

  previousPage(): void {
    this.viewer.previousPage();
    this.#emitPageChange();
  }

  nextPage(): void {
    this.viewer.nextPage();
    this.#emitPageChange();
  }

  setPage(page: number): void {
    if (!Number.isInteger(page) || page < 1 || page > this.pageCount) return;
    this.viewer.currentPageNumber = page;
    this.#emitPageChange();
  }

  zoomIn(): void {
    this.viewer.currentScale = Math.min(this.viewer.currentScale * 1.1, 4);
    this.#emitScaleChange();
  }

  zoomOut(): void {
    this.viewer.currentScale = Math.max(this.viewer.currentScale / 1.1, 0.25);
    this.#emitScaleChange();
  }

  fitPageWidth(): void {
    this.viewer.currentScaleValue = 'page-width';
    this.#emitScaleChange('page-width');
  }

  async getOutlineItems(): Promise<FlatOutlineItem[]> {
    if (!this.#doc) return [];
    const outline = (await this.#doc.getOutline()) as OutlineNode[] | null;
    if (!outline?.length) return [];

    const items: FlatOutlineItem[] = [];
    let nextId = 0;
    const walk = async (nodes: OutlineNode[], depth: number): Promise<void> => {
      for (const node of nodes) {
        const item: FlatOutlineItem = {
          id: `toc-${nextId++}`,
          title: node.title,
          depth,
          dest: node.dest,
          url: node.url,
          page: await this.#resolveDestPage(node.dest)
        };
        items.push(item);
        if (node.items?.length) {
          await walk(node.items, depth + 1);
        }
      }
    };

    await walk(outline, 0);
    return items;
  }

  async jumpToOutline(item: FlatOutlineItem): Promise<void> {
    if (item.url) {
      window.open(item.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (item.dest) {
      await this.linkService.goToDestination(item.dest as string | unknown[]);
    } else if (item.page) {
      this.setPage(item.page);
    }
  }

  #setDocument(doc: PDFDocumentProxy, url?: string): void {
    this.#doc = doc;
    const linkService = this.linkService as PDFLinkService & {
      setDocument(pdfDocument: PDFDocumentProxy, baseUrl?: string | null): void;
    };
    linkService.setDocument(doc, url ?? null);
    this.viewer.setDocument(doc);
  }

  async #resolveDestPage(dest: string | unknown[] | null): Promise<number | null> {
    if (!this.#doc || !dest) return null;
    try {
      const destArray = typeof dest === 'string' ? await this.#doc.getDestination(dest) : dest;
      if (!destArray?.length) return null;
      const first = destArray[0];
      if (typeof first === 'number') return first + 1;
      if (first && typeof first === 'object' && 'num' in first && 'gen' in first) {
        return (await this.#doc.getPageIndex(first as { num: number; gen: number })) + 1;
      }
      return null;
    } catch {
      return null;
    }
  }

  #emitPageChange(): void {
    this.#callbacks.onPageChange?.(this.currentPage, this.pageCount);
  }

  #emitScaleChange(presetValue?: string): void {
    this.#callbacks.onScaleChange?.(this.viewer.currentScale, presetValue);
  }
}
