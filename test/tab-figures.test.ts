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
const figure = (
  page: number,
  num = String(page),
  captionPage?: number
): EngineFigure => ({
  num,
  page,
  /* 엔진은 captionPage가 page와 다를 때만 필드를 싣는다 — 없는 상태도 그대로 재현한다 */
  ...(captionPage === undefined ? {} : { captionPage }),
  confidence: 1,
  caption: `Figure ${num}`,
  bboxPt: { x0: 0, y0: 0, x1: 10, y1: 10 },
  captionBoxPt: { x0: 0, y0: 10, x1: 10, y1: 12 },
  bboxPx: { x0: 0, y0: 0, x1: 22, y1: 22 }
});

const result = (figures: EngineFigure[]): EngineResult => ({
  title: null,
  numPages: 10,
  engineVersion: 'test',
  suspectedMissing: [],
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

  /* v2.19.0 12-B: 캡션은 7페이지, 그림은 6페이지. 카드가 가리키는 것은 **그림 페이지**다 —
   * 식별 키가 (num, page)이고 사용자가 카드를 눌러 보고 싶은 것도 그림이다. captionPage로
   * 바꾸는 뮤테이션을 이 테스트가 죽인다 (기존 픽스처는 captionPage가 없어 구별 불가였다). */
  it('points cards at the figure page, not the caption page', async () => {
    const list = new FakeElement();
    const onJumpToPage = vi.fn();
    const engine = makeEngine(vi.fn(async () => result([figure(6, '4', 7)])));
    const tab = new FiguresTab(
      list as unknown as HTMLElement,
      { onJumpToPage },
      engine
    );

    tab.setDocument(doc);
    await vi.waitFor(() => expect(list.children[0]?.className).toBe('fig-card'));

    const card = list.children[0];
    expect(card.dataset.page).toBe('6');
    expect(card.attributes['aria-label']).toBe('Figure 4, 6페이지로 이동');
    /* 카드 머리의 "p.N" 칩도 그림 페이지다 (children: img, head[label, page], caption) */
    expect(card.children[1].children[1].textContent).toBe('p.6');
    list.emit('click', card);
    expect(onJumpToPage).toHaveBeenCalledWith(6);
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

  /* 엔진 v2.19.1+는 렌더 결과가 존재하지 않을 때(메모리 압력으로 Chrome이 캔버스 백킹 스토어를
   * 회수) `name === 'FigRenderError'`로 거절한다. 일시적 조건이라 재시도가 유효하므로 일반
   * 실패와 다른 문구를 준다 — 통합 규약 §주의사항 `FigRenderError`. */
  it('tells the user to retry when the engine reports a dead canvas', async () => {
    const list = new FakeElement();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const renderError = new Error('페이지 렌더 결과가 비어 있습니다');
    renderError.name = 'FigRenderError';
    const tab = new FiguresTab(
      list as unknown as HTMLElement,
      { onJumpToPage: vi.fn() },
      makeEngine(vi.fn(async () => { throw renderError; }))
    );

    tab.setDocument(doc);
    await vi.waitFor(() => expect(list.children[0]?.children[0]?.className).toContain('fig-retry'));
    expect(list.children[0]?.textContent).toContain('메모리가 부족했을 수 있어요');
  });

  /* 엔진의 판별식은 `!!error && error.name === "FigRenderError"`다. 소비자가 `instanceof Error`를
   * 덧붙이면 realm 경계나 구조화 복제를 넘어온 거절에서 이름은 맞는데 분기만 조용히 사라진다.
   * Error 인스턴스가 아닌 거절로 그 좁힘을 죽인다. */
  it('recognises the engine error by name alone, not by instanceof', async () => {
    const list = new FakeElement();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tab = new FiguresTab(
      list as unknown as HTMLElement,
      { onJumpToPage: vi.fn() },
      makeEngine(vi.fn(async () => {
        throw { name: 'FigRenderError', message: '페이지 렌더 결과가 비어 있습니다' };
      }))
    );

    tab.setDocument(doc);
    await vi.waitFor(() => expect(list.children[0]?.children[0]?.className).toContain('fig-retry'));
    expect(list.children[0]?.textContent).toContain('메모리가 부족했을 수 있어요');
  });

  it('keeps the generic message for other failures', async () => {
    const list = new FakeElement();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tab = new FiguresTab(
      list as unknown as HTMLElement,
      { onJumpToPage: vi.fn() },
      makeEngine(vi.fn(async () => { throw new Error('boom'); }))
    );

    tab.setDocument(doc);
    await vi.waitFor(() => expect(list.children[0]?.children[0]?.className).toContain('fig-retry'));
    expect(list.children[0]?.textContent).toContain('figure 스캔에 실패했어요');
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

  it('aborts the in-flight scan when the document changes (#34)', async () => {
    const list = new FakeElement();
    const signals: (AbortSignal | undefined)[] = [];
    /* 첫 스캔은 abort될 때까지 매달아 둔다 — 엔진이 signal을 받아 AbortError로 reject하는
     * 동작을 모사한다 (실제 엔진은 페이지 경계에서 체크한다). */
    const extract = vi.fn(async (_data, opts) => {
      signals.push(opts?.signal);
      if (signals.length === 1) {
        return await new Promise<EngineResult>((_resolve, reject) => {
          /* 엔진이 실제로 던지는 것과 같은 형태로 거절한다 (fig-extract.js의
           * `new DOMException("figure 추출이 취소됨", "AbortError")`). */
          opts?.signal?.addEventListener('abort', () => {
            reject(new DOMException('figure 추출이 취소됨', 'AbortError'));
          });
        });
      }
      return result([figure(2)]);
    }) as unknown as FigExtractApi['extract'];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tab = new FiguresTab(
      list as unknown as HTMLElement,
      { onJumpToPage: vi.fn() },
      makeEngine(extract)
    );

    tab.setDocument(doc);
    await vi.waitFor(() => expect(signals.length).toBe(1));
    expect(signals[0]?.aborted).toBe(false);

    tab.setDocument({} as PDFDocumentProxy);
    /* 수용 기준 ①: 이전 스캔이 실제로 중단된다 (결과만 버리는 게 아니다) */
    expect(signals[0]?.aborted).toBe(true);

    /* 수용 기준 ③: 새 문서 스캔은 정상 렌더된다 */
    await vi.waitFor(() => expect(list.children[0]?.dataset.page).toBe('2'));
    /* 수용 기준 ②: 취소는 정상 흐름 — 에러 UI도 콘솔 오류도 남기지 않는다 */
    expect(list.children[0]?.className).toBe('fig-card');
    expect(consoleError).not.toHaveBeenCalled();
  });

  /* 재시도가 자기 스캔을 죽이지 않는다는 것은 **구조적으로** 보장된다 — 재시도는 종료 상태
   * 'error'에서만 진입하고 그때 #scanAbort는 이미 정리돼 있다. 즉 abort 호출을 ensureScanned로
   * 옮기는 변형은 도달 가능한 경로에서 현재 코드와 동작이 같아 테스트로 구별할 수 없다.
   * 그래서 이 테스트가 실제로 고정하는 것은 "재시도 스캔도 signal을 받고 그 signal이 살아 있다"다. */
  it('gives the retry scan a live signal of its own (#34)', async () => {
    const list = new FakeElement();
    const signals: (AbortSignal | undefined)[] = [];
    const extract = vi.fn(async (_data, opts) => {
      signals.push(opts?.signal);
      if (signals.length === 1) throw new Error('temporary failure');
      return result([figure(3)]);
    }) as unknown as FigExtractApi['extract'];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tab = new FiguresTab(
      list as unknown as HTMLElement,
      { onJumpToPage: vi.fn() },
      makeEngine(extract)
    );

    tab.setDocument(doc);
    await vi.waitFor(() => expect(list.children[0]?.children[0]?.className).toContain('fig-retry'));

    list.emit('click', list.children[0].children[0]);
    await vi.waitFor(() => expect(list.children[0]?.dataset.page).toBe('3'));
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    expect(signals[1]?.aborted).toBe(false);
    expect(signals[1]).not.toBe(signals[0]);   // 스캔마다 자기 컨트롤러를 갖는다
  });
});
