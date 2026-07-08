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

// 스캔 텍스트는 pdf.js 아이템을 구분자 없이 이어 붙여 공백 유무가 불안정하다
// (예: "threereviewers"). 엔진 캡션과의 대조는 공백을 아예 무시하고 한다.
function normalizeSearchText(value: string): NormalizedText {
  const chars: string[] = [];
  const map: number[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (/\s/.test(char)) continue;
    chars.push(char.toLocaleLowerCase());
    map.push(index);
  }

  return { text: chars.join(''), map };
}
