import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PEN_THEME,
  isPenTheme,
  nextPenTheme,
  PEN_NAMES,
  PEN_THEME_LABELS,
  PEN_THEMES
} from '../src/core/pen-theme';
import type { PenColor } from '../src/core/types';

const PEN_COLORS: PenColor[] = ['amber', 'teal', 'pink', 'blue'];

describe('pen-theme', () => {
  it('기본 테마는 목록에 있고 라벨이 있다', () => {
    expect(PEN_THEMES).toContain(DEFAULT_PEN_THEME);
    for (const theme of PEN_THEMES) {
      expect(PEN_THEME_LABELS[theme]).toBeTruthy();
    }
  });

  it('nextPenTheme은 전체 테마를 순환해 제자리로 돌아온다', () => {
    let theme = DEFAULT_PEN_THEME;
    const seen = new Set([theme]);
    for (let i = 0; i < PEN_THEMES.length - 1; i++) {
      theme = nextPenTheme(theme);
      seen.add(theme);
    }
    expect(seen.size).toBe(PEN_THEMES.length);
    expect(nextPenTheme(theme)).toBe(DEFAULT_PEN_THEME);
  });

  it('isPenTheme은 저장된 문자열만 통과시킨다', () => {
    expect(isPenTheme('classic')).toBe(true);
    expect(isPenTheme('soda')).toBe(true);
    expect(isPenTheme('neon')).toBe(false);
    expect(isPenTheme(undefined)).toBe(false);
    expect(isPenTheme(1)).toBe(false);
  });

  it('모든 테마가 4개 펜 슬롯의 이름을 빠짐없이 가진다', () => {
    for (const theme of PEN_THEMES) {
      for (const color of PEN_COLORS) {
        expect(PEN_NAMES[theme][color]).toBeTruthy();
      }
    }
  });
});
