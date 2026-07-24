import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import { FigExtract, type EngineFigure, type FigExtractApi } from '../../core/fig-engine';

export type FiguresTabCallbacks = {
  onJumpToPage: (page: number) => void;
};

type FiguresTabEngine = Pick<FigExtractApi, 'extract' | 'cropDataURL'>;

/**
 * 그림·표 탭 — fig-extract 엔진으로 문서를 스캔해 figure 프리뷰 카드를 렌더한다.
 * 스캔은 PDFDocumentProxy가 준비되는 즉시 1회 실행한다. 문서가 바뀌면 setDocument()로 리셋.
 */
export class FiguresTab {
  #list: HTMLElement;
  #callbacks: FiguresTabCallbacks;
  #engine: FiguresTabEngine;
  #doc: PDFDocumentProxy | null = null;
  #state: 'idle' | 'scanning' | 'done' | 'error' = 'idle';
  #figures: EngineFigure[] = [];
  #scanGeneration = 0;

  constructor(
    list: HTMLElement,
    callbacks: FiguresTabCallbacks,
    engine: FiguresTabEngine = FigExtract
  ) {
    this.#list = list;
    this.#callbacks = callbacks;
    this.#engine = engine;
    this.#list.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      if (target?.closest('.fig-retry')) {
        this.ensureScanned();
        return;
      }
      const card = target?.closest<HTMLElement>('.fig-card');
      if (!card) return;
      const page = Number(card.dataset.page);
      if (page) this.#callbacks.onJumpToPage(page);
    });
  }

  setDocument(doc: PDFDocumentProxy | null): void {
    this.#scanGeneration += 1;
    this.#doc = doc;
    this.#state = 'idle';
    this.#figures = [];
    this.#setStatus(doc ? 'figure 스캔 준비 중…' : 'PDF를 열면 그림·표를 자동으로 스캔합니다.');
    this.ensureScanned();
  }

  /** 문서 로드 직후 호출된다. 실패 상태에서는 같은 문서 스캔을 다시 시도할 수 있다. */
  ensureScanned(): void {
    if ((this.#state !== 'idle' && this.#state !== 'error') || !this.#doc) return;
    this.#state = 'scanning';
    void this.#scan(this.#scanGeneration);
  }

  async #scan(scanGeneration: number): Promise<void> {
    const doc = this.#doc;
    if (!doc) return;
    this.#setStatus('figure 스캔 중…');
    try {
      const result = await this.#engine.extract(null, {
        pdfDocument: doc,
        onProgress: (msg) => {
          if (this.#scanGeneration === scanGeneration) this.#setStatus(msg);
        }
      });
      if (this.#scanGeneration !== scanGeneration) return;
      this.#figures = result.figures;
      this.#state = 'done';
      this.#render();
    } catch (error) {
      if (this.#scanGeneration !== scanGeneration) return;
      console.error('figure 스캔 실패', error);
      this.#state = 'error';
      this.#setStatus('figure 스캔에 실패했어요.', true);
    }
  }

  #setStatus(text: string, retry = false): void {
    const state = document.createElement('div');
    state.className = 'empty';
    state.textContent = text;
    if (retry) {
      const button = document.createElement('button');
      button.className = 'lnkbtn fig-retry';
      button.type = 'button';
      button.textContent = '다시 시도';
      state.append(button);
    }
    this.#list.replaceChildren(state);
  }

  #render(): void {
    if (!this.#figures.length) {
      this.#setStatus('감지된 figure가 없어요. (스캔 PDF이거나 캡션 형식 미지원일 수 있어요)');
      return;
    }
    this.#list.replaceChildren();
    for (const fig of this.#figures) {
      const card = document.createElement('button');
      card.className = 'fig-card';
      card.type = 'button';
      card.dataset.page = String(fig.page);
      card.setAttribute('aria-label', `Figure ${fig.num}, ${fig.page}페이지로 이동`);
      const img = document.createElement('img');
      img.src = this.#engine.cropDataURL(fig);
      img.alt = `Figure ${fig.num}`;
      const head = document.createElement('span');
      head.className = 'fig-head';
      const label = document.createElement('b');
      label.textContent = `Figure ${fig.num}`;
      const page = document.createElement('span');
      page.textContent = `p.${fig.page}`;
      head.append(label, page);
      const caption = document.createElement('span');
      caption.className = 'fig-cap';
      caption.textContent = fig.caption;
      card.append(img, head, caption);
      this.#list.append(card);
    }
  }
}
