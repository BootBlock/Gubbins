/**
 * Locale-aware formatting via native Intl (spec §2.4.3 — no third-party libs).
 *
 * `makeFormatters(locale, currency)` is the single pure factory: it builds a bundle
 * of formatters bound to one locale + base currency. The defaults are the locked
 * GBP / en-GB (§1.2.1); the user-configurable values live in `usePreferencesStore`
 * and are wired in via the `useFormatters()` hook so every call site honours the
 * chosen currency and locale end-to-end (§3).
 */
import { moneyDecimals } from './money';
import { formatWeight, type WeightUnit } from './weight';
import { formatDimension, type DimensionUnit } from './dimensions';
import {
  DEFAULT_VOLUME_UNIT,
  formatVolume,
  resolveVolumeUnit,
  type VolumeUnit,
  type VolumeUnitPreference,
} from './volume';
import { nowMs } from './clock';

/** The locked default locale (§1.2.1) — also the fallback for non-reactive callers. */
export const DEFAULT_LOCALE = 'en-GB';
/** The locked default base currency (§1.2.1). */
export const DEFAULT_CURRENCY = 'GBP';

/**
 * Popular currencies offered by the app-wide currency picker (§1.2.1 GBP default, §3).
 * A pragmatic subset of widely-used ISO-4217 codes — broad enough to cover most users
 * without turning the picker into an exhaustive registry. Each entry carries a short
 * English name so the longer list stays scannable. `GBP` stays first as the locked
 * default. Every code here must be representable by {@link Intl.NumberFormat}.
 *
 * This is the single source of truth for the offered currencies: the `CurrencySelect` /
 * `CurrencyAutocompleteField` Foundry primitives render it, and `guessBaseCurrency` maps a
 * browser region onto one of these codes.
 */
export const CURRENCY_OPTIONS = [
  { value: 'GBP', label: 'British Pound' },
  { value: 'USD', label: 'US Dollar' },
  { value: 'EUR', label: 'Euro' },
  { value: 'AUD', label: 'Australian Dollar' },
  { value: 'CAD', label: 'Canadian Dollar' },
  { value: 'JPY', label: 'Japanese Yen' },
  { value: 'CHF', label: 'Swiss Franc' },
  { value: 'CNY', label: 'Chinese Yuan' },
  { value: 'INR', label: 'Indian Rupee' },
  { value: 'NZD', label: 'New Zealand Dollar' },
  { value: 'SEK', label: 'Swedish Krona' },
  { value: 'NOK', label: 'Norwegian Krone' },
  { value: 'DKK', label: 'Danish Krone' },
  { value: 'PLN', label: 'Polish Zloty' },
  { value: 'SGD', label: 'Singapore Dollar' },
  { value: 'HKD', label: 'Hong Kong Dollar' },
  { value: 'ZAR', label: 'South African Rand' },
  { value: 'MXN', label: 'Mexican Peso' },
  { value: 'BRL', label: 'Brazilian Real' },
  { value: 'AED', label: 'UAE Dirham' },
  { value: 'KRW', label: 'South Korean Won' },
] as const satisfies readonly { value: string; label: string }[];

/**
 * The character a locale uses as its **decimal separator** — `.` for en-GB / en-US,
 * `,` for de-DE / fr-FR and most of the eurozone. Derived from a live `Intl.NumberFormat`
 * (so it needs no hand-maintained table and stays correct as the platform's CLDR data
 * evolves); an unknown or malformed locale falls back to `.`. Pure and injectable — pass a
 * locale explicitly in tests. Callers that parse *user-entered* numbers (e.g. a pasted
 * invoice price) use this to interpret `,` vs `.` the way the user's own locale writes them.
 */
