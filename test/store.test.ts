import { describe, expect, it } from 'vitest';
import {
  DOCS_KEY,
  DOWNLOAD_BINDINGS_KEY,
  FutureSchemaVersionError,
  MarginStore,
  SCHEMA_VERSION_KEY,
  SETTINGS_KEY,
  type StorageArea
} from '../src/core/store';
import type { AnnotationBucket, DocNode } from '../src/core/types';

class TestStorage implements StorageArea {
  data = new Map<string, unknown>();
  removed: string[][] = [];

  constructor(initial: Record<string, unknown>) {
    for (const [key, value] of Object.entries(initial)) this.data.set(key, value);
  }

  async get(keys?: string | string[] | Record<string, unknown> | null) {
    if (keys == null) return Object.fromEntries(this.data);
    if (typeof keys === 'string') return { [keys]: this.data.get(keys) };
    if (Array.isArray(keys)) {
      return Object.fromEntries(keys.map((key) => [key, this.data.get(key)]));
    }
    return Object.fromEntries(
      Object.entries(keys).map(([key, fallback]) => [key, this.data.get(key) ?? fallback])
    );
  }

  async set(items: Record<string, unknown>) {
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
  }

  async remove(keys: string | string[]) {
    const list = Array.isArray(keys) ? keys : [keys];
    this.removed.push(list);
    for (const key of list) this.data.delete(key);
  }
}

describe('MarginStore schema v2', () => {
  it('clears only v1 document data and preserves settings', async () => {
    const settings = { autoIntercept: false, penTheme: 'soda' };
    const storage = new TestStorage({
      [SCHEMA_VERSION_KEY]: 1,
      [SETTINGS_KEY]: settings,
      [DOCS_KEY]: { old: { id: 'old' } },
      'margin:doc:old:highlights': [{ id: 'h1' }],
      'unrelated:key': 'keep'
    });

    await new MarginStore(storage).ensureSchema();

    expect(storage.data.get(SCHEMA_VERSION_KEY)).toBe(2);
    expect(storage.data.get(SETTINGS_KEY)).toEqual(settings);
    expect(storage.data.has(DOCS_KEY)).toBe(false);
    expect(storage.data.has('margin:doc:old:highlights')).toBe(false);
    expect(storage.data.get('unrelated:key')).toBe('keep');
  });

  it('is a no-op after the first successful initialization', async () => {
    const storage = new TestStorage({ [SCHEMA_VERSION_KEY]: 1, [DOCS_KEY]: {} });
    const store = new MarginStore(storage);

    await store.ensureSchema();
    const removeCalls = storage.removed.length;
    await store.ensureSchema();

    expect(storage.removed).toHaveLength(removeCalls);
  });

  it('preserves all data and stops on a future schema', async () => {
    const storage = new TestStorage({
      [SCHEMA_VERSION_KEY]: 3,
      [DOCS_KEY]: { future: true },
      [SETTINGS_KEY]: { penTheme: 'soda' }
    });

    await expect(new MarginStore(storage).ensureSchema()).rejects.toEqual(
      expect.objectContaining<Partial<FutureSchemaVersionError>>({
        name: 'FutureSchemaVersionError',
        foundVersion: 3
      })
    );
    expect(Object.fromEntries(storage.data)).toEqual({
      [SCHEMA_VERSION_KEY]: 3,
      [DOCS_KEY]: { future: true },
      [SETTINGS_KEY]: { penTheme: 'soda' }
    });
    expect(storage.removed).toHaveLength(0);
  });

  it('promotes a completed Chrome download to an exact path locator', async () => {
    const node: DocNode = {
      id: 'download-node', syncHubId: 'source', syncState: 'undecided', bucketId: 'bucket',
      locator: null, contentEvidence: { pdfJsId: 'weak', sha256: 'same' }, title: 'copy',
      pageCount: 1, pdfjsVersion: '4', addedAt: 1, lastOpenedAt: 1, lastEditedAt: 1
    };
    const bucket: AnnotationBucket = {
      id: 'bucket', revisionId: 'rev', highlights: [], memos: [], figures: []
    };
    const storage = new TestStorage({
      [SCHEMA_VERSION_KEY]: 2,
      [DOCS_KEY]: { [node.id]: node },
      'margin:group:bucket': bucket,
      'margin:locators': {},
      [DOWNLOAD_BINDINGS_KEY]: [{
        id: 'binding', nodeId: node.id, chromeDownloadId: 42, expectedSha256: 'same',
        status: 'pending', createdAt: 1
      }]
    });

    const completed = await new MarginStore(storage).completeDownloadBinding(
      42,
      '/Users/me/Downloads/copy.pdf',
      10
    );
    const savedNodes = storage.data.get(DOCS_KEY) as Record<string, DocNode>;
    const locators = storage.data.get('margin:locators') as Record<string, string>;

    expect(completed).toMatchObject({ status: 'complete', finalPath: '/Users/me/Downloads/copy.pdf' });
    expect(savedNodes[node.id].locator).toEqual({
      kind: 'path', value: '/Users/me/Downloads/copy.pdf'
    });
    expect(locators['path:/Users/me/Downloads/copy.pdf']).toBe(node.id);
  });
});
