import 'pdfjs-dist/web/pdf_viewer.css';
import './viewer.css';
import { createAnchorFromRange, repairAnchor } from '../core/anchor';
import { FigExtract, toFigureEntries, type FigureSeed } from '../core/fig-engine';
import { findCaptionAnchor, mergeFigureEntries } from '../core/figures';
import { escapeHtml, parseLinks, parseTags } from '../core/format';
import { figureMentions, injectFigureReferenceLinks, nearestFigureMention, scanFigureReferences, updateReferenceLinkActive, type FigureReference } from '../core/mentions';
import { isFileUrl, parseViewableUrl } from '../core/pdf-url';
import { renderRegionDataURL } from '../core/render-region';
import {
  DEFAULT_PEN_THEME,
  isPenTheme,
  nextPenTheme,
  PEN_NAMES,
  PEN_THEME_LABELS,
  type PenTheme
} from '../core/pen-theme';
import { makeId, MarginStore, type DocData } from '../core/store';
import { buildPageTextIndex, rangeFromOffsets, type PageTextIndex } from '../core/text-index';
import type { FigureEntry, Highlight, Memo, PenColor, PdfRect } from '../core/types';
import { CropMode, type CropRegion } from './crop-mode';
import { jumpToRegion, jumpToText, type JumpAccess } from './jump';
import { HighlightOverlay } from './overlay-highlights';
import { FiguresTab, type CropPreviewState } from './panel/tab-figures';
import { MemoTab } from './panel/tab-memos';
import { type FlatOutlineItem, PdfHost, type ResolvedPdfDestination } from './pdf-host';

const PANEL_WIDTH_KEY = 'margin:panelWidth';
const PANEL_MIN_WIDTH = 264;
const PANEL_MAX_WIDTH = 560;
const VIEWER_MIN_WIDTH = 360;
const PANEL_STEP = 16;
const DEST_MATCH_TOLERANCE_PT = 40;
const ANNOTATION_ORIGIN_TTL_MS = 3000;

type TextScanIndex = {
  page: number;
  text: string;
  segments: Array<{ start: number; end: number; yPdf?: number }>;
};

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

  return parseViewableUrl(raw) ? raw : null;
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

function pdfDownloadName(base: string): string {
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '-').trim() || 'document';
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
}

function runtimeUrl(path: string): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return path;
}

function isFileSchemeUrl(raw: string): boolean {
  const url = parseViewableUrl(raw);
  return Boolean(url && isFileUrl(url));
}

function fileAccessSettingsUrl(): string {
  const extensionId = typeof chrome !== 'undefined' ? chrome.runtime?.id : '';
  return `chrome://extensions/?id=${extensionId}`;
}

async function canReadFileSchemeUrls(): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.extension?.isAllowedFileSchemeAccess) return true;
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

// PDF.js 예외는 Error 서브클래스가 아닐 수 있어 name 필드로 구분한다.
function isMissingPdfError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'MissingPDFException';
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function showOnly(section: HTMLElement | null): void {
  for (const el of [emptyState, pendingState, errorState, fileAccessState, missingFileState, readRow]) {
    el?.setAttribute('hidden', '');
  }
  section?.removeAttribute('hidden');
}

function setLoading(label: string): void {
  if (pendingUrl) pendingUrl.textContent = label;
  downloadButton.disabled = true;
  showOnly(pendingState);
}

function setError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (errorMessage) errorMessage.textContent = message;
  showOnly(errorState);
}

function showFileAccessState(): void {
  fileAccessSettingsFallback.hidden = true;
  fileAccessSettingsFallback.textContent = '';
  showOnly(fileAccessState);
}

function showMissingFileState(file: string): void {
  missingFileUrl.textContent = file;
  showOnly(missingFileState);
}

async function openFileAccessSettings(): Promise<void> {
  const url = fileAccessSettingsUrl();
  try {
    await chrome.tabs.update({ url });
  } catch {
    fileAccessSettingsFallback.textContent = url;
    fileAccessSettingsFallback.hidden = false;
  }
}

function openFilePicker(): void {
  fileInput.value = '';
  fileInput.click();
}

let downloadName = 'document.pdf';

