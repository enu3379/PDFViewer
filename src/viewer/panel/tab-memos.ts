import { escapeHtml, formatShortDate, renderRichText } from '../../core/format';
import type { Highlight, Memo, PenColor } from '../../core/types';

export type MemoTabCallbacks = {
  onPenChange: (color: PenColor) => void;
  onSaveHighlightMemo: (highlightId: string, text: string) => void;
  onDeleteHighlight: (highlightId: string) => void;
  onDeleteMemo: (memoId: string) => void;
  onJumpHighlight: (highlightId: string) => void;
};

type MemoTabElements = {
  composeSlot: HTMLElement;
  pensRow: HTMLElement;
  memoSearch: HTMLInputElement;
  memoCount: HTMLElement;
  memoTabN: HTMLElement;
  memoList: HTMLElement;
};

type ComposeState = {
  highlightId: string;
};

const PEN_COLORS: PenColor[] = ['amber', 'teal', 'pink', 'blue'];

export class MemoTab {
  #elements: MemoTabElements;
  #callbacks: MemoTabCallbacks;
  #highlights: Highlight[] = [];
  #memos: Memo[] = [];
  #lost = new Set<string>();
  #currentPen: PenColor = 'amber';
  #compose: ComposeState | null = null;

  constructor(elements: MemoTabElements, callbacks: MemoTabCallbacks) {
    this.#elements = elements;
    this.#callbacks = callbacks;
    this.#bind();
  }

  setData(highlights: Highlight[], memos: Memo[], lost: Set<string>, currentPen: PenColor): void {
    this.#highlights = highlights;
    this.#memos = memos;
    this.#lost = lost;
    this.#currentPen = currentPen;
    this.render();
  }

  openComposeForHighlight(highlightId: string): void {
    this.#compose = { highlightId };
    this.render();
    window.requestAnimationFrame(() => {
      this.#elements.composeSlot.querySelector<HTMLTextAreaElement>('#memoText')?.focus();
    });
  }

  closeCompose(): void {
    this.#compose = null;
    this.render();
  }

  get composingHighlightId(): string | null {
    return this.#compose?.highlightId ?? null;
  }

  focusMemo(memoId: string): void {
    const card = this.#elements.memoList.querySelector<HTMLElement>(`.mcard[data-mid="${CSS.escape(memoId)}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('ring');
    window.setTimeout(() => card.classList.remove('ring'), 1600);
  }

  render(): void {
    this.#renderPens();
    this.#renderCompose();
    this.#renderList();
  }

