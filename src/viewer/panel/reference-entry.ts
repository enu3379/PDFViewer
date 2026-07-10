export type ReferenceTextItem = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ReferenceLine = {
  text: string;
  y: number;
};

export type ReferenceEntry = {
  marker: string;
  text: string;
};

export type CitationMention = {
  label: string;
  markers: string[];
  context: string;
};

type ReferenceMarker = {
  marker: string;
  bracketed: boolean;
};

const REFERENCE_HEADINGS = /^(references|bibliography|works cited|literature cited)(?:\s+and\s+notes)?$/i;

export function normalizeReferenceMarker(marker: string): string {
  const normalized = marker.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/[.)]$/, '').trim();
  return `[${normalized.toLowerCase()}]`;
}

function markerFromText(text: string): ReferenceMarker | null {
  const bracketed = text.match(/^\s*(\[\s*\d+[a-z]?\s*\])\s*/i);
  if (bracketed) return { marker: bracketed[1], bracketed: true };

  const numbered = text.match(/^\s*(\d+[a-z]?)[.)]\s+/i);
  if (numbered) return { marker: numbered[1], bracketed: false };

  return null;
}

function appendSegment(text: string, segment: ReferenceTextItem, previous: ReferenceTextItem | null): string {
  if (!text || !previous) return segment.text;
  const gap = segment.x - previous.x - previous.width;
  const needsSpace = gap > 0.5
    && !/\s$/.test(text)
    && !/^\s|^[,.;:)]/.test(segment.text)
    && !/-$/.test(text);
  return `${text}${needsSpace ? ' ' : ''}${segment.text}`;
}

/** Convert positioned PDF text runs into visual lines in PDF user-space order. */
export function buildReferenceLines(items: ReferenceTextItem[]): ReferenceLine[] {
  const sorted = items
    .filter((item) => item.text.trim())
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<{ y: number; items: ReferenceTextItem[] }> = [];

  for (const item of sorted) {
    const current = lines.at(-1);
    const tolerance = Math.max(2, item.height * 0.35);
    if (!current || Math.abs(current.y - item.y) > tolerance) {
      lines.push({ y: item.y, items: [item] });
    } else {
      current.items.push(item);
    }
  }

  return lines.map((line) => {
    const ordered = line.items.sort((a, b) => a.x - b.x);
    let text = '';
    let previous: ReferenceTextItem | null = null;
    for (const item of ordered) {
      text = appendSegment(text, item, previous);
      previous = item;
    }
    return { text: text.replace(/\s+/g, ' ').trim(), y: line.y };
  }).filter((line) => line.text);
}

export function hasReferenceHeading(lines: ReferenceLine[]): boolean {
  return lines.some((line) => REFERENCE_HEADINGS.test(line.text.trim()));
}

function entriesFromMarkers(lines: ReferenceLine[], markers: Array<ReferenceMarker & { index: number }>): ReferenceEntry[] {
  return markers.flatMap((marker, index) => {
    const nextMarker = markers[index + 1];
    const text = lines
      .slice(marker.index, nextMarker?.index)
      .map((line) => line.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text ? [{ marker: marker.marker, text }] : [];
  });
}

/** Returns every numbered entry on a page that is already known to be a reference page. */
export function getNumberedReferenceEntries(lines: ReferenceLine[]): ReferenceEntry[] {
  const markers = lines.flatMap((line, index) => {
    const marker = markerFromText(line.text);
    return marker ? [{ ...marker, index }] : [];
  });
  return entriesFromMarkers(lines, markers);
}

export function findCitationMentions(lines: ReferenceLine[]): CitationMention[] {
  const mentions: CitationMention[] = [];
  const citationPattern = /\[(\d+[a-z]?(?:\s*(?:,|;|-|–)\s*\d+[a-z]?)+|\d+[a-z]?)\]/gi;

  for (const line of lines) {
    for (const match of line.text.matchAll(citationPattern)) {
      const label = match[0];
      const markers = Array.from(match[1].matchAll(/\d+[a-z]?/gi), (token) => normalizeReferenceMarker(token[0]));
      if (!markers.length) continue;
      mentions.push({ label, markers, context: line.text });
    }
  }
  return mentions;
}

/**
 * Returns a single numbered bibliography entry at an internal PDF destination.
 * It deliberately declines ordinary section links so their normal page navigation remains intact.
 */
export function findReferenceEntry(lines: ReferenceLine[], targetY: number | null): ReferenceEntry | null {
  if (targetY === null) return null;

  const markers = lines.flatMap((line, index) => {
    const marker = markerFromText(line.text);
    return marker ? [{ ...marker, index }] : [];
  });
  if (!markers.length) return null;

  const closest = markers.reduce((nearest, candidate) => (
    Math.abs(lines[candidate.index].y - targetY) < Math.abs(lines[nearest.index].y - targetY)
      ? candidate
      : nearest
  ));
  const looksLikeReferencePage = hasReferenceHeading(lines) || markers.length >= 2;

  // A lone decimal section number is ambiguous; bracketed citation entries are not.
  if (!looksLikeReferencePage && !closest.bracketed) return null;

  return entriesFromMarkers(lines, markers).find((entry) => entry.marker === closest.marker) ?? null;
}
