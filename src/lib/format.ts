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
  /** Money in the configured base currency (e.g. `£1,234.50`); `—` for non-finite. */
  currency(value: number): string;
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
    currency(value) {
      if (!Number.isFinite(value)) return '—';
      return currencyFormat.format(value);
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
