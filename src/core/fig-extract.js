/*
 * fig-extract.js — 논문 PDF에서 figure 영역을 자동 감지·크롭하는 엔진
 *
 * ⚠ 이 파일은 PDFViewer(Margin) repo의 src/core/fig-extract.js 로 그대로 복사(vendoring)된다.
 *   알고리즘 수정은 figure-preview-test repo에서만 한다.
 *   릴리스 절차: figure-preview-test/docs/DEV.md §버전 릴리스 절차
 *   벤더링 절차: PDFViewer/docs/fig-extract-integration.md §갱신 절차
 *
 * 의존성: pdf.js (전역 pdfjsLib). 브라우저 전용 (canvas 사용).
 * 사용법:
 *   const result = await FigExtract.extract(uint8Array, {
 *     onProgress: msg => {},   // 진행 상태 문자열
 *     debug: msg => {},        // 상세 진단 로그 (선택)
 *     maxPages: 60,            // 선택
 *     pdfDocument: doc,        // 선택 — 이미 로드된 PDFDocumentProxy 재사용 (지정 시 data는 null 가능)
 *     renderPage: async (pageNum, scale) => canvas,  // 선택 — 호스트 렌더 캐시 주입
 *   });
 *   // result = { title, numPages, engineVersion, figures: [...] }
 *   // figure = { num, page, confidence, caption, bboxPt(그림만), captionBoxPt, bboxPx, canvas }
 *   // 크롭 이미지: FigExtract.cropDataURL(fig) / FigExtract.cropBlob(fig)
 *   // 좌표: pt, 좌상단 원점. PDF user space 변환은 y' = pageHeight - y
 *
 * 알고리즘 설명과 각 규칙의 유래는 docs/ALGORITHM.md 참고.
 */
"use strict";

const FigExtract = (() => {

const VERSION = "2.3.0";
// 2.3.0: [BREAKING] method 필드 제거 — 감지 경로가 아니라 "영역이 래스터 이미지와 겹치는지"의
//        사후 라벨이었음. 중복 번호 dedup 내부용으로만 유지. 헤더 정리·globalThis 노출 포함. bbox 로직 무변경
// 2.2.1: opts.pdfDocument 지원 — 호스트(Margin 뷰어)가 이미 로드한 PDFDocumentProxy 재사용 (재파싱 방지)
// 2.2.0: region(그림만)/캡션(텍스트) 분리 출력, confidence 추가(현재 1.0 고정), renderPage 주입 지원
// 2.1.1: pdf.js 3.11.174 → 4.10.38 (Margin과 버전 일치). 알고리즘 무변경

/* ===================== 상수 (pt 단위 기준) ===================== */
// 캡션 정규식: "Figure 1:" "Fig. 2." "Fig. 3 |" "FIGURE 4" "Figure A.1:" "Figure IV." 등
const CAP_RE  = /^(figure|fig)\s*\.?\s*(\d+(?:\.\d+)?|[A-D]\.\d+|[IVXLC]+)\s*([.:|]|$)/i;
// 공백 제거 버전: PDF.js가 small-caps를 "F IGURE 2"처럼 조각내는 경우 대응
const CAP_RE2 = /^(figure|fig)\.?(\d+(?:\.\d+)?|[A-D]\.\d+|[IVXLC]+)([.:|]|$)/i;
const S = 2.2;             // 분석/크롭 렌더 스케일 (px per pt)
const MAX_PAGES = 60;      // 분석할 최대 페이지 수

/* ===================== 기하 유틸 ===================== */
const ox = (a, b) => Math.min(a.left + a.w, b.left + b.w) - Math.max(a.left, b.left);
const mul = (m, n) => [
  m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1],
  m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3],
  m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]
];

