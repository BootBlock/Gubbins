import type { Migration } from './migration';

/**
 * v10 — Activity-Ledger sync prune watermark (spec §7.2/§7.3, §7.6.3-A, Phase 11).
 *
 * Phase 11 brings the append-only `item_history` ledger into the synced set, where it
 * reconciles by **union-by-id** (never LWW — an immutable row is the same event on
 * every device). That collides with the Phase-10 §7.6.3-A "Action History Pruning"
 * recovery, which DELETEs old ledger rows *locally* to reclaim OPFS space: a naive
 * union would simply re-download those pruned rows from any peer that still has them,
 * silently undoing the space reclamation.
 *
 * The fix mirrors the §7.2 Tombstone-TTL watermark precedent: a per-device high-water
 * mark recording the instant before which this device has *deliberately* pruned its
 * ledger. The reconcile engine then refuses to import any remote history row whose
 * `created_at` is older than this mark, so pruning stays effective while newer history
 * still unions normally. It lives on the single-row, **local-only** `sync_meta` table
 * (never synced — pruning is intentionally a local divergence), so a single additive,
 * nullable column is the clean fit (no §2.3.3 12-step recreation).
 *
 * NULL / 0 = nothing pruned (import everything). A UNIX-ms stamp = the prune cutoff;
 * the §7.6.3-A workflow advances it (monotonically) whenever it prunes.
 */
export const v10HistoryWatermark: Migration = {
  version: 10,
  name: 'history-prune-watermark',
  statements: [
    { sql: `ALTER TABLE sync_meta ADD COLUMN history_pruned_before INTEGER NOT NULL DEFAULT 0;` },
  ],
};
