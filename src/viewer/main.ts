import 'pdfjs-dist/web/pdf_viewer.css';
import './viewer.css';
import { type FlatOutlineItem, PdfHost } from './pdf-host';

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'file:', 'blob:']);

function readFileParam(): string | null {
  const search = location.search.startsWith('?') ? location.search.slice(1) : location.search;
  const marker = 'file=';
  const markerIndex = search.indexOf(marker);
  if (markerIndex < 0) return null;

  const rawTail = search.slice(markerIndex + marker.length);
  if (!rawTail) return null;

  let raw: string;
  try {
    raw = decodeURIComponent(rawTail);
  } catch {
    raw = rawTail;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  return ALLOWED_SCHEMES.has(url.protocol) ? raw : null;
}

function basenameFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const last = url.pathname.split('/').filter(Boolean).at(-1);
    return last ? decodeURIComponent(last) : url.hostname;
  } catch {
    return value;
  }
}

function runtimeUrl(path: string): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return path;
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function showOnly(section: HTMLElement | null): void {
  for (const el of [emptyState, pendingState, errorState, readRow]) {
    el?.setAttribute('hidden', '');
  }
  section?.removeAttribute('hidden');
}

function setLoading(label: string): void {
  if (pendingUrl) pendingUrl.textContent = label;
  showOnly(pendingState);
}

function setError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (errorMessage) errorMessage.textContent = message;
  showOnly(errorState);
}

function setPageUi(page: number, pageCount: number): void {
  pageNumberInput.value = String(page || 1);
  pageCountLabel.textContent = String(pageCount || 0);
  prevPage.disabled = page <= 1;
  nextPage.disabled = pageCount === 0 || page >= pageCount;
  markTocForPage(page);
}

function setScaleUi(scale: number, presetValue?: string): void {
  zoomLabel.textContent = presetValue === 'page-width'
    ? '폭 맞춤'
    : `${Math.round(scale * 100)}%`;
}

function setTab(tab: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('.ptab')) {
    button.classList.toggle('on', button.dataset.tab === tab);
  }
  for (const page of document.querySelectorAll<HTMLElement>('.tab-page')) {
    page.toggleAttribute('hidden', page.dataset.tab !== tab);
  }
}

function closePanel(): void {
  panel.hidden = true;
  edge.hidden = false;
}

function openPanel(tab?: string): void {
  panel.hidden = false;
  edge.hidden = true;
  if (tab) setTab(tab);
}

function renderToc(items: FlatOutlineItem[]): void {
  outlineItems = items;
  if (!items.length) {
    tocList.innerHTML = '<div class="empty">이 PDF에는 목차가 없어요</div>';
    return;
  }

  tocList.innerHTML = items.map((item) => {
    const depth = Math.min(item.depth, 5);
    const page = item.page ? `<span class="toc-page">p.${item.page}</span>` : '';
    return `<button class="toc-row" data-id="${item.id}" style="--depth:${depth}" type="button"><span>${escapeHtml(item.title)}</span>${page}</button>`;
  }).join('');
  markTocForPage(host.currentPage);
}

