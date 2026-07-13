import { describe, expect, it } from 'vitest';
import {
  DocumentIdentityResolver,
  locatorFromUrl,
  normalizeLocalPath,
  normalizeWebUrl
} from '../src/core/doc-identity';
import { locatorKey } from '../src/core/store';
import type { AnnotationBucket, DocNode, IdentityState } from '../src/core/types';

function bucket(id: string, revisionId = 'rev-1'): AnnotationBucket {
  return { id, revisionId, highlights: [], memos: [], figures: [] };
}

function node(id: string, path: string, sha256 = 'same'): DocNode {
  return {
    id,
    syncHubId: null,
    syncState: 'detached',
    bucketId: `bucket-${id}`,
    locator: { kind: 'path', value: path },
    contentEvidence: { pdfJsId: 'weak', sha256 },
    title: id,
    pageCount: 1,
    pdfjsVersion: 'test',
    addedAt: 1,
    lastOpenedAt: 1,
    lastEditedAt: 1
  };
}

function state(...nodes: DocNode[]): IdentityState {
  return {
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    buckets: Object.fromEntries(nodes.map((item) => [item.bucketId, bucket(item.bucketId)])),
    locators: Object.fromEntries(nodes.flatMap((item) => {
      const key = locatorKey(item.locator);
      return key ? [[key, item.id]] : [];
    })),
    downloadBindings: []
  };
}

function input(path: string, sha256 = 'same') {
  return {
    locator: { kind: 'path' as const, value: path },
    title: 'Paper',
    pageCount: 2,
    pdfjsVersion: '4',
    evidence: { pdfJsId: 'weak', sha256 },
    now: 10
  };
}

describe('URL locator normalization', () => {
  it('drops fragments and tracking parameters while preserving meaningful query order', () => {
    expect(normalizeWebUrl('HTTPS://Example.COM:443/p.pdf?b=2&utm_source=x&a=1#page=3'))
      .toBe('https://example.com/p.pdf?b=2&a=1');
    expect(normalizeWebUrl('https://x.test/p.pdf?a=1&b=2'))
      .not.toBe(normalizeWebUrl('https://x.test/p.pdf?b=2&a=1'));
  });

  it('keeps arXiv versions separate and normalizes local paths', () => {
    expect(normalizeWebUrl('https://arxiv.org/pdf/1234.5678v1'))
      .not.toBe(normalizeWebUrl('https://arxiv.org/pdf/1234.5678v2'));
    expect(locatorFromUrl('file:///C:/Users/Me/paper.pdf')).toEqual({
      kind: 'path', value: 'c:/Users/Me/paper.pdf'
    });
    expect(normalizeLocalPath('C:\\Users\\Me\\paper.pdf')).toBe('c:/Users/Me/paper.pdf');
  });
});

