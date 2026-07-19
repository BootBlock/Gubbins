/**
 * The foreign-key reference registry (spec §7.5) — the single source of truth for which
 * snapshot column points at which parent table, and what a dangling reference means.
 *
 * Two consumers share it, and both need the *same* answer or a snapshot stops importing:
 * the reconciliation engine ({@link import('./reconcile')}) repairs rows whose parent did
 * not survive a merge, and the backup codec
 * ({@link import('@/features/backup/backup-format')}) repairs rows whose item the user
 * chose to exclude from the file. Adding a table/column here is what keeps both honest.
 */
import type { SyncTable } from '@/db/repositories';

/** One foreign-key column of a child table, and how a dangling reference is repaired. */
export interface FkRef {
  readonly col: string;
  readonly parent: SyncTable;
  /**
   * Mirrors the column's ON DELETE behaviour: `false` (NOT NULL / ON DELETE CASCADE) means
   * the child cannot outlive its parent — drop the row; `true` (ON DELETE SET NULL) keeps
   * the row with the reference cleared.
   */
  readonly nullable: boolean;
}

/**
 * Foreign-key references of each synced child table to a synced parent table (§7.5).
 * `nullable` mirrors the column's ON DELETE behaviour: a NOT-NULL FK (ON DELETE CASCADE)
 * means the child cannot outlive its parent (drop it); a nullable FK (ON DELETE SET NULL)
 * keeps the child with the reference cleared. `items.location_id` is intentionally absent
 * — the §7.5.2 re-parent already re-homes orphaned items to Unassigned.
 */
