import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import { FigExtract, type EngineFigure } from '../../core/fig-engine';
import { escapeHtml } from '../../core/format';

export type FiguresTabCallbacks = {
  onJumpToPage: (page: number) => void;
};

/**
 * 그림·표 탭 — fig-extract 엔진으로 문서를 스캔해 figure 프리뷰 카드를 렌더한다.
 * 스캔은 PDFDocumentProxy가 준비되는 즉시 1회 실행한다. 문서가 바뀌면 setDocument()로 리셋.
 */
export class FiguresTab {
  #list: HTMLElement;
  #callbacks: FiguresTabCallbacks;
  #doc: PDFDocumentProxy | null = null;
  #state: 'idle' | 'scanning' | 'done' | 'error' = 'idle';
  #figures: EngineFigure[] = [];
  #scanGeneration = 0;

  constructor(list: HTMLElement, callbacks: FiguresTabCallbacks) {
    this.#list = list;
    this.#callbacks = callbacks;
    this.#list.addEventListener('click', (event) => {
      const card = (event.target as Element).closest<HTMLElement>('.fig-card');
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

  /** 문서 로드 직후 호출된다. 탭 클릭 시 재호출되어도 최초 1회만 스캔한다. */
  ensureScanned(): void {
    if (this.#state !== 'idle' || !this.#doc) return;
    this.#state = 'scanning';
    void this.#scan(this.#scanGeneration);
  }

  async #scan(scanGeneration: number): Promise<void> {
    const doc = this.#doc;
    if (!doc) return;
    this.#setStatus('figure 스캔 중…');
    try {
      const result = await FigExtract.extract(null, {
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
      this.#setStatus('figure 스캔에 실패했어요. 콘솔 로그를 확인해주세요.');
    }
  }

  #setStatus(text: string): void {
    this.#list.innerHTML = `<div class="empty">${escapeHtml(text)}</div>`;
  }

  #render(): void {
    if (!this.#figures.length) {
      this.#setStatus('감지된 figure가 없어요. (스캔 PDF이거나 캡션 형식 미지원일 수 있어요)');
      return;
    }
    this.#list.innerHTML = '';
    for (const fig of this.#figures) {
      const card = document.createElement('article');
      card.className = 'fig-card';
      card.dataset.page = String(fig.page);
      const img = document.createElement('img');
      img.src = FigExtract.cropDataURL(fig);
      img.alt = `Figure ${fig.num}`;
      const head = document.createElement('div');
      head.className = 'fig-head';
      head.innerHTML = `<b>Figure ${escapeHtml(fig.num)}</b><span>p.${fig.page}</span>`;
      const caption = document.createElement('p');
      caption.className = 'fig-cap';
      caption.textContent = fig.caption;
      card.append(img, head, caption);
      this.#list.append(card);
    }
  }
}
