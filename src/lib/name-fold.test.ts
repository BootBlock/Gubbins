import { describe, it, expect } from 'vitest';
import { foldName, namesMatch } from './name-fold';

describe('foldName', () => {
  it('folds ASCII case and surrounding whitespace, as SQLite NOCASE would', () => {
    expect(foldName('  Manufacturer ')).toBe('manufacturer');
    expect(namesMatch('MANUFACTURER', 'manufacturer')).toBe(true);
  });

  it('folds case beyond ASCII, which SQLite NOCASE does not (issue #343)', () => {
    expect(namesMatch('Café', 'CAFÉ')).toBe(true);
    expect(namesMatch('Grösse', 'GRÖSSE')).toBe(true);
    // The reported pair: capitalising `Größe` yields `GRÖSSE`, which a plain lower-casing
    // fold would leave as a second, distinct name (issue #343).
    expect(namesMatch('Größe', 'GRÖSSE')).toBe(true);
    expect(namesMatch('Δοκιμή', 'ΔΟΚΙΜΉ')).toBe(true);
    expect(namesMatch('Цвет', 'ЦВЕТ')).toBe(true);
  });

  it('folds a decomposed accent onto its composed spelling', () => {
    // Identical on screen, different code points — a duplicate no user could tell apart.
    const composed = 'Café'.normalize('NFC');
    const decomposed = 'Café'.normalize('NFD');
    expect(composed).not.toBe(decomposed);
    expect(namesMatch(composed, decomposed)).toBe(true);
  });

  it('keeps genuinely different names apart', () => {
    expect(namesMatch('Voltage', 'Wattage')).toBe(false);
    expect(namesMatch('Größe', 'Grüße')).toBe(false);
    expect(namesMatch('Café', 'Cafe')).toBe(false);
  });

  it('does not depend on the ambient locale', () => {
    // Under a Turkish locale `toLocaleLowerCase` yields a dotless 'ı', which would fold
    // `MANUFACTURER` differently from every other device — and from rows arriving over sync.
    expect(foldName('MANUFACTURER')).toBe('manufacturer');
    expect(foldName('I')).toBe('i');
  });
});
