/**
 * Location fullness — the pure seam behind the capacity gauge (Edit dialog), the subtle
 * fill bar on tree rows, and the "location is full" warning when adding/moving an item.
 *
 * A location without a capacity (null, or a non-positive one) has no notion of fullness, so
 * the helpers return `null` / `false` for it. `percent` is rounded and clamped to 0–100 for
 * display; `over` reports the true over-capacity state (which `percent` alone would hide once
 * it saturates at 100).
 */

export interface Fullness {
  /** Rounded, clamped 0–100 for the bar width / label. */
  readonly percent: number;
  /** True when the item count meets or exceeds the capacity (the location is full). */
  readonly full: boolean;
  /** True when the item count strictly exceeds the capacity (over the limit). */
  readonly over: boolean;
}

/** Fullness of a location, or `null` when it has no (positive) capacity limit. */
export function locationFullness(
  itemCount: number,
  capacity: number | null | undefined,
): Fullness | null {
  if (capacity == null || !Number.isFinite(capacity) || capacity <= 0) return null;
  const ratio = itemCount / capacity;
  return {
    percent: Math.min(100, Math.max(0, Math.round(ratio * 100))),
    full: itemCount >= capacity,
    over: itemCount > capacity,
  };
}

/** Would adding `adding` item(s) meet or exceed the location's capacity? */
export function isLocationFull(
  itemCount: number,
  capacity: number | null | undefined,
  adding = 1,
): boolean {
  if (capacity == null || !Number.isFinite(capacity) || capacity <= 0) return false;
  return itemCount + adding > capacity;
}