describe('DocumentIdentityResolver', () => {
  it('keeps the node and bucket when bytes change at the same locator', async () => {
    const original = node('original', '/docs/paper.pdf', 'old');
    const result = await new DocumentIdentityResolver().resolve(
      {
        ...input('/docs/paper.pdf', 'old'),
        evidence: { pdfJsId: 'weak' },
        getSha256: async () => 'new'
      },
      state(original)
    );

    expect(result.kind).toBe('existing');
    expect(result.node.id).toBe('original');
    expect(result.node.bucketId).toBe('bucket-original');
    expect(result.node.contentEvidence.sha256).toBe('new');
  });

  it('opens an external byte-identical copy as a new independent node', async () => {
    const original = node('original', '/docs/paper.pdf');
    const result = await new DocumentIdentityResolver([], {
      locatorExists: async () => true,
      makeId: (() => {
        const ids = ['copy', 'bucket-copy'];
        return () => ids.shift()!;
      })()
    }).resolve(input('/docs/paper copy.pdf'), state(original));

    expect(result.kind).toBe('new');
    expect(result.node.id).toBe('copy');
    expect(result.node.bucketId).not.toBe(original.bucketId);
    result.state.buckets[result.node.bucketId].memos.push({
      id: 'm', doc: result.node.id, anchorType: 'highlight', anchorId: 'h', quote: '', page: 1,
      text: 'copy only', tags: [], links: [], createdAt: 1, updatedAt: 1
    });
    expect(result.state.buckets[original.bucketId].memos).toHaveLength(0);
  });

  it('rebinds a unique strong match when the old path is gone', async () => {
    const original = node('original', '/docs/old.pdf');
    const result = await new DocumentIdentityResolver([], {
      locatorExists: async () => false
    }).resolve(input('/docs/moved.pdf'), state(original));

    expect(result.kind).toBe('rebound');
    expect(result.node.id).toBe('original');
    expect(result.node.locator).toEqual({ kind: 'path', value: '/docs/moved.pdf' });
  });

  it('does not auto-select non-equivalent pending downloads', async () => {
    const a = node('a', '', 'same');
    const b = node('b', '', 'same');
    a.locator = null;
    b.locator = null;
    b.syncHubId = 'hub';
    b.syncState = 'undecided';
    const initial = state(a, b);
    initial.downloadBindings = [
      { id: 'd1', nodeId: 'a', expectedSha256: 'same', status: 'pending', createdAt: 2 },
      { id: 'd2', nodeId: 'b', expectedSha256: 'same', status: 'pending', createdAt: 2 }
    ];

    const result = await new DocumentIdentityResolver([], {
      makeId: (() => {
        const ids = ['new', 'bucket-new'];
        return () => ids.shift()!;
      })()
    }).resolve(input('/downloads/paper.pdf'), initial);

    expect(result.ambiguous).toBe(true);
    expect(result.node.id).toBe('new');
    expect(result.state.downloadBindings.every((item) => item.status === 'pending')).toBe(true);
  });

  it('deterministically consumes one exchangeable pending download', async () => {
    const a = node('a', '', 'same');
    const b = node('b', '', 'same');
    a.locator = null;
    b.locator = null;
    const initial = state(a, b);
    initial.downloadBindings = [
      { id: 'd1', nodeId: 'a', expectedSha256: 'same', status: 'pending', createdAt: 2 },
      { id: 'd2', nodeId: 'b', expectedSha256: 'same', status: 'pending', createdAt: 2 }
    ];

    const result = await new DocumentIdentityResolver().resolve(input('/downloads/paper.pdf'), initial);

    expect(result.kind).toBe('download-binding');
    expect(result.node.id).toBe('a');
    expect(result.state.downloadBindings.find((item) => item.id === 'd1')?.status).toBe('complete');
    expect(result.state.downloadBindings.find((item) => item.id === 'd2')?.status).toBe('pending');
  });

  it('adopts a first-seen portable attachment into a new independent bucket', async () => {
    const result = await new DocumentIdentityResolver([], {
      makeId: (() => {
        const ids = ['adopted', 'bucket-adopted', 'revision'];
        return () => ids.shift()!;
      })()
    }).resolve({
      ...input('/downloads/from-other-device.pdf', 'portable-sha'),
      attachment: {
        format: 'margin.annotations', version: 1, artifactId: 'portable', exportedAt: 1,
        source: { sha256: 'a'.repeat(64), pageCount: 2 },
        payload: {
          highlights: [], figures: [], memos: [{
            id: 'm1', anchorType: 'highlight', anchorId: 'h1', quote: '', page: 1,
            text: 'portable memo', tags: [], links: [], createdAt: 1, updatedAt: 1
          }]
        }
      }
    }, state());

    expect(result.kind).toBe('adopted');
    expect(result.node).toMatchObject({
      id: 'adopted', syncHubId: null, syncState: 'detached', artifactId: 'portable'
    });
    expect(result.state.buckets['bucket-adopted'].memos[0]).toMatchObject({
      doc: 'adopted', text: 'portable memo'
    });
  });
});
