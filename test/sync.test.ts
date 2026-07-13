import { describe, expect, it } from 'vitest';
import {
  applySync,
  createDerivedNode,
  deleteNode,
  deletionImpact,
  detachNode,
  EMPTY_NODE_TTL_MS,
  PENDING_BINDING_TTL_MS,
  selectSyncTarget,
  sweepIdentityState,
  validateSyncInvariants
} from '../src/core/sync';
import type { AnnotationBucket, DocNode, IdentityState } from '../src/core/types';

function bucket(id: string, revisionId = 'r0', memoText?: string): AnnotationBucket {
  return {
    id,
    revisionId,
    highlights: [],
    memos: memoText ? [{
      id: `m-${id}`, doc: id, anchorType: 'highlight', anchorId: 'h', quote: '', page: 1,
      text: memoText, tags: [], links: [], createdAt: 1, updatedAt: 1
    }] : [],
    figures: []
  };
}

function node(id: string, bucketId = `b-${id}`, patch: Partial<DocNode> = {}): DocNode {
  return {
    id,
    syncHubId: null,
    syncState: 'detached',
    bucketId,
    locator: null,
    contentEvidence: { pdfJsId: 'weak', sha256: 'sha' },
    title: id,
    pageCount: 1,
    pdfjsVersion: '4',
    addedAt: 1,
    lastOpenedAt: 1,
    lastEditedAt: 1,
    ...patch
  };
}

function state(nodes: DocNode[], buckets?: AnnotationBucket[]): IdentityState {
  return {
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    buckets: Object.fromEntries(
      (buckets ?? nodes.map((item) => bucket(item.bucketId))).map((item) => [item.id, item])
    ),
    locators: {},
    downloadBindings: []
  };
}

describe('derived document transitions', () => {
  it('creates file-only and clone nodes as undecided private forks', () => {
    const root = node('root');
    const fileOnly = createDerivedNode(state([root]), 'root', 'file-only', {
      id: 'file', bucketId: 'b-file', now: 2
    });
    expect(fileOnly.node).toMatchObject({
      syncHubId: 'root', syncState: 'undecided', bucketId: 'b-file',
      forkBaseRevisionId: 'r0', syncHubBaselineRevisionId: 'r0'
    });
    expect(fileOnly.state.buckets['b-file']).toMatchObject({
      revisionId: fileOnly.state.buckets['b-root'].revisionId,
      highlights: fileOnly.state.buckets['b-root'].highlights,
      memos: fileOnly.state.buckets['b-root'].memos,
      figures: fileOnly.state.buckets['b-root'].figures
    });
    expect(fileOnly.state.buckets['b-file']).not.toBe(fileOnly.state.buckets['b-root']);

    const syncingSource = node('member', 'b-root', {
      syncHubId: 'root', syncState: 'syncing'
    });
    const cloned = createDerivedNode(
      state([root, syncingSource], [bucket('b-root')]),
      'member',
      'clone',
      { id: 'clone', bucketId: 'b-clone' }
    );
    expect(cloned.node).toMatchObject({
      syncHubId: 'root', syncState: 'undecided', bucketId: 'b-clone'
    });
  });

  it('creates memo-with nodes already sharing the current bucket', () => {
    const root = node('root');
    const result = createDerivedNode(state([root]), 'root', 'memo-with', {
      id: 'with-memos', bucketId: 'unused', artifactId: 'artifact'
    });
    expect(result.node).toMatchObject({
      syncHubId: 'root', syncState: 'syncing', bucketId: 'b-root', artifactId: 'artifact'
    });
    expect(validateSyncInvariants(result.state)).toEqual([]);
  });
});

