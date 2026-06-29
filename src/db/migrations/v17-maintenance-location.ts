import type { Migration } from './migration';

/**
 * v17 — Per-location maintenance scheduling (spec §4.3 Tool Maintenance, Phase 30).
 *
 * Phase 25 made `item_stock` the SSOT for *where* a DISCRETE tool's units sit, so the
 * same tool can live across several placements at once. A maintenance schedule, though,
 * stayed strictly item-level (Phase 9): "service the lathe every 90 days" applies to the
 * whole item regardless of which copy is where. Phase 30 lets a schedule be scoped to a
 * *specific* placement — "recalibrate the multimeter at the Workshop bench" — so a tool
 * spread across locations can be serviced per location.
 *
 * That scope is the lend-from location on the schedule, so this single additive,
 * **nullable** column records it. NULL means "the whole item" — the Phase-9 behaviour, so
 * every existing schedule reads correctly with no backfill. A nullable FK to `locations`
 * (NO ACTION / RESTRICT, like every other location reference) keeps it referentially
 * honest; the local `LocationRepository.delete` and the §7.5.2 sync `applyPlan` both null
 * it out for a removed location before the location's tombstone DELETE (the schedule then
 * reverts to item-level rather than vanishing), and the sync `FK_REFS` guard nulls an
 * *incoming* schedule whose scope location did not survive the merge — mirroring the v14
 * `checkouts.source_location_id` precedent exactly.
 *
 * The scope is also operationally meaningful, not a mere label: a location-scoped USAGE
 * schedule that auto-accrues checkout-hours (Phase 22) counts only the loans *drawn from
 * that location* (`checkouts.source_location_id`, Phase 26), so each placement's wear is
 * attributed to its own service clock. An item-level schedule (NULL) still accrues every
 * loan, exactly as before.
 *
 * `maintenance_schedules` is already in `SYNC_TABLES` and the LWW schema dictionary reads
 * its columns live via `PRAGMA table_info`, so the new column round-trips across devices
 * with no further registration — the scope should sync, so it is deliberately *not* added
 * to `SYNC_EXCLUDED_COLUMNS`. (SQLite permits an `ADD COLUMN` carrying a `REFERENCES`
 * clause only when its default is NULL, which a nullable column satisfies — no §2.3.3
 * 12-step table recreation is needed.)
 */
export const v17MaintenanceLocation: Migration = {
  version: 17,
  name: 'maintenance-location',
  statements: [
    {
      sql: `ALTER TABLE maintenance_schedules ADD COLUMN location_id TEXT REFERENCES locations(id);`,
    },
  ],
};
