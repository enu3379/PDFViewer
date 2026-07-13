import { locatorKey, makeUuid } from './store';
import type {
  AnnotationBucket,
  ContentEvidence,
  DocNode,
  DownloadBinding,
  IdentityState
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
export const PENDING_BINDING_TTL_MS = 30 * DAY_MS;
export const EMPTY_NODE_TTL_MS = 90 * DAY_MS;

export type DerivedKind = 'file-only' | 'memo-with' | 'clone' | 'export';

export interface DerivedNodeInput {
  id?: string;
  bucketId?: string;
  title?: string;
  pageCount?: number;
  pdfjsVersion?: string;
  contentEvidence?: ContentEvidence;
  artifactId?: string;
  now?: number;
  makeId?: () => string;
}

export interface SyncSelection {
  current: DocNode;
  target: DocNode;
  hub: DocNode;
  member: DocNode;
}

export interface SyncAssessment extends SyncSelection {
  conflict: boolean;
  memberEdited: boolean;
  hubEdited: boolean;
  birthDiverged: boolean;
  action: 'adopt-hub' | 'adopt-member';
}

export type SyncApplyResult =
  | { status: 'no-target'; state: IdentityState }
  | { status: 'conflict'; state: IdentityState; assessment: SyncAssessment }
  | { status: 'synced'; state: IdentityState; assessment: SyncAssessment };

export interface DeleteImpact {
  shared: boolean;
  memoCount: number;
}

export function pendingMembersOf(state: IdentityState, hubId: string): DocNode[] {
  return Object.values(state.nodes).filter(
    (node) => node.syncHubId === hubId && node.syncState === 'undecided'
  );
}

export function activeMembersOf(state: IdentityState, hubId: string): DocNode[] {
  return Object.values(state.nodes).filter(
    (node) => node.syncHubId === hubId && node.syncState === 'syncing'
  );
}

export function forkBucket(
  source: AnnotationBucket,
  id = makeUuid()
): AnnotationBucket {
  return {
    id,
    // fork 기준점 비교를 위해 복제 직후에는 revision을 그대로 유지한다.
    revisionId: source.revisionId,
    highlights: structuredClone(source.highlights),
    memos: structuredClone(source.memos),
    figures: structuredClone(source.figures)
  };
}

export function createDerivedNode(
  sourceState: IdentityState,
  sourceId: string,
  kind: DerivedKind,
  input: DerivedNodeInput = {}
): { state: IdentityState; node: DocNode } {
  const state = cloneState(sourceState);
  const source = requiredNode(state, sourceId);
  const sourceBucket = requiredBucket(state, source.bucketId);
  const makeId = input.makeId ?? makeUuid;
  const now = input.now ?? Date.now();
  const id = input.id ?? makeId();
  const newBucketId = input.bucketId ?? makeId();
  let bucketId = newBucketId;
  let syncHubId: string | null = null;
  let syncState: DocNode['syncState'] = 'detached';
  let forkBaseRevisionId: string | undefined;
  let syncHubBaselineRevisionId: string | undefined;

  if (kind === 'memo-with') {
    bucketId = source.bucketId;
    syncHubId = source.id;
    syncState = 'syncing';
    forkBaseRevisionId = sourceBucket.revisionId;
    syncHubBaselineRevisionId = sourceBucket.revisionId;
  } else if (kind === 'file-only' || kind === 'clone') {
    const hubId = kind === 'clone' ? (source.syncHubId ?? source.id) : source.id;
    const hub = requiredNode(state, hubId);
    const hubBucket = requiredBucket(state, hub.bucketId);
    state.buckets[newBucketId] = forkBucket(sourceBucket, newBucketId);
    syncHubId = hubId;
    syncState = 'undecided';
    forkBaseRevisionId = sourceBucket.revisionId;
    syncHubBaselineRevisionId = hubBucket.revisionId;
  } else {
    state.buckets[newBucketId] = forkBucket(sourceBucket, newBucketId);
  }

  const node: DocNode = {
    id,
    syncHubId,
    syncState,
    bucketId,
    locator: null,
    artifactId: input.artifactId,
    contentEvidence: input.contentEvidence ?? { ...source.contentEvidence },
    forkBaseRevisionId,
    syncHubBaselineRevisionId,
    title: input.title ?? source.title,
    pageCount: input.pageCount ?? source.pageCount,
    pdfjsVersion: input.pdfjsVersion ?? source.pdfjsVersion,
    addedAt: now,
    lastOpenedAt: now,
    lastEditedAt: now
  };
  state.nodes[id] = node;
  return { state, node };
}

export function createDownloadBinding(
  nodeId: string,
  expectedSha256: string,
  input: { id?: string; now?: number; makeId?: () => string } = {}
): DownloadBinding {
  return {
    id: input.id ?? (input.makeId ?? makeUuid)(),
    nodeId,
    expectedSha256,
    status: 'pending',
    createdAt: input.now ?? Date.now()
  };
}

export function selectSyncTarget(state: IdentityState, currentId: string): SyncSelection | null {
  const current = state.nodes[currentId];
  if (!current) return null;
  const candidates: DocNode[] = [];
  if (current.syncState === 'undecided' && current.syncHubId) {
    const hub = state.nodes[current.syncHubId];
    if (hub) candidates.push(hub);
  }
  candidates.push(...pendingMembersOf(state, current.id));
  const target = candidates.sort(
    (a, b) => b.lastEditedAt - a.lastEditedAt || a.id.localeCompare(b.id)
  )[0];
  if (!target) return null;

  if (current.syncState === 'undecided' && current.syncHubId === target.id) {
    return { current, target, hub: target, member: current };
  }
  return { current, target, hub: current, member: target };
}

export function assessSync(state: IdentityState, currentId: string): SyncAssessment | null {
  const selection = selectSyncTarget(state, currentId);
  if (!selection) return null;
  const memberBucket = requiredBucket(state, selection.member.bucketId);
  const hubBucket = requiredBucket(state, selection.hub.bucketId);
  const forkBase = selection.member.forkBaseRevisionId;
  const hubBaseline = selection.member.syncHubBaselineRevisionId;
  const birthDiverged = !forkBase || !hubBaseline || forkBase !== hubBaseline;
  const memberEdited = !forkBase || memberBucket.revisionId !== forkBase;
  const hubEdited = !hubBaseline || hubBucket.revisionId !== hubBaseline;
  return {
    ...selection,
    conflict: birthDiverged || (memberEdited && hubEdited),
    memberEdited,
    hubEdited,
    birthDiverged,
    action: memberEdited && !hubEdited ? 'adopt-member' : 'adopt-hub'
  };
}

export function applySync(
  sourceState: IdentityState,
  currentId: string,
  options: { overwriteConflict?: boolean; makeId?: () => string } = {}
): SyncApplyResult {
  const state = cloneState(sourceState);
  const assessment = assessSync(state, currentId);
  if (!assessment) return { status: 'no-target', state };
  if (assessment.conflict && !options.overwriteConflict) {
    return { status: 'conflict', state, assessment };
  }

  const makeId = options.makeId ?? makeUuid;
  const hub = requiredNode(state, assessment.hub.id);
  const member = requiredNode(state, assessment.member.id);
  const hubBucket = requiredBucket(state, hub.bucketId);
  const memberBucket = requiredBucket(state, member.bucketId);
  const oldMemberBucketId = member.bucketId;

  if (assessment.conflict) {
    const current = requiredNode(state, currentId);
    const currentBucket = requiredBucket(state, current.bucketId);
    if (currentBucket.id !== hubBucket.id) copyBucketContents(currentBucket, hubBucket, makeId());
  } else if (assessment.action === 'adopt-member') {
    copyBucketContents(memberBucket, hubBucket, makeId());
  }

  member.bucketId = hub.bucketId;
  member.syncHubId = hub.id;
  member.syncState = 'syncing';
  delete member.forkBaseRevisionId;
  delete member.syncHubBaselineRevisionId;
  removeBucketIfUnused(state, oldMemberBucketId);
  return { status: 'synced', state, assessment };
}

export function detachNode(
  sourceState: IdentityState,
  nodeId: string,
  options: { bucketId?: string; makeId?: () => string } = {}
): IdentityState {
  const state = cloneState(sourceState);
  const node = requiredNode(state, nodeId);
  if (node.syncState === 'detached') return state;

  if (node.syncState === 'syncing') {
    const sourceBucket = requiredBucket(state, node.bucketId);
    const newBucketId = options.bucketId ?? (options.makeId ?? makeUuid)();
    state.buckets[newBucketId] = forkBucket(sourceBucket, newBucketId);
    node.bucketId = newBucketId;
    for (const child of activeMembersOf(state, node.id)) child.bucketId = newBucketId;
  }
  node.syncHubId = null;
  node.syncState = 'detached';
  delete node.forkBaseRevisionId;
  delete node.syncHubBaselineRevisionId;
  return state;
}

export function deletionImpact(state: IdentityState, nodeId: string): DeleteImpact {
  const node = requiredNode(state, nodeId);
  const bucket = requiredBucket(state, node.bucketId);
  const shared = Object.values(state.nodes).some(
    (candidate) => candidate.id !== node.id && candidate.bucketId === node.bucketId
  );
  return { shared, memoCount: bucket.memos.length };
}

export function deleteNode(sourceState: IdentityState, nodeId: string): IdentityState {
  const state = cloneState(sourceState);
  const deleted = requiredNode(state, nodeId);
  const references = Object.values(state.nodes).filter((node) => node.syncHubId === deleted.id);
  const activeReferences = references
    .filter((node) => node.syncState === 'syncing' && node.bucketId === deleted.bucketId)
    .sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id));

  if (activeReferences.length) {
    const successor = activeReferences[0];
    successor.syncHubId = null;
    successor.syncState = 'detached';
    delete successor.forkBaseRevisionId;
    delete successor.syncHubBaselineRevisionId;
    for (const reference of references) {
      if (reference.id === successor.id) continue;
      reference.syncHubId = successor.id;
    }
  } else {
    for (const reference of references) {
      reference.syncHubId = null;
      reference.syncState = 'detached';
      delete reference.forkBaseRevisionId;
      delete reference.syncHubBaselineRevisionId;
    }
  }

  const key = locatorKey(deleted.locator);
  if (key && state.locators[key] === deleted.id) delete state.locators[key];
  delete state.nodes[deleted.id];
  state.downloadBindings = state.downloadBindings.filter((binding) => binding.nodeId !== deleted.id);
  removeBucketIfUnused(state, deleted.bucketId);
  return state;
}

