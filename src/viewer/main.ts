import './viewer.css';

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'file:', 'blob:']);

function readFileParam(): string | null {
  const params = new URLSearchParams(location.search);
  const raw = params.get('file');
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  return ALLOWED_SCHEMES.has(url.protocol) ? raw : null;
}

function runtimeUrl(path: string): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return path;
}

const file = readFileParam();
const emptyState = document.querySelector<HTMLElement>('#emptyState');
const pendingState = document.querySelector<HTMLElement>('#pendingState');
const fileLabel = document.querySelector<HTMLElement>('#fileLabel');
const pendingUrl = document.querySelector<HTMLElement>('#pendingUrl');
const hubButton = document.querySelector<HTMLButtonElement>('#hubButton');

if (file) {
  pendingState?.removeAttribute('hidden');
  if (pendingUrl) pendingUrl.textContent = file;
  if (fileLabel) fileLabel.textContent = file;
} else {
  emptyState?.removeAttribute('hidden');
  if (fileLabel) fileLabel.textContent = '빈 뷰어';
}

hubButton?.addEventListener('click', () => {
  location.href = runtimeUrl('hub.html');
});

