import { escapeHtml, formatShortDate, renderRichText } from '../../core/format';
import type { Highlight, Memo, PenColor } from '../../core/types';

export type MemoTabCallbacks = {
  onPenChange: (color: PenColor) => void;
  onSaveHighlightMemo: (highlightId: string, text: string) => void;
  onDeleteHighlight: (highlightId: string) => void;
  onDeleteMemo: (memoId: string) => void;
  onJumpHighlight: (highlightId: string) => void;
  onComposeHighlightChange: (highlightId: string | null) => void;
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
  // 이번 드래그로 방금 만든 하이라이트인지. 취소/Esc가 삭제(신규) vs 원복(기존)을 가른다.
  isNew: boolean;
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

  openComposeForHighlight(highlightId: string, isNew = false): void {
    this.#setCompose({ highlightId, isNew });
    window.requestAnimationFrame(() => {
      const textarea = this.#elements.composeSlot.querySelector<HTMLTextAreaElement>('#memoText');
      textarea?.focus();
      const caret = textarea?.value.length ?? 0;
      textarea?.setSelectionRange(caret, caret);
    });
  }

  /** 카드를 그냥 닫는다(비파괴). 하이라이트/메모는 그대로 유지. */
  closeCompose(): void {
    this.#setCompose(null);
  }

  /** 이번 편집을 되감는다. 신규 하이라이트면 삭제, 기존이면 수정 내용만 버리고 닫는다. */
  cancelCompose(): void {
    const compose = this.#compose;
    if (!compose) return;
    this.#setCompose(null);
    if (compose.isNew) this.#callbacks.onDeleteHighlight(compose.highlightId);
  }

  #setCompose(state: ComposeState | null): void {
    this.#compose = state;
    this.#callbacks.onComposeHighlightChange(state?.highlightId ?? null);
    this.render();
  }

  /** 저장 버튼/Enter 공용 — 비어 있으면 하이라이트만 남기고 닫는다. */
  #saveCompose(): void {
    if (!this.#compose) return;
    const highlightId = this.#compose.highlightId;
    const text = this.#elements.composeSlot.querySelector<HTMLTextAreaElement>('#memoText')?.value.trim() ?? '';
    this.closeCompose();
    if (text) this.#callbacks.onSaveHighlightMemo(highlightId, text);
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
      if (action === 'cancel') {
        this.cancelCompose();
      } else if (action === 'save') {
        this.#saveCompose();
      } else if (action === 'delete-highlight') {
        this.closeCompose();
        this.#callbacks.onDeleteHighlight(highlightId);
      } else if (action === 'delete-memo') {
        const memo = this.#memoForHighlight(highlightId);
        this.closeCompose();
        if (memo) this.#callbacks.onDeleteMemo(memo.id);
      }
    });

    // Enter는 저장(Esc 취소와 대칭), Shift+Enter는 줄바꿈.
    // 한글 IME 조합을 확정하는 Enter는 isComposing이라 저장으로 새지 않는다.
    this.#elements.composeSlot.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      if ((event.target as HTMLElement).id !== 'memoText') return;
      event.preventDefault();
      this.#saveCompose();
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
      // 하이라이트가 외부에서 사라졌으면 카드도 닫고 강조도 해제한다.
      this.#compose = null;
      this.#callbacks.onComposeHighlightChange(null);
      this.#elements.composeSlot.innerHTML = '';
      return;
    }

    const memo = this.#memoForHighlight(highlight.id);
    const isNew = this.#compose.isNew;

    // 리렌더(예: 펜 색 변경) 중에도 입력하던 메모가 날아가지 않게 현재 초안을 살린다.
    const prev = this.#elements.composeSlot.querySelector<HTMLElement>('.compose');
    const draft = prev?.dataset.hid === highlight.id
      ? prev.querySelector<HTMLTextAreaElement>('#memoText')?.value
      : undefined;
    const text = draft ?? memo?.text ?? '';

    // 진입 상태(신규/메모없음/메모있음)에 따라 상단 라벨·하단 버튼을 바꿔 "지금 뭐 하는 중"을 드러낸다.
    const stateLabel = isNew ? '새 하이라이트' : memo ? '메모 편집' : '메모 추가';
    const primaryLabel = isNew && !text.trim() ? '하이라이트만 저장' : '메모 저장';
    const destructive = isNew
      ? ''
      : memo
        ? '<button class="lnkbtn" data-action="delete-memo" type="button">메모 삭제</button><button class="lnkbtn danger" data-action="delete-highlight" type="button">하이라이트 삭제</button>'
        : '<button class="lnkbtn danger" data-action="delete-highlight" type="button">하이라이트 삭제</button>';

    // design: 작성 카드는 데모처럼 인용문을 먼저 보여줘서 사용자가 현재 문맥을 놓치지 않게 한다.
    this.#elements.composeSlot.innerHTML = `
      <div class="compose" data-hid="${escapeHtml(highlight.id)}">
        <div class="cstate">${stateLabel}</div>
        <div class="cquote cquote-${highlight.color}">
          ${escapeHtml(highlight.anchor.quote)}
          <div class="cqmeta"><span class="chipmini">p.${highlight.anchor.page}</span><span>드래그한 문장이 자동 인용됨</span></div>
        </div>
        <textarea id="memoText" class="cta" placeholder="메모를 입력하세요">${escapeHtml(text)}</textarea>
        <div class="chint">[[제목]] 노트 연결 · #태그 · Enter 저장 · Shift+Enter 줄바꿈</div>
        <div class="crow">
          ${destructive}
          <span class="spacer"></span>
          <button class="btn" data-action="cancel" type="button">취소</button>
          <button class="btn pri" data-action="save" type="button">${primaryLabel}</button>
        </div>
      </div>
    `;

    // 신규 하이라이트는 입력 여부에 따라 주 버튼 라벨이 "하이라이트만 저장" ↔ "메모 저장"으로 바뀐다.
    if (isNew) {
      const textarea = this.#elements.composeSlot.querySelector<HTMLTextAreaElement>('#memoText');
      const primary = this.#elements.composeSlot.querySelector<HTMLButtonElement>('.btn.pri');
      textarea?.addEventListener('input', () => {
        if (primary) primary.textContent = textarea.value.trim() ? '메모 저장' : '하이라이트만 저장';
      });
    }
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