describe('sync target and divergence', () => {
  it('connects only the most recently edited pending member', () => {
    const root = node('root');
    const old = node('old', 'b-old', {
      syncHubId: 'root', syncState: 'undecided', forkBaseRevisionId: 'r0',
      syncHubBaselineRevisionId: 'r0', lastEditedAt: 3
    });
    const recent = node('recent', 'b-recent', {
      syncHubId: 'root', syncState: 'undecided', forkBaseRevisionId: 'r0',
      syncHubBaselineRevisionId: 'r0', lastEditedAt: 9
    });
    const initial = state([root, old, recent]);

    expect(selectSyncTarget(initial, 'root')?.target.id).toBe('recent');
    const synced = applySync(initial, 'root');
    expect(synced.status).toBe('synced');
    expect(synced.state.nodes.recent.syncState).toBe('syncing');
    expect(synced.state.nodes.old.syncState).toBe('undecided');
  });

  it('adopts member edits when only the member changed', () => {
    const root = node('root');
    const member = node('member', 'b-member', {
      syncHubId: 'root', syncState: 'undecided', forkBaseRevisionId: 'r0',
      syncHubBaselineRevisionId: 'r0'
    });
    const initial = state(
      [root, member],
      [bucket('b-root', 'r0', 'root'), bucket('b-member', 'member-edit', 'member')]
    );
    const synced = applySync(initial, 'member', { makeId: () => 'union-rev' });

    expect(synced.status).toBe('synced');
    expect(synced.state.buckets['b-root'].memos[0].text).toBe('member');
    expect(synced.state.buckets['b-root'].revisionId).toBe('union-rev');
    expect(synced.state.nodes.member.bucketId).toBe('b-root');
  });

  it('requires confirmation when both sides changed and overwrites from the current document', () => {
    const root = node('root');
    const member = node('member', 'b-member', {
      syncHubId: 'root', syncState: 'undecided', forkBaseRevisionId: 'r0',
      syncHubBaselineRevisionId: 'r0'
    });
    const initial = state(
      [root, member],
      [bucket('b-root', 'hub-edit', 'hub'), bucket('b-member', 'member-edit', 'member')]
    );
    expect(applySync(initial, 'member').status).toBe('conflict');

    const overwritten = applySync(initial, 'member', {
      overwriteConflict: true,
      makeId: () => 'overwrite-rev'
    });
    expect(overwritten.status).toBe('synced');
    expect(overwritten.state.buckets['b-root'].memos[0].text).toBe('member');
  });
});

describe('detach, delete, and lazy sweep', () => {
  it('forks an active member and its active children together on detach', () => {
    const root = node('root');
    const member = node('member', 'b-root', { syncHubId: 'root', syncState: 'syncing' });
    const child = node('child', 'b-root', { syncHubId: 'member', syncState: 'syncing' });
    const detached = detachNode(
      state([root, member, child], [bucket('b-root', 'r0', 'memo')]),
      'member',
      { bucketId: 'b-detached' }
    );
    expect(detached.nodes.member).toMatchObject({
      syncHubId: null, syncState: 'detached', bucketId: 'b-detached'
    });
    expect(detached.nodes.child).toMatchObject({
      syncHubId: 'member', syncState: 'syncing', bucketId: 'b-detached'
    });
    expect(detached.buckets['b-detached'].memos[0].text).toBe('memo');
  });

  it('promotes the oldest active member when a hub is deleted', () => {
    const hub = node('hub', 'shared', { addedAt: 1 });
    const old = node('old', 'shared', {
      syncHubId: 'hub', syncState: 'syncing', addedAt: 2
    });
    const recent = node('recent', 'shared', {
      syncHubId: 'hub', syncState: 'syncing', addedAt: 3
    });
    const pending = node('pending', 'private', {
      syncHubId: 'hub', syncState: 'undecided', addedAt: 4
    });
    const initial = state([hub, old, recent, pending], [bucket('shared', 'r', 'memo'), bucket('private')]);

    expect(deletionImpact(initial, 'hub')).toEqual({ shared: true, memoCount: 1 });
    const deleted = deleteNode(initial, 'hub');
    expect(deleted.nodes.old).toMatchObject({ syncHubId: null, syncState: 'detached' });
    expect(deleted.nodes.recent.syncHubId).toBe('old');
    expect(deleted.nodes.pending.syncHubId).toBe('old');
    expect(deleted.buckets.shared.memos[0].text).toBe('memo');
    expect(validateSyncInvariants(deleted)).toEqual([]);
  });

  it('detaches pending references when a hub has no active member', () => {
    const hub = node('hub');
    const pending = node('pending', 'private', {
      syncHubId: 'hub', syncState: 'undecided'
    });
    const deleted = deleteNode(state([hub, pending]), 'hub');
    expect(deleted.nodes.pending).toMatchObject({ syncHubId: null, syncState: 'detached' });
    expect(deleted.buckets['b-hub']).toBeUndefined();
  });

  it('sweeps stale pending bindings and old empty detached nodes but preserves annotated nodes', () => {
    const now = 200 * 24 * 60 * 60 * 1000;
    const empty = node('empty', 'b-empty', { lastOpenedAt: now - EMPTY_NODE_TTL_MS });
    const annotated = node('annotated', 'b-annotated', { lastOpenedAt: 0 });
    const initial = state(
      [empty, annotated],
      [bucket('b-empty'), bucket('b-annotated', 'r', 'keep')]
    );
    initial.downloadBindings = [
      { id: 'stale', nodeId: 'annotated', expectedSha256: 'x', status: 'pending', createdAt: now - PENDING_BINDING_TTL_MS },
      { id: 'fresh', nodeId: 'annotated', expectedSha256: 'x', status: 'pending', createdAt: now - 1 }
    ];

    const swept = sweepIdentityState(initial, now);
    expect(swept.nodes.empty).toBeUndefined();
    expect(swept.nodes.annotated).toBeDefined();
    expect(swept.downloadBindings.map((item) => item.id)).toEqual(['fresh']);
  });
});
