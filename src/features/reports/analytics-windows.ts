/**
 * Selectable trailing-window options for the Reports analytics controls.
 *
 * Kept in its own dependency-free module so both the Reports UI (via `queries.ts`) and the
 * preferences store can share the same SSOT without a circular import (`queries.ts` reads the
 * store, so the store must not import back through it).
 */

/**
 * Selectable trailing windows (days) for the turnover / valuation-trend / spend / sales
 * analytics, in ascending duration order so the segmented control reads shortest-first
 * (7d on the left) to longest (365d on the right).
 */
export const ANALYTICS_WINDOWS = [7, 14, 30, 60, 90, 365] as const;

/** A trailing-window length the analytics controls offer. */
export type AnalyticsWindow = (typeof ANALYTICS_WINDOWS)[number];

/** Default analytics window — a quarter reads well for both turnover and the value trend. */
export const DEFAULT_ANALYTICS_WINDOW: AnalyticsWindow = 90;

/**
 * Coerce an arbitrary (persisted, possibly stale) value to a valid analytics window, falling
 * back to {@link DEFAULT_ANALYTICS_WINDOW}. Guards the read side so a window no longer offered
 * (were the list ever trimmed) can never reach a query key or the segmented control.
 */
export function normaliseAnalyticsWindow(days: unknown): AnalyticsWindow {
  return (ANALYTICS_WINDOWS as readonly number[]).includes(days as number)
    ? (days as AnalyticsWindow)
    : DEFAULT_ANALYTICS_WINDOW;
}
