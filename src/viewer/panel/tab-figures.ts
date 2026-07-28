import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import { FigExtract, type EngineFigure, type FigExtractApi } from '../../core/fig-engine';

export type FiguresTabCallbacks = {
  onJumpToPage: (page: number) => void;
};

type FiguresTabEngine = Pick<FigExtractApi, 'extract' | 'cropDataURL'>;

/**
 * 엔진이 `name`으로만 구별해 주는 렌더 실패 (v2.19.1+ — 별도 클래스가 아니라 이름을 덮어쓴 Error다).
 *
 * 엔진의 판별식(`fig-extract.js`: `!!error && error.name === "FigRenderError"`)을 **그대로** 쓴다.
 * `instanceof Error`를 덧붙이면 소비자가 엔진보다 좁아진다 — 오류가 realm 경계(worker·다른 프레임)를
 * 넘거나 구조화 복제를 거치면 `instanceof`가 깨지는데 `name`은 남아, 이름은 맞지만 분기만 조용히
 * 사라진다. 좁힐 근거가 없으므로 공급자와 같은 술어를 쓴다.
 */
function isFigRenderError(error: unknown): boolean {
  return !!error && (error as { name?: unknown }).name === 'FigRenderError';
}

/**
 * 그림·표 탭 — fig-extract 엔진으로 문서를 스캔해 figure 프리뷰 카드를 렌더한다.
 * 스캔은 PDFDocumentProxy가 준비되는 즉시 1회 실행한다. 문서가 바뀌면 setDocument()로 리셋.
 */
export class FiguresTab {
  #list: HTMLElement;
  #callbacks: FiguresTabCallbacks;
  #engine: FiguresTabEngine;
  #doc: PDFDocumentProxy | null = null;
  #state: 'idle' | 'scanning' | 'done' | 'error' = 'idle';
  #figures: EngineFigure[] = [];
  #scanGeneration = 0;
  /** 진행 중인 스캔의 취소 핸들 — 문서가 바뀔 때만 abort한다 (#34) */
  #scanAbort: AbortController | null = null;

