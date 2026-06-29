/**
 * Settings domain — pure helpers & option sets (spec §3 preferences, §2.1 Tier 2).
 *
 * Side-effect-free so the Settings screen, the lifecycle widgets and the Storage
 * Triage dialog all share one validated source of truth for the user-configurable
 * windows, and so the bounds/clamping logic is unit-tested in isolation. The values
 * themselves live in `usePreferencesStore` (Tier-2, localStorage-persisted).
 */
import type { Theme } from '@/state/stores/usePreferencesStore';
import {
  BUDGET_WARN_PERCENT,
  EXPIRY_SOON_WINDOW_DAYS,
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
} from '@/db/repositories/constants';
import { DEFAULT_CURRENCY } from '@/lib/format';

/**
 * Popular base currencies offered by the Settings control (§1.2.1 GBP default, §3).
 * A pragmatic subset of widely-used ISO-4217 codes — broad enough to cover most
 * users without turning the picker into an exhaustive registry. Each entry carries
 * a short English name so the longer list stays scannable. `GBP` stays first as the
 * locked default. Every code here must be representable by {@link Intl.NumberFormat}.
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
 * Map of ISO 3166 region → an offered {@link CURRENCY_OPTIONS} code, used to make a
 * best-effort first-run currency guess from the browser locale (§3). Only regions
 * whose currency we actually offer appear here; anything else falls back to the
 * locked {@link DEFAULT_CURRENCY}. Eurozone members all map to `EUR`.
 */
const REGION_CURRENCY: Readonly<Record<string, string>> = {
  GB: 'GBP', IM: 'GBP', JE: 'GBP', GG: 'GBP',
  US: 'USD',
  // Eurozone members.
  AT: 'EUR', BE: 'EUR', CY: 'EUR', DE: 'EUR', EE: 'EUR', ES: 'EUR', FI: 'EUR',
  FR: 'EUR', GR: 'EUR', IE: 'EUR', IT: 'EUR', LT: 'EUR', LU: 'EUR', LV: 'EUR',
  MT: 'EUR', NL: 'EUR', PT: 'EUR', SI: 'EUR', SK: 'EUR', HR: 'EUR',
  AU: 'AUD',
  CA: 'CAD',
  JP: 'JPY',
  CH: 'CHF', LI: 'CHF',
  CN: 'CNY',
  IN: 'INR',
  NZ: 'NZD',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  PL: 'PLN',
  SG: 'SGD',
  HK: 'HKD',
  ZA: 'ZAR',
  MX: 'MXN',
  BR: 'BRL',
  AE: 'AED',
  KR: 'KRW',
};

/** Resolve a BCP-47 locale tag to its (maximized) ISO region, e.g. `en-US` → `US`. */
function regionOf(locale: string): string | undefined {
  try {
    const loc = new Intl.Locale(locale);
    const region = (loc.maximize().region ?? loc.region)?.toUpperCase();
    return region || undefined;
  } catch {
    return undefined;
  }
}

/** The host's preferred locales, most-preferred first; `[]` when there is no DOM. */
function readNavigatorLocales(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  const langs = navigator.languages;
  if (Array.isArray(langs) && langs.length > 0) return langs;
  return navigator.language ? [navigator.language] : [];
}

/**
 * Best-effort first-run guess of the user's base currency from their browser locale
 * (§1.2.1, §3). Pure and injectable — pass `locales` explicitly in tests; by default
 * it reads the host's `navigator.languages` (falling back to `navigator.language`).
 * Each locale's region is resolved and mapped through {@link REGION_CURRENCY},
 * taking the first match; anything unknown falls back to the locked
 * {@link DEFAULT_CURRENCY} (GBP). Never throws.
 */
export function guessBaseCurrency(
  locales: readonly string[] = readNavigatorLocales(),
): string {
  for (const locale of locales) {
    const region = regionOf(locale);
    const currency = region ? REGION_CURRENCY[region] : undefined;
    if (currency) return currency;
  }
  return DEFAULT_CURRENCY;
}

/** Theme choices for the Settings control — Dark/Light/System (spec §2.1). */
export const THEME_OPTIONS = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
] as const satisfies readonly { value: Theme; label: string }[];

