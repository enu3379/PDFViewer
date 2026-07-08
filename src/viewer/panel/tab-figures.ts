import type { FigureReference } from '../../core/mentions';
import type { FigureEntry, PdfRect } from '../../core/types';

type Region = { page: number; rect: PdfRect };

export type CropPreviewState = {
  figId: string;
  region: Region;
};

export type FiguresTabCallbacks = {
  onScan: (setStatus: (text: string) => void) => Promise<FigureEntry[]>;
  onJumpFigure: (figId: string) => void;
  onJumpMention: (refKey: string) => void;
  onStartCrop: (figId: string) => void;
  onSaveCrop: () => void;
  onRedoCrop: (figId: string) => void;
  onCancelCrop: () => void;
  renderRegion: (region: Region) => Promise<string | null>;
};

/**
 * 그림·표 탭 — 저장된 FigureEntry를 렌더하고, 없으면 fig-extract 스캔을 요청한다.
 * 스캔은 문서 로드 직후 자동 시작한다(탭 클릭 시 재호출돼도 1회, 실패 상태에서는 재시도).
 * 문서가 바뀌면 setDocument()로 리셋.
 */
export class FiguresTab {
  #list: HTMLElement;
  #callbacks: FiguresTabCallbacks;
  #state: 'idle' | 'scanning' | 'done' | 'error' = 'idle';
  #figures: FigureEntry[] = [];
  #mentions: FigureReference[] = [];
  #activeFigId: string | null = null;
  #originRefKey: string | null = null;
  #cropPreview: CropPreviewState | null = null;
  #imageUrls = new Map<string, string>();
  #renderGeneration = 0;
  #scanGeneration = 0;

  constructor(list: HTMLElement, callbacks: FiguresTabCallbacks) {
    this.#list = list;
    this.#callbacks = callbacks;
    this.#list.addEventListener('click', (event) => this.#handleClick(event));
    this.#list.addEventListener('keydown', (event) => this.#handleKeyDown(event));
  }

  setDocument(figures: FigureEntry[]): void {
    this.#scanGeneration += 1;
    this.#figures = figures;
    this.#mentions = [];
    this.#activeFigId = null;
    this.#originRefKey = null;
    this.#cropPreview = null;
    this.#imageUrls.clear();
    this.#state = figures.length ? 'done' : 'idle';
    this.#render();
  }

