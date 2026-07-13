import type {
  AnnotationBucket,
  DocId,
  DocNode,
  DownloadBinding,
  IdentityState,
  LocatorIndex
} from './types';

export const SCHEMA_VERSION_KEY = 'margin:schemaVersion';
export const DOCS_KEY = 'margin:docs';
export const LOCATORS_KEY = 'margin:locators';
export const DOWNLOAD_BINDINGS_KEY = 'margin:downloadBindings';
export const SETTINGS_KEY = 'margin:settings';
export const SCHEMA_VERSION = 2;
const SAVE_DELAY_MS = 500;
const LEGACY_DOC_PREFIX = 'margin:doc:';
const GROUP_PREFIX = 'margin:group:';

export type Settings = {
  autoIntercept?: boolean;
  penTheme?: string;
};

export type DocData = {
  meta: DocNode;
  bucket: AnnotationBucket;
  highlights: AnnotationBucket['highlights'];
  memos: AnnotationBucket['memos'];
  figures: AnnotationBucket['figures'];
};

export type StorageArea = {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

export class FutureSchemaVersionError extends Error {
  constructor(readonly foundVersion: number) {
    super(`이 데이터는 더 새로운 Margin 스키마(v${foundVersion})로 저장되어 있습니다.`);
    this.name = 'FutureSchemaVersionError';
  }
}

const memoryStorage = new Map<string, unknown>();

const fallbackStorage: StorageArea = {
  async get(keys?: string | string[] | Record<string, unknown> | null) {
    if (keys == null) return Object.fromEntries(memoryStorage.entries());
    if (typeof keys === 'string') return { [keys]: memoryStorage.get(keys) };
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, memoryStorage.get(key)]));
    }
    return Object.fromEntries(
      Object.entries(keys).map(([key, fallback]) => [key, memoryStorage.get(key) ?? fallback])
    );
  },
  async set(items: Record<string, unknown>) {
    for (const [key, value] of Object.entries(items)) memoryStorage.set(key, value);
  },
  async remove(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) memoryStorage.delete(key);
  }
};

function storageArea(): StorageArea {
  return typeof chrome !== 'undefined' && chrome.storage?.local
    ? chrome.storage.local
    : fallbackStorage;
}

export function groupKey(bucketId: string): string {
  return `${GROUP_PREFIX}${bucketId}`;
}

export function locatorKey(locator: DocNode['locator']): string | null {
  if (!locator) return null;
  return locator.kind === 'fsa-handle'
    ? `fsa-handle:${locator.handleKey}`
    : `${locator.kind}:${locator.value}`;
}

function emptyBucket(bucketId: string): AnnotationBucket {
  return {
    id: bucketId,
    revisionId: makeUuid(),
    highlights: [],
    memos: [],
    figures: []
  };
}

function docData(node: DocNode, bucket: AnnotationBucket): DocData {
  return {
    meta: node,
    bucket,
    highlights: bucket.highlights,
    memos: bucket.memos,
    figures: bucket.figures
  };
}

export class MarginStore {
  #storage: StorageArea;
  #saveTimers = new Map<DocId, number>();
  #dirtyDocs = new Set<DocId>();

  constructor(storage: StorageArea = storageArea()) {
    this.#storage = storage;
  }

