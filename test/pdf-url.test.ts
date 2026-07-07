import { describe, expect, it } from 'vitest';
import { isPdfContentType, isPdfLikeUrl, parseViewableUrl } from '../src/core/pdf-url';

describe('PDF URL helpers', () => {
  it('allows viewer-supported URL schemes', () => {
    expect(parseViewableUrl('https://example.com/paper.pdf')?.protocol).toBe('https:');
    expect(parseViewableUrl('file:///Users/me/paper.pdf')?.protocol).toBe('file:');
    expect(parseViewableUrl('chrome://extensions')).toBeNull();
  });

  it('recognizes obvious PDF URLs', () => {
    expect(isPdfLikeUrl('https://example.com/paper.PDF?download=1')).toBe(true);
    expect(isPdfLikeUrl('https://arxiv.org/pdf/2401.00001')).toBe(true);
    expect(isPdfLikeUrl('https://example.com/article')).toBe(false);
  });

  it('recognizes PDF content types', () => {
    expect(isPdfContentType('application/pdf')).toBe(true);
    expect(isPdfContentType('application/pdf; charset=binary')).toBe(true);
    expect(isPdfContentType('application/x-pdf')).toBe(true);
    expect(isPdfContentType('text/html')).toBe(false);
  });
});