async function downloadCurrentPdf(): Promise<void> {
  const doc = host.pdfDocument;
  if (!doc || downloadButton.disabled) return;
  const data = await doc.getData();
  // getData()의 Uint8Array<ArrayBufferLike>는 BlobPart와 타입이 안 맞아 ArrayBuffer 사본으로 감싼다.
  const blob = new Blob([new Uint8Array(data)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = downloadName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flashElement(el: HTMLElement): void {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  window.setTimeout(() => el.classList.remove('flash'), 1500);
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
  memoTab.closeCompose();
  panel.hidden = true;
  edge.hidden = false;
  refreshFitWidthIfNeeded();
}

function openPanel(tab?: string): void {
  panel.hidden = false;
  edge.hidden = true;
  if (tab) setTab(tab);
  refreshFitWidthIfNeeded();
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

function syncAnnotationViews(): void {
  if (!docData) return;
  overlay.setData(docData.highlights, docData.memos, lostHighlights);
  overlay.renderAll();
  memoTab.setData(docData.highlights, docData.memos, lostHighlights, currentPen);
}

function scheduleDocSave(): void {
  if (docData) store.scheduleSaveDoc(docData);
}

function flushDocSave(): void {
  if (docData) void store.flushDoc(docData);
}

async function initializeDoc(titleFallback: string, url?: string): Promise<void> {
  const meta = await host.getDocMeta(titleFallback, url);
  docData = await store.loadDoc(meta);
  pageIndexes.clear();
  pageScanIndexes.clear();
  figureReferences = [];
  captionYByFigure.clear();
  activeFigureId = null;
  activeOriginRefKey = null;
  pendingCrop = null;
  lostHighlights.clear();
  buildRenderedPageIndexes();
  syncAnnotationViews();
  repairRenderedPages();
  figuresTab.setDocument(docData.figures);
  cropMode.cancel(false);
  void refreshFigureReferences();
  figuresTab.ensureScanned();
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

async function loadUrl(file: string): Promise<void> {
  setLoading(file);
  figuresTab.setDocument([]);
  if (fileLabel) fileLabel.textContent = basenameFromUrl(file);
  const isLocalFile = isFileSchemeUrl(file);
  if (isLocalFile && !(await canReadFileSchemeUrls())) {
    showFileAccessState();
    return;
  }
  try {
    await host.loadUrl(file);
    await initializeDoc(basenameFromUrl(file), file);
    if (fileLabel && docData) fileLabel.textContent = docData.meta.title;
    downloadName = pdfDownloadName(basenameFromUrl(file));
    downloadButton.disabled = false;
    showOnly(readRow);
    host.refreshLayoutSoon();
    setPageUi(host.currentPage, host.pageCount);
    renderToc(await host.getOutlineItems());
  } catch (error) {
    figuresTab.setDocument([]);
    if (isLocalFile && isMissingPdfError(error)) {
      showMissingFileState(file);
      return;
    }
    setError(error);
  }
}

async function loadSelectedFile(file: File): Promise<void> {
  setLoading(file.name);
  figuresTab.setDocument([]);
  if (fileLabel) fileLabel.textContent = file.name;
  try {
    await host.loadFile(file);
    await initializeDoc(file.name);
    if (fileLabel && docData) fileLabel.textContent = docData.meta.title;
    downloadName = pdfDownloadName(file.name);
    downloadButton.disabled = false;
    showOnly(readRow);
    host.refreshLayoutSoon();
    setPageUi(host.currentPage, host.pageCount);
    renderToc(await host.getOutlineItems());
  } catch (error) {
    figuresTab.setDocument([]);
    setError(error);
  }
}

function pageNumberFromDiv(pageDiv: HTMLElement): number | null {
  const raw = pageDiv.dataset.pageNumber ?? pageDiv.id.match(/\d+/)?.[0];
  const page = raw ? Number(raw) : NaN;
  return Number.isInteger(page) && page > 0 ? page : null;
}

function closestPageDiv(node: Node): HTMLElement | null {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node instanceof HTMLElement ? node : null;
  return element?.closest<HTMLElement>('.page') ?? null;
}

function getOrBuildPageIndex(pageNumber: number): PageTextIndex | null {
  const existing = pageIndexes.get(pageNumber);
  if (existing) return existing;
  const pageDiv = host.getPageDiv(pageNumber);
  if (!pageDiv) return null;
  const index = buildPageTextIndex(pageNumber, pageDiv);
  if (!index.text) return null;
  pageIndexes.set(pageNumber, index);
  return index;
}

function getJumpAccess(): JumpAccess {
  return {
    container: viewerContainer,
    viewer: host.viewer,
    getPageDiv: (pageNumber) => host.getPageDiv(pageNumber),
    getPageViewport: (pageNumber) => host.getPageViewport(pageNumber)
  };
}

async function getTextScanIndex(pageNumber: number): Promise<TextScanIndex | null> {
  const existing = pageScanIndexes.get(pageNumber);
  if (existing) return existing;
  const pdfDocument = host.pdfDocument;
  if (!pdfDocument) {
    const rendered = pageIndexes.get(pageNumber);
    if (!rendered) return null;
    const scanIndex: TextScanIndex = { page: rendered.page, text: rendered.text, segments: [] };
    pageScanIndexes.set(pageNumber, scanIndex);
    return scanIndex;
  }

  const page = await pdfDocument.getPage(pageNumber);
  const textContent = await page.getTextContent();
  const segments: TextScanIndex['segments'] = [];
  let text = '';
  for (const item of textContent.items as Array<{ str?: string; transform?: unknown[] }>) {
    const str = item.str ?? '';
    const start = text.length;
    text += str;
    const yPdf = Array.isArray(item.transform) && typeof item.transform[5] === 'number'
      ? item.transform[5]
      : undefined;
    segments.push({ start, end: text.length, yPdf });
  }
  const scanIndex: TextScanIndex = { page: pageNumber, text, segments };
  pageScanIndexes.set(pageNumber, scanIndex);
  return scanIndex;
}

function yForScanOffset(index: TextScanIndex, offset: number): number | undefined {
  return index.segments.find((segment) => offset >= segment.start && offset < segment.end)?.yPdf;
}

function yForRenderedOffset(index: PageTextIndex, pageDiv: HTMLElement, offset: number): number | undefined {
  const viewport = host.getPageViewport(index.page);
  if (!viewport) return undefined;
  const end = Math.min(index.text.length, Math.max(offset + 1, offset));
  const range = rangeFromOffsets(index, offset, end);
  if (!range) return undefined;
  const rect = range.getClientRects()[0];
  range.detach();
  if (!rect) return undefined;
  const pageBounds = pageDiv.getBoundingClientRect();
  return viewport.convertToPdfPoint(rect.left - pageBounds.left, rect.top - pageBounds.top)[1];
}

function replacePageReferences(pageNumber: number, refs: FigureReference[]): void {
  figureReferences = [
    ...figureReferences.filter((reference) => reference.page !== pageNumber),
    ...refs
  ].sort((a, b) => a.page - b.page || a.start - b.start);
  updateFigureTabData();
}

function updateFigureTabData(): void {
  if (!docData) return;
  figuresTab.setData(docData.figures, figureMentions(figureReferences));
}

function buildRenderedPageIndexes(): void {
  for (let pageNumber = 1; pageNumber <= host.pageCount; pageNumber += 1) {
    const pageDiv = host.getPageDiv(pageNumber);
    if (!pageDiv?.querySelector('.textLayer span')) continue;
    const index = buildPageTextIndex(pageNumber, pageDiv);
    if (index.text) pageIndexes.set(pageNumber, index);
  }
}

function handleTextLayerRendered(pageNumber: number): void {
  const pageDiv = host.getPageDiv(pageNumber);
  if (!pageDiv) return;
  const index = buildPageTextIndex(pageNumber, pageDiv);
  pageIndexes.set(pageNumber, index);
  pageScanIndexes.delete(pageNumber);
  updateRenderedFigureReferences(pageNumber, pageDiv, index);
  repairPageAnchors(pageNumber);
  syncAnnotationViews();
}

function updateRenderedFigureReferences(pageNumber: number, pageDiv: HTMLElement, index: PageTextIndex): void {
  if (!docData?.figures.length) return;
  const refs = scanFigureReferences(
    index,
    docData.figures,
    (offset) => yForRenderedOffset(index, pageDiv, offset)
  );
  for (const reference of refs) {
    if (reference.isCaptionLabel && reference.yPdf !== undefined) {
      captionYByFigure.set(reference.figId, reference.yPdf);
    }
  }
  replacePageReferences(pageNumber, refs);
  injectFigureReferencesForPage(pageNumber);
}

function injectFigureReferencesForPage(pageNumber: number): void {
  if (!docData?.figures.length) return;
  const pageDiv = host.getPageDiv(pageNumber);
  const index = pageIndexes.get(pageNumber);
  if (!pageDiv || !index) return;
  injectFigureReferenceLinks(
    pageDiv,
    index,
    figureReferences.filter((reference) => reference.page === pageNumber),
    activeFigureId
  );
}

function injectFigureReferencesIntoRenderedPages(): void {
  for (const pageNumber of pageIndexes.keys()) {
    injectFigureReferencesForPage(pageNumber);
  }
}

function repairRenderedPages(): void {
  for (const pageNumber of pageIndexes.keys()) {
    repairPageAnchors(pageNumber);
  }
  syncAnnotationViews();
}

function repairPageAnchors(pageNumber: number): void {
  if (!docData) return;
  const index = pageIndexes.get(pageNumber);
  const pageDiv = host.getPageDiv(pageNumber);
  const viewport = host.getPageViewport(pageNumber);
  if (!index || !pageDiv || !viewport) return;

  let changed = false;
  for (const highlight of docData.highlights.filter((item) => item.anchor.page === pageNumber)) {
    const repaired = repairAnchor(highlight.anchor, index, pageDiv, viewport);
    if (!repaired) {
      lostHighlights.add(highlight.id);
      continue;
    }
    lostHighlights.delete(highlight.id);
    // repairAnchor는 손댈 게 없으면 원본 객체를 그대로 반환한다. 새 객체면 무엇이든 갱신된 것.
    if (repaired !== highlight.anchor) {
      highlight.anchor = repaired;
      changed = true;
    }
  }
  if (changed) scheduleDocSave();
}

async function scanFigures(setStatus: (text: string) => void): Promise<FigureEntry[]> {
  const data = docData;
  if (!data || !host.pdfDocument) return [];
  const result = await FigExtract.extract(null, {
    pdfDocument: host.pdfDocument,
    onProgress: setStatus
  });
  const seeds = toFigureEntries(result, pageHeightPt);
  const incoming: FigureEntry[] = [];
  for (const seed of seeds) {
    if (docData !== data) return data.figures;
    incoming.push(await completeFigureEntry(seed));
  }
  if (docData !== data) return data.figures;
  docData.figures = mergeFigureEntries(docData.figures, incoming);
  scheduleDocSave();
  await refreshFigureReferences();
  return docData.figures;
}

async function completeFigureEntry(seed: FigureSeed): Promise<FigureEntry> {
  if (!docData) throw new Error('Document data is not loaded.');
  const scanIndex = await getTextScanIndex(seed.page);
  const captionAnchor = scanIndex
    ? findCaptionAnchor(seed.page, scanIndex.text, seed.captionText)
    : undefined;
  if (captionAnchor && scanIndex) {
    const captionY = yForScanOffset(scanIndex, captionAnchor.start);
    if (captionY !== undefined) captionYByFigure.set(seed.id, captionY);
  }
  return {
    ...seed,
    doc: docData.meta.id,
    captionAnchor
  };
}

function pageHeightPt(pageNumber: number): number {
  const viewport = host.getPageViewport(pageNumber);
  const scale = ((viewport as { scale?: number } | null)?.scale ?? host.viewer.currentScale) || 1;
  return viewport ? viewport.height / scale : 792;
}

async function refreshFigureReferences(): Promise<void> {
  if (!docData?.figures.length) {
    figureReferences = [];
    captionYByFigure.clear();
    updateFigureTabData();
    return;
  }

  const refs: FigureReference[] = [];
  captionYByFigure.clear();
  for (const figure of docData.figures) {
    if (!figure.captionAnchor) continue;
    const scanIndex = await getTextScanIndex(figure.captionAnchor.page);
    const captionY = scanIndex ? yForScanOffset(scanIndex, figure.captionAnchor.start) : undefined;
    if (captionY !== undefined) captionYByFigure.set(figure.id, captionY);
  }

  for (let pageNumber = 1; pageNumber <= host.pageCount; pageNumber += 1) {
    const scanIndex = await getTextScanIndex(pageNumber);
    if (!scanIndex) continue;
    refs.push(...scanFigureReferences(
      scanIndex,
      docData.figures,
      (offset) => yForScanOffset(scanIndex, offset)
    ));
  }

  figureReferences = refs.sort((a, b) => a.page - b.page || a.start - b.start);
  updateFigureTabData();
  injectFigureReferencesIntoRenderedPages();
}

function handleSelection(): void {
  if (!docData) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!viewerContainer.contains(range.startContainer)) return;

  const pageDiv = closestPageDiv(range.startContainer);
  const pageNumber = pageDiv ? pageNumberFromDiv(pageDiv) : null;
  if (!pageDiv || !pageNumber) return;

  const index = getOrBuildPageIndex(pageNumber);
  const viewport = host.getPageViewport(pageNumber);
  if (!index || !viewport) return;

  const anchor = createAnchorFromRange(range, index, pageDiv, viewport);
  selection.removeAllRanges();
  if (!anchor) return;

  const highlight: Highlight = {
    id: makeId('h'),
    doc: docData.meta.id,
    color: currentPen,
    anchor,
    createdAt: Date.now()
  };
  docData.highlights.push(highlight);
  scheduleDocSave();
  syncAnnotationViews();

  if (!panel.hidden) {
    openPanel('memos');
    memoTab.openComposeForHighlight(highlight.id, true);
  }
}

function memoForHighlight(highlightId: string): Memo | undefined {
  return docData?.memos.find((memo) => memo.anchorType === 'highlight' && memo.anchorId === highlightId);
}

function saveHighlightMemo(highlightId: string, text: string): void {
  if (!docData) return;
  const highlight = docData.highlights.find((candidate) => candidate.id === highlightId);
  if (!highlight) return;

  const now = Date.now();
  const existing = memoForHighlight(highlightId);
  if (existing) {
    existing.text = text;
    existing.tags = parseTags(text);
    existing.links = parseLinks(text);
    existing.updatedAt = now;
  } else {
    const memo: Memo = {
      id: makeId('m'),
      doc: docData.meta.id,
      anchorType: 'highlight',
      anchorId: highlight.id,
      quote: highlight.anchor.quote,
      page: highlight.anchor.page,
      text,
      tags: parseTags(text),
      links: parseLinks(text),
      createdAt: now,
      updatedAt: now
    };
    docData.memos.push(memo);
    highlight.memoId = memo.id;
  }
  scheduleDocSave();
  syncAnnotationViews();
}

function deleteHighlight(highlightId: string): void {
  if (!docData) return;
  docData.highlights = docData.highlights.filter((highlight) => highlight.id !== highlightId);
  docData.memos = docData.memos.filter(
    (memo) => !(memo.anchorType === 'highlight' && memo.anchorId === highlightId)
  );
  lostHighlights.delete(highlightId);
  scheduleDocSave();
  syncAnnotationViews();
}

function deleteMemo(memoId: string): void {
  if (!docData) return;
  const memo = docData.memos.find((candidate) => candidate.id === memoId);
  if (!memo) return;
  // 메모만 지우고 하이라이트는 남긴다(하이라이트 우선). dot은 hollow로 돌아간다.
  docData.memos = docData.memos.filter((candidate) => candidate.id !== memoId);
  if (memo.anchorType === 'highlight') {
    const highlight = docData.highlights.find((candidate) => candidate.id === memo.anchorId);
    if (highlight) highlight.memoId = undefined;
  }
  scheduleDocSave();
  syncAnnotationViews();
}

function handleHighlightClick(highlightId: string): void {
  if (!docData) return;
  const highlight = docData.highlights.find((candidate) => candidate.id === highlightId);
  if (!highlight) return;
  openPanel('memos');

  const memo = highlight.memoId ? docData.memos.find((candidate) => candidate.id === highlight.memoId) : undefined;
  if (memo) {
    memoTab.closeCompose();
    window.requestAnimationFrame(() => memoTab.focusMemo(memo.id));
  } else {
    memoTab.openComposeForHighlight(highlightId);
  }
}

function jumpToHighlight(highlightId: string): void {
  if (!docData) return;
  const highlight = docData.highlights.find((candidate) => candidate.id === highlightId);
  if (!highlight) return;
  const yPdf = highlight.anchor.quads[0]
    ? Math.max(highlight.anchor.quads[0][1], highlight.anchor.quads[0][3])
    : undefined;
  void jumpToText(getJumpAccess(), highlight.anchor.page, yPdf).then(() => {
    const el = overlay.getFirstElement(highlightId);
    if (el) flashElement(el);
  });
  if (!pinned) closePanel();
}

function openFigurePanel(figId: string, originRefKey: string | null = null): void {
  if (!docData?.figures.some((figure) => figure.id === figId)) return;
  activeFigureId = figId;
  activeOriginRefKey = originRefKey;
  openPanel('figures');
  figuresTab.focusFigure(figId, activeOriginRefKey);
  for (const pageNumber of pageIndexes.keys()) {
    const pageDiv = host.getPageDiv(pageNumber);
    if (pageDiv) updateReferenceLinkActive(pageDiv, activeFigureId);
  }
}

function handleFigureReferenceClick(event: MouseEvent): void {
  const link = (event.target as Element).closest<HTMLElement>('a.mgn-ref[data-fig]');
  if (!link || !viewerContainer.contains(link)) return;
  event.preventDefault();
  event.stopPropagation();
  const figId = link.dataset.fig;
  if (!figId) return;
  openFigurePanel(figId, link.dataset.cap === '1' ? null : link.dataset.refKey ?? null);
}

function rememberAnnotationLinkOrigin(event: MouseEvent): void {
  const link = (event.target as Element).closest<HTMLElement>('.annotationLayer a');
  if (!link || !viewerContainer.contains(link)) return;
  const pageDiv = link.closest<HTMLElement>('.page');
  const pageNumber = Number(pageDiv?.dataset.pageNumber);
  if (!pageDiv || !Number.isInteger(pageNumber) || pageNumber < 1) return;
  const viewport = host.getPageViewport(pageNumber);
  if (!viewport) return;
  const pageBounds = pageDiv.getBoundingClientRect();
  const yPdf = viewport.convertToPdfPoint(
    event.clientX - pageBounds.left,
    event.clientY - pageBounds.top
  )[1];
  annotationLinkOrigin = { page: pageNumber, yPdf, at: Date.now() };
}

function takeAnnotationLinkOrigin(): { page: number; yPdf: number } | null {
  const origin = annotationLinkOrigin;
  annotationLinkOrigin = null;
  if (!origin || Date.now() - origin.at > ANNOTATION_ORIGIN_TTL_MS) return null;
  return { page: origin.page, yPdf: origin.yPdf };
}

function handleInternalDestination(destination: ResolvedPdfDestination): boolean {
  const origin = takeAnnotationLinkOrigin();
  const figure = findFigureForDestination(destination);
  if (!figure) return false;
  const originMention = origin
    ? nearestFigureMention(figureReferences, figure.id, origin.page, origin.yPdf)
    : null;
  openFigurePanel(figure.id, originMention?.key ?? null);
  return true;
}

function findFigureForDestination(destination: ResolvedPdfDestination): FigureEntry | null {
  if (!docData?.figures.length) return null;
  const samePage = docData.figures.filter((figure) => figure.page === destination.pageNumber);
  if (!samePage.length) return null;

  const y = destination.yPdf;
  const x = destination.xPdf;
  if (y !== undefined) {
    const byRegion = samePage.find((figure) => {
      if (!figure.region || figure.region.page !== destination.pageNumber) return false;
      const [x1, y1, x2, y2] = normalizeRect(figure.region.rect);
      const yMatches = y >= y1 - DEST_MATCH_TOLERANCE_PT && y <= y2 + DEST_MATCH_TOLERANCE_PT;
      const xMatches = x === undefined || (x >= x1 - DEST_MATCH_TOLERANCE_PT && x <= x2 + DEST_MATCH_TOLERANCE_PT);
      return yMatches && xMatches;
    });
    if (byRegion) return byRegion;

    const byCaption = samePage.find((figure) => {
      const captionY = captionYByFigure.get(figure.id);
      return captionY !== undefined && Math.abs(captionY - y) <= DEST_MATCH_TOLERANCE_PT;
    });
    if (byCaption) return byCaption;
  }

  return samePage.length === 1 ? samePage[0] : null;
}

function jumpToFigure(figId: string): void {
  if (!docData) return;
  const figure = docData.figures.find((candidate) => candidate.id === figId);
  if (!figure) return;
  if (activeFigureId !== figId) activeOriginRefKey = null;
  activeFigureId = figId;
  figuresTab.focusFigure(figId, activeOriginRefKey);
  if (figure.region) {
    void jumpToRegion(getJumpAccess(), figure.region.page, figure.region.rect);
  } else if (figure.captionAnchor) {
    const yPdf = captionYByFigure.get(figure.id);
    void jumpToText(getJumpAccess(), figure.captionAnchor.page, yPdf);
  } else {
    host.setPage(figure.page);
  }
  if (!pinned) closePanel();
}

function jumpToFigureMention(refKey: string): void {
  const mention = figureReferences.find((reference) => reference.key === refKey);
  if (!mention) return;
  void jumpToText(getJumpAccess(), mention.page, mention.yPdf);
  if (!pinned) closePanel();
}

async function jumpToOutlineItem(item: FlatOutlineItem): Promise<void> {
  if (item.url) {
    await host.jumpToOutline(item);
    return;
  }
  const resolved = item.dest ? await host.resolveDestination(item.dest as string | unknown[]) : null;
  if (resolved?.yPdf !== undefined) {
    await jumpToText(getJumpAccess(), resolved.pageNumber, resolved.yPdf);
  } else {
    await host.jumpToOutline(item);
  }
}

async function renderFigureRegion(region: { page: number; rect: PdfRect }): Promise<string | null> {
  return host.pdfDocument ? renderRegionDataURL(host.pdfDocument, region.page, region.rect) : null;
}

function startFigureCrop(figId: string): void {
  if (!docData) return;
  const figure = docData.figures.find((candidate) => candidate.id === figId);
  if (!figure) return;
  pendingCrop = null;
  figuresTab.setCropPreview(null);
  openFigurePanel(figId);
  void cropMode.start(figure);
}

function saveFigureCrop(): void {
  if (!docData || !pendingCrop) return;
  const figure = docData.figures.find((candidate) => candidate.id === pendingCrop?.figId);
  if (!figure) return;
  figure.page = pendingCrop.region.page;
  figure.region = pendingCrop.region;
  figure.regionSource = 'manual';
  figure.confidence = 1;
  cropMode.accept();
  pendingCrop = null;
  figuresTab.setCropPreview(null);
  scheduleDocSave();
  updateFigureTabData();
}

function redoFigureCrop(figId: string): void {
  pendingCrop = null;
  figuresTab.setCropPreview(null);
  startFigureCrop(figId);
}

function cancelFigureCrop(): void {
  cropMode.cancel(false);
  pendingCrop = null;
  figuresTab.setCropPreview(null);
}

function handleCropPreview(region: CropRegion): void {
  const figId = cropMode.figId;
  if (!figId) return;
  pendingCrop = { figId, region };
  figuresTab.setCropPreview(pendingCrop);
}

function handleCropCancel(): void {
  pendingCrop = null;
  figuresTab.setCropPreview(null);
}

function normalizeRect(rect: PdfRect): PdfRect {
  const [x1, y1, x2, y2] = rect;
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

let dropActiveTimer: number | undefined;

function setDropActive(active: boolean): void {
  document.body.classList.toggle('dragging-pdf', active);
}

function keepDropActive(): void {
  setDropActive(true);
  if (dropActiveTimer !== undefined) window.clearTimeout(dropActiveTimer);
  dropActiveTimer = window.setTimeout(() => setDropActive(false), 120);
}

function setupFileDrop(): void {
  window.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    keepDropActive();
  });

  window.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return;
    setDropActive(false);
  });

  window.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (dropActiveTimer !== undefined) window.clearTimeout(dropActiveTimer);
    setDropActive(false);

    const pdf = Array.from(event.dataTransfer?.files ?? []).find(isPdfFile);
    if (!pdf) {
      setError(new Error('PDF 파일만 열 수 있습니다.'));
      return;
    }
    void loadSelectedFile(pdf);
  });
}

