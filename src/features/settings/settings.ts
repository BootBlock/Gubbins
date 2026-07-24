/**
 * Settings domain — pure helpers & option sets (spec §3 preferences, §2.1 Tier 2).
 *
 * Side-effect-free so the Settings screen, the lifecycle widgets and the Storage
 * Triage dialog all share one validated source of truth for the user-configurable
 * windows, and so the bounds/clamping logic is unit-tested in isolation. The values
 * themselves live in `usePreferencesStore` (Tier-2, localStorage-persisted).
 */
import {
  BUDGET_WARN_PERCENT,
  EXPIRY_SOON_WINDOW_DAYS,
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
  MAX_PAGE_SIZE,
} from '@/db/repositories/constants';
import { CURRENCY_OPTIONS, DEFAULT_CURRENCY } from '@/lib/format';

/**
 * Re-exported for callers that reach the offered-currency list through the settings
 * domain. The list itself now lives in `@/lib/format` (its single source of truth), so the
 * {@link CurrencySelect} Foundry primitive can render it without importing a feature module.
 */
export { CURRENCY_OPTIONS };

/**
 * Map of ISO 3166 region → an offered {@link CURRENCY_OPTIONS} code, used to make a
 * best-effort first-run currency guess from the browser locale (§3). Only regions
 * whose currency we actually offer appear here; anything else falls back to the
 * locked {@link DEFAULT_CURRENCY}. Eurozone members all map to `EUR`.
 */
const REGION_CURRENCY: Readonly<Record<string, string>> = {
  GB: 'GBP',
  IM: 'GBP',
  JE: 'GBP',
  GG: 'GBP',
  US: 'USD',
  // Eurozone members.
  AT: 'EUR',
  BE: 'EUR',
  CY: 'EUR',
  DE: 'EUR',
  EE: 'EUR',
  ES: 'EUR',
  FI: 'EUR',
  FR: 'EUR',
  GR: 'EUR',
  IE: 'EUR',
  IT: 'EUR',
  LT: 'EUR',
  LU: 'EUR',
  LV: 'EUR',
  MT: 'EUR',
  NL: 'EUR',
  PT: 'EUR',
  SI: 'EUR',
  SK: 'EUR',
  HR: 'EUR',
  AU: 'AUD',
  CA: 'CAD',
  JP: 'JPY',
  CH: 'CHF',
  LI: 'CHF',
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
export function guessBaseCurrency(locales: readonly string[] = readNavigatorLocales()): string {
  for (const locale of locales) {
    const region = regionOf(locale);
    const currency = region ? REGION_CURRENCY[region] : undefined;
    if (currency) return currency;
  }
  return DEFAULT_CURRENCY;
}

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
 * {@link LOW_STOCK_GAUGE_PERCENT} constants (Phase 45) into configurable preferences
 * while keeping them sane.
 *
 * **The floor is 0 = off.** Low-stock alerts are opt-in: at 0 the blanket default
 * flags nothing, so items only alert once given their own reorder point (or the user
 * raises the blanket above 0). The quantity ceiling is a generous 1000; the gauge
 * percentage tops out at 99 (100 would flag every gauge).
 */
export const LOW_STOCK_QTY_BOUNDS = { min: 0, max: 1000 } as const;
export const LOW_STOCK_GAUGE_BOUNDS = { min: 0, max: 99 } as const;

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
  return Math.min(LOW_STOCK_GAUGE_BOUNDS.max, Math.max(LOW_STOCK_GAUGE_BOUNDS.min, Math.round(value)));
}

/**
 * The **dead-stock** idle-threshold bounds and clamp (issue #92) — how long stock must sit
 * unmoved before it is reported. Defined in the dependency-free constants module because
 * the repository layer clamps per-location overrides with them; re-exported here so UI call
 * sites reach for them alongside the other Tier-2 preference clamps.
 */
export { DEAD_STOCK_DAYS_BOUNDS, clampDeadStockDays } from '@/db/repositories/constants';

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