export function sweepIdentityState(sourceState: IdentityState, now = Date.now()): IdentityState {
  let state = cloneState(sourceState);
  state.downloadBindings = state.downloadBindings.filter(
    (binding) => binding.status !== 'interrupted'
      && !(binding.status === 'pending' && now - binding.createdAt >= PENDING_BINDING_TTL_MS)
  );

  const referencedHubs = new Set(
    Object.values(state.nodes).map((node) => node.syncHubId).filter((id): id is string => Boolean(id))
  );
  const removable = Object.values(state.nodes).filter((node) => {
    const bucket = state.buckets[node.bucketId];
    return node.syncState === 'detached'
      && !referencedHubs.has(node.id)
      && Boolean(bucket)
      && bucket.highlights.length === 0
      && bucket.memos.length === 0
      && bucket.figures.length === 0
      && now - node.lastOpenedAt >= EMPTY_NODE_TTL_MS;
  });
  for (const node of removable) state = deleteNode(state, node.id);
  return state;
}

export function validateSyncInvariants(state: IdentityState): string[] {
  const errors: string[] = [];
  for (const node of Object.values(state.nodes)) {
    const hub = node.syncHubId ? state.nodes[node.syncHubId] : undefined;
    if (!state.buckets[node.bucketId]) errors.push(`${node.id}: missing bucket`);
    if ((node.syncState === 'detached') !== (node.syncHubId === null)) {
      errors.push(`${node.id}: detached iff syncHubId=null violated`);
    }
    if (node.syncHubId === node.id) errors.push(`${node.id}: self hub`);
    if (node.syncHubId && !hub) errors.push(`${node.id}: dangling hub`);
    if (node.syncState === 'syncing' && hub && node.bucketId !== hub.bucketId) {
      errors.push(`${node.id}: syncing bucket differs from hub`);
    }
    if (node.syncState === 'undecided' && hub && node.bucketId === hub.bucketId) {
      errors.push(`${node.id}: undecided member shares hub bucket`);
    }

    const visited = new Set<string>([node.id]);
    let cursor = hub;
    while (cursor) {
      if (visited.has(cursor.id)) {
        errors.push(`${node.id}: syncHubId cycle`);
        break;
      }
      visited.add(cursor.id);
      cursor = cursor.syncHubId ? state.nodes[cursor.syncHubId] : undefined;
    }
  }
  return errors;
}

function copyBucketContents(source: AnnotationBucket, target: AnnotationBucket, revisionId: string): void {
  target.highlights = structuredClone(source.highlights);
  target.memos = structuredClone(source.memos);
  target.figures = structuredClone(source.figures);
  target.revisionId = revisionId;
}

function removeBucketIfUnused(state: IdentityState, bucketId: string): void {
  if (!Object.values(state.nodes).some((node) => node.bucketId === bucketId)) {
    delete state.buckets[bucketId];
  }
}

function requiredNode(state: IdentityState, id: string): DocNode {
  const node = state.nodes[id];
  if (!node) throw new Error(`Unknown document node: ${id}`);
  return node;
}

function requiredBucket(state: IdentityState, id: string): AnnotationBucket {
  const bucket = state.buckets[id];
  if (!bucket) throw new Error(`Unknown annotation bucket: ${id}`);
  return bucket;
}

function cloneState(state: IdentityState): IdentityState {
  return structuredClone(state);
}