  #bind(): void {
    this.#elements.pensRow.addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('.pen');
      const color = button?.dataset.color as PenColor | undefined;
      if (!color || !PEN_COLORS.includes(color)) return;
      this.#callbacks.onPenChange(color);
    });

    this.#elements.memoSearch.addEventListener('input', () => this.#renderList());

    this.#elements.composeSlot.addEventListener('click', (event) => {
      const action = (event.target as HTMLElement).dataset.action;
      if (!action || !this.#compose) return;
      const highlightId = this.#compose.highlightId;
      if (action === 'close') {
        this.closeCompose();
      } else if (action === 'save') {
        const text = this.#elements.composeSlot.querySelector<HTMLTextAreaElement>('#memoText')?.value.trim() ?? '';
        if (text) this.#callbacks.onSaveHighlightMemo(highlightId, text);
        this.closeCompose();
      } else if (action === 'delete-highlight') {
        this.#callbacks.onDeleteHighlight(highlightId);
        this.closeCompose();
      } else if (action === 'delete-memo') {
        const memo = this.#memoForHighlight(highlightId);
        if (memo) this.#callbacks.onDeleteMemo(memo.id);
        this.closeCompose();
      }
    });

    this.#elements.memoList.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const card = target.closest<HTMLElement>('.mcard');
      if (!card) return;
      const memo = this.#memos.find((candidate) => candidate.id === card.dataset.mid);
      if (!memo || memo.anchorType !== 'highlight') return;

      const action = target.dataset.action;
      if (action === 'edit') {
        this.openComposeForHighlight(memo.anchorId);
      } else if (action === 'delete') {
        this.#callbacks.onDeleteMemo(memo.id);
      } else {
        this.#callbacks.onJumpHighlight(memo.anchorId);
      }
    });
  }

  #renderPens(): void {
    for (const button of this.#elements.pensRow.querySelectorAll<HTMLButtonElement>('.pen')) {
      button.classList.toggle('on', button.dataset.color === this.#currentPen);
    }
  }

  #renderCompose(): void {
    if (!this.#compose) {
      this.#elements.composeSlot.innerHTML = '';
      return;
    }

    const highlight = this.#highlights.find((candidate) => candidate.id === this.#compose?.highlightId);
    if (!highlight) {
      this.#elements.composeSlot.innerHTML = '';
      this.#compose = null;
      return;
    }

    const memo = this.#memoForHighlight(highlight.id);
    // design: 작성 카드는 데모처럼 인용문을 먼저 보여줘서 사용자가 현재 문맥을 놓치지 않게 한다.
    this.#elements.composeSlot.innerHTML = `
      <div class="compose">
        <div class="cquote cquote-${highlight.color}">
          ${escapeHtml(highlight.anchor.quote)}
          <div class="cqmeta"><span class="chipmini">p.${highlight.anchor.page}</span><span>드래그한 문장이 자동 인용됨</span></div>
        </div>
        <textarea id="memoText" class="cta" placeholder="메모를 입력하세요">${escapeHtml(memo?.text ?? '')}</textarea>
        <div class="chint">[[제목]] 으로 노트 연결 · #태그</div>
        <div class="crow">
          ${memo ? '<button class="lnkbtn" data-action="delete-memo" type="button">메모 삭제</button>' : '<button class="lnkbtn" data-action="delete-highlight" type="button">하이라이트 삭제</button>'}
          <span class="spacer"></span>
          <button class="btn" data-action="close" type="button">닫기</button>
          <button class="btn pri" data-action="save" type="button">저장</button>
        </div>
      </div>
    `;
  }

  #renderList(): void {
    const query = this.#elements.memoSearch.value.trim().toLowerCase();
    const memos = this.#memos
      .filter((memo) => memo.anchorType === 'highlight')
      .filter((memo) => !query || memo.text.toLowerCase().includes(query) || memo.quote.toLowerCase().includes(query))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    this.#elements.memoCount.textContent = String(this.#memos.length);
    this.#elements.memoTabN.textContent = this.#memos.length ? `(${this.#memos.length})` : '';

    if (!memos.length) {
      this.#elements.memoList.innerHTML = `<div class="empty">${query ? '검색 결과가 없어요.' : '메모가 없어요. 본문을 드래그해 보세요.'}</div>`;
      return;
    }

    // design: 카드에는 긴 인용문을 한 줄로 제한해 패널 폭을 조절해도 목록 스캔이 흔들리지 않게 한다.
    this.#elements.memoList.innerHTML = memos.map((memo) => {
      const lost = this.#lost.has(memo.anchorId);
      return `
        <article class="mcard" data-mid="${escapeHtml(memo.id)}" tabindex="0">
          <div class="mq">${escapeHtml(memo.quote)}</div>
          <div class="mtxt">${renderRichText(memo.text)}</div>
          <div class="mfoot">
            <span class="chipmini">p.${memo.page}</span>
            ${memo.links.length ? `<span class="chipmini">링크 ${memo.links.length}</span>` : ''}
            ${lost ? '<span class="lostbadge">위치 유실</span>' : ''}
            <span class="dt">${formatShortDate(memo.updatedAt)}</span>
            <span class="spacer"></span>
            <button class="lnkbtn" data-action="edit" type="button">편집</button>
            <button class="lnkbtn" data-action="delete" type="button">삭제</button>
          </div>
        </article>
      `;
    }).join('');
  }

  #memoForHighlight(highlightId: string): Memo | undefined {
    return this.#memos.find((memo) => memo.anchorType === 'highlight' && memo.anchorId === highlightId);
  }
}
