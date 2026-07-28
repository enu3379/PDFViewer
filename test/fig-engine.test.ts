import { describe, expect, it, vi } from 'vitest';
import {
  FigExtract,
  VENDORED_ENGINE_VERSION,
  requireFigExtract,
  toFigureEntries,
  toFigureEntry,
  toPdfRect,
  type EngineFigure,
  type EngineResult,
  type FigExtractApi
} from '../src/core/fig-engine';

/**
 * 페이지 높이 조회 mock. **페이지마다 높이를 다르게 주는 것이 요점이다** — 모든 페이지가 같은
 * 높이면 `getPageHeightPt(f.page)`를 `f.captionPage ?? f.page`로 바꿔도 좌표가 그대로라 테스트가
 * 통과한다. 지도에 없는 페이지를 물으면 던져서, "어느 페이지 높이를 물었나"까지 고정한다.
 */
function pageHeights(heights: Record<number, number>) {
  return vi.fn((pageNum: number): number => {
    const height = heights[pageNum];
    if (height === undefined) throw new Error(`물으면 안 되는 페이지 높이: ${pageNum}`);
    return height;
  });
}

describe('figure engine integration', () => {
  it('pins the vendored engine version these types were written for', () => {
    /* 상수는 "옆에 있는 src/core/fig-extract.js가 이 버전이다"라는 단언이다. 엔진 파일을
     * 복사하면 여기서 깨지고, 그게 docs/fig-extract-integration.md §갱신 절차로 돌아가라는
     * 신호다 — 파일 복사와 상수 갱신은 같은 커밋이어야 한다.
     * ⚠ 이 핀이 지키는 것은 **상수 ↔ 엔진 파일**뿐이다. 이 파일의 타입·주석이 어느 버전을
     *   기준으로 쓰였는지는 기계가 검사할 수 없다 — 그건 §갱신 절차가 지킨다. */
    expect(FigExtract.VERSION).toBe(VENDORED_ENGINE_VERSION);
  });

  /* FigExtractApi는 손으로 쓴 선언이라 컴파일러가 런타임과 대조해 주지 않는다. 벤더링이 실제로
   * 쓰는 세 함수를 잃어버리면(예: v2.19.1의 `cropCanvas` 제거처럼 export 목록이 바뀌면) 타입은
   * 통과하고 프리뷰 렌더에서 처음 터진다 — 그 전에 여기서 잡는다. */
  it('exposes the crop accessors the viewer actually calls', () => {
    for (const name of ['extract', 'cropDataURL', 'cropBlob'] as const) {
      expect(typeof FigExtract[name]).toBe('function');
    }
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
          confidence: 1,   // 엔진은 1.0 고정 (플레이스홀더) — 다른 값은 나올 수 없다
          caption: 'Figure 2. Result',
          bboxPt: { x0: 10, y0: 20, x1: 110, y1: 220 },
          captionBoxPt: { x0: 10, y0: 225, x1: 110, y1: 250 },
          bboxPx: { x0: 22, y0: 44, x1: 242, y1: 484 },
          /* 엔진이 실어 보내는 "선언에 없는 필드"의 대리다 — 벤더링본 v2.14.0의 `cropCanvas`와
           * v2.19.1의 `cropPng_`(수 MB PNG data URL)가 여기 해당한다. 아래 toEqual이 이걸 잡아야
           * "toFigureEntries가 엔진 객체를 그대로 흘리지 않는다"가 보장된다.
           * (spread 리팩터가 들어오면 FigureSeed에 수 MB data URL이 실려 storage로 간다.) */
          surplusEngineField: 'must not leak into FigureSeed'
        } as unknown as EngineFigure
      ]
    };

    const [seed] = toFigureEntries(result, pageHeights({ 3: 900 }));
    expect(seed).toEqual({
      id: 'fig2-p3',
      kind: 'figure',
      num: '2',
      label: 'Figure 2',
      page: 3,
      captionText: 'Figure 2. Result',
      /* 엔진이 captionPage를 안 실어 보내면 캡션도 그림 페이지에 있다는 뜻이다 */
      captionPage: 3,
      region: { page: 3, rect: [10, 680, 110, 880] },
      regionSource: 'auto',
      confidence: 1
    });
    expect(seed).not.toHaveProperty('doc');
    expect(seed).not.toHaveProperty('captionAnchor');
  });

  /* v2.19.0 12-B: 캡션이 다음 장 상단이고 그림은 앞 페이지인 레이아웃. 이 필드를 버리면 M3의
   * captionAnchor 계산이 그림 페이지에서 캡션을 찾다가 **오류 없이** 빈손으로 끝난다. */
  it('carries the caption page for cross-page figures (v2.19.0 12-B)', () => {
    const result: EngineResult = {
      title: 'Cross-page caption',
      numPages: 12,
      engineVersion: 'test',
      suspectedMissing: [],
      figures: [
        {
          num: '4',
          page: 6,
          captionPage: 7,
          confidence: 1,
          caption: 'Figure 4. Spans a page break',
          bboxPt: { x0: 10, y0: 20, x1: 110, y1: 220 },
          /* caption page 좌표계다 — 그림 페이지 높이로 변환하면 조용히 틀린다.
           * toFigureEntries는 이 박스를 변환하지 않으므로 여기서는 통과만 확인한다. */
          captionBoxPt: { x0: 10, y0: 40, x1: 110, y1: 70 },
          bboxPx: { x0: 22, y0: 44, x1: 242, y1: 484 }
        }
      ]
    };

    /* 두 페이지 높이를 다르게 준다: region이 어느 쪽 높이로 변환됐는지가 좌표에 드러난다 */
    const heights = pageHeights({ 6: 1000, 7: 500 });
    const [seed] = toFigureEntries(result, heights);

    expect(seed.page).toBe(6);          // 식별 키 (num, page)·페이지 점프·region은 그림 페이지
    expect(seed.captionPage).toBe(7);   // 캡션 텍스트 검색은 캡션 페이지
    expect(seed.id).toBe('fig4-p6');
    /* 그림 페이지(1000) 기준: y' = 1000 − y. 캡션 페이지(500)를 썼다면 [10, 280, 110, 480]이다 */
    expect(seed.region).toEqual({ page: 6, rect: [10, 780, 110, 980] });
    expect(heights.mock.calls).toEqual([[6]]);   // 캡션 페이지 높이는 묻지 않는다
  });

  /* M3 함정 고정: 영속 스키마에 seed 전용 필드가 새면 안 된다. TS strict도 스프레드
   * (`{ ...seed, doc, captionAnchor }`)에는 초과 속성 검사를 하지 않아 컴파일이 막지 않는다 —
   * store.saveDoc이 화이트리스트 없이 통째로 저장하므로 그대로 chrome.storage에 영속된다. */
  it('drops seed-only fields when completing a FigureEntry', () => {
    const seed = toFigureEntries(
      {
        title: 'Cross-page caption',
        numPages: 12,
        engineVersion: 'test',
        suspectedMissing: [],
        figures: [
          {
            num: '4',
            page: 6,
            captionPage: 7,
            confidence: 1,
            caption: 'Figure 4. Spans a page break',
            bboxPt: { x0: 10, y0: 20, x1: 110, y1: 220 },
            captionBoxPt: { x0: 10, y0: 40, x1: 110, y1: 70 },
            bboxPx: { x0: 22, y0: 44, x1: 242, y1: 484 }
          }
        ]
      },
      pageHeights({ 6: 1000 })
    )[0];

    /* captionAnchor.page는 seed.captionPage와 같아야 한다 — 호출 측 책임이고, 그래서 seed가
     * 그 값을 날라 왔다. 여기까지 오면 captionPage 자체는 더 이상 필요 없다. */
    const entry = toFigureEntry(seed, 'doc-1', { page: seed.captionPage, start: 12, end: 40 });

    expect(entry).not.toHaveProperty('captionPage');
    expect(Object.keys(entry).sort()).toEqual([
      'captionAnchor', 'captionText', 'confidence', 'doc', 'id', 'kind',
      'label', 'num', 'page', 'region', 'regionSource'
    ]);
    expect(entry.captionAnchor.page).toBe(7);
    expect(entry.page).toBe(6);
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
          confidence: 1,
          caption: 'Figure 1. Chapter one result',
          bboxPt: box,
          captionBoxPt: captionBox,
          bboxPx: pixelBox
        },
        {
          num: '1',
          page: 18,
          confidence: 1,
          caption: 'Figure 1. Chapter two result',
          bboxPt: box,
          captionBoxPt: captionBox,
          bboxPx: pixelBox
        }
      ]
    };

    /* 페이지마다 높이가 다르므로 "figure별로 자기 페이지 높이를 쓴다"까지 고정된다 */
    const seeds = toFigureEntries(result, pageHeights({ 2: 800, 18: 1200 }));

    expect(seeds.map(({ id, num, page }) => ({ id, num, page }))).toEqual([
      { id: 'fig1-p2', num: '1', page: 2 },
      { id: 'fig1-p18', num: '1', page: 18 }
    ]);
    expect(seeds.map((s) => s.region)).toEqual([
      { page: 2, rect: [10, 580, 110, 780] },
      { page: 18, rect: [10, 980, 110, 1180] }
    ]);
  });
});
