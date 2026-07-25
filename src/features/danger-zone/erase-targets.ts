/**
 * "Erase my data" (Danger Zone) catalog & SQL builders (spec §3 Settings, §7.2/§7.3 sync).
 *
 * The Danger Zone lets a user selectively erase categories of their own data — a single
 * inventory dimension, a whole section, or every local trace of the app — without resorting
 * to the all-or-nothing Safe-Mode hard reset. This module is the *pure* data layer: a static
 * catalog of every erasable target plus the ordered SQL each one runs. It has no browser or
 * React dependencies, so it is exhaustively unit-testable and the UI can render the catalog
 * (labels, tooltips, affected-count badges) straight from {@link ERASE_TARGETS}.
 *
 * Two design rules drive the SQL builders:
 *
 *  1. **Deletions must propagate, not resurrect.** A bare DELETE on a synced device looks to a
 *     peer like a row that should be re-downloaded. So when `tombstone` is requested we emit a
 *     *set-based* tombstone INSERT for every syncable row that will disappear (spec §7.2). FK
 *     cascade deletes do NOT fire row triggers that record tombstones, so every cascaded child
 *     table is listed explicitly here — the catalog is the single source of truth for "what
 *     also goes". `item_history` is the one exception: it is union-by-id reconciled, not LWW,
 *     so it is never tombstoned — instead its prune watermark is advanced (mirroring
 *     {@link StorageRepository.pruneHistoryBefore}) so a peer cannot re-import the cleared rows.
 *
 *  2. **Never corrupt a trigger-maintained projection.** The per-location ledgers
 *     (`item_stock` / `stock_batches`) and the stock-recompute triggers mean we never *reassign*
 *     stock to make a location deletable — the locations target removes only genuinely empty,
 *     non-system locations, leaving anything still holding stock for the user to empty first.
 *
 * The builders emit ONLY data statements (no `PRAGMA`, no `BEGIN`/`COMMIT`); the executor in
 * `erase-actions.ts` prepends the deferred-FK pragma and wraps the whole batch atomically.
 */
import type { SqlStatement } from '@/db/rpc/driver';
import { eraseGroupKeys, type LocalEraseGroupId } from '@/lib/storage-keys';

/** Every distinct thing a user can erase. The UI codes against these ids verbatim. */
export type EraseTargetId =
  | 'items'
  | 'item-photos'
  | 'item-history'
  | 'checkouts'
  | 'maintenance'
  | 'supplier-parts'
  | 'suppliers'
  | 'custom-field-values'
  | 'tags'
  | 'categories'
  | 'field-dictionary'
  | 'locations'
  | 'location-photos'
  | 'projects'
  | 'purchase-orders'
  | 'contacts'
  | 'preferences'
  | 'dashboard-layout'
  | 'saved-searches'
  | 'dismissed-alerts'
  | 'cloud-signin'
  | 'sync-links'
  | 'enabled-features'
  | 'local-ui';

/**
 * The `localStorage` keys the shared registry (`lib/storage-keys.ts`, issue #378) files under
 * this target. The parameter type is the *intersection* of the registry's group union and the
 * target ids above, so a group that isn't a real target here fails to compile at the call site
 * rather than quietly erasing nothing.
 */
function localKeysFor(group: LocalEraseGroupId & EraseTargetId): readonly string[] {
  return eraseGroupKeys(group);
}

/** Grouping for the Danger-Zone UI (one collapsible section per id). */
export type EraseSection = 'inventory' | 'organisation' | 'projects' | 'contacts' | 'local';

