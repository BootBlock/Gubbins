import { describe, it, expect } from 'vitest';
import { buildCataloguePageStyle, cssContentString } from './catalogue-print';

describe('cssContentString', () => {
  it('wraps in quotes and escapes backslash and double-quote', () => {
    expect(cssContentString('Acme')).toBe('"Acme"');
    expect(cssContentString('a"b')).toBe('"a\\"b"');
    expect(cssContentString('a\\b')).toBe('"a\\\\b"');
  });

  it('collapses newlines and tabs to spaces (can never break the string)', () => {
    expect(cssContentString('a\nb\tc')).toBe('"a b c"');
    // A crafted breakout attempt stays inside the string.
    expect(cssContentString('"; } evil { x: 1')).toBe('"\\"; } evil { x: 1"');
  });
});

describe('buildCataloguePageStyle', () => {
  it('returns empty when nothing is enabled', () => {
    expect(buildCataloguePageStyle({ pageNumbers: false, runningHeader: false, headerText: 'Acme' })).toBe(
      '',
    );
  });

  it('emits page numbers via counters', () => {
    const css = buildCataloguePageStyle({ pageNumbers: true, runningHeader: false, headerText: '' });
    expect(css).toContain('@media print');
    expect(css).toContain('@page');
    expect(css).toContain('counter(page)');
    expect(css).toContain('counter(pages)');
  });

  it('emits the running header with the escaped text', () => {
    const css = buildCataloguePageStyle({ pageNumbers: false, runningHeader: true, headerText: 'Acme Ltd' });
    expect(css).toContain('@top-right');
    expect(css).toContain('"Acme Ltd"');
  });

  it('omits the running header when its text is blank', () => {
    expect(buildCataloguePageStyle({ pageNumbers: false, runningHeader: true, headerText: '   ' })).toBe('');
  });

  it('emits both boxes when both are on', () => {
    const css = buildCataloguePageStyle({ pageNumbers: true, runningHeader: true, headerText: 'Acme' });
    expect(css).toContain('@top-right');
    expect(css).toContain('@bottom-right');
  });
});