export const FK_REFS: Partial<Record<SyncTable, readonly FkRef[]>> = {
  items: [{ col: 'category_id', parent: 'categories', nullable: true }],
  // A user whose role was removed elsewhere keeps their account and loses only the grant,
  // mirroring the column's ON DELETE SET NULL (issue #79). Dropping the user instead would
  // delete an account because a role was renamed away on another device.
  users: [{ col: 'role_id', parent: 'roles', nullable: true }],
  // Per-location stock ledger (Phase 25). item_id mirrors the cascade children above —
  // drop a placement whose item was removed. location_id drops an *incoming* placement at
  // a removed location (it would trip the location's RESTRICT FK); the device's *own*
  // surviving placement at that location is instead re-homed to Unassigned by `applyPlan`
  // before the location tombstone DELETE, so local stock is preserved rather than lost.
  item_stock: [
    { col: 'item_id', parent: 'items', nullable: false },
    { col: 'location_id', parent: 'locations', nullable: false },
  ],
  // Per-batch ledger (Phase 28), the SSOT below item_stock. Same guards as item_stock: a
  // batch whose item was removed is dropped (CASCADE), and an *incoming* batch at a removed
  // location is dropped (its RESTRICT FK would reject it) while the device's own surviving
  // batches at that location are re-homed to Unassigned by `applyPlan` before the location
  // tombstone DELETE.
  stock_batches: [
    { col: 'item_id', parent: 'items', nullable: false },
    { col: 'location_id', parent: 'locations', nullable: false },
  ],
  // A category's use of a dictionary definition (issue #97): both ends are ON DELETE
  // CASCADE / NOT NULL, so an incoming row whose category *or* whose definition did not
  // survive the merge is dropped.
  category_fields: [
    { col: 'category_id', parent: 'categories', nullable: false },
    { col: 'def_id', parent: 'field_defs', nullable: false },
  ],
  // The values a location offers for inheritance (issue #97). Same shape: both FKs are
  // ON DELETE CASCADE / NOT NULL. A value at a removed location is dropped rather than
  // resurrected, mirroring item_stock's location guard above.
  location_field_values: [
    { col: 'location_id', parent: 'locations', nullable: false },
    { col: 'def_id', parent: 'field_defs', nullable: false },
  ],
  // Photos of a place, and the named shapes drawn onto them (issue #81). Both FKs are
  // ON DELETE CASCADE / NOT NULL, so an incoming photo at a removed location — or a region
  // on a photo that did not survive the merge — is dropped rather than resurrected. The
  // chain is two deep, and the SYNC_TABLES order (locations → location_photos →
  // location_regions) is what lets a single pass resolve it.
  location_photos: [{ col: 'location_id', parent: 'locations', nullable: false }],
  location_regions: [{ col: 'photo_id', parent: 'location_photos', nullable: false }],
  item_aliases: [{ col: 'item_id', parent: 'items', nullable: false }],
  // Manual current-value log points (feature-gap G9). item_id mirrors the item-child cascade
  // above — drop an incoming revaluation whose item did not survive the merge (ON DELETE
  // CASCADE, NOT NULL).
  revaluations: [{ col: 'item_id', parent: 'items', nullable: false }],
  // Related-items cross-links (feature-gap G6). BOTH endpoints are ON DELETE CASCADE / NOT NULL,
  // so an incoming relation whose either item did not survive the merge is dropped (mirrors the
  // item-child cascade above). Its deterministic id means concurrent identical adds merge by LWW,
  // so no bespoke collision handling is needed (contrast item_aliases' text-collision resolver).
  item_relations: [
    { col: 'from_item_id', parent: 'items', nullable: false },
    { col: 'to_item_id', parent: 'items', nullable: false },
  ],
  // Per-instance test / calibration / service records (feature-gap G7). item_id mirrors the
  // item-child cascade above — drop an incoming record whose item did not survive the merge
  // (ON DELETE CASCADE, NOT NULL), exactly like revaluations.
  test_records: [{ col: 'item_id', parent: 'items', nullable: false }],
  // Supplier parts (Phase 60, issue #384). item_id mirrors the item-child cascade above —
  // drop an incoming supplier-part whose item was removed (ON DELETE CASCADE, NOT NULL).
  // supplier_id is the same shape: a part is that supplier's price for an item and cannot
  // outlive the supplier.
  supplier_parts: [
    { col: 'item_id', parent: 'items', nullable: false },
    { col: 'supplier_id', parent: 'suppliers', nullable: false },
  ],
  // Supplier price-history points (Phase 81). supplier_part_id mirrors the cascade children
  // above — drop an incoming price point whose supplier part did not survive the merge
  // (ON DELETE CASCADE, NOT NULL). supplier_parts is already in the `removed`-parents set.
  supplier_part_price_history: [{ col: 'supplier_part_id', parent: 'supplier_parts', nullable: false }],
  // Purchase orders (Phase 62, issue #384). The one NULLABLE supplier reference: an order
  // whose supplier did not survive the merge keeps its row with the link cleared, exactly
  // like checkouts.source_location_id above. Making this non-nullable — or the FK RESTRICT —
  // would abort the whole merge transaction whenever two devices disagreed about a supplier.
  purchase_orders: [{ col: 'supplier_id', parent: 'suppliers', nullable: true }],
  item_field_values: [
    { col: 'item_id', parent: 'items', nullable: false },
    { col: 'def_id', parent: 'field_defs', nullable: false },
  ],
  item_images: [{ col: 'item_id', parent: 'items', nullable: false }],
  item_attachments: [{ col: 'item_id', parent: 'items', nullable: false }],
  capabilities: [{ col: 'item_id', parent: 'items', nullable: false }],
  checkouts: [
    { col: 'item_id', parent: 'items', nullable: false },
    // §7.5 (Phase 14): a peer hard-deleting a contact cascades its loans (ON DELETE
    // CASCADE, NOT NULL). Without this the deleting device would re-download an orphaned
    // checkout and trip the FK on its next sync.
    { col: 'contact_id', parent: 'contacts', nullable: false },
    // Phase 26: the per-location lend-from pointer. Nullable (NO ACTION) — an incoming
    // checkout whose source location did not survive the merge keeps the loan but clears
    // the pointer (the return then falls back to the item's primary location), mirroring
    // the location-delete null-out in `applyPlan` / `LocationRepository.delete`.
    { col: 'source_location_id', parent: 'locations', nullable: true },
  ],
  // Asset bookings (Phase 78). item_id mirrors the item-child cascade — drop an incoming
  // booking whose asset was removed (ON DELETE CASCADE, NOT NULL). contact_id is nullable
  // (ON DELETE SET NULL): an incoming booking whose contact did not survive the merge keeps
  // the reservation but clears the "booked for" reference, mirroring the checkout
  // source-location / expense-category null-out. (`converted_checkout_id` is a soft pointer,
  // not a synced FK, so it needs no guard — a dangling pointer only affects a derived label.)
  asset_bookings: [
    { col: 'item_id', parent: 'items', nullable: false },
    { col: 'contact_id', parent: 'contacts', nullable: true },
  ],
  maintenance_schedules: [
    { col: 'item_id', parent: 'items', nullable: false },
    // Phase 30: the optional per-location scope. Nullable (NO ACTION) — an incoming
    // schedule whose scope location did not survive the merge keeps the schedule but
    // clears the pointer (it reverts to item-level), mirroring the location-delete
    // null-out in `applyPlan` / `LocationRepository.delete`.
    { col: 'location_id', parent: 'locations', nullable: true },
  ],
  project_bom_lines: [
    { col: 'project_id', parent: 'projects', nullable: false },
    { col: 'item_id', parent: 'items', nullable: true },
  ],
  // Budget categories (Phase 58): drop an incoming category whose project did not survive
  // the merge (it would trip the project's cascade FK), mirroring the BOM-line guard.
  project_budget_categories: [{ col: 'project_id', parent: 'projects', nullable: false }],
  // Expenses (Phase 58): the project_id guard mirrors the BOM line. category_id is nullable
  // (ON DELETE SET NULL) — an incoming expense whose category did not survive the merge keeps
  // the spend but clears the reference (it falls back to "uncategorised"), mirroring the
  // checkout source-location null-out.
  project_expenses: [
    { col: 'project_id', parent: 'projects', nullable: false },
    { col: 'category_id', parent: 'project_budget_categories', nullable: true },
  ],
  // Purchase-order lines (Phase 62). po_id mirrors the cascade children above — drop a line
  // whose order did not survive (ON DELETE CASCADE, NOT NULL). item_id and supplier_part_id
  // are nullable (ON DELETE SET NULL): an incoming line whose item / supplier-part did not
  // survive keeps the line (the order history is real) with the reference cleared, mirroring
  // the checkout source-location / expense-category null-out.
  purchase_order_lines: [
    { col: 'po_id', parent: 'purchase_orders', nullable: false },
    { col: 'item_id', parent: 'items', nullable: true },
    { col: 'supplier_part_id', parent: 'supplier_parts', nullable: true },
  ],
};
