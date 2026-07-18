/**
 * persisted-state — tiny pure helpers for **reconciling rehydrated `localStorage` state**.
 *
 * Zustand's `persist` middleware hands back whatever `JSON.parse` returned and merges it
 * over the store's defaults verbatim: the declared TypeScript types are a compile-time
 * fiction on that path. A value written by an older release, hand-edited in devtools, or
 * truncated by a quota error therefore reaches render as-is — and a union field that no
 * longer matches any arm silently falls through exhaustive lookups.
 *
 * The app already normalises this way on *write* (the ~20 `normalise*` / `clamp*` helpers
 * the preferences store routes its setters through). These helpers are the same discipline
 * applied at the *read* boundary, factored out so each store's `merge` stays a one-liner
 * per field rather than re-hand-rolling the `includes ? : fallback` dance.
 *
 * Everything here is pure, DOM-free and unit-tested; no store state, no clock.
 */

/**
 * Reconcile an unknown rehydrated value against a closed set of allowed values, falling
 * back to `fallback` when it doesn't match. The canonical guard for a string-union field —
 * pass the union's SSOT array and its default:
 *
 * ```ts
 * normaliseOneOf(persisted.density, LAYOUT_DENSITIES, DEFAULT_DENSITY);
 * ```
 */
export function normaliseOneOf<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/** Reconcile a rehydrated boolean, falling back when it isn't one (missing, `null`, `"true"`, …). */
export function normaliseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reconcile a rehydrated array, falling back to `fallback` when it isn't one. Element shape
 * is *not* checked — pass an `item` guard to filter the members too.
 */
export function normaliseArray<T>(
  value: unknown,
  fallback: readonly T[] = [],
  item?: (candidate: unknown) => candidate is T,
): readonly T[] {
  if (!Array.isArray(value)) return fallback;
  return item ? (value as unknown[]).filter(item) : (value as readonly T[]);
}

/** True for a plain (non-null, non-array) object — the shape a nested persisted record must have. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reconcile a rehydrated integer, falling back when it isn't a finite whole number and
 * clamping it into `[min, max]` when bounds are given.
 */
export function normaliseInteger(
  value: unknown,
  fallback: number,
  bounds?: { readonly min?: number; readonly max?: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const whole = Math.trunc(value);
  const min = bounds?.min ?? Number.NEGATIVE_INFINITY;
  const max = bounds?.max ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(whole, min), max);
}
