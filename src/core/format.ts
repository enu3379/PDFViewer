const TAG_RE = /(^|\s)#([\p{L}\p{N}_·-]+)/gu;
const LINK_RE = /\[\[([^\]]+)\]\]/g;

export function escapeHtml(value: string): string {
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

export function parseTags(text: string): string[] {
  return Array.from(text.matchAll(TAG_RE), (match) => match[2]);
}

export function parseLinks(text: string): string[] {
  return Array.from(text.matchAll(LINK_RE), (match) => match[1].trim()).filter(Boolean);
}

export function renderRichText(text: string): string {
  return escapeHtml(text)
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="wl">[[$1]]</span>')
    .replace(/(^|\s)#([\p{L}\p{N}_·-]+)/gu, '$1<span class="tg">#$2</span>');
}

export function formatShortDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}
