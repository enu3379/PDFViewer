import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FigureEntry } from '../src/core/types';
import { FiguresTab, type FiguresTabCallbacks } from '../src/viewer/panel/tab-figures';

type Listener = (event: {
  target: FakeElement;
  preventDefault: () => void;
  stopPropagation: () => void;
}) => void;

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
  role = '';
  tabIndex = -1;
  title = '';
  decoding = '';
  attributes: Record<string, string> = {};
  classList = {
    add: () => {},
    toggle: () => {},
    contains: () => false
  };
  #listeners = new Map<string, Listener[]>();

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
  }

  set innerHTML(value: string) {
    if (value === '') this.children = [];
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  emit(type: string, target: FakeElement): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener({ target, preventDefault: () => {}, stopPropagation: () => {} });
    }
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

  querySelector(): FakeElement | null {
    return null;
  }

  closest(selector: string): FakeElement | null {
    const dataMatch = selector.match(/^\[data-([a-z-]+)\]$/);
    if (dataMatch) {
      const key = dataMatch[1].replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if (this.dataset[key] !== undefined) return this;
    } else if (selector.startsWith('.') && this.className.split(/\s+/).includes(selector.slice(1))) {
      return this;
    }
    return this.parent?.closest(selector) ?? null;
  }
}

const entry = (id: string, page: number, label: string): FigureEntry => ({
  id,
  doc: 'doc',
  kind: 'figure',
  num: label.replace(/\D+/g, ''),
  label,
  page,
  captionText: `${label}. Caption.`,
  region: null,
  regionSource: 'auto',
  confidence: 1
});

function makeCallbacks(onScan: FiguresTabCallbacks['onScan']): FiguresTabCallbacks {
  return {
    onScan,
    onJumpFigure: vi.fn(),
    onJumpMention: vi.fn(),
    onStartCrop: vi.fn(),
    onSaveCrop: vi.fn(),
    onRedoCrop: vi.fn(),
    onCancelCrop: vi.fn(),
    renderRegion: vi.fn(async () => null)
  };
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

  it('renders accessible cards after a scan and jumps via the preview control', async () => {
    const list = new FakeElement();
    const callbacks = makeCallbacks(vi.fn(async () => [entry('fig4-p4', 4, 'Figure 4')]));
    const tab = new FiguresTab(list as unknown as HTMLElement, callbacks);

    tab.setDocument([]);
    tab.ensureScanned();
    await vi.waitFor(() => expect(list.children[0]?.className).toContain('fig-card'));

    const preview = list.children[0].children[0];
    expect(preview.className).toBe('fig-preview');
    expect(preview.role).toBe('button');
    expect(preview.tabIndex).toBe(0);
    list.emit('click', preview);
    expect(callbacks.onJumpFigure).toHaveBeenCalledWith('fig4-p4');
  });

  it('offers a retry after failure and succeeds without replacing the document', async () => {
    const list = new FakeElement();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onScan = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce([]);
    const tab = new FiguresTab(list as unknown as HTMLElement, makeCallbacks(onScan));

    tab.setDocument([]);
    tab.ensureScanned();
    await vi.waitFor(() => expect(list.children[0]?.children[0]?.className).toContain('fig-retry'));
    expect(list.children[0].children[0].dataset.action).toBe('retry');

    list.emit('click', list.children[0].children[0]);
    await vi.waitFor(() => expect(onScan).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(list.children[0]?.textContent).toContain('감지된 figure가 없어요'));
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('discards a stale scan when the document changes', async () => {
    const list = new FakeElement();
    let resolveFirst: ((value: FigureEntry[]) => void) | undefined;
    const first = new Promise<FigureEntry[]>((resolve) => { resolveFirst = resolve; });
    const onScan = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce([entry('fig2-p2', 2, 'Figure 2')]);
    const tab = new FiguresTab(list as unknown as HTMLElement, makeCallbacks(onScan));

    tab.setDocument([]);
    tab.ensureScanned();
    tab.setDocument([]);
    tab.ensureScanned();
    await vi.waitFor(() => expect(list.children[0]?.dataset.fig).toBe('fig2-p2'));

    resolveFirst?.([entry('fig9-p9', 9, 'Figure 9')]);
    await Promise.resolve();
    expect(list.children[0]?.dataset.fig).toBe('fig2-p2');
  });
});
