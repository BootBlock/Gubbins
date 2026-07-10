import { describe, it, expect } from 'vitest';
import { humanizeGlyphName, glyphSearchText, filterGlyphNames } from './glyph-name';

describe('humanizeGlyphName', () => {
  it('spaces a simple TitleCase name', () => {
    expect(humanizeGlyphName('CircleAlert')).toBe('Circle Alert');
  });

  it('leaves a single word untouched', () => {
    expect(humanizeGlyphName('Rocket')).toBe('Rocket');
  });

  it('keeps a trailing acronym run together', () => {
    expect(humanizeGlyphName('ArrowDownAZ')).toBe('Arrow Down AZ');
  });

  it('keeps an acronym together before a TitleCase word', () => {
    expect(humanizeGlyphName('QrCode')).toBe('Qr Code');
  });

  it('separates a trailing digit', () => {
    expect(humanizeGlyphName('Volume2')).toBe('Volume 2');
  });
});

describe('filterGlyphNames', () => {
  const names = ['Rocket', 'CircleAlert', 'ArrowDownAZ', 'ArrowUp', 'Volume2'];

  it('returns a fresh copy for an empty query', () => {
    const out = filterGlyphNames(names, '   ');
    expect(out).toEqual(names);
    expect(out).not.toBe(names);
  });

  it('matches on the spaced, human-readable words', () => {
    expect(filterGlyphNames(names, 'circle')).toEqual(['CircleAlert']);
  });

  it('matches on the raw PascalCase too', () => {
    expect(filterGlyphNames(names, 'circlealert')).toEqual(['CircleAlert']);
  });

  it('ANDs multiple terms in any order', () => {
    expect(filterGlyphNames(names, 'down arrow')).toEqual(['ArrowDownAZ']);
  });

  it('is case-insensitive', () => {
    expect(filterGlyphNames(names, 'ROCKET')).toEqual(['Rocket']);
  });

  it('returns nothing when a term has no hit', () => {
    expect(filterGlyphNames(names, 'zzz')).toEqual([]);
  });
});

describe('glyphSearchText', () => {
  it('includes both spaced words and the raw lower-cased name', () => {
    expect(glyphSearchText('CircleAlert')).toBe('circle alert circlealert');
  });
});
