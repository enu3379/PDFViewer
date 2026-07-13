import { describe, expect, it } from 'vitest';
import { figureMentions, nearestFigureMention, scanFigureReferences, type FigureReference } from '../src/core/mentions';
import type { FigureEntry } from '../src/core/types';

const figures: FigureEntry[] = [
  {
    id: 'fig1-p1',
    doc: 'doc',
    kind: 'figure',
    num: '1',
    label: 'Figure 1',
    page: 1,
    captionText: 'Figure 1. Result caption.',
    captionAnchor: { page: 1, start: 0, end: 25 },
    region: { page: 1, rect: [10, 20, 30, 40] },
    regionSource: 'auto',
    confidence: 1
  },
  {
    id: 'fig2-p2',
    doc: 'doc',
    kind: 'figure',
    num: '2',
    label: 'Figure 2',
    page: 2,
    captionText: 'Figure 2. More.',
    captionAnchor: { page: 2, start: 100, end: 115 },
    region: { page: 2, rect: [10, 20, 30, 40] },
    regionSource: 'auto',
    confidence: 1
  }
];

describe('figure mentions', () => {
  it('links caption labels but excludes them from mention chips', () => {
    const refs = scanFigureReferences(
      { page: 1, text: 'Figure 1. Result caption. As shown in Fig. 2, the trend holds.' },
      figures,
      (offset) => 700 - offset
    );

    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ figId: 'fig1-p1', isCaptionLabel: true });
    expect(refs[1]).toMatchObject({ figId: 'fig2-p2', isCaptionLabel: false, yPdf: 662 });
    expect(figureMentions(refs).map((ref) => ref.figId)).toEqual(['fig2-p2']);
  });

  it('normalizes figure labels before lookup', () => {
    const refs = scanFigureReferences({ page: 4, text: 'See figure 1 and FIG. 2.' }, figures);

    expect(refs.map((ref) => ref.figId)).toEqual(['fig1-p1', 'fig2-p2']);
  });
});

describe('nearestFigureMention', () => {
  const mention = (key: string, figId: string, page: number, yPdf: number | undefined, isCaptionLabel = false): FigureReference => ({
    key,
    figId,
    page,
    start: 0,
    end: 6,
    quote: 'Fig. 2',
    yPdf,
    isCaptionLabel
  });

  const refs: FigureReference[] = [
    mention('top', 'fig2-p2', 3, 700),
    mention('mid', 'fig2-p2', 3, 420),
    mention('caption', 'fig2-p2', 3, 415, true),
    mention('other-fig', 'fig1-p1', 3, 418),
    mention('other-page', 'fig2-p2', 5, 421),
    mention('no-y', 'fig2-p2', 3, undefined)
  ];

  it('picks the same-page mention nearest to the click y', () => {
    expect(nearestFigureMention(refs, 'fig2-p2', 3, 419)?.key).toBe('mid');
    expect(nearestFigureMention(refs, 'fig2-p2', 3, 690)?.key).toBe('top');
  });

  it('ignores caption labels, other figures, other pages, and y-less mentions', () => {
    expect(nearestFigureMention(refs, 'fig2-p2', 3, 415)?.key).toBe('mid');
    expect(nearestFigureMention(refs, 'fig2-p2', 5, 421)?.key).toBe('other-page');
    expect(nearestFigureMention(refs, 'fig1-p1', 1, 400)).toBeNull();
  });

  it('returns null when no mention qualifies', () => {
    expect(nearestFigureMention([], 'fig2-p2', 3, 100)).toBeNull();
    expect(nearestFigureMention(refs, 'fig2-p2', 7, 100)).toBeNull();
  });
});