export function decimalSeparatorForLocale(locale: string = DEFAULT_LOCALE): string {
  try {
    const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === 'decimal');
    return decimal?.value ?? '.';
  } catch {
    return '.';
  }
}

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
  /**
   * How many fraction digits this currency is written with — `2` for GBP/USD/EUR, `0` for
   * JPY, `3` for BHD — derived from the live `Intl` currency data (no hand-maintained table).
   * `currencyOverride` behaves as it does for {@link Formatters.currency}: a valid ISO-4217
   * code reports *that* currency's digits, a malformed one falls back to the base currency.
   * Used to snap a user-entered price to the right number of decimals on blur (`8` → `8.00`).
   */
  currencyFractionDigits(currencyOverride?: string): number;
  /** A 0..1 ratio as a percentage, clamped (e.g. `50%`). */
  percent(ratio: number, maximumFractionDigits?: number): string;
  /** A human-readable SI byte size (e.g. `1.5 kB`). */
  bytes(bytes: number): string;
  /** An integer quantity with locale grouping (e.g. `12,500`). */
  quantity(value: number): string;
  /** A gauge value (decimals trimmed) with its unit appended (e.g. `400g`). */
  measure(value: number, unit: string): string;
  /**
   * A canonical **gram** weight rendered in the user's chosen weight unit (e.g. `1.25 kg`);
   * `—` for a non-finite value. The unit is the Tier-2 `weightUnit` preference this bundle was
   * built with — the stored grams are unchanged, only the presentation. See `lib/weight.ts`.
   */
  weight(grams: number): string;
  /**
   * A canonical **millimetre** dimension rendered in the user's chosen dimension unit (e.g.
   * `1.25 m`); `—` for a non-finite value. The unit is the Tier-2 `dimensionUnit` preference
   * this bundle was built with — the stored mm are unchanged, only the presentation. See
   * `lib/dimensions.ts`.
   */
  dimension(mm: number): string;
  /**
   * A canonical **cubic-millimetre** volume rendered in the user's chosen `volumeUnit` (e.g.
   * `12.5 L`); `—` for a non-finite value. When the preference is `'auto'` a readable unit is
   * picked *per value* from the `dimensionUnit` this bundle was built with (metric →
   * cm³/litres/m³, imperial → in³/ft³), so a drawer never renders as `0.0000027 m³`. The stored
   * mm³ are unchanged, only the presentation. See `lib/volume.ts`.
   *
   * Pass an explicit `unit` to force that unit instead of resolving one — used to render a pair
   * of volumes (e.g. `used of capacity`) in a **single** unit so they read consistently, rather
   * than each auto-resolving its own (which could yield "12 mL of 30 L"). Get the unit for the
   * reference value from {@link Formatters.volumeUnitFor}.
   */
  volume(mm3: number, unit?: VolumeUnit): string;
  /**
   * The volume unit {@link Formatters.volume} would resolve for `mm3` under the current
   * `volumeUnit`/`dimensionUnit` preferences — so a caller can format several related volumes in
   * one consistent unit (see the `unit` param above).
   */
  volumeUnitFor(mm3: number): VolumeUnit;
  /** A UNIX-ms instant as a short date (e.g. `28 Jun 2026`). */
  date(ms: number): string;
  /** A UNIX-ms instant as a date *and* time (e.g. `28 Jun 2026, 14:30`). */
  dateTime(ms: number): string;
  /**
   * A UNIX-ms instant as a locale-aware *relative* time versus now (e.g. `3 days ago`,
   * `in 2 hours`, `yesterday`, `now`). The coarsest sensible unit is chosen automatically
   * (seconds → minutes → … → years); a past instant reads "… ago", a future one "in …".
   * `—` for a non-finite `ms`. `now` is injectable (defaults to `nowMs()`) so the choice
   * of unit is deterministic in tests.
   */
  relativeTime(ms: number, now?: number): string;
}

/**
 * Descending unit cascade for {@link Formatters.relativeTime}: each step's `amount` is how
 * many of the *current* unit make up the *next* one, so a signed second-count can be reduced
 * to the coarsest unit whose magnitude is below its own ceiling. `week`'s 4.34524 is the mean
 * weeks-per-month; the terminal `year` has an infinite ceiling so the loop always resolves.
 */
