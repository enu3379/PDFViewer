import './hub.css';
import { FileHandleRegistry, fileUrlFromPath, normalizeLocalPath, sha256Hex } from '../core/doc-identity';
import { escapeHtml } from '../core/format';
import { MarginStore } from '../core/store';
import {
  createDerivedNode,
  createDownloadBinding,
  deleteNode,
  deletionImpact,
  sweepIdentityState
} from '../core/sync';
import type { DocLocator, DocNode, IdentityState } from '../core/types';

const store = new MarginStore();
const handles = new FileHandleRegistry();
const search = requireElement<HTMLInputElement>('#hubSearch');
const docList = requireElement<HTMLElement>('#docList');
const hubEmpty = requireElement<HTMLElement>('#hubEmpty');
const toast = requireElement<HTMLElement>('#hubToast');
const deleteDialog = requireElement<HTMLDialogElement>('#deleteDialog');
const deleteMessage = requireElement<HTMLElement>('#deleteMessage');
const deleteCancel = requireElement<HTMLButtonElement>('#deleteCancel');

let identityState: IdentityState = { nodes: {}, buckets: {}, locators: {}, downloadBindings: [] };
let toastTimer: number | undefined;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function runtimeUrl(path: string): string {
  return typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path;
}

function openUrl(locator: DocLocator | null): string | null {
  if (!locator) return null;
  if (locator.kind === 'url') return locator.value;
  if (locator.kind === 'path') return fileUrlFromPath(locator.value);
  return null;
}

function pdfName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '-').trim() || 'document';
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
}

function badge(node: DocNode): string {
  if (node.syncState === 'syncing') {
    return '<span class="sync-badge is-syncing"><span class="d"></span>연동중</span>';
  }
  if (node.syncState === 'undecided') {
    return '<span class="sync-badge is-undecided"><span class="d"></span>미결정</span>';
  }
  return '';
}

function render(): void {
  const query = search.value.trim().toLocaleLowerCase('ko');
  const nodes = Object.values(identityState.nodes)
    .filter((node) => {
      if (!query) return true;
      const bucket = identityState.buckets[node.bucketId];
      return node.title.toLocaleLowerCase('ko').includes(query)
        || bucket?.memos.some((memo) => `${memo.text} ${memo.quote}`.toLocaleLowerCase('ko').includes(query));
    })
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  hubEmpty.hidden = nodes.length > 0;
  docList.innerHTML = nodes.map((node) => {
    const bucket = identityState.buckets[node.bucketId];
    const target = openUrl(node.locator);
    const openAttrs = target ? '' : 'disabled title="파일 위치가 확정되면 열 수 있습니다"';
    return `<article class="doc-card" data-node-id="${node.id}">
      <div class="doc-card-head">
        <button class="doc-open" type="button" ${openAttrs}>${escapeHtml(node.title)}</button>
        ${badge(node)}
        <button class="doc-more" type="button" aria-label="${escapeHtml(node.title)} 메뉴" aria-expanded="false">•••</button>
      </div>
      <div class="doc-meta"><span>${node.pageCount}쪽</span><span>메모 ${bucket?.memos.length ?? 0}</span></div>
      <div class="doc-menu" hidden>
        <button class="doc-clone" type="button" ${node.locator ? '' : 'disabled'}>복제</button>
        <button class="doc-delete" type="button">삭제</button>
      </div>
    </article>`;
  }).join('');
}

async function refresh(): Promise<void> {
  identityState = sweepIdentityState(await store.loadIdentityState());
  await store.saveIdentityState(identityState);
  render();
}

function showToast(message: string): void {
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
    toastTimer = undefined;
  }, 4200);
}

function confirmDelete(message: string): Promise<boolean> {
  deleteMessage.textContent = message;
  deleteDialog.returnValue = 'cancel';
  deleteDialog.showModal();
  window.queueMicrotask(() => deleteCancel.focus());
  return new Promise((resolve) => {
    deleteDialog.addEventListener('close', () => {
      resolve(deleteDialog.returnValue === 'delete');
    }, { once: true });
  });
}

