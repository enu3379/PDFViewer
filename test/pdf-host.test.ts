import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';

/* pdf.js는 워커를 띄우고 실제 DOM에 렌더하므로 통째로 대역을 세운다 — 여기서 검증하는 것은
 * PdfHost의 문서 교체 순서와 이전 문서 정리(#35)뿐이다. */
const getDocument = vi.fn();
const linkServiceSetDocument = vi.fn();
const viewerSetDocument = vi.fn();

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => getDocument(...args),
  version: '4.10.38'
}));

vi.mock('pdfjs-dist/build/pdf.worker.mjs?url', () => ({ default: 'worker.mjs' }));

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  EventBus: class {
    on(): void {}
  },
  LinkTarget: { BLANK: 2 },
  PDFLinkService: class {
    setViewer(): void {}
    setDocument(...args: unknown[]): void {
      linkServiceSetDocument(...args);
    }
  },
  PDFViewer: class {
    currentPageNumber = 1;
    currentScaleValue = '';
    setDocument(...args: unknown[]): void {
      viewerSetDocument(...args);
    }
  }
}));

/* 정적 import는 위 vi.mock 팩토리가 닫아 잡는 const들(:8-10) 위로 호이스팅돼
 * "Cannot access 'getDocument' before initialization"으로 죽는다 — 동적 import여야 한다. */
const { PdfHost } = await import('../src/viewer/pdf-host');

