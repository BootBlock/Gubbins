import type { Migration } from './migration';

/**
 * v12 — Partial / split BOM-line receipts (spec §4 procurement, Phase 24).
 *
 * Phase 20 surfaced an item's In-Transit quantity as a derived projection over its
 * `IN_TRANSIT` BOM lines, but a line still transitioned to RECEIVED *wholesale*:
 * receiving fewer units than ordered cleared the entire line's incoming figure. This
 * column lets a line be received in instalments — `received_qty` accumulates as stock
 * arrives, the line stays IN_TRANSIT until cumulative receipts meet the requirement,
 * and the derived incoming figure becomes `SUM(required_qty − received_qty)`.
 *
 * Unlike the Phase-20/22 "derive, never store a counter" projections, the cumulative
 * received quantity has no underlying ledger to derive from reliably (history can be
 * pruned per §7.6.3-A; unmatched / non-DISCRETE lines log no item history), so it is
 * the *primary* record of instalment progress. A single additive, NOT-NULL column
 * (default 0 — the pre-Phase-24 "nothing received yet" state) is the clean fit; no
 * §2.3.3 12-step table recreation is needed.
 *
 * `project_bom_lines` is already in `SYNC_TABLES` and the LWW schema dictionary reads
 * its columns live via `PRAGMA table_info`, so the new column round-trips across
 * devices with no further registration — received progress should sync, so it is
 * deliberately *not* added to `SYNC_EXCLUDED_COLUMNS`.
 */
export const v12BomReceivedQty: Migration = {
  version: 12,
  name: 'bom-received-qty',
  statements: [
    {
      sql: `ALTER TABLE project_bom_lines ADD COLUMN received_qty INTEGER NOT NULL DEFAULT 0;`,
    },
  ],
};
