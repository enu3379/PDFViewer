import { access, copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DocumentIdentityResolver,
  normalizeLocalPath,
  sha256Hex
} from '../src/core/doc-identity';
import { embedMarginAttachment, readMarginAttachment } from '../src/core/pdf-embed';
import { MarginStore, type StorageArea } from '../src/core/store';
import {
  applySync,
  createDerivedNode,
  createDownloadBinding,
  deleteNode,
  detachNode,
  validateSyncInvariants
} from '../src/core/sync';
import type { DocLocator, IdentityState, MarginAttachmentV1, Memo } from '../src/core/types';

class SmokeStorage implements StorageArea {
  readonly data = new Map<string, unknown>();

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
    for (const [key, value] of Object.entries(items)) this.data.set(key, structuredClone(value));
  }

  async remove(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true
  })));
});

async function smokeDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'margin-w33-smoke-'));
  temporaryDirectories.push(path);
  return path;
}

async function blankPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  return pdf.save();
}

function makeResolver(prefix = 'smoke') {
  let sequence = 0;
  return new DocumentIdentityResolver([], {
    makeId: () => `${prefix}-${++sequence}`,
    locatorExists: async (locator) => {
      if (locator.kind !== 'path') return true;
      try {
        await access(locator.value);
        return true;
      } catch {
        return false;
      }
    }
  });
}

async function resolvePdf(
  resolver: DocumentIdentityResolver,
  state: IdentityState,
  locator: DocLocator,
  bytes: Uint8Array,
  now: number,
  attachment: MarginAttachmentV1 | null = null
) {
  return resolver.resolve({
    locator,
    title: locator.kind === 'path' ? basename(locator.value) : 'Web original',
    pageCount: 1,
    pdfjsVersion: 'smoke',
    evidence: {
      pdfJsId: 'same-weak-pdfjs-id',
      byteLength: bytes.byteLength,
      fileName: locator.kind === 'path' ? basename(locator.value) : undefined
    },
    attachment,
    now,
    getSha256: () => sha256Hex(bytes)
  }, state);
}

async function resolvePdfFile(
  resolver: DocumentIdentityResolver,
  state: IdentityState,
  path: string,
  now: number
) {
  const bytes = new Uint8Array(await readFile(path));
  const embedded = await readMarginAttachment(bytes);
  return resolvePdf(
    resolver,
    state,
    { kind: 'path', value: normalizeLocalPath(path) },
    bytes,
    now,
    embedded.attachment
  );
}

function memo(doc: string, id: string, text: string, now: number): Memo {
  return {
    id,
    doc,
    anchorType: 'highlight',
    anchorId: `highlight-${id}`,
    quote: '',
    page: 1,
    text,
    tags: [],
    links: [],
    createdAt: now,
    updatedAt: now
  };
}

function addMemo(
  state: IdentityState,
  nodeId: string,
  id: string,
  text: string,
  revisionId: string,
  now: number
): void {
  const node = state.nodes[nodeId];
  const bucket = state.buckets[node.bucketId];
  bucket.memos.push(memo(nodeId, id, text, now));
  bucket.revisionId = revisionId;
  node.lastEditedAt = now;
}

async function bindCompletedDownload(
  store: MarginStore,
  state: IdentityState,
  nodeId: string,
  sha256: string,
  bindingId: string,
  downloadId: number,
  path: string,
  now: number
): Promise<IdentityState> {
  const binding = createDownloadBinding(nodeId, sha256, { id: bindingId, now });
  binding.kind = 'file-only';
  state.downloadBindings.push(binding);
  await store.saveIdentityState(state);
  await store.setDownloadId(bindingId, downloadId);
  await store.completeDownloadBinding(downloadId, normalizeLocalPath(path), now + 1);
  return store.loadIdentityState();
}