  setData(figures: FigureEntry[], mentions: FigureReference[]): void {
    this.#figures = figures;
    this.#mentions = mentions;
    if (figures.length && this.#state !== 'scanning') this.#state = 'done';
    this.#render();
  }

  setCropPreview(preview: CropPreviewState | null): void {
    this.#cropPreview = preview;
    this.#render();
  }

  focusFigure(figId: string, originRefKey: string | null = null): void {
    this.#activeFigId = figId;
    this.#originRefKey = originRefKey;
    this.#render();
    window.requestAnimationFrame(() => {
      const card = this.#list.querySelector<HTMLElement>(`.fig-card[data-fig="${CSS.escape(figId)}"]`);
      card?.scrollIntoView({ block: 'nearest' });
    });
  }

  /** 문서 로드 직후 호출 — 저장 데이터가 없으면 최초 1회 스캔. 실패 상태에서는 재시도. */
  ensureScanned(): void {
    if (this.#state === 'scanning' || this.#figures.length) return;
    this.#state = 'scanning';
    const generation = this.#scanGeneration;
    this.#setStatus('figure 스캔 중...');
    void this.#callbacks.onScan((msg) => {
        if (generation === this.#scanGeneration) this.#setStatus(msg);
      })
      .then((figures) => {
        if (generation !== this.#scanGeneration) return;
        this.#figures = figures;
        this.#state = 'done';
        this.#render();
      })
      .catch((error) => {
        if (generation !== this.#scanGeneration) return;
        console.error('figure 스캔 실패', error);
        this.#state = 'error';
        this.#setStatus('figure 스캔에 실패했어요.', true);
      });
  }

  #handleClick(event: Event): void {
    const target = event.target as Element;
    const action = target.closest<HTMLElement>('[data-action]');
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();

    const figId = action.dataset.fig;
    switch (action.dataset.action) {
      case 'jump':
        if (figId) this.#callbacks.onJumpFigure(figId);
        break;
      case 'mention':
        if (action.dataset.refKey) this.#callbacks.onJumpMention(action.dataset.refKey);
        break;
      case 'crop':
        if (figId) this.#callbacks.onStartCrop(figId);
        break;
      case 'save-crop':
        this.#callbacks.onSaveCrop();
        break;
      case 'redo-crop':
        if (figId) this.#callbacks.onRedoCrop(figId);
        break;
      case 'cancel-crop':
        this.#callbacks.onCancelCrop();
        break;
      case 'retry':
        this.ensureScanned();
        break;
      case 'rescan':
        this.#scanGeneration += 1;
        this.#state = 'idle';
        this.#figures = [];
        this.#mentions = [];
        this.ensureScanned();
        break;
    }
  }

  #handleKeyDown(event: KeyboardEvent): void {
    const target = event.target as Element;
    const action = target.closest<HTMLElement>('[role="button"][data-action]');
    if (!action || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    action.click();
  }

  #setStatus(text: string, retry = false): void {
    const state = document.createElement('div');
    state.className = 'empty';
    state.textContent = text;
    if (retry) {
      const button = document.createElement('button');
      button.className = 'lnkbtn fig-retry';
      button.type = 'button';
      button.dataset.action = 'retry';
      button.textContent = '다시 시도';
      state.append(button);
    }
    this.#list.replaceChildren(state);
  }

  #render(): void {
    this.#renderGeneration += 1;
    const generation = this.#renderGeneration;
    if (this.#state === 'idle') {
      this.#setStatus('PDF를 열면 그림·표를 자동으로 스캔합니다.');
      return;
    }
    if (!this.#figures.length) {
      if (this.#state === 'scanning') return;
      if (this.#state === 'error') return;
      this.#setStatus('감지된 figure가 없어요. (스캔 PDF이거나 캡션 형식 미지원일 수 있어요)');
      return;
    }

    this.#list.innerHTML = '';
    this.#list.classList.add('fig-list');
    for (const fig of this.#figures) {
      this.#list.append(this.#renderCard(fig, generation));
    }

    const rescan = document.createElement('button');
    rescan.type = 'button';
    rescan.className = 'lnkbtn fig-rescan';
    rescan.dataset.action = 'rescan';
    rescan.textContent = '다시 스캔';
    this.#list.append(rescan);
  }

  #renderCard(fig: FigureEntry, generation: number): HTMLElement {
    const card = document.createElement('article');
    card.className = `fig-card${fig.id === this.#activeFigId ? ' on' : ''}`;
    card.dataset.fig = fig.id;

    const preview = document.createElement('div');
    preview.className = 'fig-preview';
    preview.dataset.action = 'jump';
    preview.dataset.fig = fig.id;
    preview.role = 'button';
    preview.tabIndex = 0;
    preview.title = '본문 위치로 이동';
    this.#appendRegionImage(preview, fig.region, fig.label, generation, fig.id);

    const crop = document.createElement('button');
    crop.type = 'button';
    crop.className = 'fig-crop';
    crop.dataset.action = 'crop';
    crop.dataset.fig = fig.id;
    crop.title = '영역 지정';
    crop.setAttribute('aria-label', '영역 지정');
    crop.textContent = '⌗';
    preview.append(crop);

    const head = document.createElement('div');
    head.className = 'fig-head';
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'fig-label';
    label.dataset.action = 'jump';
    label.dataset.fig = fig.id;
    label.textContent = fig.label;
    const page = document.createElement('span');
    page.textContent = `p.${fig.page}`;
    head.append(label, page);

    const caption = document.createElement('p');
    caption.className = 'fig-cap';
    caption.textContent = fig.captionText;

    card.append(preview, head, caption);
    const cropControls = this.#renderCropControls(fig, generation);
    if (cropControls) card.append(cropControls);

    const mentions = this.#mentionsForFigure(fig.id);
    if (mentions.length) card.append(this.#renderMentions(mentions));
    return card;
  }

  #appendRegionImage(
    parent: HTMLElement,
    region: Region | null,
    alt: string,
    generation: number,
    cachePrefix: string
  ): void {
    if (!region) {
      const empty = document.createElement('div');
      empty.className = 'fig-img-empty';
      empty.textContent = '영역 없음';
      parent.append(empty);
      return;
    }

    const key = `${cachePrefix}:${region.page}:${region.rect.join(',')}`;
    const img = document.createElement('img');
    img.alt = alt;
    img.decoding = 'async';
    const cached = this.#imageUrls.get(key);
    if (cached) {
      img.src = cached;
      parent.append(img);
      return;
    }

    const loading = document.createElement('div');
    loading.className = 'fig-img-empty';
    loading.textContent = '렌더 중...';
    parent.append(loading);
    void this.#callbacks.renderRegion(region).then((url) => {
      if (!url || generation !== this.#renderGeneration) return;
      this.#imageUrls.set(key, url);
      img.src = url;
      loading.replaceWith(img);
    });
  }

  #renderCropControls(fig: FigureEntry, generation: number): HTMLElement | null {
    if (this.#cropPreview?.figId !== fig.id) return null;

    const controls = document.createElement('div');
    controls.className = 'fig-crop-panel';
    const preview = document.createElement('div');
    preview.className = 'fig-crop-preview';
    this.#appendRegionImage(preview, this.#cropPreview.region, '새 영역 미리보기', generation, `crop-${fig.id}`);

    const row = document.createElement('div');
    row.className = 'fig-crop-actions';
    row.append(
      actionButton('save-crop', '저장'),
      actionButton('redo-crop', '다시 지정', fig.id),
      actionButton('cancel-crop', '취소')
    );
    controls.append(preview, row);
    return controls;
  }

  #mentionsForFigure(figId: string): FigureReference[] {
    const mentions = this.#mentions.filter((mention) => mention.figId === figId);
    if (!this.#originRefKey) return mentions;
    return mentions.slice().sort((a, b) => {
      if (a.key === this.#originRefKey) return -1;
      if (b.key === this.#originRefKey) return 1;
      return a.page - b.page || a.start - b.start;
    });
  }

  #renderMentions(mentions: FigureReference[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'fig-mentions';
    const label = document.createElement('div');
    label.className = 'fig-mentions-title';
    label.textContent = `본문 언급 ${mentions.length}곳`;
    wrap.append(label);

    const chips = document.createElement('div');
    chips.className = 'fig-mention-list';
    for (const mention of mentions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `fig-mention${mention.key === this.#originRefKey ? ' origin' : ''}`;
      chip.dataset.action = 'mention';
      chip.dataset.refKey = mention.key;
      chip.textContent = `${mention.key === this.#originRefKey ? '↩ ' : ''}p.${mention.page} ${mention.quote}`;
      chips.append(chip);
    }
    wrap.append(chips);
    return wrap;
  }
}

function actionButton(action: string, text: string, figId?: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = action === 'save-crop' ? 'btn pri' : 'btn';
  button.dataset.action = action;
  if (figId) button.dataset.fig = figId;
  button.textContent = text;
  return button;
}