async function bytesForNode(node: DocNode): Promise<Uint8Array> {
  if (!node.locator) throw new Error('복제할 파일 위치가 없습니다.');
  if (node.locator.kind === 'fsa-handle') {
    const handle = await handles.get(node.locator.handleKey) as (Awaited<ReturnType<typeof handles.get>> & {
      getFile?: () => Promise<File>;
    });
    const file = await handle?.getFile?.();
    if (!file) throw new Error('파일 접근 권한이 만료되었습니다. 문서를 다시 열어 주세요.');
    return new Uint8Array(await file.arrayBuffer());
  }
  const response = await fetch(openUrl(node.locator)!, { credentials: 'include' });
  if (!response.ok) throw new Error('원본 PDF를 읽을 수 없습니다.');
  return new Uint8Array(await response.arrayBuffer());
}

async function startCloneDownload(bytes: Uint8Array, name: string, bindingId: string): Promise<void> {
  const blobUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }));
  try {
    const downloadId = await chrome.downloads.download({ url: blobUrl, filename: name, saveAs: true });
    await store.setDownloadId(bindingId, downloadId);
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item?.state === 'complete' && item.filename) {
      await store.completeDownloadBinding(downloadId, normalizeLocalPath(item.filename));
    }
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}

async function cloneDocument(nodeId: string): Promise<void> {
  const current = identityState.nodes[nodeId];
  if (!current) return;
  let pendingNodeId: string | null = null;
  try {
    const bytes = await bytesForNode(current);
    const sha256 = await sha256Hex(bytes);
    const derived = createDerivedNode(
      sweepIdentityState(await store.loadIdentityState()),
      current.id,
      'clone',
      {
        contentEvidence: {
          pdfJsId: current.contentEvidence.pdfJsId,
          sha256,
          byteLength: bytes.byteLength,
          fileName: pdfName(current.title)
        }
      }
    );
    const binding = createDownloadBinding(derived.node.id, sha256);
    pendingNodeId = derived.node.id;
    binding.kind = 'clone';
    derived.state.downloadBindings.push(binding);
    await store.saveIdentityState(derived.state);
    await startCloneDownload(bytes, pdfName(current.title), binding.id);
    await refresh();
  } catch (error) {
    if (pendingNodeId) {
      let failedState = await store.loadIdentityState();
      const failedNode = failedState.nodes[pendingNodeId];
      if (failedNode && !failedNode.locator) {
        failedState = deleteNode(failedState, failedNode.id);
        await store.saveIdentityState(failedState);
        identityState = failedState;
        render();
      }
    }
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function removeDocument(nodeId: string): Promise<void> {
  const current = identityState.nodes[nodeId];
  if (!current) return;
  const impact = deletionImpact(identityState, nodeId);
  const message = impact.shared
    ? '문서만 삭제됩니다 — 연동 중인 다른 사본의 메모는 유지됩니다.'
    : `이 문서를 삭제하면 메모 ${impact.memoCount}개가 함께 삭제됩니다.`;
  if (!(await confirmDelete(message))) return;
  identityState = deleteNode(identityState, nodeId);
  await store.saveIdentityState(identityState);
  render();
}

docList.addEventListener('click', (event) => {
  const target = event.target as Element;
  const card = target.closest<HTMLElement>('.doc-card');
  const node = card ? identityState.nodes[card.dataset.nodeId ?? ''] : undefined;
  if (!card || !node) return;
  if (target.closest('.doc-open')) {
    const url = openUrl(node.locator);
    if (url) location.href = `${runtimeUrl('viewer.html')}?file=${encodeURIComponent(url)}`;
    return;
  }
  if (target.closest('.doc-more')) {
    const menu = card.querySelector<HTMLElement>('.doc-menu')!;
    const opening = menu.hidden;
    for (const other of docList.querySelectorAll<HTMLElement>('.doc-menu')) other.hidden = true;
    menu.hidden = !opening;
    card.querySelector('.doc-more')?.setAttribute('aria-expanded', String(opening));
    return;
  }
  if (target.closest('.doc-clone')) void cloneDocument(node.id);
  if (target.closest('.doc-delete')) void removeDocument(node.id);
});

document.addEventListener('click', (event) => {
  if ((event.target as Element).closest('.doc-card')) return;
  for (const menu of docList.querySelectorAll<HTMLElement>('.doc-menu')) menu.hidden = true;
});

search.addEventListener('input', render);
search.focus();
void refresh().catch((error) => showToast(error instanceof Error ? error.message : String(error)));
