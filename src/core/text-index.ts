export type TextSpanIndex = {
  el: HTMLElement;
  start: number;
  end: number;
};

export type PageTextIndex = {
  page: number;
  text: string;
  spans: TextSpanIndex[];
};

export function buildPageTextIndex(page: number, pageDiv: HTMLElement): PageTextIndex {
  const textLayer = pageDiv.querySelector<HTMLElement>('.textLayer');
  const spans = Array.from(textLayer?.querySelectorAll<HTMLElement>('span') ?? []);
  let offset = 0;
  const indexed = spans.map((el) => {
    const text = el.textContent ?? '';
    const start = offset;
    offset += text.length;
    return { el, start, end: offset };
  });

  return {
    page,
    text: indexed.map((span) => span.el.textContent ?? '').join(''),
    spans: indexed
  };
}

export function offsetFromSpanOffset(
  spans: Array<Pick<TextSpanIndex, 'start' | 'end'>>,
  spanIndex: number,
  localOffset: number
): number | null {
  const span = spans[spanIndex];
  if (!span) return null;
  return Math.min(Math.max(span.start + localOffset, span.start), span.end);
}

export function findTextOffset(index: PageTextIndex, node: Node, nodeOffset: number): number | null {
  const textNode = node.nodeType === Node.TEXT_NODE ? node : null;
  const element = textNode ? textNode.parentElement : node instanceof HTMLElement ? node : null;
  const spanEl = element?.closest('span');
  if (!spanEl) return null;

  const spanIndex = index.spans.findIndex((span) => span.el === spanEl);
  if (spanIndex < 0) return null;

  let localOffset = 0;
  const walker = document.createTreeWalker(spanEl, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const current = walker.currentNode;
    if (current === textNode) {
      localOffset += nodeOffset;
      return offsetFromSpanOffset(index.spans, spanIndex, localOffset);
    }
    localOffset += current.textContent?.length ?? 0;
  }

  return offsetFromSpanOffset(index.spans, spanIndex, nodeOffset);
}

export function rangeFromOffsets(index: PageTextIndex, start: number, end: number): Range | null {
  const range = document.createRange();
  let foundStart = false;
  let foundEnd = false;

  for (const span of index.spans) {
    if (!foundStart && start >= span.start && start <= span.end) {
      const point = textPointInSpan(span.el, start - span.start);
      if (!point) return null;
      range.setStart(point.node, point.offset);
      foundStart = true;
    }
    if (!foundEnd && end >= span.start && end <= span.end) {
      const point = textPointInSpan(span.el, end - span.start);
      if (!point) return null;
      range.setEnd(point.node, point.offset);
      foundEnd = true;
      break;
    }
  }

  return foundStart && foundEnd ? range : null;
}

function textPointInSpan(span: HTMLElement, offset: number): { node: Text; offset: number } | null {
  let remaining = offset;
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let lastText: Text | null = null;

  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    lastText = text;
    const length = text.data.length;
    if (remaining <= length) {
      return { node: text, offset: remaining };
    }
    remaining -= length;
  }

  return lastText ? { node: lastText, offset: lastText.data.length } : null;
}

