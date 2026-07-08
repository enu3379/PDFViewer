import type { FigureEntry } from './types';

export type CaptionMatch = {
  page: number;
  start: number;
  end: number;
};

type NormalizedText = {
  text: string;
  map: number[];
};

export function findCaptionAnchor(page: number, pageText: string, captionText: string): CaptionMatch | undefined {
  const exactStart = pageText.indexOf(captionText);
  if (exactStart >= 0) {
    return { page, start: exactStart, end: exactStart + captionText.length };
  }

  const haystack = normalizeSearchText(pageText);
  const needle = normalizeSearchText(captionText);
  if (!needle.text) return undefined;

  const normalizedStart = haystack.text.indexOf(needle.text);
  if (normalizedStart < 0) return undefined;

  const normalizedEnd = normalizedStart + needle.text.length - 1;
  const start = haystack.map[normalizedStart];
  const end = (haystack.map[normalizedEnd] ?? start) + 1;
  return { page, start, end };
}

export function mergeFigureEntries(existing: FigureEntry[], incoming: FigureEntry[]): FigureEntry[] {
  const existingById = new Map(existing.map((figure) => [figure.id, figure]));
  const seen = new Set<string>();
  const merged = incoming.map((figure) => {
    seen.add(figure.id);
    const previous = existingById.get(figure.id);
    if (previous?.regionSource === 'manual' && previous.region) {
      return {
        ...figure,
        region: previous.region,
        regionSource: 'manual' as const,
        confidence: Math.max(previous.confidence, figure.confidence)
      };
    }
    return figure;
  });

  for (const previous of existing) {
    if (previous.regionSource === 'manual' && !seen.has(previous.id)) {
      merged.push(previous);
    }
  }
  return merged.sort((a, b) => a.page - b.page || a.kind.localeCompare(b.kind) || naturalNumberCompare(a.num, b.num));
}

function naturalNumberCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function normalizeSearchText(value: string): NormalizedText {
  const chars: string[] = [];
  const map: number[] = [];
  let lastWasSpace = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (/\s/.test(char)) {
      if (!lastWasSpace && chars.length > 0) {
        chars.push(' ');
        map.push(index);
        lastWasSpace = true;
      }
      continue;
    }

    chars.push(char.toLocaleLowerCase());
    map.push(index);
    lastWasSpace = false;
  }

  if (chars.at(-1) === ' ') {
    chars.pop();
    map.pop();
  }

  return { text: chars.join(''), map };
}