// Packing-efficiency bounds/clamp live in the shared volume domain (`lib/volume.ts`) so the same
// floor is enforced everywhere a packing factor is set or applied (issue #457). Re-exported here
// so Settings / the store keep importing them from the settings barrel.
export { DEFAULT_PACKING_FACTOR, PACKING_FACTOR_BOUNDS, clampPackingFactor } from '@/lib/volume';

/**
 * Which metric the Visual-mode item card shows in its hero slot for a plain DISCRETE
 * item (spec §3). The card's ± stepper already shows the on-hand quantity, so a big
 * repeated number there is redundant — this lets the user pick a genuinely useful
 * signal instead:
 * - `stockHealth` — a colour-coded reorder status (In stock / Low stock / Out of
 *   stock), derived from the item's reorder point. The actionable default.
 * - `value` — the item's total stock value (`unitCost × quantity`), via the Money control.
 * - `lastUpdated` — how long ago the item last changed, as a relative time (e.g. "3 days
 *   ago"), for spotting stale or freshly-touched stock at a glance.
 * - `condition` — the item's tracked condition (Mint / Good / …), tinted with its
 *   condition token, or "Untracked" when the item has no condition set.
 * - `manufacturer` — the item's manufacturer/brand, or a muted em-dash when unset.
 *
 * Gauge / serialised / untracked / unlimited cards are unaffected — their hero already
 * shows meaningful, non-duplicated content — so this preference only swaps the plain
 * discrete card's hero.
 */
export type VisualCardMetric = 'stockHealth' | 'value' | 'lastUpdated' | 'condition' | 'manufacturer';

/** The default Visual-card hero metric — the actionable stock-health status. */
export const DEFAULT_VISUAL_CARD_METRIC: VisualCardMetric = 'stockHealth';

/** Choices for the Settings "Visual card details" control (default listed first). */
export const VISUAL_CARD_METRIC_OPTIONS = [
  { value: 'stockHealth', label: 'Stock health' },
  { value: 'value', label: 'Total value' },
  { value: 'lastUpdated', label: 'Last updated' },
  { value: 'condition', label: 'Condition' },
  { value: 'manufacturer', label: 'Manufacturer' },
] as const satisfies readonly { value: VisualCardMetric; label: string }[];

/**
 * Coerce an arbitrary persisted value to a valid {@link VisualCardMetric} (default stock
 * health). Kept total so a stale localStorage value from an older/newer build can never
 * reach the card's render switch.
 */
export function normaliseVisualCardMetric(value: string): VisualCardMetric {
  return (VISUAL_CARD_METRIC_OPTIONS as readonly { value: string }[]).some((o) => o.value === value)
    ? (value as VisualCardMetric)
    : DEFAULT_VISUAL_CARD_METRIC;
}

/**
 * The fallback shown in the Visual-card hero when the chosen {@link VisualCardMetric} has
 * nothing to show for a given item (issue #107) — e.g. "Manufacturer" with a "Stock health"
 * fallback shows the maker where one is set and the reorder status everywhere else. Any of
 * the metric ids, or `none` to keep the primary's own placeholder (a muted em-dash /
 * "Untracked") for that item — which is the shipped default, so the fallback is opt-in and an
 * upgrade changes nothing until the user picks one. `stockHealth` / `lastUpdated` always have
 * content, so the fallback never triggers when either is the primary.
 */
export type VisualCardMetricFallback = VisualCardMetric | 'none';

/** The default hero fallback — none, so the primary's own placeholder still shows (no change on upgrade). */
export const DEFAULT_VISUAL_CARD_METRIC_FALLBACK: VisualCardMetricFallback = 'none';

/** Choices for the Settings "Detail fallback" control — the metric options plus "None". */
export const VISUAL_CARD_METRIC_FALLBACK_OPTIONS = [
  ...VISUAL_CARD_METRIC_OPTIONS,
  { value: 'none', label: 'None' },
] as const satisfies readonly { value: VisualCardMetricFallback; label: string }[];