function getDefaultPanelWidth(): number {
  return window.matchMedia('(max-width: 900px)').matches ? PANEL_MIN_WIDTH : 312;
}

function getMaxPanelWidth(): number {
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, window.innerWidth - VIEWER_MIN_WIDTH));
}

function clampPanelWidth(width: number): number {
  return Math.round(Math.min(Math.max(width, PANEL_MIN_WIDTH), getMaxPanelWidth()));
}

function readStoredPanelWidth(): number | null {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function storePanelWidth(width: number): void {
  try {
    localStorage.setItem(PANEL_WIDTH_KEY, String(width));
  } catch {
    // Storage can be unavailable in some extension/debug contexts.
  }
}

function getCurrentPanelWidth(): number {
  const rectWidth = panel.getBoundingClientRect().width;
  return rectWidth > 0 ? rectWidth : getDefaultPanelWidth();
}

function updateResizeHandleA11y(width: number): void {
  panelResize.setAttribute('aria-valuemin', String(PANEL_MIN_WIDTH));
  panelResize.setAttribute('aria-valuemax', String(getMaxPanelWidth()));
  panelResize.setAttribute('aria-valuenow', String(width));
}

function setPanelWidth(width: number, persist = false): void {
  const clamped = clampPanelWidth(width);
  panel.style.width = `${clamped}px`;
  updateResizeHandleA11y(clamped);
  if (persist) storePanelWidth(clamped);
}

function refreshFitWidthIfNeeded(): void {
  window.requestAnimationFrame(() => {
    if (host.viewer.currentScaleValue === 'page-width') {
      host.fitPageWidth();
    }
  });
}

function setupPanelResize(): void {
  const storedWidth = readStoredPanelWidth();
  if (storedWidth !== null) {
    setPanelWidth(storedWidth);
  } else {
    updateResizeHandleA11y(getDefaultPanelWidth());
  }

  panelResize.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = getCurrentPanelWidth();
    document.body.classList.add('resizing-panel');

    const onPointerMove = (moveEvent: PointerEvent): void => {
      setPanelWidth(startWidth + startX - moveEvent.clientX);
    };
    const onPointerUp = (): void => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      document.body.classList.remove('resizing-panel');
      setPanelWidth(getCurrentPanelWidth(), true);
      refreshFitWidthIfNeeded();
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  });

  panelResize.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setPanelWidth(getCurrentPanelWidth() + PANEL_STEP, true);
      refreshFitWidthIfNeeded();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setPanelWidth(getCurrentPanelWidth() - PANEL_STEP, true);
      refreshFitWidthIfNeeded();
    } else if (event.key === 'Home') {
      event.preventDefault();
      setPanelWidth(PANEL_MIN_WIDTH, true);
      refreshFitWidthIfNeeded();
    } else if (event.key === 'End') {
      event.preventDefault();
      setPanelWidth(getMaxPanelWidth(), true);
      refreshFitWidthIfNeeded();
    }
  });

  window.addEventListener('resize', () => {
    const stored = readStoredPanelWidth();
    if (stored !== null) {
      setPanelWidth(stored);
      refreshFitWidthIfNeeded();
    } else {
      updateResizeHandleA11y(getDefaultPanelWidth());
    }
  });
}

