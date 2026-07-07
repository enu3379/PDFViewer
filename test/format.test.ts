import { describe, expect, it } from 'vitest';
import { parseLinks, parseTags, renderRichText } from '../src/core/format';

describe('format helpers', () => {
  it('parses wiki links', () => {
    expect(parseLinks('see [[Cohen kappa]] and [[ 재현 체크리스트 ]]')).toEqual([
      'Cohen kappa',
      '재현 체크리스트'
    ]);
  });

  it('parses tags', () => {
    expect(parseTags('메모 #평가방법 and #DiD')).toEqual(['평가방법', 'DiD']);
  });

  it('escapes rich text before rendering links and tags', () => {
    expect(renderRichText('<b>[[x]]</b> #태그')).toContain('&lt;b&gt;');
    expect(renderRichText('<b>[[x]]</b> #태그')).toContain('<span class="tg">#태그</span>');
  });
});
