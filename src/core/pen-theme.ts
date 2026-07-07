import type { PenColor } from './types';

/**
 * 형광펜 팔레트 테마. 저장 데이터의 PenColor 4슬롯(amber/teal/pink/blue)은 그대로 두고,
 * 테마는 그 슬롯에 입히는 색만 바꾼다(:root[data-pen-theme] CSS 토큰). 덕분에 테마를
 * 전환해도 기존 하이라이트는 마이그레이션 없이 새 팔레트로 재도색된다.
 */
export type PenTheme = 'classic' | 'soda';

export const PEN_THEMES: readonly PenTheme[] = ['classic', 'soda'];

export const DEFAULT_PEN_THEME: PenTheme = 'classic';

export const PEN_THEME_LABELS: Record<PenTheme, string> = {
  classic: '클래식',
  soda: '소다'
};

/** 테마별 슬롯 색 이름 — 스와치의 aria-label/title에 쓴다. */
export const PEN_NAMES: Record<PenTheme, Record<PenColor, string>> = {
  classic: { amber: '주황', teal: '초록', pink: '분홍', blue: '파랑' },
  soda: { amber: '라임', teal: '아쿠아', pink: '핫핑크', blue: '라일락' }
};

export function isPenTheme(value: unknown): value is PenTheme {
  return typeof value === 'string' && (PEN_THEMES as readonly string[]).includes(value);
}

export function nextPenTheme(theme: PenTheme): PenTheme {
  const index = PEN_THEMES.indexOf(theme);
  return PEN_THEMES[(index + 1) % PEN_THEMES.length];
}