const emptyState = requireElement<HTMLElement>('#emptyState');
const pendingState = requireElement<HTMLElement>('#pendingState');
const errorState = requireElement<HTMLElement>('#errorState');
const fileAccessState = requireElement<HTMLElement>('#fileAccessState');
const missingFileState = requireElement<HTMLElement>('#missingFileState');
const readRow = requireElement<HTMLElement>('#readRow');
const fileLabel = requireElement<HTMLElement>('#fileLabel');
const pendingUrl = requireElement<HTMLElement>('#pendingUrl');
const errorMessage = requireElement<HTMLElement>('#errorMessage');
const downloadButton = requireElement<HTMLButtonElement>('#downloadButton');
const fileAccessSettings = requireElement<HTMLButtonElement>('#fileAccessSettings');
const fileAccessPickFile = requireElement<HTMLButtonElement>('#fileAccessPickFile');
const fileAccessSettingsFallback = requireElement<HTMLElement>('#fileAccessSettingsFallback');
const missingFilePickFile = requireElement<HTMLButtonElement>('#missingFilePickFile');
const missingFileUrl = requireElement<HTMLElement>('#missingFileUrl');
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
const panelResize = requireElement<HTMLElement>('#panelResize');
const edge = requireElement<HTMLButtonElement>('#edge');
const closePanelButton = requireElement<HTMLButtonElement>('#closePanel');
const pinPanel = requireElement<HTMLButtonElement>('#pinPanel');
const tocList = requireElement<HTMLElement>('#tocList');
const figList = requireElement<HTMLElement>('#figList');
const composeSlot = requireElement<HTMLElement>('#composeSlot');
const pensRow = requireElement<HTMLElement>('#pensRow');
const penThemeButton = requireElement<HTMLButtonElement>('#penTheme');
const memoSearch = requireElement<HTMLInputElement>('#memoSearch');
const memoCount = requireElement<HTMLElement>('#memoCount');
const memoTabN = requireElement<HTMLElement>('#memoTabN');
const memoList = requireElement<HTMLElement>('#memoList');

