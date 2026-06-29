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
