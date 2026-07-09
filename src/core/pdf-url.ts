const VIEWABLE_SCHEMES = new Set(['http:', 'https:', 'file:', 'blob:']);
const CHROME_NEW_TAB_URLS = new Set([
  'chrome://newtab/',
  'chrome://new-tab-page/',
  'chrome-search://local-ntp/local-ntp.html',
  'chrome-search://newtab/'
]);

export function parseViewableUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return VIEWABLE_SCHEMES.has(url.protocol) ? url : null;
}

export function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

export function isFileUrl(url: URL): boolean {
  return url.protocol === 'file:';
}

export function isPdfContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mime === 'application/pdf' || mime === 'application/x-pdf';
}

export function isLocalPdfUrl(raw: string): boolean {
  const url = parseViewableUrl(raw);
  return Boolean(url && isFileUrl(url) && url.pathname.toLowerCase().endsWith('.pdf'));
}

export function isPdfLikeUrl(raw: string): boolean {
  const url = parseViewableUrl(raw);
  if (!url) return false;

  const pathname = url.pathname.toLowerCase();
  if (pathname.endsWith('.pdf')) return true;
  return url.protocol === 'https:' && url.hostname === 'arxiv.org' && pathname.startsWith('/pdf/');
}

export function isChromeNewTabUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return CHROME_NEW_TAB_URLS.has(url.href);
}