const RELATIVE_DIVISIONS: readonly { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

/**
 * Build a {@link Formatters} bundle bound to `locale` and base `currency`. Pure and
 * memo-friendly (the heavyweight `Intl.*Format` objects are created once per call),
 * so the React layer caches one bundle per `[locale, currency]` via `useFormatters`.
 */
export function makeFormatters(
  locale: string = DEFAULT_LOCALE,
  currency: string = DEFAULT_CURRENCY,
  weightUnit: WeightUnit = 'g',
  dimensionUnit: DimensionUnit = 'mm',
  volumeUnit: VolumeUnitPreference = DEFAULT_VOLUME_UNIT,
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
  // `numeric: 'auto'` prefers idiomatic phrasing where the locale has one ("yesterday",
  // "last week") over the plain "1 … ago", and yields "now" for a zero offset.
  const relativeTimeFormat = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  // `percent` and `bytes` vary only by `maximumFractionDigits`, so memoise the
  // (heavyweight) `Intl.NumberFormat` per digit-count rather than rebuilding one on
  // every call — these run in list rows (dashboard widgets, ABC breakdown, storage).
  const percentFormatters = new Map<number, Intl.NumberFormat>();
  const percentFormatterFor = (maximumFractionDigits: number): Intl.NumberFormat => {
    const cached = percentFormatters.get(maximumFractionDigits);
    if (cached) return cached;
    const fmt = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits });
    percentFormatters.set(maximumFractionDigits, fmt);
    return fmt;
  };
  const byteFormatters = new Map<number, Intl.NumberFormat>();
  const byteFormatterFor = (maximumFractionDigits: number): Intl.NumberFormat => {
    const cached = byteFormatters.get(maximumFractionDigits);
    if (cached) return cached;
    const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits });
    byteFormatters.set(maximumFractionDigits, fmt);
    return fmt;
  };

  return {
    currency(value, currencyOverride) {
      const parts = computeCurrencyParts(value, currencyOverride);
      return parts ? parts.map((p) => p.value).join('') : '—';
    },
    currencyParts(value, currencyOverride) {
      return computeCurrencyParts(value, currencyOverride);
    },
    currencyFractionDigits(currencyOverride) {
      const code = currencyOverride?.trim().toUpperCase();
      // Delegated to the money seam so the scale a figure is *rounded* to and the scale it is
      // *rendered* at come from one lookup — two implementations of this is what issue #292 was
      // (a formatter that knew about the yen beside arithmetic that did not). An override `Intl`
      // cannot format falls back to the base currency, exactly as `currency()` falls back to the
      // base symbol.
      const usable = !!code && code !== currency && currencyFormatterFor(code) !== null;
      return moneyDecimals(usable ? code : currency);
    },
    percent(ratio, maximumFractionDigits = 0) {
      return percentFormatterFor(maximumFractionDigits).format(clamp01(ratio));
    },
    bytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const index = Math.min(SI_UNITS.length - 1, Math.floor(Math.log10(bytes) / 3));
      const value = bytes / 1000 ** index;
      const formatted = byteFormatterFor(value < 10 ? 1 : 0).format(value);
      return `${formatted} ${SI_UNITS[index] ?? 'B'}`;
    },
    quantity(value) {
      return number.format(value);
    },
    measure(value, unit) {
      const rounded = Math.round(value * 100) / 100;
      return `${number.format(rounded)}${unit}`;
    },
    weight(grams) {
      return formatWeight(grams, weightUnit, locale);
    },
    dimension(mm) {
      return formatDimension(mm, dimensionUnit, locale);
    },
    volume(mm3, unit) {
      // `'auto'` resolves per value (a drawer → litres/in³, a bay → m³/ft³); a fixed preference —
      // or an explicit `unit` argument — is used as-is. A non-finite value falls through to
      // `formatVolume`'s `—`.
      return formatVolume(mm3, unit ?? resolveVolumeUnit(volumeUnit, mm3, dimensionUnit), locale);
    },
    volumeUnitFor(mm3) {
      return resolveVolumeUnit(volumeUnit, mm3, dimensionUnit);
    },
    date(ms) {
      return dateFormat.format(new Date(ms));
    },
    dateTime(ms) {
      return dateTimeFormat.format(new Date(ms));
    },
    relativeTime(ms, now = nowMs()) {
      if (!Number.isFinite(ms)) return '—';
      // Signed seconds from now; reduce through the cascade to the coarsest unit whose
      // magnitude is still below its ceiling, then let `Intl` phrase it (sign → ago/in).
      let duration = (ms - now) / 1000;
      for (const { amount, unit } of RELATIVE_DIVISIONS) {
        if (Math.abs(duration) < amount) return relativeTimeFormat.format(Math.round(duration), unit);
        duration /= amount;
      }
      // Unreachable — the terminal division's ceiling is Infinity — but keep total.
      return relativeTimeFormat.format(Math.round(duration), 'year');
    },
  };
}

