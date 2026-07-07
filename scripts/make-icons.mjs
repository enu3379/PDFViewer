// 확장 아이콘 생성기 — 시안 A(여백) 아트를 PNG로 굽는다.
// 사용: node scripts/make-icons.mjs  →  public/icons/icon-{16,32,48,128}.png
// 외부 의존성 없이 node:zlib로 PNG를 직접 인코딩한다.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');

// 128 좌표계 원화 — 종이 위 글줄, 형광펜 스와이프, 오른쪽 여백의 점.
const ART_128 = [
  { kind: 'rrect', x: 4, y: 4, w: 120, h: 120, r: 26, color: '#E3E0D5' },
  { kind: 'rrect', x: 6, y: 6, w: 116, h: 116, r: 24, color: '#FBFAF6' },
  { kind: 'rrect', x: 22, y: 54, w: 50, h: 20, r: 6, color: '#FAD57E' },
  { kind: 'rrect', x: 22, y: 30, w: 46, h: 9, r: 4.5, color: '#C7C3B5' },
  { kind: 'rrect', x: 27, y: 59.5, w: 40, h: 9, r: 4.5, color: '#756F5E' },
  { kind: 'rrect', x: 22, y: 92, w: 38, h: 9, r: 4.5, color: '#C7C3B5' },
  { kind: 'circle', cx: 99, cy: 64, r: 8.5, color: '#BA7517' },
];

// 16 좌표계 단순화판 — 작은 크기에서 뭉개지지 않도록 요소를 줄였다.
const ART_16 = [
  { kind: 'rrect', x: 0, y: 0, w: 16, h: 16, r: 4.25, color: '#D8D4C8' },
  { kind: 'rrect', x: 1.5, y: 1.5, w: 13, h: 13, r: 3, color: '#FBFAF6' },
  { kind: 'rrect', x: 3, y: 6.6, w: 6.2, h: 3, r: 1, color: '#FAD57E' },
  { kind: 'rrect', x: 3, y: 3.4, w: 5.8, h: 1.6, r: 0.8, color: '#BDB9AB' },
  { kind: 'rrect', x: 3, y: 11.6, w: 4.6, h: 1.6, r: 0.8, color: '#BDB9AB' },
  { kind: 'circle', cx: 12.2, cy: 8.1, r: 2, color: '#BA7517' },
];

const TARGETS = [
  { size: 16, art: ART_16, artSize: 16 },
  { size: 32, art: ART_16, artSize: 16 },
  { size: 48, art: ART_128, artSize: 128 },
  { size: 128, art: ART_128, artSize: 128 },
];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function insideRoundedRect(px, py, s) {
  const hw = s.w / 2;
  const hh = s.h / 2;
  const dx = Math.abs(px - (s.x + hw)) - (hw - s.r);
  const dy = Math.abs(py - (s.y + hh)) - (hh - s.r);
  if (dx > s.r || dy > s.r) return false;
  if (dx <= 0 || dy <= 0) return dx <= s.r && dy <= s.r;
  return dx * dx + dy * dy <= s.r * s.r;
}

function insideCircle(px, py, s) {
  const dx = px - s.cx;
  const dy = py - s.cy;
  return dx * dx + dy * dy <= s.r * s.r;
}

// 4×4 슈퍼샘플 커버리지로 안티앨리어싱한다.
const SS = 4;

function render(size, art, artSize) {
  const scale = artSize / size;
  const buf = new Float64Array(size * size * 4); // straight-alpha RGBA 0..1
  for (const shape of art) {
    const [r, g, b] = hexToRgb(shape.color);
    const test = shape.kind === 'circle' ? insideCircle : insideRoundedRect;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let hit = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const px = (x + (sx + 0.5) / SS) * scale;
            const py = (y + (sy + 0.5) / SS) * scale;
            if (test(px, py, shape)) hit++;
          }
        }
        if (!hit) continue;
        const sa = hit / (SS * SS);
        const i = (y * size + x) * 4;
        const da = buf[i + 3];
        const oa = sa + da * (1 - sa);
        buf[i] = (r / 255 * sa + buf[i] * da * (1 - sa)) / oa;
        buf[i + 1] = (g / 255 * sa + buf[i + 1] * da * (1 - sa)) / oa;
        buf[i + 2] = (b / 255 * sa + buf[i + 2] * da * (1 - sa)) / oa;
        buf[i + 3] = oa;
      }
    }
  }
  const bytes = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    bytes[i * 4] = Math.round(buf[i * 4] * 255);
    bytes[i * 4 + 1] = Math.round(buf[i * 4 + 1] * 255);
    bytes[i * 4 + 2] = Math.round(buf[i * 4 + 2] * 255);
    bytes[i * 4 + 3] = Math.round(buf[i * 4 + 3] * 255);
  }
  return bytes;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const { size, art, artSize } of TARGETS) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, render(size, art, artSize)));
  console.log(`wrote ${file}`);
}