/**
 * Coerce an arbitrary persisted value to a valid {@link VisualCardMetricFallback} (default
 * `none`). Total, like {@link normaliseVisualCardMetric}, so a stale value can never reach the
 * card's fallback resolution.
 */
export function normaliseVisualCardMetricFallback(value: string): VisualCardMetricFallback {
  return (VISUAL_CARD_METRIC_FALLBACK_OPTIONS as readonly { value: string }[]).some((o) => o.value === value)
    ? (value as VisualCardMetricFallback)
    : DEFAULT_VISUAL_CARD_METRIC_FALLBACK;
}

/**
 * What tapping the empty space of an item card/row does (spec §3, §4). The card is a
 * drag source and hosts its own action buttons (details / move / label / …); this lets a
 * plain click on the card body — anywhere outside those controls — act as a shortcut to the
 * most-used of them:
 * - `details` — open the full item record (the same dialog as the card's pencil button). The
 *   default: clicking a card to open it is the least-surprising behaviour.
 * - `move` — open "Move item" to relocate it to another location.
 * - `qr` — open the printable label (QR + barcode) dialog.
 * - `none` — a click does nothing (the buttons remain the only way in), for users who'd rather
 *   the card body stay inert.
 *
 * Only ever mirrors an action already reachable by a labelled button on the card, so it stays
 * a pointer-only convenience: keyboard/assistive-tech users use those buttons, and the shortcut
 * is suppressed while the batch-selection checkbox is active (a click there is a selection).
 */
export type CardClickAction = 'none' | 'details' | 'move' | 'qr';

/** The default card-click action — open the item's full details (the expected click-to-open). */
export const DEFAULT_CARD_CLICK_ACTION: CardClickAction = 'details';

/** Choices for the Settings "Item card click" control (default listed first). */
export const CARD_CLICK_ACTION_OPTIONS = [
  { value: 'details', label: 'Open details' },
  { value: 'move', label: 'Move to location' },
  { value: 'qr', label: 'Show label' },
  { value: 'none', label: 'Do nothing' },
] as const satisfies readonly { value: CardClickAction; label: string }[];

/**
 * Coerce an arbitrary persisted value to a valid {@link CardClickAction} (default `details`).
 * Kept total so a stale localStorage value from an older/newer build can never drive the
 * card's click handler into an unknown dialog.
 */
export function normaliseCardClickAction(value: string): CardClickAction {
  return (CARD_CLICK_ACTION_OPTIONS as readonly { value: string }[]).some((o) => o.value === value)
    ? (value as CardClickAction)
    : DEFAULT_CARD_CLICK_ACTION;
}

/**
 * List pagination (issue #20). When the user turns on "paginate long lists", the browse lists
 * (inventory, the activity feed, the contacts dictionary) split into fixed-size pages instead of
 * one continuously-scrolling list, with a page control at the foot. This preference is the
 * **default page size** the control opens with; the control's own editable size picker writes
 * back here, so there is a single shared value that persists everywhere.
 *
 * The ceiling is the repository's strict {@link MAX_PAGE_SIZE} (100): a single page maps to one
 * `LIMIT/OFFSET` read, which the repositories clamp to that ceiling, so a larger page would
 * silently return only 100 rows. The floor of 5 keeps a page from being uselessly small.
 */
export const PAGE_SIZE_BOUNDS = { min: 5, max: MAX_PAGE_SIZE } as const;

/** Suggested page sizes offered by the editable size picker (the user may still type any value in range). */
export const PAGE_SIZE_PRESETS = [10, 25, 50, 100] as const;

/** The default items-per-page when nothing is stored — a comfortable middle preset. */
export const DEFAULT_ITEMS_PER_PAGE = 50;

/**
 * Clamp an items-per-page value to {@link PAGE_SIZE_BOUNDS} (rounded to a whole number). A
 * non-finite value (e.g. a half-typed or stale persisted entry) falls back to the default, so a
 * bad value can never reach the page maths or a repository read.
 */
