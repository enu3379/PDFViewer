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

/* workerSrc만 설정한다 — `workerPort`는 절대 쓰지 말 것 (#35). workerPort를 주면 pdf.js가
 * `PDFWorker.fromPort`로 **모든 문서가 공유하는 싱글턴 워커**를 넘기고, 그러면 #releaseDocument의
 * destroy()가 다른 문서들의 워커까지 종료시킨다. 문서당 워커 1개라는 전제 위에 서 있는 코드다. */
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

/**
 * 로드가 끝나기 전에 사용자가 다른 문서를 요청해 이 로드가 밀려났다는 신호 (#35).
 * **오류가 아니다** — 호출 측은 화면을 건드리지 말고 조용히 물러나야 한다. 이걸 일반 실패로
 * 처리하면 정상 로드된 새 문서 위에 오류 화면이 뜬다.
 */
export class PdfLoadSupersededError extends Error {
  constructor() {
    super('이 PDF 로드는 더 최신 로드로 대체되었습니다.');
    this.name = 'PdfLoadSupersededError';
  }
}

export const isLoadSuperseded = (error: unknown): boolean =>
  typeof error === 'object' && error !== null
  && (error as { name?: unknown }).name === 'PdfLoadSupersededError';

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
  /** 로드 요청 일련번호 — 완료 시점에 자기가 아직 최신인지 판별한다 (#35) */
  #loadSeq = 0;
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
    const seq = ++this.#loadSeq;
    const loadingTask = getDocument({
      url,
      docBaseUrl: url,
      isEvalSupported: false
    });
    const doc = await this.#awaitLoad(loadingTask, seq);
    return this.#adopt(doc, seq, url);
  }

  async loadFile(file: File): Promise<PDFDocumentProxy> {
    const seq = ++this.#loadSeq;
    const data = new Uint8Array(await file.arrayBuffer());
    const loadingTask = getDocument({
      data,
      isEvalSupported: false
    });
    const doc = await this.#awaitLoad(loadingTask, seq);
    return this.#adopt(doc, seq);
  }

  /* 늦게 끝난 로드가 사용자가 **마지막으로 요청한** 문서를 밀어내지 않게 한다 (#35).
   * 느린 URL(A)을 로드하는 중에 파일(B)을 드롭하면 B가 먼저 적용되는데, 그 뒤 A가 완료되면
   * #setDocument(A)가 화면에 떠 있는 B를 destroy해 버린다 — 이 destroy는 이 PR이 추가한 것이라
   * 여기서 함께 막는다. 밀려난 쪽은 방금 받은 자기 문서를 스스로 버리고 물러난다.
   * (표시 상태·TOC·docData의 stale 갱신은 main.ts 레벨 문제라 #37에 남아 있다.) */
  #adopt(doc: PDFDocumentProxy, seq: number, url?: string): PDFDocumentProxy {
    if (seq !== this.#loadSeq) {
      void this.#releaseDocument(doc);
      throw new PdfLoadSupersededError();
    }
    this.#setDocument(doc, url);
    return doc;
  }

  /* 로드가 실패하면 loadingTask를 명시로 정리한다 (#35). getDocument는 문서마다 전용 PDFWorker를
   * 띄우는데, 실패 시 pdf.js는 promise만 reject하고 task·worker를 회수하지 않는다 — 파일 없음·권한
   * 거부가 일상적인 UX라 실패 N번이 워커 스레드 N개로 쌓인다. 성공 경로는 #setDocument가 이전
   * 문서를 destroy할 때 함께 정리되므로 여기서 건드리지 않는다. */
  async #awaitLoad(
    loadingTask: { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> },
    seq: number
  ) {
    try {
      return await loadingTask.promise;
    } catch (error) {
      void loadingTask.destroy().catch(() => {});
      /* 이미 밀려난 로드의 **실패**도 화면에 띄우면 안 된다 (#35). 그대로 올려보내면 호출 측이
       * 일반 오류로 처리해 figuresTab을 비우고 오류 화면을 띄우는데, 그 화면에는 사용자가
       * 실제로 연 다른 문서가 떠 있다. 성공 경로의 #adopt와 같은 판정을 실패 경로에도 적용한다. */
      throw seq !== this.#loadSeq ? new PdfLoadSupersededError() : error;
    }
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

  /* 문서 하나에 고정해서 읽는다 (#35). 원격 PDF의 outline은 아직 안 받은 range를 기다릴 수 있어
   * 이 함수가 수 초 매달릴 수 있는데, 그 사이 사용자가 다른 PDF를 열면 #releaseDocument가 이 문서를
   * destroy한다 — 그러면 getOutline이 AbortException으로 거절하고, 그 거절이 **이전 로드의 catch**로
   * 흘러가 방금 열린 새 문서 위에 오류 화면을 띄운다. 거절을 삼키고, 교체를 감지하면 빈 목록으로
   * 빠진다. this.#doc을 다시 읽지 않는 것도 같은 이유다(교체 후 새 문서에 옛 dest를 풀지 않는다). */
  async getOutlineItems(): Promise<FlatOutlineItem[]> {
    const doc = this.#doc;
    if (!doc) return [];
    let outline: OutlineNode[] | null;
    try {
      outline = (await doc.getOutline()) as OutlineNode[] | null;
    } catch {
      return [];   // 파괴된 문서이거나 outline을 못 읽는 문서 — TOC 없음으로 취급
    }
    if (this.#doc !== doc || !outline?.length) return [];

    const items: FlatOutlineItem[] = [];
    let nextId = 0;
    const walk = async (nodes: OutlineNode[], depth: number): Promise<void> => {
      for (const node of nodes) {
        if (this.#doc !== doc) return;
        const item: FlatOutlineItem = {
          id: `toc-${nextId++}`,
          title: node.title,
          depth,
          dest: node.dest,
          url: node.url,
          page: await this.#resolveDestPage(node.dest, doc)
        };
        items.push(item);
        if (node.items?.length) {
          await walk(node.items, depth + 1);
        }
      }
    };

    await walk(outline, 0);
    return this.#doc === doc ? items : [];
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
    const previous = this.#doc;
    this.#doc = doc;
    const linkService = this.linkService as PDFLinkService & {
      setDocument(pdfDocument: PDFDocumentProxy, baseUrl?: string | null): void;
    };
    linkService.setDocument(doc, url ?? null);
    this.viewer.setDocument(doc);
    this.refreshLayoutSoon();
    /* 이전 문서는 **뷰어·linkService가 새 문서로 전환된 뒤에** 정리한다 (#35). pdf.js는
     * PDFDocumentProxy를 destroy()하지 않으면 워커 측 자원과 페이지 프록시를 계속 붙들고 있어
     * GC 대상이 되지 않는다 — 한 세션에서 문서를 N번 열면 N개가 그대로 상주해 Chrome이 캔버스
     * 백킹 스토어를 회수하는 메모리 압력 조건(엔진 백로그 B7)에 직접 기여한다.
     * (크롭 자체는 엔진 v2.19.1부터 PNG 문자열이라 회수 대상이 아니다. 남은 기여분은 문서
     *  프록시·워커 자원과 페이지 캔버스 쪽이다.)
     * 순서가 중요하다 — 전환 전에 destroy하면 뷰어가 방금 파괴된 문서를 렌더하려 한다. */
    if (previous && previous !== doc) void this.#releaseDocument(previous);
  }

  /** 이전 문서의 워커 자원을 반환한다. 실패해도 새 문서 로드를 막지 않는다 (#35). */
  async #releaseDocument(doc: PDFDocumentProxy): Promise<void> {
    try {
      await doc.destroy();
    } catch (error) {
      console.warn('이전 PDF 문서를 정리하지 못했습니다', error);
    }
  }

  /** doc을 명시로 받는다 — 호출 중 문서가 교체돼도 옛 dest를 새 문서에 풀지 않는다 (#35). */
  async #resolveDestPage(
    dest: string | unknown[] | null,
    doc: PDFDocumentProxy | null = this.#doc
  ): Promise<number | null> {
    if (!doc || !dest) return null;
    try {
      const destArray = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!destArray?.length) return null;
      const first = destArray[0];
      if (typeof first === 'number') return first + 1;
      if (first && typeof first === 'object' && 'num' in first && 'gen' in first) {
        return (await doc.getPageIndex(first as { num: number; gen: number })) + 1;
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