/** destroy 호출을 기록하는 문서 대역. numPages만 실제로 읽힌다. */
function makeDoc(label: string, destroy: () => Promise<void> = async () => {}): PDFDocumentProxy {
  return { label, numPages: 3, destroy: vi.fn(destroy) } as unknown as PDFDocumentProxy;
}
const destroyOf = (doc: PDFDocumentProxy) => (doc as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy;

function makeHost(): InstanceType<typeof PdfHost> {
  return new PdfHost({
    container: {} as HTMLDivElement,
    viewer: {} as HTMLDivElement
  });
}

const asFile = () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as File;

/** loadFile 경로로 문서를 주입한다 (File.arrayBuffer만 필요). */
async function load(host: InstanceType<typeof PdfHost>, doc: PDFDocumentProxy): Promise<void> {
  getDocument.mockReturnValueOnce({ promise: Promise.resolve(doc), destroy: vi.fn(async () => {}) });
  await host.loadFile(asFile());
}

describe('PdfHost document lifecycle', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { requestAnimationFrame: () => 0 }
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    /* clearAllMocks는 호출 기록만 지운다 — 테스트 안에서 심은 mockImplementation과 console spy가
     * 다음 테스트로 새 나가므로 restore여야 한다. */
    vi.restoreAllMocks();
    getDocument.mockReset();
    linkServiceSetDocument.mockReset();
    viewerSetDocument.mockReset();
  });

  it('keeps the first document alive', async () => {
    const host = makeHost();
    const first = makeDoc('first');

    await load(host, first);

    expect(host.pdfDocument).toBe(first);
    expect(destroyOf(first)).not.toHaveBeenCalled();
  });

  it('destroys the previous document and never the current one (#35)', async () => {
    const host = makeHost();
    const first = makeDoc('first');
    const second = makeDoc('second');

    await load(host, first);
    await load(host, second);

    expect(destroyOf(first)).toHaveBeenCalledTimes(1);
    expect(destroyOf(second)).not.toHaveBeenCalled();
    expect(host.pdfDocument).toBe(second);
  });

  it('destroys the previous document only after the viewer switched over (#35)', async () => {
    const order: string[] = [];
    const host = makeHost();
    const first = makeDoc('first', async () => { order.push('destroy:first'); });
    const second = makeDoc('second');
    viewerSetDocument.mockImplementation((doc: PDFDocumentProxy) => {
      order.push(`viewer:${(doc as unknown as { label: string }).label}`);
    });
    linkServiceSetDocument.mockImplementation((doc: PDFDocumentProxy) => {
      order.push(`link:${(doc as unknown as { label: string }).label}`);
    });

    await load(host, first);
    await load(host, second);
    await vi.waitFor(() => expect(order).toContain('destroy:first'));

    /* pdf.js의 PDFViewer.setDocument는 나가는 문서를 **동기로** 정리한다(render/textLayer cancel →
     * _resetView). 그 정리가 옛 proxy를 만지므로 destroy가 먼저 오면 파괴된 문서를 건드린다.
     * 대역은 그 내부 동작을 재현하지 않으므로 여기서 고정하는 것은 **호출 순서**다. */
    expect(order.indexOf('destroy:first')).toBeGreaterThan(order.indexOf('viewer:second'));
    expect(order).toEqual([
      'link:first', 'viewer:first',
      'link:second', 'viewer:second',
      'destroy:first'
    ]);
  });

  it('survives a document that fails to destroy (#35)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = makeHost();
    const first = makeDoc('first', async () => { throw new Error('worker already gone'); });
    const second = makeDoc('second');

    await load(host, first);
    await load(host, second);

    /* 정리 실패는 warn 한 줄로 끝나고 새 문서 전환은 완료돼 있어야 한다. destroy는 void 처리라
     * load 자체는 어차피 resolve하므로 그것만으로는 아무것도 증명하지 못한다 — 여기가 본체다. */
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(host.pdfDocument).toBe(second);
    expect(viewerSetDocument).toHaveBeenLastCalledWith(second);
  });

  it('destroys the loading task when a load fails, so no worker is orphaned (#35)', async () => {
    const host = makeHost();
    const first = makeDoc('first');
    await load(host, first);

    const taskDestroy = vi.fn(async () => {});
    getDocument.mockReturnValueOnce({
      promise: Promise.reject(new Error('missing file')),
      destroy: taskDestroy
    });

    await expect(host.loadFile(asFile())).rejects.toThrow('missing file');
    await vi.waitFor(() => expect(taskDestroy).toHaveBeenCalledTimes(1));
    /* 실패한 로드는 화면에 남아 있는 문서를 건드리지 않는다 — 정리는 다음 성공 로드로 밀린다 */
    expect(host.pdfDocument).toBe(first);
    expect(destroyOf(first)).not.toHaveBeenCalled();
  });

  it('flattens the outline of the current document', async () => {
    const host = makeHost();
    const doc = makeDoc('only');
    Object.assign(doc, {
      getOutline: async () => [
        { title: 'Ch 1', dest: 'ch1', url: null, items: [{ title: 'Ch 1.1', dest: null, url: null }] }
      ],
      getDestination: async () => [{ num: 5, gen: 0 }],
      getPageIndex: async () => 2
    });
    await load(host, doc);

    const items = await host.getOutlineItems();
    expect(items.map((item) => [item.title, item.depth, item.page])).toEqual([
      ['Ch 1', 0, 3],
      ['Ch 1.1', 1, null]
    ]);
  });

  it('returns no outline instead of throwing when the read fails (#35)', async () => {
    const host = makeHost();
    const doc = makeDoc('only');
    /* destroy된 문서의 getOutline은 AbortException으로 거절한다. 이게 새어나가면 **이전 로드의
     * catch**로 흘러가 방금 열린 새 문서 위에 오류 화면을 띄운다 — 그래서 삼켜야 한다. */
    Object.assign(doc, { getOutline: async () => { throw new Error('Worker was terminated.'); } });
    await load(host, doc);

    await expect(host.getOutlineItems()).resolves.toEqual([]);
  });

  it('discards an outline whose document was swapped out mid-read (#35)', async () => {
    const host = makeHost();
    let releaseOutline!: (nodes: unknown[]) => void;
    const first = makeDoc('first');
    Object.assign(first, {
      getOutline: () => new Promise((resolve) => { releaseOutline = resolve as typeof releaseOutline; }),
      getDestination: async () => [{ num: 1, gen: 0 }],
      getPageIndex: async () => 0
    });
    const second = makeDoc('second');

    await load(host, first);
    const pending = host.getOutlineItems();
    await load(host, second);                                   // 조회 중 문서 교체
    releaseOutline([{ title: 'stale', dest: 'x', url: null }]);

    /* 옛 문서의 목차로 새 문서의 TOC를 덮지 않는다 */
    await expect(pending).resolves.toEqual([]);
    expect(host.pdfDocument).toBe(second);
  });

  it('discards a late load instead of destroying the document the user actually opened (#35)', async () => {
    const host = makeHost();
    let releaseSlow!: (doc: PDFDocumentProxy) => void;
    const slow = makeDoc('slow');
    const fast = makeDoc('fast');

    /* 느린 URL 로드(A)가 진행 중일 때 사용자가 파일(B)을 드롭하는 상황 */
    getDocument.mockReturnValueOnce({
      promise: new Promise<PDFDocumentProxy>((resolve) => { releaseSlow = resolve; }),
      destroy: vi.fn(async () => {})
    });
    const slowLoad = host.loadUrl('https://example.com/slow.pdf');
    await load(host, fast);
    expect(host.pdfDocument).toBe(fast);

    releaseSlow(slow);

    /* 밀려난 로드는 오류가 아니라 "물러남" 신호로 끝나고, 자기가 받은 문서를 스스로 버린다 */
    await expect(slowLoad).rejects.toMatchObject({ name: 'PdfLoadSupersededError' });
    await vi.waitFor(() => expect(destroyOf(slow)).toHaveBeenCalledTimes(1));
    /* 사용자가 마지막으로 요청한 문서는 살아 있고 화면에도 그대로다 */
    expect(destroyOf(fast)).not.toHaveBeenCalled();
    expect(host.pdfDocument).toBe(fast);
    expect(viewerSetDocument).toHaveBeenLastCalledWith(fast);
  });

  it('reports a late load FAILURE as superseded, not as an error (#35)', async () => {
    const host = makeHost();
    let failSlow!: (reason: Error) => void;
    const taskDestroy = vi.fn(async () => {});
    const fast = makeDoc('fast');

    getDocument.mockReturnValueOnce({
      promise: new Promise<PDFDocumentProxy>((_resolve, reject) => { failSlow = reject; }),
      destroy: taskDestroy
    });
    const slowLoad = host.loadUrl('https://example.com/slow.pdf');
    await load(host, fast);

    failSlow(Object.assign(new Error('missing'), { name: 'MissingPDFException' }));

    /* 원본 오류를 그대로 올려보내면 호출 측이 figuresTab을 비우고 오류 화면을 띄운다 —
     * 그 화면에는 사용자가 실제로 연 문서가 떠 있다. superseded로 바꿔야 조용히 물러난다. */
    await expect(slowLoad).rejects.toMatchObject({ name: 'PdfLoadSupersededError' });
    await vi.waitFor(() => expect(taskDestroy).toHaveBeenCalledTimes(1));
    expect(host.pdfDocument).toBe(fast);
    expect(destroyOf(fast)).not.toHaveBeenCalled();
  });

  it('still reports a current load failure as a real error (#35)', async () => {
    const host = makeHost();
    getDocument.mockReturnValueOnce({
      promise: Promise.reject(Object.assign(new Error('missing'), { name: 'MissingPDFException' })),
      destroy: vi.fn(async () => {})
    });

    /* 밀려나지 않은 로드의 실패는 그대로 올라가야 한다 — 안 그러면 오류 화면이 영영 안 뜬다 */
    await expect(host.loadFile(asFile())).rejects.toMatchObject({ name: 'MissingPDFException' });
  });

  it('does not destroy a document that is being re-set as the same instance (#35)', async () => {
    const host = makeHost();
    const doc = makeDoc('same');

    await load(host, doc);
    await load(host, doc);

    expect(destroyOf(doc)).not.toHaveBeenCalled();
    expect(host.pdfDocument).toBe(doc);
  });
});
