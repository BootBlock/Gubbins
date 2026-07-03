import { describe, it, expect } from 'vitest';
import { DEFAULT_CURRENCY, DEFAULT_LOCALE, makeFormatters } from './format';

const gb = makeFormatters(); // en-GB / GBP defaults (§1.2.1)

describe('makeFormatters — defaults (§1.2.1 en-GB / GBP)', () => {
  it('exposes the locked defaults', () => {
    expect(DEFAULT_LOCALE).toBe('en-GB');
    expect(DEFAULT_CURRENCY).toBe('GBP');
  });

  it('formats currency in the base currency', () => {
    expect(gb.currency(1234.5)).toBe('£1,234.50');
  });

  it('renders a dash for non-finite currency', () => {
    expect(gb.currency(Number.NaN)).toBe('—');
    expect(gb.currency(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('renders a per-call currency override with its own symbol (no conversion)', () => {
    // The number is shown verbatim under the override's own symbol, not the base £.
    const eur = gb.currency(1.23, 'EUR');
    expect(eur).toContain('€');
    expect(eur).toContain('1.23');
    expect(eur).not.toContain('£');
    const usd = gb.currency(1, 'USD');
    expect(usd).toContain('$');
    expect(usd).toContain('1.00');
    expect(usd).not.toContain('£');
    // A code equal to the base (any case) is just the base format.
    expect(gb.currency(1234.5, 'gbp')).toBe('£1,234.50');
    expect(gb.currency(1234.5, undefined)).toBe('£1,234.50');
  });

  it('falls back to the base symbol + raw code for a malformed override', () => {
    // Not three ASCII letters — Intl rejects it, so keep it legible and preserve the code.
    expect(gb.currency(1.23, 'ZZ')).toBe('£1.23 ZZ');
  });

  it('exposes the money value as Intl parts, agreeing with the string form', () => {
    const parts = gb.currencyParts(1234.5);
    expect(parts).not.toBeNull();
    // The pieces re-join to exactly the string form (the two share one source of truth).
    expect(parts!.map((p) => p.value).join('')).toBe('£1,234.50');
    // Exactly one `currency` part carries the symbol, so a caller can tint just that.
    const symbols = parts!.filter((p) => p.type === 'currency');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.value).toBe('£');
  });

  it('returns null parts for a non-finite value', () => {
    expect(gb.currencyParts(Number.NaN)).toBeNull();
    expect(gb.currencyParts(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('carries a malformed override code as a trailing literal part', () => {
    const parts = gb.currencyParts(1.23, 'ZZ');
    expect(parts!.map((p) => p.value).join('')).toBe('£1.23 ZZ');
    // The base £ is still the (tintable) currency part; the raw code rides along as a literal.
    expect(parts!.some((p) => p.type === 'currency' && p.value === '£')).toBe(true);
    expect(parts!.some((p) => p.type === 'literal' && p.value === ' ZZ')).toBe(true);
  });

  it('formats a 0..1 ratio as a percentage, clamping out-of-range/non-finite input', () => {
    expect(gb.percent(0)).toBe('0%');
    expect(gb.percent(0.5)).toBe('50%');
    expect(gb.percent(1)).toBe('100%');
    expect(gb.percent(1.5)).toBe('100%');
    expect(gb.percent(-0.2)).toBe('0%');
    expect(gb.percent(Number.NaN)).toBe('0%');
  });

  it('formats SI byte sizes', () => {
    expect(gb.bytes(0)).toBe('0 B');
    expect(gb.bytes(-5)).toBe('0 B');
    expect(gb.bytes(Number.NaN)).toBe('0 B');
    expect(gb.bytes(512)).toBe('512 B');
    expect(gb.bytes(1500)).toBe('1.5 kB');
    expect(gb.bytes(2_000_000)).toBe('2 MB');
    expect(gb.bytes(3_500_000_000)).toMatch(/GB$/);
  });

  it('groups integer quantities', () => {
    expect(gb.quantity(12500)).toBe('12,500');
  });

  it('trims gauge decimals and appends the unit', () => {
    expect(gb.measure(399.999, 'g')).toBe('400g');
    expect(gb.measure(45.5, 'ml')).toBe('45.5ml');
  });

  it('formats a UNIX-ms instant as a short date', () => {
    // Midday UTC so no machine timezone offset can shift the rendered day.
    expect(gb.date(Date.UTC(2026, 5, 28, 12))).toBe('28 Jun 2026');
  });

  it('formats a UNIX-ms instant as a date and time (TZ-independent assertion)', () => {
    // Time-of-day is machine-TZ-dependent, so assert the date part is present.
    const out = gb.dateTime(Date.UTC(2026, 5, 28, 12));
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/Jun/);
  });
});

describe('makeFormatters — locale & currency propagation (§3)', () => {
  it('honours a non-default currency', () => {
    const usd = makeFormatters('en-US', 'USD');
    expect(usd.currency(1234.5)).toBe('$1,234.50');
  });

  it('honours a non-default locale for currency grouping/symbol placement', () => {
    // de-DE groups with a dot, has a comma decimal and trails the currency symbol.
    // (Intl separates value and symbol with a narrow no-break space, so assert the
    // pieces structurally rather than the exact whitespace.)
    const out = makeFormatters('de-DE', 'EUR').currency(1234.5);
    expect(out.startsWith('1.234,50')).toBe(true);
    expect(out).toContain('€'); // €
  });

  it('honours the locale for number grouping', () => {
    const de = makeFormatters('de-DE', 'EUR');
    expect(de.quantity(12500)).toBe('12.500');
  });

  it('honours the locale for dates', () => {
    const us = makeFormatters('en-US', 'USD');
    expect(us.date(Date.UTC(2026, 5, 28, 12))).toBe('Jun 28, 2026');
  });
});
