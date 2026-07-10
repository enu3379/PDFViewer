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

export type PdfDestination = string | unknown[];

export type ResolvedDestination = {
  page: number;
  y: number | null;
};

type InternalDestinationHandler = (destination: PdfDestination) => boolean | Promise<boolean>;

class MarginLinkService extends PDFLinkService {
  #onInternalDestination: InternalDestinationHandler;

  constructor(
    options: ConstructorParameters<typeof PDFLinkService>[0],
    onInternalDestination: InternalDestinationHandler
  ) {
    super(options);
    this.#onInternalDestination = onInternalDestination;
  }

  override async goToDestination(destination: PdfDestination): Promise<void> {
    try {
      if (await this.#onInternalDestination(destination)) return;
    } catch (error) {
      // A failed panel lookup must never make an ordinary PDF link unusable.
      console.warn('internal PDF destination interception failed', error);
    }
    await super.goToDestination(destination);
  }

  async goToDestinationWithoutInterception(destination: PdfDestination): Promise<void> {
    await super.goToDestination(destination);
  }
}

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
  onInternalDestination?: InternalDestinationHandler;
};

export class PdfHost {
  readonly eventBus: EventBus;
  readonly linkService: MarginLinkService;
  readonly viewer: PDFViewer;
  readonly version = pdfjsVersion;

  #doc: PDFDocumentProxy | null = null;
  #callbacks: PdfHostCallbacks;

  constructor(elements: PdfHostElements, callbacks: PdfHostCallbacks = {}) {
    this.#callbacks = callbacks;
    this.eventBus = new EventBus();
    this.linkService = new MarginLinkService(
      {
        eventBus: this.eventBus,
        externalLinkTarget: LinkTarget.BLANK,
        ignoreDestinationZoom: true
      },
      (destination) => this.#callbacks.onInternalDestination?.(destination) ?? false
    );
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
      this.refreshLayoutSoon();
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

  refreshLayoutSoon(): void {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => this.refreshLayout());
    });
  }

  refreshLayout(): void {
    if (!this.#doc) return;
    if (this.viewer.currentScaleValue === 'page-width') {
      this.viewer.currentScaleValue = 'page-width';
    }
    this.viewer.update();
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
      await this.linkService.goToDestinationWithoutInterception(item.dest);
    } else if (item.page) {
      this.setPage(item.page);
    }
  }

  async resolveDestination(destination: PdfDestination): Promise<ResolvedDestination | null> {
    if (!this.#doc) return null;
    try {
      const explicitDestination = typeof destination === 'string'
        ? await this.#doc.getDestination(destination)
        : destination;
      if (!explicitDestination?.length) return null;

      const first = explicitDestination[0];
      let page: number | null = null;
      if (typeof first === 'number') {
        page = first + 1;
      } else if (first && typeof first === 'object' && 'num' in first && 'gen' in first) {
        page = (await this.#doc.getPageIndex(first as { num: number; gen: number })) + 1;
      }
      if (!page) return null;

      const mode = explicitDestination[1];
      const modeName = mode && typeof mode === 'object' && 'name' in mode
        && typeof (mode as { name?: unknown }).name === 'string'
        ? (mode as { name: string }).name
        : null;
      const yIndex = modeName === 'XYZ' ? 3 : modeName === 'FitH' || modeName === 'FitBH' ? 2 : null;
      const y = yIndex !== null && typeof explicitDestination[yIndex] === 'number'
        ? explicitDestination[yIndex] as number
        : null;
      return { page, y };
    } catch {
      return null;
    }
  }

  #setDocument(doc: PDFDocumentProxy, url?: string): void {
    this.#doc = doc;
    const linkService = this.linkService as PDFLinkService & {
      setDocument(pdfDocument: PDFDocumentProxy, baseUrl?: string | null): void;
    };
    linkService.setDocument(doc, url ?? null);
    this.viewer.setDocument(doc);
    this.refreshLayoutSoon();
  }

  async #resolveDestPage(dest: string | unknown[] | null): Promise<number | null> {
    if (!dest) return null;
    return (await this.resolveDestination(dest))?.page ?? null;
  }

  #emitPageChange(): void {
    this.#callbacks.onPageChange?.(this.currentPage, this.pageCount);
  }

  #emitScaleChange(presetValue?: string): void {
    this.#callbacks.onScaleChange?.(this.viewer.currentScale, presetValue);
  }
}
