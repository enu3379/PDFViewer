import { describe, expect, it } from 'vitest';
import {
  FigExtract,
  VENDORED_ENGINE_VERSION,
  requireFigExtract,
  toFigureEntries,
  toPdfRect,
  type EngineFigure,
  type EngineResult,
  type FigExtractApi
} from '../src/core/fig-engine';

describe('figure engine integration', () => {
  it('pins the vendored engine version these types were written for', () => {
    /* 이 파일의 타입·주석과 docs/fig-extract-integration.md의 "다음 벤더링 할 일"은 이 버전을
     * 전제한다. 엔진을 벤더링하면 여기서 깨지고, 그게 TODO 목록으로 돌아가라는 신호다. */
    expect(FigExtract.VERSION).toBe(VENDORED_ENGINE_VERSION);
  });

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
      suspectedMissing: [],
      figures: [
        {
          num: '2',
          page: 3,
          confidence: 0.9,
          caption: 'Figure 2. Result',
          bboxPt: { x0: 10, y0: 20, x1: 110, y1: 220 },
          captionBoxPt: { x0: 10, y0: 225, x1: 110, y1: 250 },
          bboxPx: { x0: 22, y0: 44, x1: 242, y1: 484 },
          /* 엔진이 실어 보내는 "선언에 없는 필드"의 대리다 — 벤더링본 v2.14.0의 `cropCanvas`,
           * v2.19.1의 `cropPng_`, v2.19.0의 `captionPage`가 전부 여기 해당한다. 아래 toEqual이
           * 이걸 잡아야 "toFigureEntries가 엔진 객체를 그대로 흘리지 않는다"가 보장된다.
           * (spread 리팩터가 들어오면 FigureSeed에 캔버스나 수 MB data URL이 실려 storage로 간다.) */
          surplusEngineField: 'must not leak into FigureSeed'
        } as unknown as EngineFigure
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
    const box = { x0: 10, y0: 20, x1: 110, y1: 220 };
    const captionBox = { x0: 10, y0: 225, x1: 110, y1: 250 };
    const pixelBox = { x0: 22, y0: 44, x1: 242, y1: 484 };
    const result: EngineResult = {
      title: 'Paper with per-chapter numbering',
      numPages: 20,
      engineVersion: 'next',
      suspectedMissing: [],
      figures: [
        {
          num: '1',
          page: 2,
          confidence: 0.9,
          caption: 'Figure 1. Chapter one result',
          bboxPt: box,
          captionBoxPt: captionBox,
          bboxPx: pixelBox
        },
        {
          num: '1',
          page: 18,
          confidence: 0.8,
          caption: 'Figure 1. Chapter two result',
          bboxPt: box,
          captionBoxPt: captionBox,
          bboxPx: pixelBox
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