let outlineItems: FlatOutlineItem[] = [];
let pinned = true;
let currentPen: PenColor = 'amber';
let docData: DocData | null = null;
const store = new MarginStore();
const pageIndexes = new Map<number, PageTextIndex>();
const pageScanIndexes = new Map<number, TextScanIndex>();
const lostHighlights = new Set<string>();
let figureReferences: FigureReference[] = [];
const captionYByFigure = new Map<string, number>();
let activeFigureId: string | null = null;
let activeOriginRefKey: string | null = null;
let annotationLinkOrigin: { page: number; yPdf: number; at: number } | null = null;
let pendingCrop: CropPreviewState | null = null;

function setActivePen(color: PenColor): void {
  currentPen = color;
  document.documentElement.dataset.pen = color;
}

let penTheme: PenTheme = DEFAULT_PEN_THEME;

function applyPenTheme(theme: PenTheme): void {
  penTheme = theme;
  document.documentElement.dataset.penTheme = theme;
  // 버튼은 "누르면 바뀔 팔레트"를 보여준다.
  penThemeButton.textContent = `${PEN_THEME_LABELS[nextPenTheme(theme)]} 팔레트`;
  for (const pen of pensRow.querySelectorAll<HTMLButtonElement>('.pen')) {
    const color = pen.dataset.color as PenColor | undefined;
    if (!color) continue;
    const label = `${PEN_NAMES[theme][color]} 형광펜`;
    pen.setAttribute('aria-label', label);
    pen.title = label;
  }
}