export function clampPageSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ITEMS_PER_PAGE;
  return Math.min(PAGE_SIZE_BOUNDS.max, Math.max(PAGE_SIZE_BOUNDS.min, Math.round(value)));
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
  return (WINDOW_MONTH_OPTIONS as readonly number[]).includes(value) ? value : DEFAULT_WINDOW_MONTHS;
}

/**
 * Dashboard nav-tile count metrics (backlog A1). Each *collection* tile on the Dashboard
 * hub shows a small count (see `useNavCounts`); these let the user re-point a tile at a
 * different metric than the one shipped as its default — generalising the fixed
 * "active projects / open orders / upcoming bookings" choices into a user preference.
 *
 * Only tiles with **more than one genuinely useful metric** appear here: Contacts (always all
 * contacts) is single-metric, so it carries no picker. Most metrics are a pure selector over
 * data the tile's existing read hook already loads — no new query — which keeps the count free
 * (shared TanStack cache) and unit-testable. The A2 "problem" metrics (over-budget, low-stock,
 * out-of-stock) are the exception: each reads a small dedicated count query that `useNavCounts`
 * fetches **only when that metric is the tile's current choice**, so an unselected problem
 * metric costs nothing. This map is the SSOT for the Settings picker (option values + labels),
 * the store default/normalisation, each tile's spoken noun, and each metric's attention
 * {@link NavCountTone}; the selectors/reads themselves live beside the hooks in `useNavCounts`.
 */

/**
 * How a nav-count pill is tinted (backlog A2). A `warning`/`danger` metric counts something
 * needing attention (low-stock, out-of-stock, over-budget), so its pill takes a
 * warning/destructive token rather than the tile's group hue — a glance distinguishes
 * "12 things" from "12 *problems*". `neutral` (the default) keeps the group hue. The colour is
 * never the only signal: the tile's accessible name always states the metric in words
 * ("5 low-stock items"), so the distinction survives colour-blindness / high-contrast (WCAG).
 */
export type NavCountTone = 'neutral' | 'warning' | 'danger';

export interface NavCountMetricOption {
  readonly value: string;
  /** The Settings picker label for this metric. */
  readonly label: string;
  /** Singular spoken noun for the tile's accessible name (e.g. "active project"). */
  readonly noun: string;
  /**
   * Plural spoken noun (e.g. "active projects"). Held explicitly because a phrase noun
   * does not pluralise by a bare `+s` ("booking starting this week" → "bookings starting
   * this week"), so {@link plural} needs the irregular form.
   */
  readonly nounPlural: string;
  /**
   * Attention tone for the count pill (backlog A2); absent ⇒ `'neutral'` (the group hue).
   * A problem metric ({@link NavCountTone} `warning`/`danger`) tints the pill so it reads as
   * an alert, not a plain total.
   */
  readonly tone?: NavCountTone;
}

interface NavCountMetricConfig {
  /** The tile's Settings picker label ("Projects tile counts"). */
  readonly settingLabel: string;
  /** The default metric — the behaviour shipped before A1/A2 made it configurable. */
  readonly default: string;
  readonly options: readonly NavCountMetricOption[];
}