/**
 * Process-wide cache of {@link Formatters} bundles keyed by `locale|currency|weightUnit|dimensionUnit|volumeUnit`. Every
 * component formats through {@link useFormatters}, which memoises per component; this
 * shared cache goes one further and lets *all* of them reuse a single bundle (and its
 * heavyweight `Intl.*Format` objects) per preference pair, instead of one bundle per
 * component. The set of `[locale, currency]` pairs a running app sees is tiny (it only
 * changes when the user edits a preference), so the map never grows unbounded. The
 * bundle is immutable — its internal maps are memoisation only — so sharing is safe.
 */
const formattersCache = new Map<string, Formatters>();

/**
 * A shared {@link Formatters} bundle for `locale`/`currency`/`weightUnit`/`dimensionUnit`, built
 * once and reused.
 */
export function getFormatters(
  locale: string = DEFAULT_LOCALE,
  currency: string = DEFAULT_CURRENCY,
  weightUnit: WeightUnit = 'g',
  dimensionUnit: DimensionUnit = 'mm',
  volumeUnit: VolumeUnitPreference = DEFAULT_VOLUME_UNIT,
): Formatters {
  const key = `${locale}|${currency}|${weightUnit}|${dimensionUnit}|${volumeUnit}`;
  const cached = formattersCache.get(key);
  if (cached) return cached;
  const bundle = makeFormatters(locale, currency, weightUnit, dimensionUnit, volumeUnit);
  formattersCache.set(key, bundle);
  return bundle;
}

/**
 * Snap a user-entered monetary string to at least the number of fraction digits its currency
 * uses (`fractionDigits` from {@link Formatters.currencyFractionDigits}): `8` → `8.00` for a
 * 2-digit currency, `8` for a 0-digit one (JPY), `8.000` for a 3-digit one (BHD). A blank
 * value stays blank — the field is optional — and anything that isn't a finite number is
 * returned unchanged so an in-progress edit is never clobbered.
 *
 * The snap is **presentation only and lossless**: it *pads* up to the currency's canonical
 * precision but never *rounds away* precision the user actually typed, so the number is
 * unchanged. A stored `1234.56` under JPY (0 digits) stays `1234.56`, and a legitimately
 * 4-decimal `0.0125` unit cost under GBP (2 digits) stays `0.0125` — rounding a figure to its
 * currency's scale is the money seam's job at compute/display time ({@link roundMoney}), not a
 * side effect of tabbing through the field.
 *
 * The input is `.`-separated — an `<input type="number">` normalises to a period decimal
 * regardless of the user's locale — so `.` parsing here is correct; the result is likewise
 * `.`-separated, exactly what the input expects for its value.
 */
export function snapMoneyInput(raw: string, fractionDigits: number): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return raw;
  // Never below what was typed: a period-decimal `type=number` value carries its precision in
  // the digits after the point, so padding to `max(currency digits, entered digits)` keeps the
  // exact same number while still reaching the currency's canonical scale for shorter entries.
  const dot = trimmed.indexOf('.');
  const enteredDigits = dot === -1 ? 0 : trimmed.length - dot - 1;
  // `toFixed` only accepts 0–100 digits; clamp so a pasted over-long decimal can't throw (a
  // double can't hold that precision anyway, and the round-trip guard below keeps it honest).
  const digits = Math.min(100, Math.max(0, fractionDigits, enteredDigits));
  const snapped = value.toFixed(digits);
  // Belt-and-braces: if the snapped string somehow represents a different number than what was
  // entered (e.g. exponent notation the digit count above can't see), keep the entry untouched
  // rather than silently rounding it.
  return Number(snapped) === value ? snapped : trimmed;
}
