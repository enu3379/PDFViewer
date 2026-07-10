import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import type { ResolvedDestination } from '../pdf-host';
import {
  buildReferenceLines,
  findCitationMentions,
  findReferenceEntry,
  getNumberedReferenceEntries,
  hasReferenceHeading,
  normalizeReferenceMarker,
  type CitationMention,
  type ReferenceEntry,
  type ReferenceLine,
  type ReferenceTextItem
} from './reference-entry';

export type ReferencesTabCallbacks = {
  onJumpToPage: (page: number) => void;
};

type PanelCitation = CitationMention & {
  id: string;
  page: number;
};

type PanelReference = ReferenceEntry & {
  page: number;
};

/** 참조 탭 — 참고문헌 목록과 각 항목을 인용한 본문 위치를 함께 보여준다. */
export class ReferencesTab {
  #list: HTMLElement;
  #callbacks: ReferencesTabCallbacks;
  #doc: PDFDocumentProxy | null = null;
  #generation = 0;
  #state: 'idle' | 'scanning' | 'done' = 'idle';
  #references: PanelReference[] = [];
  #citations: PanelCitation[] = [];
  #activeKey: string | null = null;

  constructor(list: HTMLElement, callbacks: ReferencesTabCallbacks) {
    this.#list = list;
    this.#callbacks = callbacks;
    this.#list.addEventListener('click', (event) => {
      const mention = (event.target as Element).closest<HTMLButtonElement>('.reference-mention');
      if (!mention) return;
      const page = Number(mention.dataset.page);
      if (page) this.#callbacks.onJumpToPage(page);
    });
  }

  setDocument(doc: PDFDocumentProxy | null): void {
    this.#generation += 1;
    this.#doc = doc;
    this.#state = doc ? 'scanning' : 'idle';
    this.#references = [];
    this.#citations = [];
    this.#activeKey = null;
    this.#render();
    if (doc) void this.#scan(doc, this.#generation);
  }

  async openDestination(destination: ResolvedDestination): Promise<boolean> {
    const doc = this.#doc;
    const generation = this.#generation;
    if (!doc) return false;

    try {
      const lines = await this.#readPage(destination.page);
      if (generation !== this.#generation || doc !== this.#doc) return false;
      const entry = findReferenceEntry(lines, destination.y);
      if (!entry) return false;
      this.#upsertReferences(destination.page, [entry]);
      this.#activeKey = this.#key(destination.page, entry.marker);
      this.#render();
      return true;
    } catch (error) {
      console.warn('reference entry lookup failed', error);
      return false;
    }
  }

  async #scan(doc: PDFDocumentProxy, generation: number): Promise<void> {
    let referenceSectionStarted = false;
    let referenceSectionFirstPage = 0;

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const lines = await this.#readPage(pageNumber);
      if (generation !== this.#generation || doc !== this.#doc) return;

      if (hasReferenceHeading(lines) && !referenceSectionStarted) {
        referenceSectionStarted = true;
        referenceSectionFirstPage = pageNumber;
      }

      if (referenceSectionStarted) {
        const entries = getNumberedReferenceEntries(lines);
        if (entries.length) {
          this.#upsertReferences(pageNumber, entries);
          this.#render();
        } else if (pageNumber > referenceSectionFirstPage) {
          break;
        }
        continue;
      }

      const mentions = findCitationMentions(lines);
      for (const [index, mention] of mentions.entries()) {
        this.#citations.push({ ...mention, id: `${pageNumber}:${index}`, page: pageNumber });
      }
      if (mentions.length) this.#render();
    }

    if (generation !== this.#generation || doc !== this.#doc) return;
    this.#state = 'done';
    this.#render();
  }

  async #readPage(pageNumber: number): Promise<ReferenceLine[]> {
    const doc = this.#doc;
    if (!doc) return [];
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const items: ReferenceTextItem[] = [];

    for (const item of textContent.items) {
      if (!('str' in item) || !('transform' in item) || !('width' in item) || !('height' in item)) continue;
      if (typeof item.str !== 'string' || item.transform.length < 6) continue;
      const [x, y] = [item.transform[4], item.transform[5]];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      items.push({
        text: item.str,
        x,
        y,
        width: typeof item.width === 'number' ? item.width : 0,
        height: typeof item.height === 'number' ? item.height : 0
      });
    }

    return buildReferenceLines(items);
  }

  #upsertReferences(page: number, entries: ReferenceEntry[]): void {
    for (const entry of entries) {
      const key = this.#key(page, entry.marker);
      const index = this.#references.findIndex((reference) => this.#key(reference.page, reference.marker) === key);
      if (index >= 0) {
        this.#references[index] = { ...entry, page };
      } else {
        this.#references.push({ ...entry, page });
      }
    }
    this.#references.sort((a, b) => a.page - b.page || a.marker.localeCompare(b.marker, undefined, { numeric: true }));
  }

  #key(page: number, marker: string): string {
    return `${page}:${marker.toLowerCase()}`;
  }

  #render(): void {
    if (!this.#references.length) {
      const message = this.#state === 'scanning'
        ? '참고문헌 목록과 본문 인용 위치를 찾는 중…'
        : this.#state === 'done'
          ? '이 PDF에서 참고문헌 목록을 찾지 못했어요.'
          : 'PDF를 열면 참고문헌과 본문 인용 위치를 여기에 모아 보여줍니다.';
      this.#list.innerHTML = `<div class="empty">${message}</div>`;
      return;
    }

    const cards = this.#references.map((reference) => {
      const card = document.createElement('article');
      card.className = 'reference-card';
      const key = this.#key(reference.page, reference.marker);
      card.classList.toggle('on', key === this.#activeKey);
      card.dataset.referenceKey = key;

      const head = document.createElement('div');
      head.className = 'reference-head';
      const label = document.createElement('b');
      label.textContent = reference.marker;
      const pageLabel = document.createElement('span');
      pageLabel.textContent = `p.${reference.page}`;
      head.append(label, pageLabel);

      const body = document.createElement('p');
      body.className = 'reference-text';
      body.textContent = reference.text.replace(/^\s*(?:\[[^\]]+\]|\d+[a-z]?[.)])\s*/i, '');

      const citations = this.#citations.filter((citation) => (
        citation.markers.includes(normalizeReferenceMarker(reference.marker))
      ));
      const backrefs = document.createElement('div');
      backrefs.className = 'reference-backrefs';
      const backrefLabel = document.createElement('div');
      backrefLabel.className = 'reference-backref-label';
      backrefLabel.textContent = `본문 인용 ${citations.length}곳`;
      backrefs.append(backrefLabel);

      if (citations.length) {
        for (const citation of citations) {
          const mention = document.createElement('button');
          mention.className = 'reference-mention';
          mention.type = 'button';
          mention.dataset.page = String(citation.page);
          const mentionPage = document.createElement('span');
          mentionPage.className = 'reference-mention-page';
          mentionPage.textContent = `p.${citation.page}`;
          const mentionText = document.createElement('span');
          mentionText.className = 'reference-mention-text';
          mentionText.textContent = citation.context;
          mention.append(mentionPage, mentionText);
          backrefs.append(mention);
        }
      } else {
        const empty = document.createElement('p');
        empty.className = 'reference-backref-empty';
        empty.textContent = this.#state === 'scanning' ? '인용 위치를 찾는 중…' : '본문 인용 위치가 없어요.';
        backrefs.append(empty);
      }

      card.append(head, body, backrefs);
      return card;
    });
    this.#list.replaceChildren(...cards);

    if (this.#activeKey) {
      window.requestAnimationFrame(() => {
        this.#list.querySelector<HTMLElement>(`[data-reference-key="${this.#activeKey}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      });
    }
  }
}