penThemeButton.addEventListener('click', () => {
  const next = nextPenTheme(penTheme);
  applyPenTheme(next);
  void store.updateSettings({ penTheme: next });
});

const host = new PdfHost(
  { container: viewerContainer, viewer: viewerElement },
  {
    onPageChange: setPageUi,
    onScaleChange: setScaleUi,
    onInternalDestination: handleInternalDestination
  }
);

const cropMode = new CropMode(
  {
    ...getJumpAccess(),
    pageCount: () => host.pageCount
  },
  {
    onPreview: handleCropPreview,
    onCancel: handleCropCancel
  }
);

const overlay = new HighlightOverlay(
  {
    getPageDiv: (pageNumber) => host.getPageDiv(pageNumber),
    getPageViewport: (pageNumber) => host.getPageViewport(pageNumber)
  },
  {
    onHighlightClick: handleHighlightClick
  }
);

const memoTab = new MemoTab(
  {
    composeSlot,
    pensRow,
    memoSearch,
    memoCount,
    memoTabN,
    memoList
  },
  {
    onPenChange: (color) => {
      setActivePen(color);
      const composing = memoTab.composingHighlightId;
      const highlight = docData?.highlights.find((candidate) => candidate.id === composing);
      if (highlight) {
        highlight.color = color;
        scheduleDocSave();
      }
      syncAnnotationViews();
    },
    onSaveHighlightMemo: saveHighlightMemo,
    onDeleteHighlight: deleteHighlight,
    onDeleteMemo: deleteMemo,
    onJumpHighlight: jumpToHighlight,
    onComposeHighlightChange: (highlightId) => overlay.setActive(highlightId)
  }
);

