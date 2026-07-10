import { describe, expect, it } from 'vitest';
import {
  buildReferenceLines,
  findCitationMentions,
  findReferenceEntry,
  getNumberedReferenceEntries,
  hasReferenceHeading,
  normalizeReferenceMarker
} from '../src/viewer/panel/reference-entry';

describe('reference entry helpers', () => {
  it('extracts the bibliography item at a bracketed citation destination', () => {
    const lines = buildReferenceLines([
      { text: 'References', x: 72, y: 720, width: 60, height: 10 },
      { text: '[12]', x: 72, y: 660, width: 20, height: 10 },
      { text: 'J. Doe. A useful paper.', x: 98, y: 660, width: 110, height: 10 },
      { text: 'Journal of Tests, 2026.', x: 72, y: 646, width: 120, height: 10 },
      { text: '[13]', x: 72, y: 610, width: 20, height: 10 },
      { text: 'R. Roe. Another paper.', x: 98, y: 610, width: 110, height: 10 }
    ]);

    expect(findReferenceEntry(lines, 658)).toEqual({
      marker: '[12]',
      text: '[12] J. Doe. A useful paper. Journal of Tests, 2026.'
    });
    expect(hasReferenceHeading(lines)).toBe(true);
    expect(getNumberedReferenceEntries(lines)).toEqual([
      { marker: '[12]', text: '[12] J. Doe. A useful paper. Journal of Tests, 2026.' },
      { marker: '[13]', text: '[13] R. Roe. Another paper.' }
    ]);
  });

  it('leaves an ordinary numbered section link to the PDF viewer', () => {
    const lines = buildReferenceLines([
      { text: '2. Methods', x: 72, y: 700, width: 60, height: 10 },
      { text: 'The experiment uses a fixed protocol.', x: 72, y: 680, width: 160, height: 10 }
    ]);

    expect(findReferenceEntry(lines, 700)).toBeNull();
  });

  it('lists each in-text numeric citation with its surrounding sentence', () => {
    const lines = buildReferenceLines([
      { text: 'Prior work established the baseline [12, 13].', x: 72, y: 700, width: 210, height: 10 }
    ]);

    expect(findCitationMentions(lines)).toEqual([
      {
        label: '[12, 13]',
        markers: ['[12]', '[13]'],
        context: 'Prior work established the baseline [12, 13].'
      }
    ]);
    expect(normalizeReferenceMarker('12.')).toBe('[12]');
  });
});
