import { describe, expect, it } from 'vitest';
import {
  requireFigExtract,
  toFigureEntries,
  toPdfRect,
  type EngineResult,
  type FigExtractApi
} from '../src/core/fig-engine';

describe('figure engine integration', () => {
  it('fails clearly when the vendored global is missing', () => {
    expect(() => requireFigExtract({})).toThrow(/FigExtract가 전역에 등록되지 않았습니다/);
  });

  it('returns the registered engine API', () => {
    const api = { VERSION: 'test' } as FigExtractApi;
    expect(requireFigExtract({ FigExtract: api })).toBe(api);
  });

  it('converts top-left engine coordinates to PDF user space', () => {
    expect(toPdfRect({ x0: 10, y0: 20, x1: 110, y1: 220 }, 800)).toEqual([
      10, 580, 110, 780
    ]);
  });

  it('creates FigureSeed entries without document identity or caption anchor', () => {
    const result: EngineResult = {
      title: 'Paper',
      numPages: 3,
      engineVersion: 'test',
      figures: [
        {
          num: '2',
          page: 3,
          confidence: 0.9,
          caption: 'Figure 2. Result',
          bboxPt: { x0: 10, y0: 20, x1: 110, y1: 220 },
          captionBoxPt: { x0: 10, y0: 225, x1: 110, y1: 250 },
          bboxPx: { x0: 22, y0: 44, x1: 242, y1: 484 },
          canvas: {} as HTMLCanvasElement
        }
      ]
    };

    const [seed] = toFigureEntries(result, () => 800);
    expect(seed).toEqual({
      id: 'fig2-p3',
      kind: 'figure',
      num: '2',
      label: 'Figure 2',
      page: 3,
      captionText: 'Figure 2. Result',
      region: { page: 3, rect: [10, 580, 110, 780] },
      regionSource: 'auto',
      confidence: 0.9
    });
    expect(seed).not.toHaveProperty('doc');
    expect(seed).not.toHaveProperty('captionAnchor');
  });

  it('preserves figure numbers reused on different pages', () => {
    const canvas = {} as HTMLCanvasElement;
    const box = { x0: 10, y0: 20, x1: 110, y1: 220 };
    const captionBox = { x0: 10, y0: 225, x1: 110, y1: 250 };
    const pixelBox = { x0: 22, y0: 44, x1: 242, y1: 484 };
    const result: EngineResult = {
      title: 'Paper with per-chapter numbering',
      numPages: 20,
      engineVersion: 'next',
      figures: [
        {
          num: '1',
          page: 2,
          confidence: 0.9,
          caption: 'Figure 1. Chapter one result',
          bboxPt: box,
          captionBoxPt: captionBox,
          bboxPx: pixelBox,
          canvas
        },
        {
          num: '1',
          page: 18,
          confidence: 0.8,
          caption: 'Figure 1. Chapter two result',
          bboxPt: box,
          captionBoxPt: captionBox,
          bboxPx: pixelBox,
          canvas
        }
      ]
    };

    const seeds = toFigureEntries(result, () => 800);

    expect(seeds.map(({ id, num, page }) => ({ id, num, page }))).toEqual([
      { id: 'fig1-p2', num: '1', page: 2 },
      { id: 'fig1-p18', num: '1', page: 18 }
    ]);
  });
});
