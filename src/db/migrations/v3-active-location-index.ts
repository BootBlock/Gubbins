import type { Migration } from './migration';

/**
 * v3 — Partial index on `items(location_id) WHERE is_active = 1`.
 *
 * Both hot inventory reads scope to a single location's *active* stock — the paginated
 * list (`ItemCoreRepository.list` → `buildListFilter`) and every per-status applicability
 * probe (`ItemFeedRepository.applicableStatuses`) emit `WHERE is_active = 1 AND
 * location_id = ?`. The v1 baseline carries two *single-column* indexes for this pair
 * (`idx_items_location_id` and `idx_items_is_active`), so the planner can satisfy only one
 * predicate with a seek and filters the other as a residual.
 *
 * That split is a latency cliff in the state that matters: Gubbins runs `ANALYZE` only on
 * the manual "Compact database" action (`PRAGMA optimize` in `compactDatabase`), never at
 * boot or after a bulk import — so a real database usually has **no** `sqlite_stat1`
 * statistics. Without stats the planner cannot tell that `is_active` is near-constant (~all
 * rows are 1), and its no-stats heuristic picks `idx_items_is_active`, scanning essentially
 * the whole table on every location-scoped list load and every applicability `EXISTS`. At
 * scale (measured on `node:sqlite` at 50k–200k items) that is a ~2–8 ms scan per query —
 * multiplied across the per-status applicability probes — versus ~0.15–0.20 ms once a
 * location-first index is available. With stats present the planner already picks
 * `idx_items_location_id`, so this index is *neutral* there and *decisive* without them.
 *
 * A **partial** index is the right shape rather than a full `(location_id, is_active)`
 * composite: the dominant predicate is always `is_active = 1`, and measurement shows the
 * `is_active` second column of a composite earns no extra selectivity (the `location_id`
 * seek alone reaches the same plan and latency). Encoding `is_active = 1` in the index's
 * `WHERE` instead keeps it single-column and smaller while making the planner prefer it for
 * exactly this query — the same idiom as `idx_items_expiry` / `idx_items_warranty`. The
 * `includeInactive` read path drops the `is_active` filter entirely, so it never needs this
 * index and keeps using `idx_items_location_id`.
 *
 * Purely additive, so it appends cleanly as a forward migration and needs no baseline
 * re-squash; it ships as version 3.
 */
export const v3ActiveLocationIndex: Migration = {
  version: 3,
  name: 'active-location-index',
  statements: [
    {
      sql: `CREATE INDEX idx_items_active_location ON items(location_id) WHERE is_active = 1;`,
    },
  ],
};