export const NAV_COUNT_METRIC_CONFIG = {
  '/inventory': {
    settingLabel: 'Inventory tile counts',
    default: 'total',
    options: [
      { value: 'total', label: 'All items', noun: 'item', nounPlural: 'items' },
      // A2 problem metrics — each reads a dedicated count query, fetched only when selected.
      {
        value: 'lowStock',
        label: 'Low-stock items',
        noun: 'low-stock item',
        nounPlural: 'low-stock items',
        tone: 'warning',
      },
      {
        value: 'outOfStock',
        label: 'Out-of-stock items',
        noun: 'out-of-stock item',
        nounPlural: 'out-of-stock items',
        tone: 'danger',
      },
    ],
  },
  '/projects': {
    settingLabel: 'Projects tile counts',
    default: 'active',
    options: [
      { value: 'active', label: 'Active projects', noun: 'active project', nounPlural: 'active projects' },
      { value: 'all', label: 'All projects', noun: 'project', nounPlural: 'projects' },
      // A2 problem metric — over-budget projects, from the budget-alerts feed (fetched only
      // when selected).
      {
        value: 'overBudget',
        label: 'Over-budget projects',
        noun: 'over-budget project',
        nounPlural: 'over-budget projects',
        tone: 'danger',
      },
    ],
  },
  '/purchase-orders': {
    settingLabel: 'Purchase orders tile counts',
    default: 'open',
    options: [
      { value: 'open', label: 'Open orders', noun: 'open order', nounPlural: 'open orders' },
      { value: 'all', label: 'All orders', noun: 'order', nounPlural: 'orders' },
    ],
  },
  '/bookings': {
    settingLabel: 'Bookings tile counts',
    default: 'upcoming',
    options: [
      {
        value: 'upcoming',
        label: 'Upcoming bookings',
        noun: 'upcoming booking',
        nounPlural: 'upcoming bookings',
      },
      {
        value: 'thisWeek',
        label: 'Starting this week',
        noun: 'booking starting this week',
        nounPlural: 'bookings starting this week',
      },
      { value: 'all', label: 'All bookings', noun: 'booking', nounPlural: 'bookings' },
    ],
  },
} as const satisfies Record<string, NavCountMetricConfig>;

/** The Dashboard tiles whose count metric is user-configurable (keys of {@link NAV_COUNT_METRIC_CONFIG}). */
export type NavCountRoute = keyof typeof NAV_COUNT_METRIC_CONFIG;

/** Every configurable tile route, for iteration/normalisation. */
export const NAV_COUNT_ROUTES = Object.keys(NAV_COUNT_METRIC_CONFIG) as NavCountRoute[];

/** The shipped default metric per configurable tile, derived from the config so it can't drift. */
export const DEFAULT_NAV_COUNT_METRICS = Object.fromEntries(
  NAV_COUNT_ROUTES.map((route) => [route, NAV_COUNT_METRIC_CONFIG[route].default]),
) as Record<NavCountRoute, string>;

/**
 * Coerce a persisted metric id to a valid choice for `route`, falling back to the tile's
 * shipped default. Kept total so a stale localStorage value from an older/newer build can
 * never reach the count selector or the picker.
 */
export function normaliseNavCountMetric(route: NavCountRoute, value: string): string {
  const cfg = NAV_COUNT_METRIC_CONFIG[route];
  return cfg.options.some((o) => o.value === value) ? value : cfg.default;
}

/**
 * Coerce a whole persisted map (possibly partial or stale — e.g. missing a route added in a
 * later build) into a complete, valid one. Every configurable route gets a valid metric.
 *
 * @internal Exported for unit tests only.
 */
export function normaliseNavCountMetrics(
  value: Partial<Record<NavCountRoute, string>> | undefined,
): Record<NavCountRoute, string> {
  const out = {} as Record<NavCountRoute, string>;
  for (const route of NAV_COUNT_ROUTES) {
    out[route] = normaliseNavCountMetric(route, value?.[route] ?? '');
  }
  return out;
}

/** The resolved option for a tile's current metric (its labels + spoken nouns); never null. */
export function navCountOption(route: NavCountRoute, metric: string): NavCountMetricOption {
  const cfg = NAV_COUNT_METRIC_CONFIG[route];
  return cfg.options.find((o) => o.value === metric) ?? cfg.options.find((o) => o.value === cfg.default)!;
}

/**
 * The attention {@link NavCountTone} for a tile's current metric (backlog A2) — `'neutral'`
 * for a plain total (the tile's group hue), `'warning'`/`'danger'` for a problem metric.
 *
 * @internal Exported for unit tests only.
 */
export function navCountTone(route: NavCountRoute, metric: string): NavCountTone {
  return navCountOption(route, metric).tone ?? 'neutral';
}
