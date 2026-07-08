import { describe, expect, it } from 'vitest';
import { figureMentions, scanFigureReferences } from '../src/core/mentions';
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