describe('W-33 multi-file lifecycle smoke', () => {
  it('keeps two byte-identical downloads private, then shares only after explicit sync and stops after detach', async () => {
    const directory = await smokeDirectory();
    const bytes = await blankPdf();
    const sha256 = await sha256Hex(bytes);
    const firstPath = join(directory, 'paper (1).pdf');
    const secondPath = join(directory, 'paper (2).pdf');
    await writeFile(firstPath, bytes);
    await writeFile(secondPath, bytes);

    const storage = new SmokeStorage();
    const store = new MarginStore(storage);
    const resolver = makeResolver();
    const web = await resolvePdf(
      resolver,
      await store.loadIdentityState(),
      { kind: 'url', value: 'https://example.test/paper.pdf' },
      bytes,
      10
    );
    let state = web.state;
    addMemo(state, web.node.id, 'base', 'web base', 'rev-web-base', 11);

    const first = createDerivedNode(state, web.node.id, 'file-only', {
      id: 'download-1', bucketId: 'bucket-download-1', now: 20,
      contentEvidence: { pdfJsId: 'same-weak-pdfjs-id', sha256, byteLength: bytes.byteLength }
    });
    state = await bindCompletedDownload(
      store, first.state, first.node.id, sha256, 'binding-1', 101, firstPath, 20
    );
    const second = createDerivedNode(state, web.node.id, 'file-only', {
      id: 'download-2', bucketId: 'bucket-download-2', now: 30,
      contentEvidence: { pdfJsId: 'same-weak-pdfjs-id', sha256, byteLength: bytes.byteLength }
    });
    state = await bindCompletedDownload(
      store, second.state, second.node.id, sha256, 'binding-2', 102, secondPath, 30
    );

    const reopenedFirst = await resolvePdfFile(resolver, state, firstPath, 40);
    expect(reopenedFirst.node.id).toBe(first.node.id);
    const reopenedSecond = await resolvePdfFile(resolver, reopenedFirst.state, secondPath, 41);
    expect(reopenedSecond.node.id).toBe(second.node.id);
    state = reopenedSecond.state;

    expect(new Set([
      state.nodes[web.node.id].bucketId,
      state.nodes[first.node.id].bucketId,
      state.nodes[second.node.id].bucketId
    ]).size).toBe(3);
    addMemo(state, first.node.id, 'private', 'first copy only', 'rev-first-private', 50);
    expect(state.buckets[state.nodes[web.node.id].bucketId].memos.map((item) => item.id))
      .toEqual(['base']);
    expect(state.buckets[state.nodes[second.node.id].bucketId].memos.map((item) => item.id))
      .toEqual(['base']);

    const synced = applySync(state, first.node.id, { makeId: () => 'rev-synced' });
    expect(synced.status).toBe('synced');
    state = synced.state;
    expect(state.nodes[first.node.id].bucketId).toBe(state.nodes[web.node.id].bucketId);
    expect(state.nodes[second.node.id].bucketId).not.toBe(state.nodes[web.node.id].bucketId);
    addMemo(state, web.node.id, 'shared', 'shared after sync', 'rev-shared', 60);
    expect(state.buckets[state.nodes[first.node.id].bucketId].memos.map((item) => item.id))
      .toContain('shared');
    expect(state.buckets[state.nodes[second.node.id].bucketId].memos.map((item) => item.id))
      .not.toContain('shared');

    state = detachNode(state, first.node.id, { bucketId: 'bucket-detached-first' });
    addMemo(state, first.node.id, 'detached', 'detached only', 'rev-detached', 70);
    expect(state.buckets[state.nodes[web.node.id].bucketId].memos.map((item) => item.id))
      .not.toContain('detached');
    expect(validateSyncInvariants(state)).toEqual([]);

    await store.saveIdentityState(state);
    const afterRestart = await new MarginStore(storage).loadIdentityState();
    expect(afterRestart.nodes[first.node.id]).toMatchObject({
      syncHubId: null,
      syncState: 'detached',
      locator: { kind: 'path', value: normalizeLocalPath(firstPath) }
    });
    expect(afterRestart.downloadBindings.filter((item) => item.status === 'complete')).toHaveLength(2);
  });

  it('round-trips a memo PDF, rebinds a moved file, and adopts a live external copy independently', async () => {
    const directory = await smokeDirectory();
    const sourcePath = join(directory, 'source.pdf');
    const memoPath = join(directory, 'with-memos.pdf');
    const movedPath = join(directory, 'renamed-with-memos.pdf');
    const externalPath = join(directory, 'external-copy.pdf');
    const sourceBytes = await blankPdf();
    await writeFile(sourcePath, sourceBytes);

    const storage = new SmokeStorage();
    let store = new MarginStore(storage);
    let resolver = makeResolver('before-restart');
    const source = await resolvePdfFile(resolver, await store.loadIdentityState(), sourcePath, 10);
    let state = source.state;
    addMemo(state, source.node.id, 'snapshot', 'memo in PDF', 'rev-snapshot', 11);

    const embedded = await embedMarginAttachment(
      sourceBytes,
      state.buckets[state.nodes[source.node.id].bucketId],
      { pageCount: 1, artifactId: 'artifact-smoke', exportedAt: 20 }
    );
    await writeFile(memoPath, embedded.bytes);
    const embeddedSha = await sha256Hex(embedded.bytes);
    const memoDownload = createDerivedNode(state, source.node.id, 'memo-with', {
      id: 'memo-download', bucketId: 'unused', now: 20,
      artifactId: embedded.attachment.artifactId,
      contentEvidence: {
        pdfJsId: 'embedded-weak-id', sha256: embeddedSha, byteLength: embedded.bytes.byteLength
      }
    });
    state = memoDownload.state;
    const binding = createDownloadBinding(memoDownload.node.id, embeddedSha, {
      id: 'binding-memo', now: 20
    });
    binding.kind = 'memo-with';
    state.downloadBindings.push(binding);
    await store.saveIdentityState(state);
    await store.setDownloadId(binding.id, 201);
    await store.completeDownloadBinding(201, normalizeLocalPath(memoPath), 21);

    store = new MarginStore(storage);
    resolver = makeResolver('after-restart');
    state = await store.loadIdentityState();
    const reopened = await resolvePdfFile(resolver, state, memoPath, 30);
    expect(reopened.node.id).toBe(memoDownload.node.id);
    expect(reopened.node.bucketId).toBe(reopened.state.nodes[source.node.id].bucketId);
    expect((await readMarginAttachment(new Uint8Array(await readFile(memoPath))))
      .attachment?.payload.memos.map((item) => item.text)).toEqual(['memo in PDF']);

    await rename(memoPath, movedPath);
    const moved = await resolvePdfFile(resolver, reopened.state, movedPath, 40);
    expect(moved.kind).toBe('rebound');
    expect(moved.node.id).toBe(memoDownload.node.id);
    expect(moved.node.locator).toEqual({ kind: 'path', value: normalizeLocalPath(movedPath) });

    await copyFile(movedPath, externalPath);
    const external = await resolvePdfFile(resolver, moved.state, externalPath, 50);
    expect(external.kind).toBe('adopted');
    expect(external.node.id).not.toBe(memoDownload.node.id);
    expect(external.node.syncState).toBe('detached');
    expect(external.node.bucketId).not.toBe(external.state.nodes[source.node.id].bucketId);
    expect(external.state.buckets[external.node.bucketId].memos.map((item) => item.text))
      .toEqual(['memo in PDF']);

    state = external.state;
    addMemo(state, external.node.id, 'external-only', 'external edit', 'rev-external', 51);
    expect(state.buckets[state.nodes[source.node.id].bucketId].memos.map((item) => item.id))
      .not.toContain('external-only');
    expect(validateSyncInvariants(state)).toEqual([]);
    await store.saveIdentityState(state);

    const afterRestart = await new MarginStore(storage).loadIdentityState();
    expect(afterRestart.nodes[memoDownload.node.id].locator)
      .toEqual({ kind: 'path', value: normalizeLocalPath(movedPath) });
    expect(afterRestart.nodes[external.node.id].locator)
      .toEqual({ kind: 'path', value: normalizeLocalPath(externalPath) });
  });

  it('persists a two-sided conflict resolution and promotes a linked member when the hub is deleted', async () => {
    const storage = new SmokeStorage();
    const store = new MarginStore(storage);
    const bytes = await blankPdf();
    const resolver = makeResolver();
    const hub = await resolvePdf(
      resolver,
      await store.loadIdentityState(),
      { kind: 'url', value: 'https://example.test/conflict.pdf' },
      bytes,
      10
    );
    let state = hub.state;
    const active = createDerivedNode(state, hub.node.id, 'memo-with', {
      id: 'active-member', bucketId: 'unused', now: 20, artifactId: 'active-artifact'
    });
    const pending = createDerivedNode(active.state, hub.node.id, 'file-only', {
      id: 'pending-member', bucketId: 'bucket-pending', now: 30
    });
    state = pending.state;
    addMemo(state, hub.node.id, 'hub-edit', 'hub side', 'rev-hub-edit', 40);
    addMemo(state, pending.node.id, 'member-edit', 'member side', 'rev-member-edit', 41);
    await store.saveIdentityState(state);

    const reloaded = await new MarginStore(storage).loadIdentityState();
    expect(applySync(reloaded, pending.node.id).status).toBe('conflict');
    const resolved = applySync(reloaded, pending.node.id, {
      overwriteConflict: true,
      makeId: () => 'rev-overwrite'
    });
    expect(resolved.status).toBe('synced');
    expect(resolved.state.buckets[resolved.state.nodes[hub.node.id].bucketId]
      .memos.map((item) => item.id)).toContain('member-edit');

    const deleted = deleteNode(resolved.state, hub.node.id);
    expect(deleted.nodes[active.node.id]).toMatchObject({
      syncHubId: null,
      syncState: 'detached'
    });
    expect(deleted.nodes[pending.node.id]).toMatchObject({
      syncHubId: active.node.id,
      syncState: 'syncing'
    });
    expect(validateSyncInvariants(deleted)).toEqual([]);
    await store.saveIdentityState(deleted);

    const afterRestart = await new MarginStore(storage).loadIdentityState();
    expect(validateSyncInvariants(afterRestart)).toEqual([]);
    expect(afterRestart.buckets[afterRestart.nodes[active.node.id].bucketId]
      .memos.map((item) => item.id)).toContain('member-edit');
  });
});
