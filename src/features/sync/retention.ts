/**
 * How long a device keeps the raw, un-summarised sync ledgers (§7.2, issue #544).
 *
 * The two retention horizons live together because the *stock* one is only safe while it is at
 * least as long as the *tombstone* one — see {@link STOCK_DELTA_RETENTION_MS}. Keeping them one
 * declaration apart, rather than one module apart, is what makes that relationship visible at the
 * point either could be changed.
 */

/**
 * §7.2 Tombstone TTL: 180 days in milliseconds.
 *
 * A device whose `last_sync_timestamp` is older than this cannot trust delta reconciliation — the
 * shared snapshot may have pruned the tombstones it needs — so it takes the Pre-Wipe Salvage clone
 * path instead (`needsFullResync`).
 */
export const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * How long `stock_deltas` keeps a placement's individual movements before they are summarised into
 * a single checkpoint row (issue #544).
 *
 * **Deliberately equal to {@link TOMBSTONE_TTL_MS}, and it must never be shorter.** Summarising an
 * era replaces its movements with one absolute assertion, and an assertion supersedes everything
 * ordered before it (issue #633) — so a peer's *unsynced* movement stamped inside a summarised era
 * is discarded when it finally unions in. At 180 days the only peer that can hold such a movement
 * is one that has not synced for longer than the tombstone TTL, and that peer does not delta-merge
 * at all: it clones the shared snapshot wholesale and re-applies its own work as salvage. So the
 * window where a movement could be lost is exactly the window the §7.2 clone already covers, and
 * this adds no new exposure. Shortening it would open one.
 */
export const STOCK_DELTA_RETENTION_MS = TOMBSTONE_TTL_MS;

/**
 * The grid the compaction cutoff is snapped to — one day.
 *
 * Two devices compute their cutoff from their own clocks, so an unsnapped cutoff would differ by
 * milliseconds and each device would mint a *differently identified* checkpoint for the same
 * placement. Both are correct (the replay simply restarts at the newer one, and the older is
 * absorbed by the next sweep), but they would never collapse by id and every sweep would add
 * another. Snapping to a day means two devices that sweep within the same UTC day derive the same
 * cutoff, hence the same checkpoint id and the same asserted figure, and the union keeps one row.
 */
export const COMPACTION_GRID_MS = 24 * 60 * 60 * 1000;

/**
 * The instant before which `stock_deltas` rows may be summarised, given the current time **in this
 * device's own clock frame**.
 *
 * The frame matters: `stock_deltas.created_at` is each device's raw wall clock and is deliberately
 * never shifted by the sync offset (see `replayStockQuantity`), so a cutoff derived from server
 * time would summarise the wrong rows on a device whose clock is skewed.
 */
export function stockDeltaCompactionCutoff(
  nowLocal: number,
  retentionMs: number = STOCK_DELTA_RETENTION_MS,
): number {
  return Math.floor((nowLocal - retentionMs) / COMPACTION_GRID_MS) * COMPACTION_GRID_MS;
}
