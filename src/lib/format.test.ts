import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  decimalSeparatorForLocale,
  makeFormatters,
  snapMoneyInput,
} from './format';

const gb = makeFormatters(); // en-GB / GBP defaults (§1.2.1)

describe('decimalSeparatorForLocale', () => {
  it('returns a dot for English locales', () => {
    expect(decimalSeparatorForLocale('en-GB')).toBe('.');
    expect(decimalSeparatorForLocale('en-US')).toBe('.');
  });

  it('returns a comma for eurozone / comma-decimal locales', () => {
    expect(decimalSeparatorForLocale('de-DE')).toBe(',');
    expect(decimalSeparatorForLocale('fr-FR')).toBe(',');
  });

  it('defaults to the app locale, and falls back to a dot for a bad locale', () => {
    expect(decimalSeparatorForLocale()).toBe('.'); // DEFAULT_LOCALE is en-GB
    expect(decimalSeparatorForLocale('not-a-locale!!')).toBe('.');
  });
});

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

  it('renders a canonical gram weight in the bundle weight unit', () => {
    // Default bundle is grams — the stored value shows verbatim.
    expect(gb.weight(250)).toBe('250 g');
    // A kg-unit bundle re-expresses the same stored grams (no conversion of the stored value).
    expect(makeFormatters('en-GB', 'GBP', 'kg').weight(1250)).toBe('1.25 kg');
    expect(gb.weight(Number.NaN)).toBe('—');
  });

  it('renders a canonical millimetre dimension in the bundle dimension unit', () => {
    // Default bundle is millimetres — the stored value shows verbatim.
    expect(gb.dimension(250)).toBe('250 mm');
    // A metre-unit bundle re-expresses the same stored mm (no conversion of the stored value).
    expect(makeFormatters('en-GB', 'GBP', 'g', 'm').dimension(1250)).toBe('1.25 m');
    expect(gb.dimension(Number.NaN)).toBe('—');
  });

  it('renders a canonical cubic-millimetre volume, honouring a forced unit for pairs', () => {
    // Default volumeUnit is 'auto' → a 12.5 L drawer resolves to litres.
    expect(gb.volume(12_500_000)).toBe('12.5 L');
    expect(gb.volume(Number.NaN)).toBe('—');
    // A forced unit keeps a related pair in one unit (so "used of capacity" never mixes scales).
    expect(gb.volumeUnitFor(30_000_000)).toBe('l');
    expect(gb.volume(12_000, 'l')).toBe('0.01 L'); // would auto-resolve to cm³ without the force
  });

  it('formats a UNIX-ms instant as a short date', () => {
    // Midday UTC so no machine timezone offset can shift the rendered day.
    expect(gb.date(Date.UTC(2026, 5, 28, 12))).toBe('28 Jun 2026');
  });

  it('formats a day-grained (midnight-UTC) value as its calendar day in every timezone', () => {
    // The value a date input stores for "28 Jun": midnight UTC. `date()` would slip this to
    // "27 Jun" west of UTC (all of the Americas); `calendarDate()` must render "28 Jun"
    // regardless of the host zone, which is the whole point of issue #318.
    expect(gb.calendarDate(Date.UTC(2026, 5, 28))).toBe('28 Jun 2026');
    expect(us.calendarDate(Date.UTC(2026, 5, 28))).toBe('Jun 28, 2026');
  });

  it('formats a UNIX-ms instant as a date and time (TZ-independent assertion)', () => {
    // Time-of-day is machine-TZ-dependent, so assert the date part is present.
    const out = gb.dateTime(Date.UTC(2026, 5, 28, 12));
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/Jun/);
  });

  describe('relativeTime (now injected for determinism)', () => {
    // A fixed reference instant so the chosen unit and phrasing never depend on the clock.
    const NOW = Date.UTC(2026, 5, 28, 12);
    const ago = (ms: number) => NOW - ms;
    const hence = (ms: number) => NOW + ms;
    const SEC = 1000;
    const MIN = 60 * SEC;
    const HOUR = 60 * MIN;
    const DAY = 24 * HOUR;

    it('reads "now" for the current instant', () => {
      expect(gb.relativeTime(NOW, NOW)).toBe('now');
    });

    it('reduces a past instant to the coarsest unit, phrased "… ago"', () => {
      expect(gb.relativeTime(ago(45 * SEC), NOW)).toBe('45 seconds ago');
      expect(gb.relativeTime(ago(5 * MIN), NOW)).toBe('5 minutes ago');
      expect(gb.relativeTime(ago(3 * HOUR), NOW)).toBe('3 hours ago');
      expect(gb.relativeTime(ago(3 * DAY), NOW)).toBe('3 days ago');
    });

    it('phrases a future instant as "in …"', () => {
      expect(gb.relativeTime(hence(2 * HOUR), NOW)).toBe('in 2 hours');
      expect(gb.relativeTime(hence(3 * DAY), NOW)).toBe('in 3 days');
    });

    it('uses idiomatic phrasing where the locale has it (numeric: auto)', () => {
      expect(gb.relativeTime(ago(1 * DAY), NOW)).toBe('yesterday');
      expect(gb.relativeTime(hence(1 * DAY), NOW)).toBe('tomorrow');
    });

    it('escalates to weeks/months/years for larger gaps', () => {
      expect(gb.relativeTime(ago(14 * DAY), NOW)).toBe('2 weeks ago');
      expect(gb.relativeTime(ago(60 * DAY), NOW)).toBe('2 months ago');
      expect(gb.relativeTime(ago(400 * DAY), NOW)).toBe('last year');
    });

    it('returns a dash for a non-finite instant', () => {
      expect(gb.relativeTime(Number.NaN, NOW)).toBe('—');
    });
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

describe('currencyFractionDigits', () => {
  it('reports the digit count for the base currency', () => {
    expect(gb.currencyFractionDigits()).toBe(2); // GBP
    expect(makeFormatters('ja-JP', 'JPY').currencyFractionDigits()).toBe(0);
    expect(makeFormatters('ar-BH', 'BHD').currencyFractionDigits()).toBe(3);
  });

  it('reports the override currency’s digit count, ignoring the base', () => {
    // A yen amount stored against a GBP-base bundle still snaps to 0 decimals.
    expect(gb.currencyFractionDigits('JPY')).toBe(0);
    expect(gb.currencyFractionDigits('bhd')).toBe(3); // case-insensitive
  });

  it('falls back to the base currency for a malformed override', () => {
    expect(gb.currencyFractionDigits('not-a-code')).toBe(2);
  });
});

describe('snapMoneyInput', () => {
  it('pads to the currency’s fraction digits', () => {
    expect(snapMoneyInput('8', 2)).toBe('8.00');
    expect(snapMoneyInput('8.5', 2)).toBe('8.50');
    expect(snapMoneyInput('8', 0)).toBe('8'); // JPY
    expect(snapMoneyInput('8', 3)).toBe('8.000'); // BHD
  });

  it('is lossless: pads up but never rounds away typed precision', () => {
    // More decimals than the currency writes are kept verbatim — the snap must not change the
    // number (issue #290). Rounding to a currency's scale is the money seam's job, not the field's.
    expect(snapMoneyInput('8.005', 2)).toBe('8.005');
    expect(snapMoneyInput('8.994', 2)).toBe('8.994');
    // The issue's two data-loss cases: a fractional JPY figure (0 digits) and a 4-decimal GBP
    // unit cost (2 digits) both survive tabbing through the field.
    expect(snapMoneyInput('1234.56', 0)).toBe('1234.56'); // JPY base, was → '1235'
    expect(snapMoneyInput('0.0125', 2)).toBe('0.0125'); // GBP unit cost, was → '0.01'
  });

  it('leaves a blank value blank (the field is optional)', () => {
    expect(snapMoneyInput('', 2)).toBe('');
    expect(snapMoneyInput('   ', 2)).toBe('');
  });

  it('returns non-numeric text unchanged rather than destroying it', () => {
    expect(snapMoneyInput('abc', 2)).toBe('abc');
    expect(snapMoneyInput('1,2,3', 2)).toBe('1,2,3');
  });
});
