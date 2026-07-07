import type { DocId, DocMeta, FigureEntry, Highlight, Memo } from './types';

const SCHEMA_VERSION_KEY = 'margin:schemaVersion';
const DOCS_KEY = 'margin:docs';
const SETTINGS_KEY = 'margin:settings';
const SCHEMA_VERSION = 1;
const SAVE_DELAY_MS = 500;

export type Settings = {
  autoIntercept?: boolean;
  penTheme?: string;
};

export type DocData = {
  meta: DocMeta;
  highlights: Highlight[];
  memos: Memo[];
  figures: FigureEntry[];
};

type StorageArea = {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

const memoryStorage = new Map<string, unknown>();

const fallbackStorage: StorageArea = {
  async get(keys?: string | string[] | Record<string, unknown> | null) {
    if (keys == null) return Object.fromEntries(memoryStorage.entries());
    if (typeof keys === 'string') {
      return { [keys]: memoryStorage.get(keys) };
    }
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, memoryStorage.get(key)]));
    }
    return Object.fromEntries(
      Object.entries(keys).map(([key, fallback]) => [key, memoryStorage.get(key) ?? fallback])
    );
  },
  async set(items: Record<string, unknown>) {
    for (const [key, value] of Object.entries(items)) {
      memoryStorage.set(key, value);
    }
  },
  async remove(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      memoryStorage.delete(key);
    }
  }
};

function storageArea(): StorageArea {
  return typeof chrome !== 'undefined' && chrome.storage?.local
    ? chrome.storage.local
    : fallbackStorage;
}

function highlightsKey(docId: DocId): string {
  return `margin:doc:${docId}:highlights`;
}

function memosKey(docId: DocId): string {
  return `margin:doc:${docId}:memos`;
}

function figuresKey(docId: DocId): string {
  return `margin:doc:${docId}:figures`;
}

export class MarginStore {
  #storage = storageArea();
  #saveTimers = new Map<DocId, number>();

  async ensureSchema(): Promise<void> {
    const got = await this.#storage.get(SCHEMA_VERSION_KEY);
    if (got[SCHEMA_VERSION_KEY] === SCHEMA_VERSION) return;
    await this.#storage.set({ [SCHEMA_VERSION_KEY]: SCHEMA_VERSION });
  }

  async loadSettings(): Promise<Settings> {
    const got = await this.#storage.get(SETTINGS_KEY);
    return (got[SETTINGS_KEY] as Settings | undefined) ?? {};
  }

  /** settings는 sw(자동 열기)와 뷰어(펜 테마)가 나눠 쓰므로 항상 병합 저장한다. */
  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const current = await this.loadSettings();
    await this.#storage.set({ [SETTINGS_KEY]: { ...current, ...patch } });
  }

  async loadDoc(meta: DocMeta): Promise<DocData> {
    await this.ensureSchema();
    const keys = [DOCS_KEY, highlightsKey(meta.id), memosKey(meta.id), figuresKey(meta.id)];
    const got = await this.#storage.get(keys);
    const docs = { ...((got[DOCS_KEY] as Record<DocId, DocMeta> | undefined) ?? {}) };
    const previous = docs[meta.id];
    const nextMeta: DocMeta = {
      ...previous,
      ...meta,
      url: meta.url ?? previous?.url,
      addedAt: previous?.addedAt ?? meta.addedAt,
      lastOpenedAt: meta.lastOpenedAt
    };
    docs[meta.id] = nextMeta;
    await this.#storage.set({ [DOCS_KEY]: docs });

    return {
      meta: nextMeta,
      highlights: (got[highlightsKey(meta.id)] as Highlight[] | undefined) ?? [],
      memos: (got[memosKey(meta.id)] as Memo[] | undefined) ?? [],
      figures: (got[figuresKey(meta.id)] as FigureEntry[] | undefined) ?? []
    };
  }

  scheduleSaveDoc(data: DocData): void {
    const existing = this.#saveTimers.get(data.meta.id);
    if (existing !== undefined) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.#saveTimers.delete(data.meta.id);
      void this.saveDoc(data);
    }, SAVE_DELAY_MS);
    this.#saveTimers.set(data.meta.id, timer);
  }

  async flushDoc(data: DocData): Promise<void> {
    const existing = this.#saveTimers.get(data.meta.id);
    if (existing !== undefined) {
      window.clearTimeout(existing);
      this.#saveTimers.delete(data.meta.id);
    }
    await this.saveDoc(data);
  }

  async saveDoc(data: DocData): Promise<void> {
    await this.ensureSchema();
    const got = await this.#storage.get(DOCS_KEY);
    const docs = { ...((got[DOCS_KEY] as Record<DocId, DocMeta> | undefined) ?? {}) };
    docs[data.meta.id] = data.meta;
    await this.#storage.set({
      [DOCS_KEY]: docs,
      [highlightsKey(data.meta.id)]: data.highlights,
      [memosKey(data.meta.id)]: data.memos,
      [figuresKey(data.meta.id)]: data.figures
    });
  }
}

export function makeId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${random}`;
}