/* ===================== 텍스트 라인 구성 ===================== */
// PDF.js 텍스트 조각(fragment)을 시각적 "줄(line)" 단위로 병합.
// 같은 baseline끼리 묶고, 8pt 넘는 x-갭에서는 별도 라인으로 분리(컬럼 경계 보호).
function buildLines(tc, pageH) {
  const frags = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const h = Math.abs(it.height || it.transform[3]) || 9;
    frags.push({ left: it.transform[4], top: pageH - it.transform[5] - h,
                 w: it.width || 0, h, font: it.fontName, s: it.str });
  }
  frags.sort((a, b) => (a.top + a.h) - (b.top + b.h) || a.left - b.left);
  const groups = [];
  for (const f of frags) {
    const g = groups[groups.length - 1];
    if (g && Math.abs((f.top + f.h) - g.bl) < Math.max(2, f.h * 0.45)) g.fr.push(f);
    else groups.push({ bl: f.top + f.h, fr: [f] });
  }
  const lines = [];
  for (const g of groups) {
    g.fr.sort((a, b) => a.left - b.left);
    const chunks = [[g.fr[0]]];
    for (const f of g.fr.slice(1)) {
      const cur = chunks[chunks.length - 1];
      if (f.left - (cur[cur.length-1].left + cur[cur.length-1].w) > 8) chunks.push([f]);
      else cur.push(f);
    }
    for (const ch of chunks) {
      const left = Math.min(...ch.map(f => f.left));
      const right = Math.max(...ch.map(f => f.left + f.w));
      const top = Math.min(...ch.map(f => f.top));
      const bot = Math.max(...ch.map(f => f.top + f.h));
      let s = "", prev = null;
      for (const f of ch) {
        if (prev !== null && f.left - prev > 1) s += " ";
        s += f.s; prev = f.left + f.w;
      }
      s = s.trim();
      if (!s) continue;
      const main = ch.reduce((a, b) => a.w >= b.w ? a : b);
      lines.push({ left, w: right - left, top, h: bot - top, s, font: main.font });
    }
  }
  return lines;
}

/* ===================== 캡션 판별 ===================== */
function isCaption(line) {
  let m = CAP_RE.exec(line.s);
  if (!m) {
    const stripped = line.s.replace(/\s+/g, "");
    m = CAP_RE2.exec(stripped);
    if (!m) return null;
    const sep = m[3] || "";
    if (![".", ":", "|"].includes(sep) && stripped.length > 12) return null;
    return m[2].toUpperCase();
  }
  const sep = m[3] || "";
  if (![".", ":", "|"].includes(sep) && line.s.length > 14) return null;
  return m[2].toUpperCase();
}

/* 위/아래 인접 줄(문단 이웃) 존재 여부 — 본문 문단 판별에 사용 */
function neighborsOf(u, lines) {
  let above = false, below = false;
  for (const v of lines) {
    if (v === u || ox(u, v) < 0.3 * Math.min(u.w, v.w)) continue;
    const d = (v.top + v.h) - (u.top + u.h);
    const a = Math.abs(d);
    if (a >= 0.85 * u.h && a <= 1.95 * u.h) {
      if (d < 0) above = true; else below = true;
      if (above && below) break;
    }
  }
  return { above, below };
}

/* ===================== 이미지 XObject bbox (CTM 추적) ===================== */
async function getImageBoxes(page, pageH) {
  let opsList;
  try { opsList = await page.getOperatorList(); }
  catch (e) { console.error("getOperatorList 실패:", e); return []; }
  const O = pdfjsLib.OPS, stack = [], boxes = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < opsList.fnArray.length; i++) {
    const fn = opsList.fnArray[i], args = opsList.argsArray[i];
    if (fn === O.save) stack.push(ctm.slice());
    else if (fn === O.restore) ctm = stack.pop() || ctm;
    else if (fn === O.transform) ctm = mul(ctm, args);
    else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject ||
             fn === O.paintImageMaskXObject || fn === O.paintJpegXObject) {
      const pts = [[0,0],[1,0],[0,1],[1,1]].map(([x,y]) =>
        [ctm[0]*x + ctm[2]*y + ctm[4], ctm[1]*x + ctm[3]*y + ctm[5]]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const yT = pageH - Math.max(...ys), yB = pageH - Math.min(...ys);
      if (x1 - x0 > 10 && yB - yT > 10)
        boxes.push({ left: x0, top: yT, w: x1 - x0, h: yB - yT });
    }
  }
  return boxes;
}

