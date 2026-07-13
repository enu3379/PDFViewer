import { describe, expect, it } from 'vitest';
import { computeScrollDelta } from '../src/viewer/jump';

describe('jump helpers', () => {
  it('computes the scroll delta for 1/8 text alignment', () => {
    expect(computeScrollDelta({
      containerTop: 50,
      containerHeight: 800,
      pageTop: 200,
      targetY: 320,
      alignRatio: 1 / 8
    })).toBe(370);
  });

  it('computes the scroll delta for centered region alignment', () => {
    expect(computeScrollDelta({
      containerTop: 20,
      containerHeight: 600,
      pageTop: 100,
      targetY: 500,
      alignRatio: 1 / 2
    })).toBe(280);
  });
});
