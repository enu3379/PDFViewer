import { locatorKey, makeUuid } from './store';
import type {
  AnnotationBucket,
  ContentEvidence,
  DocLocator,
  DocNode,
  IdentityState,
  MarginAttachmentV1
} from './types';

export interface FileSystemHandleLike {
  kind: 'file' | 'directory';
  name: string;
  isSameEntry(other: FileSystemHandleLike): Promise<boolean>;
}

export interface IdentityInput {
  locator: DocLocator | null;
  title: string;
  pageCount: number;
  pdfjsVersion: string;
  evidence: ContentEvidence;
  now?: number;
  attachment?: MarginAttachmentV1 | null;
  getSha256?: () => Promise<string>;
}

export type IdentityResolutionKind =
  | 'existing'
  | 'rebound'
  | 'download-binding'
  | 'adopted'
  | 'new';

export interface IdentityResolution {
  kind: IdentityResolutionKind;
  node: DocNode;
  state: IdentityState;
  ambiguous: boolean;
}

export interface IdentityProvider {
  resolve(input: IdentityInput, state: IdentityState): Promise<IdentityResolution | null>;
}

export type IdentityResolverOptions = {
  locatorExists?: (locator: DocLocator) => Promise<boolean>;
  makeId?: () => string;
};

export class DocumentIdentityResolver {
  #providers: IdentityProvider[];
  #browserProvider: BrowserIdentityProvider;

  constructor(providers: IdentityProvider[] = [], options: IdentityResolverOptions = {}) {
    this.#providers = providers;
    this.#browserProvider = new BrowserIdentityProvider(options);
  }

  async resolve(input: IdentityInput, sourceState: IdentityState): Promise<IdentityResolution> {
    for (const provider of this.#providers) {
      const result = await provider.resolve(input, cloneIdentityState(sourceState));
      if (result) return result;
    }
    return this.#browserProvider.resolve(input, cloneIdentityState(sourceState));
  }
}

class BrowserIdentityProvider implements IdentityProvider {
  #locatorExists: (locator: DocLocator) => Promise<boolean>;
  #makeId: () => string;

  constructor(options: IdentityResolverOptions) {
    this.#locatorExists = options.locatorExists ?? (async () => true);
    this.#makeId = options.makeId ?? makeUuid;
  }