/* ===================== 잉크 그리드 (렌더 픽셀의 명암 이진화) ===================== */
function makeInk(canvas) {
  const ctx = canvas.getContext("2d");
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const W = canvas.width, H = canvas.height;
  const ink = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const l = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
    if (l < 235) ink[p] = 1;
  }
  return { ink, W, H };
}
const inkAt = (g, x, y) => (x >= 0 && y >= 0 && x < g.W && y < g.H) ? g.ink[y * g.W + x] : 0;

/* ===================== 페이지 단위 감지 (핵심) ===================== */
function detectPage(pg, lines, dom, grid, dbg) {
  const figs = [];
  // stopper: 도달하면 figure 영역 상한으로 간주하는 "본문 줄"
  const stoppers = new Set(lines.filter(u => {
    if (u.font !== dom) return false;
    const nb = neighborsOf(u, lines);
    return (u.w >= 190 && (nb.above || nb.below)) ||
           (u.w >= 100 && nb.above && nb.below);   // 좁은 wrapfigure 본문 컬럼
  }));
  const caps = lines.filter(u => isCaption(u));
  dbg(`[p${pg.num}] lines=${lines.length} imgs=${pg.images.length} caps=${caps.map(c=>JSON.stringify(c.s.slice(0,30))).join(" ")}`);
  for (const cap of caps) {
    const num = isCaption(cap);
    /* 1) 캡션 블록 확장 (여러 줄 캡션 흡수) + 캡션 전체 텍스트 수집 */
    let capBottom = cap.top + cap.h, colL = cap.left, colR = cap.left + cap.w;
    let capText = cap.s;
    for (const u of [...lines].sort((a, b) => a.top - b.top)) {
      if (u === cap || isCaption(u)) continue;
      const gap = u.top - capBottom;
      const win = Math.max(u.h, cap.h) * (u.font === dom ? 0.45 : 1.7);
      if (!(gap >= -3 && gap < win)) continue;
      if (ox(u, { left: colL, w: colR - colL }) <= 0) continue;
      if (u.font === dom && u.left < cap.left - 3) continue;
      capBottom = Math.max(capBottom, u.top + u.h);
      colL = Math.min(colL, u.left); colR = Math.max(colR, u.left + u.w);
      capText += " " + u.s;
    }
    const capbox = { left: colL, w: colR - colL, top: cap.top };
    const captionBox = { x0: colL, y0: cap.top, x1: colR, y1: capBottom }; // pt, 좌상단 원점

    /* 2) 예비 상한: stopper 스캔 (x-확장 판단용) */
    let yPre = 40;
    for (const u of lines) {
      const ub = u.top + u.h;
      if (ub >= cap.top || ox(u, capbox) < 10) continue;
      if ((stoppers.has(u) || isCaption(u)) && ub > yPre) yPre = ub;
    }
    let x0 = capbox.left, x1 = capbox.left + capbox.w;
    const inband = lines.filter(u => u.top >= yPre - 2 && u.top + u.h <= cap.top + 2);
    /* 밴드 내 다른 캡션 → 확장 한계 */
    let exL = 0, exR = pg.w;
    for (const oc of inband) {
      if (isCaption(oc) && oc !== cap) {
        if (oc.left > x1) exR = Math.min(exR, oc.left - 8);
        else if (oc.left + oc.w < x0) exL = Math.max(exL, oc.left + oc.w + 8);
      }
    }
    if (!inband.some(u => (u.left + u.w < x0 || u.left > x1) && stoppers.has(u))) {
      for (const u of inband)
        if (u.left >= exL && u.left + u.w <= exR) {
          x0 = Math.min(x0, u.left); x1 = Math.max(x1, u.left + u.w);
        }
    }
    for (const im of pg.images) {
      if (im.top < cap.top && im.top + im.h > yPre - 20 &&
          ox(im, { left: x0, w: x1 - x0 }) > 0.3 * Math.min(im.w, x1 - x0)) {
        x0 = Math.min(x0, im.left); x1 = Math.max(x1, im.left + im.w);
      }
    }
    x0 = Math.max(x0, exL); x1 = Math.min(x1, exR);
    dbg(`  Fig${num}: cap L${cap.left.toFixed(0)} T${cap.top.toFixed(0)} font=${cap.font} | capbox L${colL.toFixed(0)}-R${colR.toFixed(0)} | yPre=${yPre.toFixed(0)} x=[${x0.toFixed(0)},${x1.toFixed(0)}] ex=[${exL.toFixed(0)},${exR.toFixed(0)}]`);

    /* 3) 픽셀 블록 스캔 (렌더 px) — 실패 시 캡션 폭으로 재시도 */
    const rcap = Math.max(0, Math.round(cap.top * S) - 2);
    const hasImage = (b0, b1) => pg.images.some(im => {
      const it = im.top * S, ib = (im.top + im.h) * S;
      return Math.min(ib, b1) - Math.max(it, b0) > 0.5 * (ib - it);
    });
    const scan = (bx0, bx1) => {
      const rx0 = Math.max(0, Math.round(bx0 * S)), rx1 = Math.min(grid.W, Math.round(bx1 * S));
      const Wb = Math.max(1, rx1 - rx0);
      const prof = new Int32Array(rcap);
      for (let y = 0; y < rcap; y++) {
        let c = 0;
        for (let x = rx0; x < rx1; x++) c += inkAt(grid, x, y);
        prof[y] = c;
      }
      const thr = Math.max(2, Math.floor(0.002 * Wb));
      const blank = y => prof[y] <= thr;
      const SEP = Math.round(4.8 * S);
      const blocks = [];
      let y = rcap - 1;
      while (y >= 0) {
        while (y >= 0 && blank(y)) y--;
        if (y < 0) break;
        const b1 = y; let gap = 0, b0 = y;
        while (y >= 0) {
          if (blank(y)) { gap++; if (gap >= SEP) break; }
          else { gap = 0; b0 = y; }
          y--;
        }
        blocks.push([b0, b1]);
      }
      const blockLines = (b0, b1) => lines.filter(u => {
        const c = (u.top + u.h / 2) * S;
        return c >= b0 - 4 && c <= b1 + 4 && ox(u, { left: bx0, w: bx1 - bx0 }) > 0.5 * u.w;
      });
      const hasBorder = (b0, b1) => {
        const h = b1 - b0 + 1;
        if (h < 18) return false;
        const step = Math.max(1, Math.floor(h / 40));
        const colsInk = [];
        for (let x = rx0; x < rx1; x++) {
          let any = 0;
          for (let yy = b0; yy <= b1; yy += step) if (inkAt(grid, x, yy)) { any = 1; break; }
          if (any) colsInk.push(x);
        }
        if (!colsInk.length) return false;
        for (const edge of [colsInk[0], colsInk[colsInk.length - 1]]) {
          for (let dx = 0; dx < 3; dx++) {
            const x = edge === colsInk[0] ? Math.min(grid.W-1, edge+dx) : Math.max(0, edge-dx);
            let run = 0, best = 0;
            for (let yy = b0; yy <= b1; yy++) {
              run = inkAt(grid, x, yy) ? run + 1 : 0;
              if (run > best) best = run;
            }
            if (best >= 0.75 * h) return true;
          }
        }
        return false;
      };
      const incl = [];
      for (const [b0, b1] of blocks) {
        const bl = blockLines(b0, b1);
        const others = bl.filter(u => isCaption(u) && u !== cap);
        if (others.length) {
          if (!incl.length) {
            const cb = Math.max(...others.map(u => (u.top + u.h) * S)) + 3;
            if (b1 - cb > 15) incl.push([cb, b1]);
          }
          dbg(`    blk [${b0}-${b1}] OTHER-CAP stop`);
          break;
        }
        if (b1 < 56 * S && (b1 - b0) < 28 * S && bl.length) { dbg(`    blk [${b0}-${b1}] HEADER stop`); break; }
        const nstop = bl.filter(u => stoppers.has(u)).length;
        const guard = incl.length ? 1 : 2;
        if (nstop >= guard && !hasBorder(b0, b1) && !hasImage(b0, b1)) { dbg(`    blk [${b0}-${b1}] BODY stop (nstop=${nstop})`); break; }
        dbg(`    blk [${b0}-${b1}] lines=${bl.length} nstop=${nstop} -> incl`);
        incl.push([b0, b1]);
        if (rcap - b0 > 660 * S) break;
      }
      /* 상단 슬리버(가는 선/헤더 잔재) 제거 */
      while (incl.length > 1) {
        const top = incl[incl.length - 1], nxt = incl[incl.length - 2];
        if ((top[1] - top[0]) < 12 * S && (nxt[0] - top[1]) > 40 * S) incl.pop();
        else break;
      }
      /* 상단 섹션 헤딩("2.1 Framework Overview" 등) 제거 */
      while (incl.length > 1) {
        const [tb0, tb1] = incl[incl.length - 1];
        if (tb1 - tb0 >= 20 * S) break;
        const bl = blockLines(tb0, tb1);
        if (!bl.length) break;
        const joined = bl.map(u => u.s).join(" ");
        if (joined.length <= 45 && /^(\d+(\.\d+)*|[A-Z](\.\d+)+)\s/.test(joined)) incl.pop();
        else break;
      }
      return { incl, rx0, rx1 };
    };
    let { incl, rx0, rx1 } = scan(x0, x1);
    if (!incl.length && (Math.abs(x0 - capbox.left) > 2 || Math.abs(x1 - (capbox.left + capbox.w)) > 2)) {
      dbg(`  Fig${num}: RETRY with capbox width`);
      ({ incl, rx0, rx1 } = scan(capbox.left, capbox.left + capbox.w));
    }

    if (incl.length) {
      const ry0 = incl[incl.length - 1][0], ry1 = incl[0][1];
      /* 영역이 래스터 이미지(XObject)와 겹치는지 — 중복 번호 dedup에서 우선순위로만 사용 */
      const raster = incl.some(([a, b]) => hasImage(a, b));
      /* 4) 좌우 잉크 연결 확장 (본문 줄/다른 캡션 구간 진입 금지) */
      const rowsHasInk = x => {
        for (let yy = ry0; yy <= ry1; yy += 2) if (inkAt(grid, x, yy)) return true;
        return false;
      };
      const forbid = [];
      for (const u of lines) {
        const c = (u.top + u.h / 2) * S;
        if (c < ry0 || c > ry1) continue;
        let bodyish = stoppers.has(u) || (isCaption(u) && u !== cap);
        if (!bodyish && u.font === dom && u.h >= 6 && u.w >= 100) {
          const nb = neighborsOf(u, lines);
          bodyish = nb.above && nb.below;  // 연속 문단의 내부 줄 (본문 폰트만)
        }
        if (bodyish) forbid.push([Math.round(u.left * S), Math.round((u.left + u.w) * S)]);
      }
      const inForbid = x => forbid.some(([a, b]) => x >= a && x <= b);
      const tol = Math.round(12 * S);
      const eR = Math.min(grid.W, Math.round(exR * S)), eL = Math.max(0, Math.round(exL * S));
      let xx = rx1, gap2 = 0, lastInk = rx1;
      while (xx < eR && gap2 < tol && !inForbid(xx)) {
        if (rowsHasInk(xx)) { lastInk = xx + 1; gap2 = 0; } else gap2++;
        xx++;
      }
      let nrx1 = Math.max(rx1, lastInk);
      xx = rx0 - 1; gap2 = 0; lastInk = rx0;
      while (xx >= eL && gap2 < tol && !inForbid(xx)) {
        if (rowsHasInk(xx)) { lastInk = xx; gap2 = 0; } else gap2++;
        xx--;
      }
      let nrx0 = Math.min(rx0, lastInk);
      /* 확장 구간이 본문 텍스트 줄(본문 폰트)을 여러 개 물었다면 확장 취소 (슬리버 방지) */
      const textInStrip = (a, b) => lines.filter(u => {
        const c = (u.top + u.h / 2) * S;
        if (c < ry0 || c > ry1 || u.h < 6 || u.font !== dom) return false;
        const ul = u.left * S, ur = (u.left + u.w) * S;
        return Math.min(ur, b) - Math.max(ul, a) > 4;
      }).length;
      if (nrx0 < rx0 && textInStrip(nrx0, rx0) >= 3) nrx0 = rx0;
      if (nrx1 > rx1 && textInStrip(rx1, nrx1) >= 3) nrx1 = rx1;
      /* 5) x 타이트닝: 실제 잉크 범위로 좁히기 */
      let fx0 = nrx1, fx1 = nrx0;
      for (let x = nrx0; x < nrx1; x++) {
        for (let yy = ry0; yy <= ry1; yy += 2) {
          if (inkAt(grid, x, yy)) { fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); break; }
        }
      }
      if (fx0 > fx1) { fx0 = nrx0; fx1 = nrx1; }
      fx0 = Math.min(fx0, Math.round(capbox.left * S));
      fx1 = Math.max(fx1, Math.round((capbox.left + capbox.w) * S));
      dbg(`  Fig${num}: REGION y[${ry0}-${ry1}] x[${fx0}-${fx1}]${raster ? " raster" : ""}`);
      /* region은 그림 영역만 (캡션 제외). 캡션은 captionBox/caption 텍스트로 별도 반환 */
      figs.push({ num, raster_: raster, page: pg.num,
        x0: fx0 - 10, x1: fx1 + 10, y0: ry0 - 8, y1: ry1 + 4,
        h_: Math.round(capBottom * S) - ry0, caption: capText, captionBox });
    } else {
      /* caption-above 레이아웃: 아래쪽 이미지 */
      const below = pg.images.filter(im =>
        im.top >= capBottom - 4 && im.top - capBottom < 40 &&
        ox(im, capbox) > 0.3 * Math.min(im.w, capbox.w));
      if (below.length) {
        const yb = Math.max(...below.map(im => im.top + im.h));
        const bx0 = Math.min(x0, ...below.map(im => im.left));
        const bx1 = Math.max(x1, ...below.map(im => im.left + im.w));
        figs.push({ num, raster_: true, page: pg.num,
          x0: Math.round(bx0*S) - 10, x1: Math.round(bx1*S) + 10,
          y0: Math.round(capBottom*S) + 2, y1: Math.round(yb*S) + 4,
          h_: Math.round((yb - cap.top)*S), caption: capText, captionBox });
      }
    }
  }
  return figs;
}