  async ensureSchema(): Promise<void> {
    const all = await this.#storage.get(null);
    const rawVersion = all[SCHEMA_VERSION_KEY];
    if (rawVersion === SCHEMA_VERSION) return;
    if (typeof rawVersion === 'number' && rawVersion > SCHEMA_VERSION) {
      throw new FutureSchemaVersionError(rawVersion);
    }

    const legacyKeys = Object.keys(all).filter(
      (key) => key === DOCS_KEY || key.startsWith(LEGACY_DOC_PREFIX)
    );
    if (legacyKeys.length) await this.#storage.remove(legacyKeys);
    // schemaVersion은 초기화가 전부 성공한 뒤 마지막에 기록한다.
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

  async loadIdentityState(): Promise<IdentityState> {
    await this.ensureSchema();
    const all = await this.#storage.get(null);
    const nodes = (all[DOCS_KEY] as Record<DocId, DocNode> | undefined) ?? {};
    const buckets: IdentityState['buckets'] = {};
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(GROUP_PREFIX)) continue;
      const bucket = value as AnnotationBucket | undefined;
      if (bucket?.id) buckets[bucket.id] = bucket;
    }
    return {
      nodes: { ...nodes },
      buckets,
      locators: { ...((all[LOCATORS_KEY] as LocatorIndex | undefined) ?? {}) },
      downloadBindings: [
        ...((all[DOWNLOAD_BINDINGS_KEY] as DownloadBinding[] | undefined) ?? [])
      ]
    };
  }

  async saveIdentityState(state: IdentityState): Promise<void> {
    await this.ensureSchema();
    const all = await this.#storage.get(null);
    const staleGroupKeys = Object.keys(all).filter(
      (key) => key.startsWith(GROUP_PREFIX) && !state.buckets[key.slice(GROUP_PREFIX.length)]
    );
    if (staleGroupKeys.length) await this.#storage.remove(staleGroupKeys);
    const bucketItems = Object.fromEntries(
      Object.values(state.buckets).map((bucket) => [groupKey(bucket.id), bucket])
    );
    await this.#storage.set({
      [DOCS_KEY]: state.nodes,
      [LOCATORS_KEY]: state.locators,
      [DOWNLOAD_BINDINGS_KEY]: state.downloadBindings,
      ...bucketItems
    });
  }

  async listNodes(): Promise<DocNode[]> {
    const state = await this.loadIdentityState();
    return Object.values(state.nodes).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  async loadDoc(node: DocNode): Promise<DocData> {
    const state = await this.loadIdentityState();
    const storedNode = state.nodes[node.id];
    const nextNode: DocNode = {
      ...storedNode,
      ...node,
      locator: node.locator ?? storedNode?.locator ?? null,
      artifactId: node.artifactId ?? storedNode?.artifactId,
      addedAt: storedNode?.addedAt ?? node.addedAt,
      lastOpenedAt: node.lastOpenedAt
    };
    const bucket = state.buckets[nextNode.bucketId] ?? emptyBucket(nextNode.bucketId);
    state.nodes[nextNode.id] = nextNode;
    state.buckets[bucket.id] = bucket;
    const key = locatorKey(nextNode.locator);
    if (key) state.locators[key] = nextNode.id;
    await this.saveIdentityState(state);
    return docData(nextNode, bucket);
  }

  scheduleSaveDoc(data: DocData): void {
    const id = data.meta.id;
    this.#dirtyDocs.add(id);
    const existing = this.#saveTimers.get(id);
    if (existing !== undefined && typeof window !== 'undefined') window.clearTimeout(existing);
    if (typeof window === 'undefined') {
      void this.saveDoc(data);
      return;
    }
    const timer = window.setTimeout(() => {
      this.#saveTimers.delete(id);
      void this.saveDoc(data);
    }, SAVE_DELAY_MS);
    this.#saveTimers.set(id, timer);
  }

  async flushDoc(data: DocData): Promise<void> {
    const id = data.meta.id;
    const existing = this.#saveTimers.get(id);
    if (existing !== undefined && typeof window !== 'undefined') {
      window.clearTimeout(existing);
      this.#saveTimers.delete(id);
    }
    if (!this.#dirtyDocs.has(id)) return;
    await this.saveDoc(data);
  }

  async saveDoc(data: DocData): Promise<void> {
    const state = await this.loadIdentityState();
    const now = Date.now();
    data.bucket.highlights = data.highlights;
    data.bucket.memos = data.memos;
    data.bucket.figures = data.figures;
    data.bucket.revisionId = makeUuid();
    data.meta.lastEditedAt = now;
    state.nodes[data.meta.id] = data.meta;
    state.buckets[data.bucket.id] = data.bucket;
    await this.saveIdentityState(state);
    this.#dirtyDocs.delete(data.meta.id);
  }

  async saveNode(node: DocNode): Promise<void> {
    const state = await this.loadIdentityState();
    state.nodes[node.id] = node;
    const key = locatorKey(node.locator);
    if (key) state.locators[key] = node.id;
    await this.saveIdentityState(state);
  }

  async upsertDownloadBinding(binding: DownloadBinding): Promise<void> {
    const state = await this.loadIdentityState();
    const index = state.downloadBindings.findIndex((item) => item.id === binding.id);
    if (index >= 0) state.downloadBindings[index] = binding;
    else state.downloadBindings.push(binding);
    await this.saveIdentityState(state);
  }

  async setDownloadId(bindingId: string, chromeDownloadId: number): Promise<void> {
    const state = await this.loadIdentityState();
    const binding = state.downloadBindings.find((item) => item.id === bindingId);
    if (!binding) return;
    binding.chromeDownloadId = chromeDownloadId;
    await this.saveIdentityState(state);
  }

  async interruptDownloadBinding(chromeDownloadId: number): Promise<void> {
    const state = await this.loadIdentityState();
    const binding = state.downloadBindings.find(
      (item) => item.chromeDownloadId === chromeDownloadId
    );
    if (!binding) return;
    binding.status = 'interrupted';
    await this.saveIdentityState(state);
  }

  async completeDownloadBinding(
    chromeDownloadId: number,
    finalPath: string,
    completedAt = Date.now()
  ): Promise<DownloadBinding | null> {
    const state = await this.loadIdentityState();
    const binding = state.downloadBindings.find(
      (item) => item.chromeDownloadId === chromeDownloadId
    );
    if (!binding) return null;
    const node = state.nodes[binding.nodeId];
    if (!node) return null;
    const oldKey = locatorKey(node.locator);
    if (oldKey && state.locators[oldKey] === node.id) delete state.locators[oldKey];
    node.locator = { kind: 'path', value: finalPath };
    state.locators[locatorKey(node.locator)!] = node.id;
    binding.finalPath = finalPath;
    binding.status = 'complete';
    binding.completedAt = completedAt;
    await this.saveIdentityState(state);
    return binding;
  }
}

export function makeUuid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : makeId('id-');
}

export function makeId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${random}`;
}
