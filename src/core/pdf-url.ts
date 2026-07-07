const VIEWABLE_SCHEMES = new Set(['http:', 'https:', 'file:', 'blob:']);

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

export function isPdfContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mime === 'application/pdf' || mime === 'application/x-pdf';
}

export function isPdfLikeUrl(raw: string): boolean {
  const url = parseViewableUrl(raw);
  if (!url) return false;

  const pathname = url.pathname.toLowerCase();
  if (pathname.endsWith('.pdf')) return true;
  return url.protocol === 'https:' && url.hostname === 'arxiv.org' && pathname.startsWith('/pdf/');
}
