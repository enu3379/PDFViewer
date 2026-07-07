import { describe, expect, it } from 'vitest';
import {
  commonSuffixLength,
  contextForRange,
  findQuoteWithContext,
  mergeLineRects,
  normalizePdfRect
} from '../src/core/anchor';
import { offsetFromSpanOffset } from '../src/core/text-index';

describe('anchor helpers', () => {
  it('round-trips offsets from span-local positions', () => {
    const spans = [
      { start: 0, end: 5 },
      { start: 5, end: 12 }
    ];

    expect(offsetFromSpanOffset(spans, 0, 3)).toBe(3);
    expect(offsetFromSpanOffset(spans, 1, 2)).toBe(7);
    expect(offsetFromSpanOffset(spans, 1, 99)).toBe(12);
  });

  it('uses prefix context to choose the moved quote occurrence', () => {
    const original = 'first result. target sentence. second result. target sentence.';
    const start = original.lastIndexOf('target sentence');
    const context = contextForRange(original, start, start + 'target sentence'.length);
    const moved = 'target sentence. unrelated. first result. target sentence. second result. target sentence.';

    const match = findQuoteWithContext(moved, context.quote, context.prefix);

    expect(match).toEqual({
      start: moved.lastIndexOf('target sentence'),
      end: moved.lastIndexOf('target sentence') + 'target sentence'.length
    });
  });

  it('normalizes PDF rectangles', () => {
    expect(normalizePdfRect([10, 20, 3, 4])).toEqual([3, 4, 10, 20]);
  });

  it('merges same-line client rects', () => {
    const merged = mergeLineRects([
      { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 },
      { left: 11, top: 1, right: 20, bottom: 11, width: 9, height: 10 },
      { left: 0, top: 30, right: 5, bottom: 40, width: 5, height: 10 }
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ left: 0, right: 20 });
  });

  it('counts common suffix length', () => {
    expect(commonSuffixLength('abc xyz', '123 xyz')).toBe(4);
  });
});

