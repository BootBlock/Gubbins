import type { Migration } from './migration';

/**
 * v2 — Partial index on `items.warranty_expires_at`.
 *
 * The `warranty_expires_at` column was added by an in-place `ALTER TABLE` in the v1
 * baseline (unlike `expiry_date`, which got the `idx_items_expiry` partial index at the
 * same time). This forward step adds the matching partial index so the warranty-attention
 * probe (`warrantyExpiringPredicateSql` — now only evaluated when the warranty module is
 * enabled), `listWarrantyExpiring`, and the alert centre can seek the small set of assets
 * that actually carry a warranty date rather than scanning the whole `items` table.
 *
 * The index is **partial** (`WHERE warranty_expires_at IS NOT NULL`) for the same reason
 * `idx_items_expiry` is: most items have no warranty date, so excluding those NULL rows
 * keeps the index compact and its entries aligned exactly with the predicate, which filters
 * on `warranty_expires_at IS NOT NULL AND warranty_expires_at <= ?`.
 *
 * A purely additive index needs no baseline re-squash — it appends cleanly as a forward
 * migration, so the v1 baseline is untouched and this ships as version 2.
 */
export const v2WarrantyIndex: Migration = {
  version: 2,
  name: 'warranty-expiry-index',
  statements: [
    {
      sql: `CREATE INDEX idx_items_warranty ON items(warranty_expires_at) WHERE warranty_expires_at IS NOT NULL;`,
    },
  ],
};