/**
 * Inclusive bounds (days) for the user-set "expiring soon" window (§3, §4
 * Perishables). Lifts the former hard-coded {@link EXPIRY_SOON_WINDOW_DAYS}
 * constant into a configurable preference while keeping it sane.
 */
export const EXPIRY_WINDOW_BOUNDS = { min: 1, max: 365 } as const;

/**
 * Clamp an expiry-window day count to a safe integer within
 * {@link EXPIRY_WINDOW_BOUNDS}. Non-finite input falls back to the default window.
 */
export function clampExpiryWindowDays(value: number): number {
  if (!Number.isFinite(value)) return EXPIRY_SOON_WINDOW_DAYS;
  return Math.min(EXPIRY_WINDOW_BOUNDS.max, Math.max(EXPIRY_WINDOW_BOUNDS.min, Math.round(value)));
}

/**
 * Inclusive bounds for the user-set low-stock thresholds (§3 "Low Stock Alerts",
 * §4). They lift the fixed {@link LOW_STOCK_QTY_THRESHOLD} /
 * {@link LOW_STOCK_GAUGE_PERCENT} constants (Phase 45) into configurable
 * preferences while keeping them sane: a DISCRETE quantity floor of at least 1
 * (a "low when ≤ 1" alert), and a gauge percentage strictly between 1 and 99 (0
 * would never fire; 100 would flag every gauge).
 */
export const LOW_STOCK_QTY_BOUNDS = { min: 1, max: 1000 } as const;
export const LOW_STOCK_GAUGE_BOUNDS = { min: 1, max: 99 } as const;

/**
 * Clamp a low-stock DISCRETE quantity threshold to {@link LOW_STOCK_QTY_BOUNDS}.
 * Non-finite input falls back to the default constant.
 */
export function clampLowStockQty(value: number): number {
  if (!Number.isFinite(value)) return LOW_STOCK_QTY_THRESHOLD;
  return Math.min(LOW_STOCK_QTY_BOUNDS.max, Math.max(LOW_STOCK_QTY_BOUNDS.min, Math.round(value)));
}

/**
 * Clamp a low-stock gauge percentage to {@link LOW_STOCK_GAUGE_BOUNDS}. Non-finite
 * input falls back to the default constant.
 */
export function clampLowStockGaugePercent(value: number): number {
  if (!Number.isFinite(value)) return LOW_STOCK_GAUGE_PERCENT;
  return Math.min(
    LOW_STOCK_GAUGE_BOUNDS.max,
    Math.max(LOW_STOCK_GAUGE_BOUNDS.min, Math.round(value)),
  );
}

/**
 * Inclusive bounds for the user-set project-budget warning threshold (§4 budgeting).
 * The indicator turns to a warning tone once spend reaches this percentage of the
 * budget; the floor of 1 keeps "warn from the first penny" possible, the ceiling of
 * 100 keeps "warn only once exceeded" possible — never a degenerate 0 or > 100.
 */
export const BUDGET_WARN_BOUNDS = { min: 1, max: 100 } as const;

/**
 * Clamp a project-budget warning percentage to {@link BUDGET_WARN_BOUNDS}. Non-finite
 * input falls back to the default constant.
 */
export function clampBudgetWarnPercent(value: number): number {
  if (!Number.isFinite(value)) return BUDGET_WARN_PERCENT;
  return Math.min(BUDGET_WARN_BOUNDS.max, Math.max(BUDGET_WARN_BOUNDS.min, Math.round(value)));
}

/**
 * Calendar-month windows offered by the prune/downgrade controls (§7.6.3). Shared
 * by the Settings screen and the Storage Triage dialog so both stay in lock-step.
 */
export const WINDOW_MONTH_OPTIONS = [3, 6, 12] as const;

/** The default prune/downgrade window when no preference is stored. */
export const DEFAULT_WINDOW_MONTHS = 6;

/** Coerce an arbitrary value to one of {@link WINDOW_MONTH_OPTIONS} (default 6). */
export function normaliseWindowMonths(value: number): number {
  return (WINDOW_MONTH_OPTIONS as readonly number[]).includes(value)
    ? value
    : DEFAULT_WINDOW_MONTHS;
}
