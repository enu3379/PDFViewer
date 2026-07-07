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

  it('copies coordinates from DOMRect-like objects with prototype getters', () => {
    // 실제 DOMRect는 좌표를 프로토타입 getter로 노출해서 스프레드 복사가 빈 객체를 만든다.
    class GetterRect {
      #x: number;
      #y: number;
      #w: number;
      #h: number;
      constructor(x: number, y: number, w: number, h: number) {
        this.#x = x;
        this.#y = y;
        this.#w = w;
        this.#h = h;
      }
      get left(): number { return this.#x; }
      get top(): number { return this.#y; }
      get right(): number { return this.#x + this.#w; }
      get bottom(): number { return this.#y + this.#h; }
      get width(): number { return this.#w; }
      get height(): number { return this.#h; }
    }

    const merged = mergeLineRects([new GetterRect(5, 10, 100, 12)]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ left: 5, top: 10, right: 105, bottom: 22, width: 100, height: 12 });
    expect(Object.values(merged[0]).every(Number.isFinite)).toBe(true);
  });
});