function markTocForPage(page: number): void {
  if (!outlineItems.length) return;
  let active: FlatOutlineItem | null = null;
  for (const item of outlineItems) {
    if (item.page && item.page <= page) active = item;
  }
  for (const row of tocList.querySelectorAll<HTMLButtonElement>('.toc-row')) {
    row.classList.toggle('on', row.dataset.id === active?.id);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

async function loadUrl(file: string): Promise<void> {
  setLoading(file);
  if (fileLabel) fileLabel.textContent = basenameFromUrl(file);
  try {
    await host.loadUrl(file);
    const title = await host.getTitle(basenameFromUrl(file));
    if (fileLabel) fileLabel.textContent = title;
    showOnly(readRow);
    setPageUi(host.currentPage, host.pageCount);
    renderToc(await host.getOutlineItems());
  } catch (error) {
    setError(error);
  }
}

async function loadSelectedFile(file: File): Promise<void> {
  setLoading(file.name);
  if (fileLabel) fileLabel.textContent = file.name;
  try {
    await host.loadFile(file);
    const title = await host.getTitle(file.name);
    if (fileLabel) fileLabel.textContent = title;
    showOnly(readRow);
    setPageUi(host.currentPage, host.pageCount);
    renderToc(await host.getOutlineItems());
  } catch (error) {
    setError(error);
  }
}

const emptyState = requireElement<HTMLElement>('#emptyState');
const pendingState = requireElement<HTMLElement>('#pendingState');
const errorState = requireElement<HTMLElement>('#errorState');
const readRow = requireElement<HTMLElement>('#readRow');
const fileLabel = requireElement<HTMLElement>('#fileLabel');
const pendingUrl = requireElement<HTMLElement>('#pendingUrl');
const errorMessage = requireElement<HTMLElement>('#errorMessage');
const hubButton = requireElement<HTMLButtonElement>('#hubButton');
const fileInput = requireElement<HTMLInputElement>('#fileInput');
const viewerContainer = requireElement<HTMLDivElement>('#viewerContainer');
const viewerElement = requireElement<HTMLDivElement>('#viewer');
const pageNumberInput = requireElement<HTMLInputElement>('#pageNumber');
const pageCountLabel = requireElement<HTMLElement>('#pageCount');
const prevPage = requireElement<HTMLButtonElement>('#prevPage');
const nextPage = requireElement<HTMLButtonElement>('#nextPage');
const zoomOut = requireElement<HTMLButtonElement>('#zoomOut');
const zoomIn = requireElement<HTMLButtonElement>('#zoomIn');
const fitWidth = requireElement<HTMLButtonElement>('#fitWidth');
const zoomLabel = requireElement<HTMLElement>('#zoomLabel');
const panel = requireElement<HTMLElement>('#panel');
const edge = requireElement<HTMLButtonElement>('#edge');
const closePanelButton = requireElement<HTMLButtonElement>('#closePanel');
const pinPanel = requireElement<HTMLButtonElement>('#pinPanel');
const tocList = requireElement<HTMLElement>('#tocList');

let outlineItems: FlatOutlineItem[] = [];
let pinned = true;

const host = new PdfHost(
  { container: viewerContainer, viewer: viewerElement },
  {
    onPageChange: setPageUi,
    onScaleChange: setScaleUi
  }
);

hubButton.addEventListener('click', () => {
  location.href = runtimeUrl('hub.html');
});

fileInput.addEventListener('change', () => {
  const [file] = Array.from(fileInput.files ?? []);
  if (file) void loadSelectedFile(file);
});

prevPage.addEventListener('click', () => host.previousPage());
nextPage.addEventListener('click', () => host.nextPage());
zoomOut.addEventListener('click', () => host.zoomOut());
zoomIn.addEventListener('click', () => host.zoomIn());
fitWidth.addEventListener('click', () => host.fitPageWidth());
pageNumberInput.addEventListener('change', () => {
  host.setPage(Number(pageNumberInput.value));
  setPageUi(host.currentPage, host.pageCount);
});

for (const button of document.querySelectorAll<HTMLButtonElement>('.ptab')) {
  button.addEventListener('click', () => setTab(button.dataset.tab ?? 'toc'));
}

closePanelButton.addEventListener('click', closePanel);
edge.addEventListener('click', () => openPanel());
pinPanel.addEventListener('click', () => {
  pinned = !pinned;
  pinPanel.classList.toggle('on', pinned);
  pinPanel.title = pinned ? '고정됨 — 클릭해 해제' : '고정 해제 — 패널에서 이동하면 자동으로 닫힘';
});

tocList.addEventListener('click', (event) => {
  const row = (event.target as Element).closest<HTMLButtonElement>('.toc-row');
  if (!row) return;
  const item = outlineItems.find((candidate) => candidate.id === row.dataset.id);
  if (!item) return;
  void host.jumpToOutline(item).then(() => {
    if (!pinned) closePanel();
  });
});

const file = readFileParam();
if (file) {
  void loadUrl(file);
} else {
  showOnly(emptyState);
  setPageUi(1, 0);
}