  constructor(
    list: HTMLElement,
    callbacks: FiguresTabCallbacks,
    engine: FiguresTabEngine = FigExtract
  ) {
    this.#list = list;
    this.#callbacks = callbacks;
    this.#engine = engine;
    this.#list.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      if (target?.closest('.fig-retry')) {
        this.ensureScanned();
        return;
      }
      const card = target?.closest<HTMLElement>('.fig-card');
      if (!card) return;
      const page = Number(card.dataset.page);
      if (page) this.#callbacks.onJumpToPage(page);
    });
  }

  setDocument(doc: PDFDocumentProxy | null): void {
    this.#scanGeneration += 1;
    /* generation만 올리면 이전 스캔의 **결과만** 버려지고 작업은 끝까지 돈다 — 문서를 빠르게
     * 갈아타면 스캔이 중첩돼 크롭 세트가 두 벌 상주한다. 통합 규약 §취소가 요구하는 대로
     * 실제로 중단시킨다 (#34).
     * abort가 여기에만 있는 이유: **문서 교체만이 진행 중인 스캔을 무효화하는 사건**이다.
     * 재시도(ensureScanned)는 종료 상태인 'error'에서만 진입 가능하므로 그때 in-flight 스캔은
     * 없다 — 취소할 대상 자체가 없다. */
    this.#scanAbort?.abort();
    this.#scanAbort = null;
    this.#doc = doc;
    this.#state = 'idle';
    this.#figures = [];
    this.#setStatus(doc ? 'figure 스캔 준비 중…' : 'PDF를 열면 그림·표를 자동으로 스캔합니다.');
    this.ensureScanned();
  }

  /** 문서 로드 직후 호출된다. 실패 상태에서는 같은 문서 스캔을 다시 시도할 수 있다. */
  ensureScanned(): void {
    if ((this.#state !== 'idle' && this.#state !== 'error') || !this.#doc) return;
    this.#state = 'scanning';
    const abort = new AbortController();
    this.#scanAbort = abort;
    void this.#scan(this.#scanGeneration, abort);
  }

  async #scan(scanGeneration: number, abort: AbortController): Promise<void> {
    /* 취소·완료 어느 쪽으로 끝나도 #scanAbort를 정리해야 하므로 조기 반환도 try 안에 둔다.
     * 밖에 두면 여기서 반환할 때 #scanAbort가 끝나지 않는 스캔을 계속 가리키고 #state가
     * 'scanning'에 갇혀 재시도도 취소도 불가능해진다 (현재는 도달 불가하지만, 이 불변식은
     * ensureScanned의 !this.#doc 가드에만 의존하게 두지 않는다). */
    try {
      const doc = this.#doc;
      if (!doc) return;
      this.#setStatus('figure 스캔 중…');
      const result = await this.#engine.extract(null, {
        pdfDocument: doc,
        signal: abort.signal,
        onProgress: (msg) => {
          if (this.#scanGeneration === scanGeneration) this.#setStatus(msg);
        }
      });
      /* 취소된 스캔의 결과는 후임 문서의 탭에 그려져선 안 된다. 지금은 abort가 항상 generation
       * 증가와 짝이라 아래 두 검사가 같은 집합을 막지만, generation을 올리지 않는 abort 지점
       * (dispose·패널 닫기 등)이 나중에 생기면 성공 경로에만 구멍이 남는다 — 두 경로를 대칭으로
       * 둔다 (#34). */
      if (abort.signal.aborted) return;
      if (this.#scanGeneration !== scanGeneration) return;
      this.#figures = result.figures;
      this.#state = 'done';
      this.#render();
    } catch (error) {
      /* 취소는 정상 흐름이다 — 에러 UI를 띄우면 문서를 바꿀 때마다 "실패했어요"가 번쩍인다.
       * 엔진이 던지는 이름(AbortError·RenderingCancelledException…)에 기대지 않고 signal만 본다. */
      if (abort.signal.aborted) return;
      if (this.#scanGeneration !== scanGeneration) return;
      console.error('figure 스캔 실패', error);
      this.#state = 'error';
      /* FigRenderError(엔진 v2.19.1+)는 "렌더 결과가 존재하지 않는다" — 메모리 압력을 받은 Chrome이
       * 캔버스 백킹 스토어를 회수한 경우다. 일시적 조건이라 같은 문서로 다시 시도하면 성공할 수
       * 있으므로, 일반 실패와 달리 그 사실을 문구로 알린다. 재시도 경로 자체는 동일하다. */
      this.#setStatus(
        isFigRenderError(error)
          ? '메모리가 부족했을 수 있어요. 다른 탭을 닫고 다시 시도해 주세요.'
          : 'figure 스캔에 실패했어요.',
        true
      );
    } finally {
      if (this.#scanAbort === abort) this.#scanAbort = null;
    }
  }

  #setStatus(text: string, retry = false): void {
    const state = document.createElement('div');
    state.className = 'empty';
    state.textContent = text;
    if (retry) {
      const button = document.createElement('button');
      button.className = 'lnkbtn fig-retry';
      button.type = 'button';
      button.textContent = '다시 시도';
      state.append(button);
    }
    this.#list.replaceChildren(state);
  }

  #render(): void {
    if (!this.#figures.length) {
      this.#setStatus('감지된 figure가 없어요. (스캔 PDF이거나 캡션 형식 미지원일 수 있어요)');
      return;
    }
    this.#list.replaceChildren();
    for (const fig of this.#figures) {
      const card = document.createElement('button');
      card.className = 'fig-card';
      card.type = 'button';
      card.dataset.page = String(fig.page);
      card.setAttribute('aria-label', `Figure ${fig.num}, ${fig.page}페이지로 이동`);
      const img = document.createElement('img');
      img.src = this.#engine.cropDataURL(fig);
      img.alt = `Figure ${fig.num}`;
      const head = document.createElement('span');
      head.className = 'fig-head';
      const label = document.createElement('b');
      label.textContent = `Figure ${fig.num}`;
      const page = document.createElement('span');
      page.textContent = `p.${fig.page}`;
      head.append(label, page);
      const caption = document.createElement('span');
      caption.className = 'fig-cap';
      caption.textContent = fig.caption;
      card.append(img, head, caption);
      this.#list.append(card);
    }
  }
}