setActivePen(currentPen);
applyPenTheme(penTheme);
void store.loadSettings().then((settings) => {
  if (isPenTheme(settings.penTheme) && settings.penTheme !== penTheme) {
    applyPenTheme(settings.penTheme);
  }
});
setupPanelResize();
setupFileDrop();
syncAnnotationViews();

host.eventBus.on('textlayerrendered', (event: { pageNumber: number }) => {
  handleTextLayerRendered(event.pageNumber);
});

host.eventBus.on('pagerendered', (event: { pageNumber: number }) => {
  overlay.renderPage(event.pageNumber);
});

hubButton.addEventListener('click', () => {
  location.href = runtimeUrl('hub.html');
});

downloadButton.addEventListener('click', () => {
  void downloadCurrentPdf();
});

fileAccessSettings.addEventListener('click', () => {
  void openFileAccessSettings();
});

fileAccessPickFile.addEventListener('click', openFilePicker);
missingFilePickFile.addEventListener('click', openFilePicker);

fileInput.addEventListener('change', () => {
  const [file] = Array.from(fileInput.files ?? []);
  if (file) void loadSelectedFile(file);
});

viewerContainer.addEventListener('mouseup', () => {
  window.setTimeout(handleSelection, 0);
});
viewerContainer.addEventListener('click', rememberAnnotationLinkOrigin, true);
viewerContainer.addEventListener('click', handleFigureReferenceClick);