/** A single erasable target: its catalog metadata plus, for DB targets, its SQL builder. */
export interface EraseTarget {
  readonly id: EraseTargetId;
  readonly section: EraseSection;
  readonly label: string;
  /** User-facing guidance rendered verbatim by the UI — explains exactly what goes. */
  readonly tooltip: string;
  readonly scope: 'db' | 'local';
  /** `SELECT COUNT(*) AS n FROM …` for the affected-count badge (DB targets). */
  readonly countSql?: string;
  /**
   * localStorage keys removed for this target. Always sourced from {@link eraseGroupKeys} so
   * the registry — not this catalog — decides which keys belong to which target (issue #378).
   */
  readonly localKeys?: readonly string[];
  /** When true, the executor removes the whole OPFS `images/` directory. */
  readonly clearsImages?: boolean;
  /** IndexedDB database names the executor deletes after the DB transaction. */
  readonly clearsIdb?: readonly string[];
  /**
   * Other targets whose data this one ALREADY removes (via FK cascade), so selecting this
   * makes them redundant. The UI shows each as included-and-disabled when this target is
   * ticked, rather than letting the user think the two do separate things. Derived from the
   * schema's `ON DELETE CASCADE` chains — e.g. deleting every `items` row cascades its
   * photos, history, checkouts, maintenance, supplier parts and custom-field values.
   * Deliberately does NOT include `tags`: deleting items only drops the item↔tag links, not
   * the tag dictionary, so the Tags category remains a distinct, separately-erasable thing.
   */
  readonly includes?: readonly EraseTargetId[];
  /**
   * Ordered data statements for this target (NO `PRAGMA` / NO `BEGIN`/`COMMIT` — the
   * executor wraps them in one deferred-FK transaction). Tombstone INSERTs are emitted
   * only when `opts.tombstone` is true; `opts.now` binds the history prune watermark.
   */
  buildStatements?(opts: { tombstone: boolean; now: number }): SqlStatement[];
}

/** The Danger-Zone sections, in display order. */
export const ERASE_SECTIONS: readonly { readonly id: EraseSection; readonly label: string }[] = [
  { id: 'inventory', label: 'Inventory' },
  { id: 'organisation', label: 'Organisation' },
  { id: 'projects', label: 'Projects & purchasing' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'local', label: 'App & this device' },
] as const;

/** Build a set-based tombstone INSERT that records every row a SELECT yields. */
function tombstoneSelect(tableName: string, fromWhere: string): SqlStatement {
  return {
    sql: `INSERT OR REPLACE INTO tombstones (table_name, id) SELECT '${tableName}', id ${fromWhere};`,
  };
}

/**
 * Advance the §7.6.3-A history prune watermark to `now` so a peer cannot re-import the
 * history rows we just cleared (mirrors {@link StorageRepository.pruneHistoryBefore}).
 */
function advanceHistoryWatermark(now: number): SqlStatement {
  return {
    sql: 'UPDATE sync_meta SET history_pruned_before = MAX(history_pruned_before, ?) WHERE id = 1;',
    params: [now],
  };
}

/**
 * The emptiness predicate for a location safe to delete: a non-system location that nothing
 * references. Held identical between the count, the tombstone SELECT and the DELETE so all
 * three agree on exactly which rows go. Aliased `l` so it can be embedded as a sub-query.
 */
const LOCATION_EMPTY_PREDICATE = `l.is_system = 0
  AND NOT EXISTS (SELECT 1 FROM items WHERE location_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM item_stock WHERE location_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM stock_batches WHERE location_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM checkouts WHERE source_location_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM maintenance_schedules WHERE location_id = l.id)`;

/**
 * The full catalog of erasable targets, in a deterministic order. The executor iterates
 * selected targets in THIS order so a combined erase (e.g. items + locations) always runs
 * the parent deletion before the child, and so two runs of the same selection are identical.
 */
