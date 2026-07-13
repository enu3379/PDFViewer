import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineFigure, EngineResult, FigExtractApi } from '../src/core/fig-engine';
import { FiguresTab } from '../src/viewer/panel/tab-figures';

type Listener = (event: { target: FakeElement }) => void;

class FakeElement {
  readonly tagName: string;
  className = '';
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent = '';
  type = '';
  src = '';
  alt = '';
  attributes: Record<string, string> = {};
  #listeners = new Map<string, Listener[]>();

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  emit(type: string, target: FakeElement): void {
    for (const listener of this.#listeners.get(type) ?? []) listener({ target });
  }

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = [];
    this.append(...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  closest(selector: string): FakeElement | null {
    if (selector.startsWith('.') && this.className.split(/\s+/).includes(selector.slice(1))) {
      return this;
    }
    return this.parent?.closest(selector) ?? null;
  }
}

const doc = {} as PDFDocumentProxy;
const figure = (page: number, num = String(page)): EngineFigure => ({
  num,
  page,
  confidence: 1,
  caption: `Figure ${num}`,
  bboxPt: { x0: 0, y0: 0, x1: 10, y1: 10 },
  captionBoxPt: { x0: 0, y0: 10, x1: 10, y1: 12 },
  bboxPx: { x0: 0, y0: 0, x1: 22, y1: 22 },
  canvas: {} as HTMLCanvasElement
});

const result = (figures: EngineFigure[]): EngineResult => ({
  title: null,
  numPages: 10,
  engineVersion: 'test',
  figures
});

function makeEngine(extract: FigExtractApi['extract']): Pick<FigExtractApi, 'extract' | 'cropDataURL'> {
  return { extract, cropDataURL: vi.fn(() => 'data:image/png;base64,test') };
}

describe('FiguresTab', () => {
  const originalDocument = globalThis.document;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: (tagName: string) => new FakeElement(tagName) }
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument
    });
    vi.restoreAllMocks();
  });

  it('renders native buttons and jumps when a card is activated', async () => {
    const list = new FakeElement();
    const onJumpToPage = vi.fn();
    const engine = makeEngine(vi.fn(async () => result([figure(4)])));
    const tab = new FiguresTab(
      list as unknown as HTMLElement,
      { onJumpToPage },
      engine
    );

    tab.setDocument(doc);
    await vi.waitFor(() => expect(list.children[0]?.className).toBe('fig-card'));

    const card = list.children[0];
    expect(card.tagName).toBe('BUTTON');
    expect(card.type).toBe('button');
    expect(card.attributes['aria-label']).toBe('Figure 4, 4페이지로 이동');
    list.emit('click', card);
    expect(onJumpToPage).toHaveBeenCalledWith(4);
  });

  it('offers a retry after failure and succeeds without replacing the document', async () => {
    const list = new FakeElement();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const extract = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(result([]));
    const tab = new FiguresTab(
      list as unknown as HTMLElement,
      { onJumpToPage: vi.fn() },
      makeEngine(extract)
    );

    tab.setDocument(doc);
    await vi.waitFor(() => expect(list.children[0]?.children[0]?.className).toContain('fig-retry'));

    list.emit('click', list.children[0].children[0]);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(list.children[0]?.textContent).toContain('감지된 figure가 없어요'));
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('discards a stale scan when the document changes', async () => {
    const list = new FakeElement();
    let resolveFirst: ((value: EngineResult) => void) | undefined;
    const first = new Promise<EngineResult>((resolve) => { resolveFirst = resolve; });
    const extract = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(result([figure(2)]));
    const tab = new FiguresTab(
      list as unknown as HTMLElement,
      { onJumpToPage: vi.fn() },
      makeEngine(extract)
    );

    tab.setDocument(doc);
    tab.setDocument({} as PDFDocumentProxy);
    await vi.waitFor(() => expect(list.children[0]?.dataset.page).toBe('2'));

    resolveFirst?.(result([figure(9)]));
    await Promise.resolve();
    expect(list.children[0]?.dataset.page).toBe('2');
  });
});
