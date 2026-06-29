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
  EXPIRY_SOON_WINDOW_DAYS,
  LOW_STOCK_GAUGE_PERCENT,
  LOW_STOCK_QTY_THRESHOLD,
} from '@/db/repositories/constants';

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