/* ===================== 메인 파이프라인 ===================== */
async function extract(data, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const dbg = opts.debug || (() => {});
  const maxPages = opts.maxPages || MAX_PAGES;

  const pdf = opts.pdfDocument || await pdfjsLib.getDocument({ data }).promise;
  let title = null;
  try {
    const meta = await pdf.getMetadata();
    title = (meta.info && meta.info.Title && meta.info.Title.trim()) || null;
  } catch (e) { /* 무시 */ }

  const nPages = Math.min(pdf.numPages, maxPages);
  /* 1차: 전체 텍스트 → 라인/도미넌트 폰트 */
  const pageData = [];
  const fontW = {};
  for (let p = 1; p <= nPages; p++) {
    onProgress(`텍스트 분석… ${p}/${nPages}`);
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const lines = buildLines(tc, vp.height);
    for (const l of lines) fontW[l.font] = (fontW[l.font] || 0) + l.w;
    pageData.push({ page, num: p, w: vp.width, h: vp.height, lines });
  }
  const dom = Object.entries(fontW).sort((a, b) => b[1] - a[1])[0]?.[0];
  /* 2차: 캡션 있는 페이지만 렌더 + 감지 */
  const allFigs = [];
  for (const pd of pageData) {
    if (!pd.lines.some(isCaption)) continue;
    onProgress(`figure 감지… p.${pd.num}`);
    pd.images = await getImageBoxes(pd.page, pd.h);
    /* 페이지 렌더: 호스트(Margin 등)가 renderPage(pageNum, scale)를 주입하면 그걸 사용 */
    let canvas;
    if (opts.renderPage) {
      canvas = await opts.renderPage(pd.num, S);
    } else {
      const vp = pd.page.getViewport({ scale: S });
      canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      await pd.page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    }
    const grid = makeInk(canvas);
    const figs = detectPage(pd, pd.lines, dom, grid, dbg);
    for (const f of figs) { f.canvas = canvas; allFigs.push(f); }
  }
  /* 중복 번호는 더 그럴듯한 후보 선택 */
  const best = {};
  for (const f of allFigs) {
    const score = (f.raster_ ? 1e9 : 0) + f.h_;
    if (!(f.num in best) || score > best[f.num].score) best[f.num] = { score, f };
  }
  const figures = Object.values(best).map(v => v.f)
    .filter(f => (f.x1 - f.x0) >= 30 && (f.y1 - f.y0) >= 30)
    .sort((a, b) => String(a.num).length - String(b.num).length || String(a.num).localeCompare(String(b.num)));
  for (const f of figures) {
    f.bboxPx = { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 };
    f.bboxPt = { x0: +(f.x0 / S).toFixed(1), y0: +(f.y0 / S).toFixed(1),
                 x1: +(f.x1 / S).toFixed(1), y1: +(f.y1 / S).toFixed(1) };
    f.captionBoxPt = { x0: +f.captionBox.x0.toFixed(1), y0: +f.captionBox.y0.toFixed(1),
                       x1: +f.captionBox.x1.toFixed(1), y1: +f.captionBox.y1.toFixed(1) };
    delete f.captionBox;
    delete f.raster_;
    f.confidence = 1.0; // 당분간 고정 (Margin FigureEntry.confidence 대응)
  }
  return { title, numPages: pdf.numPages, figures, engineVersion: VERSION };
}

/* ===================== 크롭 헬퍼 ===================== */
function cropCanvas(f) {
  const cw = f.x1 - f.x0, ch = f.y1 - f.y0;
  const c2 = document.createElement("canvas");
  c2.width = cw; c2.height = ch;
  const ctx = c2.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(f.canvas, f.x0, f.y0, cw, ch, 0, 0, cw, ch);
  return c2;
}
const cropDataURL = f => cropCanvas(f).toDataURL("image/png");
const cropBlob = f => new Promise(res => cropCanvas(f).toBlob(res, "image/png"));

return { VERSION, extract, cropCanvas, cropDataURL, cropBlob, isCaption, buildLines };

})();

/* Margin(Vite/TS)에서 side-effect import 후 전역으로 접근할 수 있도록 노출 */
if (typeof globalThis !== "undefined") globalThis.FigExtract = FigExtract;
