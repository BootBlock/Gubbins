import { describe, expect, it } from 'vitest';
import { isSameSupplierName, normaliseSupplierName, supplierNameKey } from './supplier-name';

describe('normaliseSupplierName', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normaliseSupplierName('  RS   Components  ')).toBe('RS Components');
    expect(normaliseSupplierName('RS\tComponents')).toBe('RS Components');
    expect(normaliseSupplierName('RS\n Components')).toBe('RS Components');
  });

  it("preserves the user's casing and punctuation — this is the displayed form", () => {
    expect(normaliseSupplierName('RS-Components')).toBe('RS-Components');
    expect(normaliseSupplierName('rs components')).toBe('rs components');
    expect(normaliseSupplierName('Farnell & Co.')).toBe('Farnell & Co.');
  });
});

describe('supplierNameKey', () => {
  it('folds the variants that look identical on screen', () => {
    const key = supplierNameKey('RS Components');
    expect(supplierNameKey('rs components')).toBe(key);
    expect(supplierNameKey('RS  Components')).toBe(key);
    expect(supplierNameKey('RS-Components')).toBe(key);
    expect(supplierNameKey('  R.S. Components ')).toBe(key);
  });

  it('folds diacritics so accented and unaccented spellings converge', () => {
    expect(supplierNameKey('Müller')).toBe(supplierNameKey('Muller'));
    expect(supplierNameKey('Sécurité')).toBe(supplierNameKey('Securite'));
  });

  it('keeps genuinely different suppliers apart', () => {
    expect(supplierNameKey('Farnell')).not.toBe(supplierNameKey('Farnel'));
    expect(supplierNameKey('RS Components')).not.toBe(supplierNameKey('RS Components UK'));
  });

  it('keeps non-Latin names distinct rather than folding them all to empty', () => {
    // A naive /[^a-z0-9]/ fold would collapse every one of these to '' and merge
    // unrelated suppliers into a single row.
    expect(supplierNameKey('鈴木電子')).not.toBe('');
    expect(supplierNameKey('鈴木電子')).not.toBe(supplierNameKey('東京部品'));
    expect(supplierNameKey('Электроника')).not.toBe('');
  });

  it('keys a name written entirely in punctuation to the empty string', () => {
    // Callers reject blanks before this point; documented so the behaviour is deliberate.
    expect(supplierNameKey('---')).toBe('');
    expect(supplierNameKey('   ')).toBe('');
  });
});

describe('isSameSupplierName', () => {
  it('is true for punctuation and case variants of one supplier', () => {
    expect(isSameSupplierName('RS Components', 'rs-components')).toBe(true);
  });

  it('is false for different suppliers', () => {
    expect(isSameSupplierName('Farnell', 'Mouser')).toBe(false);
  });
});
