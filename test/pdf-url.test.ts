import { describe, expect, it } from 'vitest';
import {
  isChromeNewTabUrl,
  isLocalPdfUrl,
  isPdfContentType,
  isPdfLikeUrl,
  parseViewableUrl
} from '../src/core/pdf-url';

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

  it('recognizes local PDF URLs including Windows UNC paths', () => {
    expect(isLocalPdfUrl('file:///Users/me/paper.PDF?download=1')).toBe(true);
    expect(isLocalPdfUrl('file://server/share/x.pdf')).toBe(true);
    expect(isPdfLikeUrl('file://server/share/x.PDF')).toBe(true);
    expect(isLocalPdfUrl('file:///Users/me/readme.txt')).toBe(false);
  });

  it('recognizes Chrome new-tab URLs', () => {
    expect(isChromeNewTabUrl('chrome://newtab/')).toBe(true);
    expect(isChromeNewTabUrl('chrome://new-tab-page/')).toBe(true);
    expect(isChromeNewTabUrl('chrome://settings/')).toBe(false);
    expect(isChromeNewTabUrl('not a url')).toBe(false);
  });

  it('recognizes PDF content types', () => {
    expect(isPdfContentType('application/pdf')).toBe(true);
    expect(isPdfContentType('application/pdf; charset=binary')).toBe(true);
    expect(isPdfContentType('application/x-pdf')).toBe(true);
    expect(isPdfContentType('text/html')).toBe(false);
  });
});
