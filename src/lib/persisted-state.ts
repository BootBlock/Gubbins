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
 * `migrate` for a store adopting `version: 1` over its shipped, *unversioned* (v0) shape.
 *
 * A persisted store with no `version` is pinned at 0 with nowhere to hang a future migration.
 * Declaring one can't be done on its own, though: zustand only calls `migrate` when the stored
 * version differs from the declared one, and when there is **no** `migrate` it logs an error and
 * hydrates with `undefined` — i.e. bumping 0 → 1 bare would *discard* every existing install's
 * layout, saved searches or half-finished stock-take. So the version bump and this pass-through
 * ship together: v0 and v1 are the same shape, so the stored state is adopted verbatim and the
 * store gains the hook point without touching anyone's data.
 *
 * Reconciling the *shape* is deliberately not this function's job — that happens on read in each
 * store's `merge` (see the module header). A store making a real shape change replaces this with
 * a versioned `migrate` of its own rather than extending it here.
 */
export function adoptUnversioned<T>(persistedState: unknown): T {
  return persistedState as T;
}

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
 * A persisted Zustand blob taken apart: the `state` object, and the envelope it sits in (which
 * carries the persist `version` the store's `migrate` keys off).
 */
export interface PersistedBlob {
  readonly state: Record<string, unknown>;
  readonly envelope: Record<string, unknown>;
}

/**
 * Read a `localStorage` value written by zustand's `persist`, or null when it isn't one.
 *
 * Anything that hands a store's stored state around — the backup settings picker, live settings
 * sync — needs the same two-part view, and needs the envelope preserved rather than rebuilt: drop
 * the `version` and the store's `migrate` would run against the wrong baseline on the next boot.
 */
export function parsePersistedBlob(raw: string): PersistedBlob | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || !isPlainObject(parsed.state)) return null;
    return { state: parsed.state, envelope: parsed };
  } catch {
    return null;
  }
}

/** Re-serialise a blob with a replacement `state`, keeping its envelope (and so its version). */
export function serialisePersistedBlob(
  blob: PersistedBlob,
  state: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify({ ...blob.envelope, state });
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
