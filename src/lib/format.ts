/**
 * Locale-aware formatting via native Intl (spec §2.4.3 — no third-party libs).
 *
 * `makeFormatters(locale, currency)` is the single pure factory: it builds a bundle
 * of formatters bound to one locale + base currency. The defaults are the locked
 * GBP / en-GB (§1.2.1); the user-configurable values live in `usePreferencesStore`
 * and are wired in via the `useFormatters()` hook so every call site honours the
 * chosen currency and locale end-to-end (§3).
 */

/** The locked default locale (§1.2.1) — also the fallback for non-reactive callers. */
export const DEFAULT_LOCALE = 'en-GB';
/** The locked default base currency (§1.2.1). */
export const DEFAULT_CURRENCY = 'GBP';

const SI_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'] as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A bundle of locale/currency-bound formatters (all pure, all native `Intl`). */
export interface Formatters {
  /**
   * Money in the configured base currency (e.g. `£1,234.50`); `—` for non-finite.
   *
   * Pass `currencyOverride` (an ISO-4217 code) to render `value` with *that* currency's
   * own symbol instead — e.g. `currency(1.23, 'EUR')` → `€1.23`, `currency(1, 'USD')`
   * → `US$1.00`. This is presentation only (no FX conversion): the number is shown
   * verbatim under the correct symbol, which is what a per-supplier stored currency
   * needs. A malformed code (not three ASCII letters) that `Intl` rejects falls back to
   * the base symbol with the raw code appended (`£1.23 ZZ`) so nothing is silently
   * dropped. (An unrecognised *well-formed* code like `XBT` is accepted by `Intl` and
   * simply renders with the code itself as the symbol.)
   */
  currency(value: number, currencyOverride?: string): string;
  /**
   * The same money value as {@link Formatters.currency}, but broken into its
   * {@link Intl.NumberFormatPart}s so a caller can style the pieces independently — most
   * notably tinting the `currency`-type part (the symbol/code) apart from the digits (the
   * Foundry `Money` control). Returns `null` for a non-finite value (the caller renders its
   * own placeholder). `currencyOverride` behaves exactly as it does for `currency`, malformed
   * fallback included (the trailing raw code arrives as a `literal` part).
   */
  currencyParts(value: number, currencyOverride?: string): Intl.NumberFormatPart[] | null;
  /** A 0..1 ratio as a percentage, clamped (e.g. `50%`). */
  percent(ratio: number, maximumFractionDigits?: number): string;
  /** A human-readable SI byte size (e.g. `1.5 kB`). */
  bytes(bytes: number): string;
  /** An integer quantity with locale grouping (e.g. `12,500`). */
  quantity(value: number): string;
  /** A gauge value (decimals trimmed) with its unit appended (e.g. `400g`). */
  measure(value: number, unit: string): string;
  /** A UNIX-ms instant as a short date (e.g. `28 Jun 2026`). */
  date(ms: number): string;
  /** A UNIX-ms instant as a date *and* time (e.g. `28 Jun 2026, 14:30`). */
  dateTime(ms: number): string;
}

/**
 * Build a {@link Formatters} bundle bound to `locale` and base `currency`. Pure and
 * memo-friendly (the heavyweight `Intl.*Format` objects are created once per call),
 * so the React layer caches one bundle per `[locale, currency]` via `useFormatters`.
 */
export function makeFormatters(
  locale: string = DEFAULT_LOCALE,
  currency: string = DEFAULT_CURRENCY,
): Formatters {
  const number = new Intl.NumberFormat(locale);
  const currencyFormat = new Intl.NumberFormat(locale, { style: 'currency', currency });
  // Per-currency formatters are built lazily and memoised (they are heavyweight), so a
  // table of parts in several currencies pays the construction cost once per code.
  const currencyFormatters = new Map<string, Intl.NumberFormat>([[currency, currencyFormat]]);
  /** An `Intl` currency formatter for `code`, or `null` if the code is not valid ISO-4217. */
  const currencyFormatterFor = (code: string): Intl.NumberFormat | null => {
    const cached = currencyFormatters.get(code);
    if (cached) return cached;
    try {
      const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency: code });
      currencyFormatters.set(code, fmt);
      return fmt;
    } catch {
      return null;
    }
  };
  /**
   * The single source of truth for money formatting — resolves the override/fallback rules
   * once and returns the `Intl` parts (or `null` for a non-finite value). Both the string
   * `currency` formatter and the structured `currencyParts` delegate here, so the two can
   * never disagree.
   */
  const computeCurrencyParts = (value: number, currencyOverride?: string): Intl.NumberFormatPart[] | null => {
    if (!Number.isFinite(value)) return null;
    const code = currencyOverride?.trim().toUpperCase();
    if (code && code !== currency) {
      const fmt = currencyFormatterFor(code);
      if (fmt) return fmt.formatToParts(value);
      // Malformed/unformattable code: keep the number legible under the base symbol and
      // append the raw code (as a literal part) so its provenance is never lost.
      return [...currencyFormat.formatToParts(value), { type: 'literal', value: ` ${code}` }];
    }
    return currencyFormat.formatToParts(value);
  };
  const dateFormat = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const dateTimeFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return {
    currency(value, currencyOverride) {
      const parts = computeCurrencyParts(value, currencyOverride);
      return parts ? parts.map((p) => p.value).join('') : '—';
    },
    currencyParts(value, currencyOverride) {
      return computeCurrencyParts(value, currencyOverride);
    },
    percent(ratio, maximumFractionDigits = 0) {
      return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits }).format(
        clamp01(ratio),
      );
    },
    bytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const index = Math.min(SI_UNITS.length - 1, Math.floor(Math.log10(bytes) / 3));
      const value = bytes / 1000 ** index;
      const formatted = new Intl.NumberFormat(locale, {
        maximumFractionDigits: value < 10 ? 1 : 0,
      }).format(value);
      return `${formatted} ${SI_UNITS[index] ?? 'B'}`;
    },
    quantity(value) {
      return number.format(value);
    },
    measure(value, unit) {
      const rounded = Math.round(value * 100) / 100;
      return `${number.format(rounded)}${unit}`;
    },
    date(ms) {
      return dateFormat.format(new Date(ms));
    },
    dateTime(ms) {
      return dateTimeFormat.format(new Date(ms));
    },
  };
}