export const ERASE_TARGETS: readonly EraseTarget[] = [
  // --- Inventory -------------------------------------------------------------------
  {
    id: 'items',
    section: 'inventory',
    label: 'All items',
    tooltip:
      'Deletes every item and everything attached to it — photos, history, tag links, custom field values, capabilities, checkouts, maintenance schedules, stock and supplier parts. Project BOM and purchase-order lines are kept but unlinked from the deleted items. (The Tags category itself is kept — only the per-item tag links go.)',
    scope: 'db',
    clearsImages: true,
    includes: [
      'item-photos',
      'item-history',
      'checkouts',
      'maintenance',
      'supplier-parts',
      'custom-field-values',
    ],
    countSql: 'SELECT COUNT(*) AS n FROM items',
    buildStatements: ({ tombstone, now }) => {
      const statements: SqlStatement[] = [];
      if (tombstone) {
        // Children first: cascade deletes do not record their own tombstones (§7.2).
        statements.push(
          tombstoneSelect('supplier_parts', 'FROM supplier_parts'),
          tombstoneSelect('item_attachments', 'FROM item_attachments'),
          tombstoneSelect('item_images', 'FROM item_images'),
          tombstoneSelect('item_aliases', 'FROM item_aliases'),
          tombstoneSelect('item_field_values', 'FROM item_field_values'),
          tombstoneSelect('capabilities', 'FROM capabilities'),
          tombstoneSelect('checkouts', 'FROM checkouts'),
          tombstoneSelect('maintenance_schedules', 'FROM maintenance_schedules'),
          tombstoneSelect('stock_batches', 'FROM stock_batches'),
          tombstoneSelect('item_stock', 'FROM item_stock'),
          // item_tags is a composite-key edge — its tombstone id is `item_id|tag_id`.
          {
            sql: "INSERT OR REPLACE INTO tombstones (table_name, id) SELECT 'item_tags', item_id || '|' || tag_id FROM item_tags;",
          },
          tombstoneSelect('items', 'FROM items'),
        );
      }
      // Explicit unlinks so the FK SET NULL is recorded as an intentional, sync-visible
      // edit on the surviving rows (a bare cascade SET NULL would not bump updated_at).
      statements.push(
        { sql: 'UPDATE project_bom_lines SET item_id = NULL WHERE item_id IS NOT NULL;' },
        { sql: 'UPDATE purchase_order_lines SET item_id = NULL WHERE item_id IS NOT NULL;' },
        advanceHistoryWatermark(now),
        // Cascades item_history, item_tags and every child listed above.
        { sql: 'DELETE FROM items;' },
      );
      return statements;
    },
  },
  {
    id: 'item-photos',
    section: 'inventory',
    label: 'Item photos',
    tooltip:
      'Removes every item photo (thumbnails and full-resolution files) while keeping the items themselves.',
    scope: 'db',
    clearsImages: true,
    countSql: 'SELECT COUNT(*) AS n FROM item_images',
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [];
      if (tombstone) statements.push(tombstoneSelect('item_images', 'FROM item_images'));
      statements.push({ sql: 'DELETE FROM item_images;' });
      return statements;
    },
  },
  {
    id: 'location-photos',
    section: 'organisation',
    label: 'Location photos',
    tooltip:
      'Removes every location photo (thumbnails and full-resolution files) and the regions drawn on them, while keeping the locations themselves. Items placed in a region are kept — they are only unplaced.',
    scope: 'db',
    clearsImages: true,
    countSql: 'SELECT COUNT(*) AS n FROM location_photos',
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [];
      if (tombstone) {
        // Children first: deleting a photo cascades to its regions and their item links,
        // and a cascade records no tombstone of its own (§7.2).
        statements.push({
          sql: "INSERT OR REPLACE INTO tombstones (table_name, id) SELECT 'item_regions', item_id || '|' || region_id FROM item_regions;",
        });
        statements.push(
          tombstoneSelect('location_regions', 'FROM location_regions'),
          tombstoneSelect('location_photos', 'FROM location_photos'),
        );
      }
      statements.push({ sql: 'DELETE FROM location_photos;' });
      return statements;
    },
  },
  {
    id: 'item-history',
    section: 'inventory',
    label: 'Activity history',
    tooltip:
      'Clears the activity log for every item. The items and their current state are kept; only the audit trail of past changes is removed.',
    scope: 'db',
    countSql: 'SELECT COUNT(*) AS n FROM item_history',
    buildStatements: ({ now }) => [
      // item_history is union-by-id reconciled, never tombstoned — advance the watermark
      // instead so a peer does not re-import what we just cleared.
      { sql: 'DELETE FROM item_history;' },
      advanceHistoryWatermark(now),
    ],
  },
  {
    id: 'checkouts',
    section: 'inventory',
    label: 'Checkout & loan records',
    tooltip: 'Removes every checkout/loan record. Items and contacts are kept.',
    scope: 'db',
    countSql: 'SELECT COUNT(*) AS n FROM checkouts',
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [];
      if (tombstone) statements.push(tombstoneSelect('checkouts', 'FROM checkouts'));
      statements.push({ sql: 'DELETE FROM checkouts;' });
      return statements;
    },
  },
  {
    id: 'maintenance',
    section: 'inventory',
    label: 'Maintenance schedules',
    tooltip: 'Removes every maintenance and calibration schedule. The items they were attached to are kept.',
    scope: 'db',
    countSql: 'SELECT COUNT(*) AS n FROM maintenance_schedules',
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [];
      if (tombstone) {
        statements.push(tombstoneSelect('maintenance_schedules', 'FROM maintenance_schedules'));
      }
      statements.push({ sql: 'DELETE FROM maintenance_schedules;' });
      return statements;
    },
  },
  {
    id: 'supplier-parts',
    section: 'inventory',
    label: 'Supplier parts',
    tooltip:
      'Removes every supplier/order-code mapping. Purchase-order lines are kept but unlinked from the deleted supplier parts.',
    scope: 'db',
    countSql: 'SELECT COUNT(*) AS n FROM supplier_parts',
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [
        // Explicit unlink so the FK SET NULL syncs as an intentional edit.
        {
          sql: 'UPDATE purchase_order_lines SET supplier_part_id = NULL WHERE supplier_part_id IS NOT NULL;',
        },
      ];
      if (tombstone) statements.push(tombstoneSelect('supplier_parts', 'FROM supplier_parts'));
      statements.push({ sql: 'DELETE FROM supplier_parts;' });
      return statements;
    },
  },
  {
    id: 'suppliers',
    section: 'projects',
    label: 'Suppliers',
    tooltip:
      'Deletes the whole supplier list, and every supplier/order-code mapping with it. Purchase orders are kept — they record what was spent — but no longer name a supplier.',
    scope: 'db',
    countSql: 'SELECT COUNT(*) AS n FROM suppliers',
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [
        // Explicit unlink so both FK SET NULLs sync as intentional edits rather than arriving
        // as silent side effects of the cascade (mirrors the supplier-parts target).
        { sql: 'UPDATE purchase_orders SET supplier_id = NULL WHERE supplier_id IS NOT NULL;' },
        {
          sql: 'UPDATE purchase_order_lines SET supplier_part_id = NULL WHERE supplier_part_id IS NOT NULL;',
        },
      ];
      if (tombstone) {
        statements.push(
          tombstoneSelect('supplier_parts', 'FROM supplier_parts'),
          tombstoneSelect('suppliers', 'FROM suppliers'),
        );
      }
      // Supplier parts cascade from the suppliers delete; the orders above keep their rows.
      statements.push({ sql: 'DELETE FROM suppliers;' });
      return statements;
    },
  },
  {
    id: 'custom-field-values',
    section: 'inventory',
    label: 'Custom field values',
    tooltip:
      "Clears the values stored against items' custom fields. The category field definitions themselves are kept.",
    scope: 'db',
    countSql: 'SELECT COUNT(*) AS n FROM item_field_values',
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [];
      if (tombstone) statements.push(tombstoneSelect('item_field_values', 'FROM item_field_values'));
      statements.push({ sql: 'DELETE FROM item_field_values;' });
      return statements;
    },
  },
  {
    id: 'tags',
    section: 'inventory',
    label: 'Tags',
    tooltip: 'Deletes every tag and removes it from all items. The items themselves are kept.',
    scope: 'db',
    countSql: 'SELECT COUNT(*) AS n FROM tags',
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [];
      if (tombstone) {
        // The item_tags edges cascade-delete with the tags; record their edge tombstones.
        statements.push(
          {
            sql: "INSERT OR REPLACE INTO tombstones (table_name, id) SELECT 'item_tags', item_id || '|' || tag_id FROM item_tags;",
          },
          tombstoneSelect('tags', 'FROM tags'),
        );
      }
      statements.push({ sql: 'DELETE FROM tags;' });
      return statements;
    },
  },
  // --- Organisation ----------------------------------------------------------------
  {
    id: 'categories',
    section: 'organisation',
    label: 'Categories & schemas',
    tooltip:
      'Deletes every category and the custom fields assigned to them, and clears the matching field values from items. Items are kept but become uncategorised. The field dictionary and any values set on locations are kept.',
    scope: 'db',
    includes: ['custom-field-values'],
    countSql: 'SELECT COUNT(*) AS n FROM categories',
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [
        // Explicit unlink so items.category_id SET NULL syncs as an intentional edit.
        { sql: 'UPDATE items SET category_id = NULL WHERE category_id IS NOT NULL;' },
      ];
      if (tombstone) {
        // Since issue #97 item values hang off the *definition*, not off a category's use
        // of it, so deleting categories no longer cascades them — they are deleted
        // explicitly below and so need their own tombstones, not a cascade's.
        statements.push(
          tombstoneSelect('item_field_values', 'FROM item_field_values'),
          tombstoneSelect('category_fields', 'FROM category_fields'),
          tombstoneSelect('categories', 'FROM categories'),
        );
      }
      statements.push(
        // Explicit: the FK cascade from categories reaches category_fields but stops there.
        { sql: 'DELETE FROM item_field_values;' },
        // Cascades category_fields.
        { sql: 'DELETE FROM categories;' },
      );
      return statements;
    },
  },
  {
    id: 'field-dictionary',
    section: 'organisation',
    label: 'Custom field dictionary',
    tooltip:
      'Deletes every custom field definition, and with it the values stored against items and locations. Removes the vocabulary itself, not just the values — use "Custom field values" if you only want to clear what is stored.',
    scope: 'db',
    includes: ['custom-field-values'],
    countSql: 'SELECT COUNT(*) AS n FROM field_defs',
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [];
      if (tombstone) {
        // Children first: cascade deletes do not record their own tombstones (§7.2).
        statements.push(
          tombstoneSelect('item_field_values', 'FROM item_field_values'),
          tombstoneSelect('location_field_values', 'FROM location_field_values'),
          tombstoneSelect('category_fields', 'FROM category_fields'),
          tombstoneSelect('field_defs', 'FROM field_defs'),
        );
      }
      // Cascades category_fields, location_field_values and item_field_values.
      statements.push({ sql: 'DELETE FROM field_defs;' });
      return statements;
    },
  },
  {
    id: 'locations',
    section: 'organisation',
    label: 'Empty custom locations',
    tooltip:
      'Deletes your empty custom locations only. The built-in system locations and any location still holding items or stock are kept — empty those items first if you want the location gone.',
    scope: 'db',
    countSql: `SELECT COUNT(*) AS n FROM locations l WHERE ${LOCATION_EMPTY_PREDICATE}`,
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [];
      if (tombstone) {
        // Children first: the location's inheritable field values cascade away with it
        // (issue #97) and, like every cascade, record no tombstone of their own (§7.2).
        statements.push({
          sql: `INSERT OR REPLACE INTO tombstones (table_name, id)
                SELECT 'location_field_values', lfv.id FROM location_field_values lfv
                WHERE lfv.location_id IN (SELECT l.id FROM locations l WHERE ${LOCATION_EMPTY_PREDICATE});`,
        });
        // Photos of the doomed locations cascade away with them, taking their regions and
        // item placements — none of which tombstone themselves (issue #81, §7.2).
        statements.push({
          sql: `INSERT OR REPLACE INTO tombstones (table_name, id)
                SELECT 'item_regions', ir.item_id || '|' || ir.region_id
                  FROM item_regions ir
                  JOIN location_regions lr ON lr.id = ir.region_id
                  JOIN location_photos  lp ON lp.id = lr.photo_id
                 WHERE lp.location_id IN (SELECT l.id FROM locations l WHERE ${LOCATION_EMPTY_PREDICATE});`,
        });
        statements.push({
          sql: `INSERT OR REPLACE INTO tombstones (table_name, id)
                SELECT 'location_regions', lr.id
                  FROM location_regions lr
                  JOIN location_photos lp ON lp.id = lr.photo_id
                 WHERE lp.location_id IN (SELECT l.id FROM locations l WHERE ${LOCATION_EMPTY_PREDICATE});`,
        });
        statements.push({
          sql: `INSERT OR REPLACE INTO tombstones (table_name, id)
                SELECT 'location_photos', lp.id FROM location_photos lp
                 WHERE lp.location_id IN (SELECT l.id FROM locations l WHERE ${LOCATION_EMPTY_PREDICATE});`,
        });
        statements.push({
          sql: `INSERT OR REPLACE INTO tombstones (table_name, id) SELECT 'locations', l.id FROM locations l WHERE ${LOCATION_EMPTY_PREDICATE};`,
        });
      }
      // Sub-query form so the predicate is evaluated up-front, not row-by-row during delete.
      statements.push({
        sql: `DELETE FROM locations WHERE id IN (SELECT l.id FROM locations l WHERE ${LOCATION_EMPTY_PREDICATE});`,
      });
      return statements;
    },
  },
  // --- Projects & purchasing -------------------------------------------------------
  {
    id: 'projects',
    section: 'projects',
    label: 'Projects',
    tooltip:
      'Deletes every project together with its BOM lines, budget categories and expense ledger. Inventory items referenced by a BOM are kept.',
    scope: 'db',
    countSql: 'SELECT COUNT(*) AS n FROM projects',
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [];
      if (tombstone) {
        statements.push(
          tombstoneSelect('project_expenses', 'FROM project_expenses'),
          tombstoneSelect('project_budget_categories', 'FROM project_budget_categories'),
          tombstoneSelect('project_bom_lines', 'FROM project_bom_lines'),
          tombstoneSelect('projects', 'FROM projects'),
        );
      }
      // Cascades expenses, budget categories and BOM lines.
      statements.push({ sql: 'DELETE FROM projects;' });
      return statements;
    },
  },
  {
    id: 'purchase-orders',
    section: 'projects',
    label: 'Purchase orders',
    tooltip:
      'Deletes every purchase order and its order lines. Inventory items and supplier parts they referenced are kept.',
    scope: 'db',
    countSql: 'SELECT COUNT(*) AS n FROM purchase_orders',
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [];
      if (tombstone) {
        statements.push(
          tombstoneSelect('purchase_order_lines', 'FROM purchase_order_lines'),
          tombstoneSelect('purchase_orders', 'FROM purchase_orders'),
        );
      }
      // Cascades the order lines.
      statements.push({ sql: 'DELETE FROM purchase_orders;' });
      return statements;
    },
  },
  // --- Contacts --------------------------------------------------------------------
  {
    id: 'contacts',
    section: 'contacts',
    label: 'Contacts',
    tooltip:
      'Deletes every contact and their checkout/loan records (these cascade with the contact). Items are kept.',
    scope: 'db',
    includes: ['checkouts'],
    countSql: 'SELECT COUNT(*) AS n FROM contacts',
    buildStatements: ({ tombstone }) => {
      const statements: SqlStatement[] = [];
      if (tombstone) {
        // checkouts cascade-delete with their contact; record their tombstones too.
        statements.push(
          tombstoneSelect('checkouts', 'FROM checkouts'),
          tombstoneSelect('contacts', 'FROM contacts'),
        );
      }
      // Cascades checkouts.
      statements.push({ sql: 'DELETE FROM contacts;' });
      return statements;
    },
  },
  // --- App & this device -----------------------------------------------------------
  //
  // These three hold the settings live settings sharing can carry between devices (issue #382), and
  // they do NOT behave alike — the tooltips say which is which, because a Danger-Zone tooltip is the
  // last place to be vague about reach:
  //
  //  · `preferences` resets the sharing **opt-in itself** (it is one of these preferences), so by the
  //    time the reset lands sharing is already off and nothing is published. The reset really is
  //    local, and it leaves sharing switched off here.
  //  · `dashboard-layout` / `saved-searches` reset stores that do not hold the opt-in, so with
  //    sharing on the restored defaults publish and reach the other devices on their next sync.
  {
    id: 'preferences',
    section: 'local',
    label: 'App preferences',
    tooltip:
      'Resets your app preferences on this device (theme, units, scanner settings and so on) to their defaults. That includes the settings-sharing choice, so sharing switches off here and your other devices keep their own settings.',
    scope: 'local',
    localKeys: localKeysFor('preferences'),
  },
  {
    id: 'dashboard-layout',
    section: 'local',
    label: 'Dashboard layout',
    tooltip:
      'Resets your customised dashboard widget layout on this device — and on your other devices too, if you share the Dashboard settings group between them.',
    scope: 'local',
    localKeys: localKeysFor('dashboard-layout'),
  },
  {
    id: 'saved-searches',
    section: 'local',
    label: 'Saved searches',
    tooltip:
      'Removes the searches you saved on this device — and from your other devices too, if you share the Saved searches settings group between them.',
    scope: 'local',
    localKeys: localKeysFor('saved-searches'),
  },
  {
    id: 'dismissed-alerts',
    section: 'local',
    label: 'Dismissed alerts',
    tooltip:
      'Forgets which alerts you dismissed, and which reminders you have already been notified about, on this device — so any still-relevant ones reappear.',
    scope: 'local',
    localKeys: localKeysFor('dismissed-alerts'),
  },
  {
    id: 'cloud-signin',
    section: 'local',
    label: 'Cloud sign-in',
    tooltip:
      'Signs you out of cloud sync on this device and discards the stored cloud access token. Your data is not deleted.',
    scope: 'local',
    localKeys: localKeysFor('cloud-signin'),
  },
  {
    id: 'sync-links',
    section: 'local',
    label: 'Sync links & pending deletions',
    tooltip:
      'Clears the links between this device and the cloud, plus any pending deletion markers and unresolved sync conflicts. Your inventory is not deleted; the next sync starts fresh.',
    // Lives in the "local" section but writes to the DB (tombstones + sync_meta) and
    // deletes the file-system-access IndexedDB store, so it is a db-scope target. It also
    // clears the local unresolved-conflict list, which the executor removes post-commit.
    scope: 'db',
    clearsIdb: ['gubbins-fs'],
    localKeys: localKeysFor('sync-links'),
    countSql: 'SELECT COUNT(*) AS n FROM tombstones',
    buildStatements: () => [
      // No tombstoning here — we are *clearing* deletion markers, not creating them.
      { sql: 'DELETE FROM tombstones;' },
      // Zero the sync cursor + clock offset, but NEVER touch history_pruned_before
      // (that watermark must survive so pruned history stays pruned).
      { sql: 'UPDATE sync_meta SET last_sync_timestamp = 0, clock_offset = 0 WHERE id = 1;' },
    ],
  },
  {
    id: 'enabled-features',
    section: 'local',
    label: 'Enabled features',
    tooltip:
      'Resets which optional features are switched on for this device, and shows the first-run feature chooser again. No data is deleted.',
    scope: 'local',
    localKeys: localKeysFor('enabled-features'),
  },
  {
    id: 'local-ui',
    section: 'local',
    label: 'Drafts & reminders',
    tooltip:
      'Clears local-only odds and ends on this device: export drafts, app-update reminders, an in-progress stock-take, which location groups are expanded, remembered dialog sizes, and which one-off celebrations have already played.',
    scope: 'local',
    localKeys: localKeysFor('local-ui'),
  },
] as const;

/** Look up a target by id (used by both the executor and the UI). */
export function eraseTargetById(id: EraseTargetId): EraseTarget | undefined {
  return ERASE_TARGETS.find((target) => target.id === id);
}
