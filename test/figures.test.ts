import { describe, expect, it } from 'vitest';
import { findCaptionAnchor, mergeFigureEntries } from '../src/core/figures';
import type { FigureEntry } from '../src/core/types';

function figure(patch: Partial<FigureEntry> = {}): FigureEntry {
  return {
    id: 'fig1-p2',
    doc: 'doc',
    kind: 'figure',
    num: '1',
    label: 'Figure 1',
    page: 2,
    captionText: 'Figure 1. A small result.',
    captionAnchor: { page: 2, start: 20, end: 45 },
    region: { page: 2, rect: [10, 20, 30, 40] },
    regionSource: 'auto',
    confidence: 1,
    ...patch
  };
}

describe('figure helpers', () => {
  it('finds exact caption anchors', () => {
    const anchor = findCaptionAnchor(2, 'Intro. Figure 1. A small result. Body.', 'Figure 1. A small result.');

    expect(anchor).toEqual({ page: 2, start: 7, end: 32 });
  });

  it('matches captions across whitespace differences', () => {
    const anchor = findCaptionAnchor(3, 'Figure 2.\nA compact   caption.', 'Figure 2. A compact caption.');

    expect(anchor).toEqual({ page: 3, start: 0, end: 30 });
  });

  it('preserves manual regions when engine results are merged', () => {
    const existing = figure({
      region: { page: 2, rect: [1, 2, 3, 4] },
      regionSource: 'manual'
    });
    const incoming = figure({
      captionText: 'Figure 1. Updated caption.',
      region: { page: 2, rect: [10, 20, 30, 40] },
      regionSource: 'auto'
    });

    expect(mergeFigureEntries([existing], [incoming])[0]).toMatchObject({
      captionText: 'Figure 1. Updated caption.',
      region: { page: 2, rect: [1, 2, 3, 4] },
      regionSource: 'manual'
    });
  });
});
