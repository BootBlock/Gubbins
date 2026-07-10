import { describe, expect, it } from 'vitest';
import { BASE_LANGUAGE, EN_CATALOG, SUPPORTED_LANGUAGES, languageForLocale, loadCatalog } from './messages';

describe('languageForLocale', () => {
  it('derives the UI language from the base subtag of the formatting locale', () => {
    expect(languageForLocale('de-DE')).toBe('de');
    expect(languageForLocale('de-AT')).toBe('de');
    expect(languageForLocale('de')).toBe('de');
  });

  it('falls back to English for a locale we do not (yet) translate', () => {
    expect(languageForLocale('en-GB')).toBe('en');
    expect(languageForLocale('en-US')).toBe('en');
    // French formatting is offered, but there is no French catalog yet → English UI.
    expect(languageForLocale('fr-FR')).toBe('en');
  });

  it('falls back to English for a malformed locale rather than throwing', () => {
    expect(languageForLocale('not-a-real-locale-@@')).toBe('en');
    expect(languageForLocale('')).toBe('en');
  });
});

describe('SUPPORTED_LANGUAGES', () => {
  it('lists English first as the base, with a loader only for translated languages', () => {
    expect(SUPPORTED_LANGUAGES[0]?.code).toBe(BASE_LANGUAGE);
    expect(SUPPORTED_LANGUAGES[0]?.load).toBeUndefined();
    const de = SUPPORTED_LANGUAGES.find((l) => l.code === 'de');
    expect(de?.load).toBeTypeOf('function');
    expect(de?.endonym).toBe('Deutsch');
  });

  it('has a unique code and a non-empty endonym for every language', () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const lang of SUPPORTED_LANGUAGES) expect(lang.endonym.length).toBeGreaterThan(0);
  });
});

describe('loadCatalog', () => {
  it('returns the bundled English catalog for the base language', async () => {
    await expect(loadCatalog('en')).resolves.toBe(EN_CATALOG);
  });

  it('returns the bundled English catalog for an unknown language', async () => {
    await expect(loadCatalog('xx')).resolves.toBe(EN_CATALOG);
  });

  it('lazily imports the German catalog and it agrees with the base on a known key', async () => {
    const de = await loadCatalog('de');
    expect(de).not.toBe(EN_CATALOG);
    expect(de['nav.inventory']).toBe('Inventar');
  });
});
