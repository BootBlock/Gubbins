/**
 * What counts as a usable epoch-ms instant.
 *
 * Every timestamp that arrives from outside this device — a backup file, a peer's snapshot in a
 * shared sync folder, a bridge push — is ordinary JSON, so `typeof value === 'number'` and even
 * `Number.isFinite` wave through values no clock could ever produce. Two things then go wrong,
 * and both are silent at the point of entry:
 *
 *  - **It cannot be rendered.** Past ±100 000 000 days from the epoch, `new Date(n)` is an
 *    Invalid Date and `toISOString()` throws a `RangeError` — which the bridge does when it
 *    reports a snapshot's age (`bridge/src/cli.ts`, the `/api/v1` responses).
 *  - **It cannot be read back.** {@link MAX_TIMESTAMP} sits just below `Number.MAX_SAFE_INTEGER`,
 *    so a value inside the bound always survives a round-trip through an SQLite INTEGER column.
 *    Above it, the bridge's driver refuses to hand the number back to JavaScript at all.
 *
 * Defined once, here, because the guard is applied at several unrelated boundaries — the sync
 * snapshot's own clock, a gauge delta's `createdAt`, a tombstone's `deletedAt`, a backup
 * manifest's `createdAt` — and a second copy of the bound would be free to drift from the first.
 */

/** The largest instant `Date` can represent (±100 000 000 days from the epoch). */
export const MAX_TIMESTAMP = 8.64e15;

/** A number that is safe both to compare and to hand to `new Date(…)`. */
export function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIMESTAMP;
}