  async resolve(input: IdentityInput, state: IdentityState): Promise<IdentityResolution> {
    const now = input.now ?? Date.now();
    const directKey = locatorKey(input.locator);
    const directNode = directKey ? state.nodes[state.locators[directKey]] : undefined;
    if (directNode) {
      if (directNode.contentEvidence.sha256 && !input.evidence.sha256 && input.getSha256) {
        input.evidence.sha256 = await input.getSha256();
      }
      updateReopenedNode(directNode, input, now);
      return result('existing', directNode, state);
    }

    const artifactMatches = input.attachment
      ? Object.values(state.nodes).filter((node) => node.artifactId === input.attachment?.artifactId)
      : [];
    if (artifactMatches.length === 1) {
      const matched = artifactMatches[0];
      if (await canReuseKnownArtifact(matched, input.locator, this.#locatorExists)) {
        rebindNode(state, matched, input.locator);
        updateReopenedNode(matched, input, now);
        return result(matched.locator ? 'rebound' : 'existing', matched, state);
      }
      return this.#createIndependent(input, state, now, false);
    }
    if (artifactMatches.length > 1) {
      return this.#createIndependent(input, state, now, true);
    }

    const sha256 = await ensureSha256(input);
    if (sha256) {
      const pending = state.downloadBindings.filter(
        (binding) => binding.status === 'pending' && binding.expectedSha256 === sha256
          && state.nodes[binding.nodeId]
      );
      if (pending.length === 1 || (pending.length > 1 && bindingsAreExchangeable(pending, state))) {
        const binding = [...pending].sort(
          (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
        )[0];
        const node = state.nodes[binding.nodeId];
        binding.status = 'complete';
        binding.completedAt = now;
        if (input.locator?.kind === 'path') binding.finalPath = input.locator.value;
        rebindNode(state, node, input.locator);
        updateReopenedNode(node, input, now);
        return result('download-binding', node, state);
      }
      if (pending.length > 1) {
        return this.#createIndependent(input, state, now, true);
      }

      if (input.locator?.kind !== 'url') {
        const evidenceMatches = Object.values(state.nodes).filter(
          (node) => node.contentEvidence.sha256 === sha256
        );
        if (evidenceMatches.length === 1) {
          const matched = evidenceMatches[0];
          if (await canRebindEvidenceMatch(matched, input.locator, this.#locatorExists)) {
            rebindNode(state, matched, input.locator);
            updateReopenedNode(matched, input, now);
            return result('rebound', matched, state);
          }
        }
        if (evidenceMatches.length > 1) {
          return this.#createIndependent(input, state, now, true);
        }
      }
    }

    return this.#createIndependent(input, state, now, false);
  }

  #createIndependent(
    input: IdentityInput,
    state: IdentityState,
    now: number,
    ambiguous: boolean
  ): IdentityResolution {
    const id = this.#makeId();
    const bucketId = this.#makeId();
    const bucket = attachmentBucket(bucketId, id, input.attachment, this.#makeId);
    const node: DocNode = {
      id,
      syncHubId: null,
      syncState: 'detached',
      bucketId,
      locator: input.locator,
      artifactId: input.attachment?.artifactId,
      contentEvidence: { ...input.evidence },
      title: input.title,
      pageCount: input.pageCount,
      pdfjsVersion: input.pdfjsVersion,
      addedAt: now,
      lastOpenedAt: now,
      lastEditedAt: now
    };
    state.nodes[id] = node;
    state.buckets[bucketId] = bucket;
    const key = locatorKey(input.locator);
    if (key) state.locators[key] = id;
    return result(input.attachment ? 'adopted' : 'new', node, state, ambiguous);
  }
}

function result(
  kind: IdentityResolutionKind,
  node: DocNode,
  state: IdentityState,
  ambiguous = false
): IdentityResolution {
  return { kind, node, state, ambiguous };
}

function updateReopenedNode(node: DocNode, input: IdentityInput, now: number): void {
  const contentChanged = node.contentEvidence.pdfJsId !== input.evidence.pdfJsId
    || (input.evidence.byteLength !== undefined
      && node.contentEvidence.byteLength !== undefined
      && node.contentEvidence.byteLength !== input.evidence.byteLength);
  node.title = input.title || node.title;
  node.pageCount = input.pageCount;
  node.pdfjsVersion = input.pdfjsVersion;
  node.lastOpenedAt = now;
  node.contentEvidence = {
    ...node.contentEvidence,
    ...input.evidence,
    sha256: input.evidence.sha256 ?? (contentChanged ? undefined : node.contentEvidence.sha256)
  };
}

function rebindNode(state: IdentityState, node: DocNode, next: DocLocator | null): void {
  const previousKey = locatorKey(node.locator);
  if (previousKey && state.locators[previousKey] === node.id) delete state.locators[previousKey];
  node.locator = next;
  const nextKey = locatorKey(next);
  if (nextKey) state.locators[nextKey] = node.id;
}

async function canReuseKnownArtifact(
  node: DocNode,
  nextLocator: DocLocator | null,
  locatorExists: (locator: DocLocator) => Promise<boolean>
): Promise<boolean> {
  const currentKey = locatorKey(node.locator);
  const nextKey = locatorKey(nextLocator);
  if (currentKey === nextKey) return true;
  if (!node.locator) return true;
  if (!nextLocator) return false;
  return !(await locatorExists(node.locator));
}

async function canRebindEvidenceMatch(
  node: DocNode,
  nextLocator: DocLocator | null,
  locatorExists: (locator: DocLocator) => Promise<boolean>
): Promise<boolean> {
  if (!node.locator) return true;
  if (!nextLocator) return false;
  if (locatorKey(node.locator) === locatorKey(nextLocator)) return true;
  return !(await locatorExists(node.locator));
}

function bindingsAreExchangeable(
  bindings: IdentityState['downloadBindings'],
  state: IdentityState
): boolean {
  if (!bindings.length) return false;
  const firstNode = state.nodes[bindings[0].nodeId];
  const firstBucket = state.buckets[firstNode.bucketId];
  return bindings.every((binding) => {
    const node = state.nodes[binding.nodeId];
    const bucket = state.buckets[node.bucketId];
    return node.syncHubId === firstNode.syncHubId
      && node.syncState === firstNode.syncState
      && node.forkBaseRevisionId === firstNode.forkBaseRevisionId
      && node.syncHubBaselineRevisionId === firstNode.syncHubBaselineRevisionId
      && bucket?.revisionId === firstBucket?.revisionId
      && node.lastOpenedAt <= binding.createdAt
      && node.lastEditedAt <= binding.createdAt;
  });
}

async function ensureSha256(input: IdentityInput): Promise<string | undefined> {
  if (input.evidence.sha256) return input.evidence.sha256;
  if (!input.getSha256) return undefined;
  const value = await input.getSha256();
  input.evidence.sha256 = value;
  return value;
}

function attachmentBucket(
  bucketId: string,
  nodeId: string,
  attachment: MarginAttachmentV1 | null | undefined,
  makeId: () => string
): AnnotationBucket {
  return {
    id: bucketId,
    revisionId: makeId(),
    highlights: (attachment?.payload.highlights ?? []).map((item) => ({ ...item, doc: nodeId })),
    memos: (attachment?.payload.memos ?? []).map((item) => ({ ...item, doc: nodeId })),
    figures: (attachment?.payload.figures ?? []).map((item) => ({ ...item, doc: nodeId }))
  };
}

function cloneIdentityState(state: IdentityState): IdentityState {
  return structuredClone(state);
}

export function normalizeWebUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('웹 locator는 http(s) URL이어야 합니다.');
  }
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80')
    || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  url.hash = '';

  const kept = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || lower === 'fbclid' || lower === 'gclid') continue;
    kept.append(key, value);
  }
  const query = kept.toString();
  url.search = query ? `?${query}` : '';
  return url.toString();
}

