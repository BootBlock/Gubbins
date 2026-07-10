import { describe, expect, it } from 'vitest';
import { interpolate, makeTranslator, selectPluralCategory, translate, type MessageCatalog } from './i18n';

const BASE: MessageCatalog = {
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  greeting: 'Hello {name}',
  'items.count.one': '{count} item',
  'items.count.other': '{count} items',
  'plain.number': 'You have {count} in stock',
};

const DE: MessageCatalog = {
  'common.save': 'Speichern',
  greeting: 'Hallo {name}',
  'items.count.one': '{count} Artikel',
  'items.count.other': '{count} Artikel',
};

describe('selectPluralCategory', () => {
  it('picks one vs other for English', () => {
    expect(selectPluralCategory('en-GB', 1)).toBe('one');
    expect(selectPluralCategory('en-GB', 0)).toBe('other');
    expect(selectPluralCategory('en-GB', 2)).toBe('other');
  });

  it('picks German categories (one for 1, other otherwise)', () => {
    expect(selectPluralCategory('de-DE', 1)).toBe('one');
    expect(selectPluralCategory('de-DE', 5)).toBe('other');
  });

  it('exposes richer categories for languages that define them', () => {
    // Polish uses `few` for 2–4 and `many` for larger groups.
    expect(selectPluralCategory('pl-PL', 3)).toBe('few');
    expect(selectPluralCategory('pl-PL', 12)).toBe('many');
  });

  it('returns "other" for a non-finite count instead of throwing', () => {
    expect(selectPluralCategory('en-GB', Number.NaN)).toBe('other');
    expect(selectPluralCategory('en-GB', Number.POSITIVE_INFINITY)).toBe('other');
  });

  it('falls back to a valid category for a malformed locale', () => {
    expect(selectPluralCategory('not a locale', 1)).toBe('one');
  });
});

describe('interpolate', () => {
  it('returns the template unchanged when there are no vars', () => {
    expect(interpolate('Hello {name}', undefined, 'en-GB')).toBe('Hello {name}');
  });

  it('substitutes string vars verbatim', () => {
    expect(interpolate('Hello {name}', { name: 'Ada' }, 'en-GB')).toBe('Hello Ada');
  });

  it('renders numeric vars through the active locale grouping', () => {
    expect(interpolate('{count} items', { count: 1234 }, 'en-GB')).toBe('1,234 items');
    expect(interpolate('{count} items', { count: 1234 }, 'de-DE')).toBe('1.234 items');
  });

  it('leaves an unknown placeholder intact rather than blanking it', () => {
    expect(interpolate('Hi {name} {missing}', { name: 'Ada' }, 'en-GB')).toBe('Hi Ada {missing}');
  });

  it('substitutes every occurrence of a repeated placeholder', () => {
    expect(interpolate('{x} and {x}', { x: 'a' }, 'en-GB')).toBe('a and a');
  });

  it('does not treat a non-placeholder brace pattern as a token', () => {
    expect(interpolate('a {b c} d', { b: 'X' }, 'en-GB')).toBe('a {b c} d');
  });

  it('falls back to the default locale grouping for a malformed locale', () => {
    expect(interpolate('{count}', { count: 1000 }, 'nonsense-locale')).toBe('1,000');
  });
});

describe('translate — lookup and fallback', () => {
  it('returns the active-catalog value when present', () => {
    expect(translate('common.save', DE, BASE, 'de-DE')).toBe('Speichern');
  });

  it('falls back to the base (English) string when the key is missing from the active catalog', () => {
    expect(translate('common.cancel', DE, BASE, 'de-DE')).toBe('Cancel');
  });

  it('falls back to an explicit caller fallback when absent from both catalogs', () => {
    expect(translate('missing.key', DE, BASE, 'de-DE', { fallback: 'Fallback' })).toBe('Fallback');
  });

  it('falls back to the key itself when nothing else resolves', () => {
    expect(translate('totally.unknown', DE, BASE, 'de-DE')).toBe('totally.unknown');
  });

  it('interpolates a string var after lookup', () => {
    expect(translate('greeting', DE, BASE, 'de-DE', { vars: { name: 'Ada' } })).toBe('Hallo Ada');
    expect(translate('greeting', {}, BASE, 'en-GB', { vars: { name: 'Ada' } })).toBe('Hello Ada');
  });
});

describe('translate — pluralization', () => {
  it('selects the one/other variant by the count and locale', () => {
    expect(translate('items.count', BASE, BASE, 'en-GB', { vars: { count: 1 } })).toBe('1 item');
    expect(translate('items.count', BASE, BASE, 'en-GB', { vars: { count: 5 } })).toBe('5 items');
  });

  it('groups the interpolated count in the active locale', () => {
    expect(translate('items.count', BASE, BASE, 'en-GB', { vars: { count: 2000 } })).toBe('2,000 items');
  });

  it('uses the translated plural variants when the active catalog has them', () => {
    expect(translate('items.count', DE, BASE, 'de-DE', { vars: { count: 1 } })).toBe('1 Artikel');
    expect(translate('items.count', DE, BASE, 'de-DE', { vars: { count: 3 } })).toBe('3 Artikel');
  });

  it('falls back to a bare key when a count is passed to a non-pluralized message', () => {
    expect(translate('plain.number', BASE, BASE, 'en-GB', { vars: { count: 7 } })).toBe(
      'You have 7 in stock',
    );
  });

  it('falls back through the base catalog for a plural key missing from the active catalog', () => {
    // `plain.number` is not in DE; it resolves via BASE even with a count present.
    expect(translate('plain.number', DE, BASE, 'de-DE', { vars: { count: 2 } })).toBe('You have 2 in stock');
  });

  it('prefers key.other when the exact category variant is absent', () => {
    const catalog: MessageCatalog = { 'x.other': '{count} things' };
    // German `1` is category `one`, which is absent here → falls to `.other`.
    expect(translate('x', catalog, catalog, 'de-DE', { vars: { count: 1 } })).toBe('1 things');
  });
});

describe('makeTranslator', () => {
  it('binds catalog/base/locale into a reusable translator', () => {
    const t = makeTranslator(DE, BASE, 'de-DE');
    expect(t('common.save')).toBe('Speichern');
    expect(t('common.cancel')).toBe('Cancel');
    expect(t('greeting', { vars: { name: 'Ada' } })).toBe('Hallo Ada');
    expect(t('items.count', { vars: { count: 4 } })).toBe('4 Artikel');
  });

  it('is a pure function of its inputs — same args, same output', () => {
    const t = makeTranslator(DE, BASE, 'de-DE');
    expect(t('greeting', { vars: { name: 'Ada' } })).toBe(t('greeting', { vars: { name: 'Ada' } }));
  });
});