prevPage.addEventListener('click', () => host.previousPage());
nextPage.addEventListener('click', () => host.nextPage());
zoomOut.addEventListener('click', () => host.zoomOut());
zoomIn.addEventListener('click', () => host.zoomIn());
fitWidth.addEventListener('click', () => host.fitPageWidth());
pageNumberInput.addEventListener('change', () => {
  host.setPage(Number(pageNumberInput.value));
  setPageUi(host.currentPage, host.pageCount);
});

const figuresTab = new FiguresTab(figList, {
  onScan: scanFigures,
  onJumpFigure: jumpToFigure,
  onJumpMention: jumpToFigureMention,
  onStartCrop: startFigureCrop,
  onSaveCrop: saveFigureCrop,
  onRedoCrop: redoFigureCrop,
  onCancelCrop: cancelFigureCrop,
  renderRegion: renderFigureRegion
});

for (const button of document.querySelectorAll<HTMLButtonElement>('.ptab')) {
  button.addEventListener('click', () => {
    const tab = button.dataset.tab ?? 'toc';
    setTab(tab);
    if (tab === 'figures') figuresTab.ensureScanned();
  });
}

closePanelButton.addEventListener('click', closePanel);
edge.addEventListener('click', () => openPanel());
pinPanel.addEventListener('click', () => {
  pinned = !pinned;
  pinPanel.classList.toggle('on', pinned);
  pinPanel.title = pinned ? '고정됨 — 클릭해 해제' : '고정 해제 — 패널에서 이동하면 자동으로 닫힘';
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    memoTab.cancelCompose();
  }
  // 내장 뷰어의 저장 단축키 대체 — 브라우저 "페이지 저장" 대화상자를 막는다.
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void downloadCurrentPdf();
  }
});

window.addEventListener('pagehide', flushDocSave);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushDocSave();
});

tocList.addEventListener('click', (event) => {
  const row = (event.target as Element).closest<HTMLButtonElement>('.toc-row');
  if (!row) return;
  const item = outlineItems.find((candidate) => candidate.id === row.dataset.id);
  if (!item) return;
  void jumpToOutlineItem(item).then(() => {
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