export function normalizeLocalPath(raw: string): string {
  let path = safeDecodeURIComponent(raw).replace(/\\/g, '/');
  if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
  if (/^[a-zA-Z]:\//.test(path)) path = `${path[0].toLowerCase()}${path.slice(1)}`;
  return path.replace(/\/{2,}/g, (slashes, offset) => offset === 0 ? '//' : '/');
}

export function locatorFromUrl(raw: string): DocLocator {
  const url = new URL(raw);
  if (url.protocol === 'file:') {
    const host = url.hostname ? `//${url.hostname.toLowerCase()}` : '';
    return { kind: 'path', value: normalizeLocalPath(`${host}${url.pathname}`) };
  }
  return { kind: 'url', value: normalizeWebUrl(raw) };
}

export function fileUrlFromPath(path: string): string {
  const normalized = normalizeLocalPath(path);
  if (normalized.startsWith('//')) return `file:${encodeURI(normalized)}`;
  const prefix = /^[a-zA-Z]:\//.test(normalized) ? '/' : '';
  return `file://${prefix}${encodeURI(normalized)}`;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class FileHandleRegistry {
  #dbName: string;

  constructor(dbName = 'margin-file-handles') {
    this.#dbName = dbName;
  }

  async resolve(handle: FileSystemHandleLike): Promise<DocLocator> {
    const db = await this.#open();
    const entries = await transactionRequest<Array<{ key: string; handle: FileSystemHandleLike }>>(
      db,
      'handles',
      'readonly',
      (store) => store.getAll()
    );
    for (const entry of entries) {
      try {
        if (await handle.isSameEntry(entry.handle)) {
          db.close();
          return { kind: 'fsa-handle', handleKey: entry.key };
        }
      } catch {
        // 만료되거나 권한을 잃은 handle은 후보에서 조용히 제외한다.
      }
    }
    const key = makeUuid();
    await transactionRequest(db, 'handles', 'readwrite', (store) => store.put({ key, handle }));
    db.close();
    return { kind: 'fsa-handle', handleKey: key };
  }

  async get(handleKey: string): Promise<FileSystemHandleLike | null> {
    const db = await this.#open();
    try {
      const entry = await transactionRequest<{ key: string; handle: FileSystemHandleLike } | undefined>(
        db,
        'handles',
        'readonly',
        (store) => store.get(handleKey)
      );
      return entry?.handle ?? null;
    } finally {
      db.close();
    }
  }

  async #open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.#dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('handles')) {
          request.result.createObjectStore('handles', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('파일 handle 저장소를 열 수 없습니다.'));
    });
  }
}

function transactionRequest<T = unknown>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  request: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const operation = request(transaction.objectStore(storeName));
    operation.onsuccess = () => resolve(operation.result as T);
    operation.onerror = () => reject(operation.error ?? new Error('파일 handle 저장에 실패했습니다.'));
  });
}
