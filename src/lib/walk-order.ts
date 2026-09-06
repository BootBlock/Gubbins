/**
 * Walk-order domain — the single definition of how a location's picking-sweep ordinal is read
 * (issue #461).
 *
 * A walk order is a rung on a sequence, not a measured quantity: it is floored to a whole
 * number, and anything that cannot be one — blank, NaN, negative, non-finite — means the
 * location is simply not on the route. That is stored as NULL, where it sorts after every
 * placed location.
 *
 * The repository writes through {@link normaliseWalkOrder}; the Add- and Edit-location dialogs
 * read their field through {@link resolveWalkOrderInput}, which is defined *in terms of* it
 * rather than beside it. A dialog judging a typed value by its own rule could accept something
 * the write path then silently discarded — the location would drop off the route with no error
 * shown. Deriving the field's verdict from the write path makes the two agree by construction.
 *
 * What construction cannot hold is the agreement with everything *below* the rule — the columns
 * the repository binds, and the `CHECK (walk_order IS NULL OR walk_order >= 0)` the schema
 * carries. `src/db/repositories/walk-order-write-parity.test.ts` drives the field seam against a
 * migrated database and compares what comes back, up to the magnitude ceiling noted on
 * {@link WalkOrderInput.valid}.
 *
 * Side-effect-free (no React, no DB, no `Intl` singletons held), so the app, the repository and
 * the bridge can all depend on it.
 */

/**
 * Coerce a walk-order ordinal to a non-negative integer, or `null` for "unplaced". A blank,
 * NaN, negative or non-finite value collapses to `null` so a cleared field drops the location
 * off the route. Floored to a whole number: walk order is a rung on a sequence, not a measured
 * quantity.
 *
 * Negative zero folds to `0`. `-0` passes the `< 0` guard and floors to `-0`, but the column is
 * an INTEGER and reads back as `0`, so leaving it would make the field promise a value the
 * database does not return — the one thing this module exists to prevent.
 */
export function normaliseWalkOrder(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  const ordinal = Math.floor(value);
  return ordinal === 0 ? 0 : ordinal;
}

/** What a walk-order form field currently holds, and whether it can be stored as typed. */
export interface WalkOrderInput {
  /** The ordinal the field would submit — `null` for "not on the picking route". */
  value: number | null;
  /**
   * Whether {@link normaliseWalkOrder} would keep exactly {@link value}, rather than quietly
   * replacing it with `null`. A field that is not valid must block its form's submit, so the
   * user sees the problem instead of losing the position they typed.
   *
   * Valid says the *rule* keeps the value; it does not promise the write succeeds. An ordinal
   * above `Number.MAX_SAFE_INTEGER` is still reported valid, and the write then fails in one of
   * two ways. Below 2^63 SQLite stores the row and the driver then fails handing the ordinal
   * back as a JavaScript number, so `create` rejects over a row that exists. At 2^63 and above
   * the value no longer converts to an int64 at all, and the column refuses it, storing nothing.
   * Both are pre-existing and shared with the Capacity field, so neither is guarded here.
   * `src/db/repositories/walk-order-write-parity.test.ts` pins both.
   */
  valid: boolean;
}

/**
 * Read a walk-order form field. Blank is valid and means "not on the picking route"; anything
 * else is valid only when the repository would keep the whole number it floors to — within the
 * magnitude noted on {@link WalkOrderInput.valid}.
 */
export function resolveWalkOrderInput(raw: string): WalkOrderInput {
  if (raw.trim() === '') return { value: null, valid: true };
  const entered = Math.floor(Number(raw));
  const stored = normaliseWalkOrder(Number(raw));
  // Accepted ⇒ report the ordinal the write path settled on, so the field and the row hold the
  // same value rather than two spellings of it. Rejected ⇒ report what was typed, which is what
  // the Edit dialog compares to decide the form is dirty.
  return stored === entered ? { value: stored, valid: true } : { value: entered, valid: false };
}
