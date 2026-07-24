/**
 * LocationRepository (spec §2.1.1, §4, §7.5.3).
 *
 * Encapsulates all SQL for the infinitely nested, self-referential locations
 * hierarchy. Enforces the invariants the schema cannot express alone: the
 * system-locked Unassigned location is immutable; parent moves are cycle-checked
 * with a recursive CTE; and deleting a location re-parents its orphaned items to
 * Unassigned (§4) while promoting its child locations, recording the moves in the
 * immutable Activity Log.
 */
import { DbError } from '../errors';
import type { SqlStatement } from '../rpc/driver';
import { historyStatement } from './item/history';
import { BaseRepository } from './base';
import { planCheckInAllForTarget } from './checkout-plan';
import { markCountedStatement } from './location-count';
import { UNASSIGNED_LOCATION_ID, clampDeadStockDays } from './constants';
import { rowToLocation } from './mappers';
import { parseLocationBranch } from '@/features/inventory/location-path';
import { PACKING_FACTOR_BOUNDS } from '@/lib/volume';
import { tombstoneStatement } from './tombstone';
import type {
  CreateLocationInput,
  Location,
  LocationRow,
  LocationTreeNode,
  LocationWithCount,
  Page,
  PageParams,
  UpdateLocationInput,
} from './types';

interface LocationCountRow extends LocationRow {
  readonly item_count: number;
  readonly used_volume: number;
  readonly measured_units: number;
  readonly total_units: number;
  readonly measured_items: number;
  readonly total_items: number;
}

/**
 * Every location with its live (active) item count (issue #167).
 *
 * The count comes from the trigger-maintained `location_item_counts` cache rather than an
 * aggregate over `items`. The obvious spelling — `LEFT JOIN items … GROUP BY l.id` — scans the
 * whole items table, and since most item writes invalidate the sidebar tree that scan ran on
 * every create, move and delete. Reading the counter makes it a bounded join over the location
 * hierarchy instead, independent of how many items exist.
 *
 * `COALESCE` covers a location with no counter row: the cache only gains one when a location
 * first holds an item, so "no row" and "zero" are the same statement.
 *
 * The volume totals (issue #457) come from a bounded aggregate over the per-location `item_stock`
 * ledger joined to `items` — the "supply" side of cube utilisation, measuring the stock that
 * physically occupies space *here*. It groups by `item_stock.location_id` (the placement) and
 * reads the ledger quantity, never `items.quantity` (the grand total spread across every
 * placement), so stock split across drawers is measured where it actually sits. `used_volume`
 * sums `w·h·d·qty` only for fully-measured items — SQLite's `SUM` skips the NULL product of an
 * item missing any dimension — while the measured/total unit split (needed for the honest
 * coverage caption) uses the `CASE` idiom the valuation reports use. On-hand only (`quantity > 0`)
 * and unlimited-supply items excluded (their quantity is meaningless for space). Indexed by
 * `idx_item_stock_location_id`, so the grouped scan stays bounded.
 *
 * Note this is a *different grain* from the `location_item_counts` counter above, which counts
 * active items by their **home** `location_id` regardless of quantity: so `total_items` here
 * (distinct items with stock physically placed at this location) can legitimately differ from
 * `item_count` (items homed here) when stock is split across locations or an item is unlimited.
 */
const VOLUME_TOTALS_SUBQUERY = `
  SELECT s.location_id AS location_id,
         SUM(i.width * i.height * i.depth * s.quantity) AS used_volume,
         SUM(CASE WHEN i.width IS NOT NULL AND i.height IS NOT NULL AND i.depth IS NOT NULL
                  THEN s.quantity ELSE 0 END) AS measured_units,
         SUM(s.quantity) AS total_units,
         COUNT(CASE WHEN i.width IS NOT NULL AND i.height IS NOT NULL AND i.depth IS NOT NULL
                    THEN 1 END) AS measured_items,
         COUNT(*) AS total_items
  FROM item_stock s
  JOIN items i ON i.id = s.item_id
  WHERE i.is_active = 1 AND s.quantity > 0 AND i.is_unlimited = 0
  GROUP BY s.location_id
`;

const SELECT_WITH_COUNT = `
  SELECT l.id, l.name, l.parent_id, l.is_system, l.description, l.color,
         l.kind, l.capacity, l.is_default, l.archived_at, l.last_counted_at,
         l.dead_stock_mode, l.dead_stock_days,
         l.width, l.height, l.depth, l.usable_volume, l.packing_factor,
         l.walk_order,
         l.updated_at,
         COALESCE(c.item_count, 0) AS item_count,
         COALESCE(v.used_volume, 0) AS used_volume,
         COALESCE(v.measured_units, 0) AS measured_units,
         COALESCE(v.total_units, 0) AS total_units,
         COALESCE(v.measured_items, 0) AS measured_items,
         COALESCE(v.total_items, 0) AS total_items
  FROM locations l
  LEFT JOIN location_item_counts c ON c.location_id = l.id
  LEFT JOIN (${VOLUME_TOTALS_SUBQUERY}) v ON v.location_id = l.id
`;

/**
 * Cycle guard for a parent move (§7.5.3), designed to live in the WHERE clause of the
 * parent-setting `UPDATE` so the check and the write are ONE statement. The recursive CTE walks
 * up from the proposed new parent collecting its ancestors; if the moving node appears there, the
 * move would make a location its own descendant, the `NOT EXISTS` is false, and the `UPDATE`
 * matches zero rows instead of committing the loop.
 *
 * This closes a check-then-write race the standalone {@link LocationRepository.assertParentMoveValid}
 * pre-check cannot: because that check and the write are separate worker messages, two concurrent
 * re-parents (e.g. spamming drag-to-nest) could each pass the pre-check against pre-move state and
 * then both commit, forming A→B→A. Folding the guard into the write makes it atomic under the DB
 * worker's serialised message loop, so a cycle can never be committed no matter the interleaving.
 *
 * Binds, in order: the new parent id (CTE seed), then the moving location's id (the membership
 * test). Kept as a bare `NOT EXISTS (…)` fragment so callers append it to an existing WHERE.
 */
const PARENT_MOVE_CYCLE_GUARD = `NOT EXISTS (
  WITH RECURSIVE ancestors(id) AS (
    SELECT ?
    UNION ALL
    SELECT l.parent_id FROM locations l JOIN ancestors a ON l.id = a.id WHERE l.parent_id IS NOT NULL
  )
  SELECT 1 FROM ancestors WHERE id = ?
)`;

export class LocationRepository extends BaseRepository {
  async getById(id: string): Promise<Location | undefined> {
    const row = await this.driver.queryOne<LocationRow>('SELECT * FROM locations WHERE id = ?;', [id]);
    return row ? rowToLocation(row) : undefined;
  }

  /** A paginated flat list of locations with live (active) item counts. */
  async list(params: PageParams = {}): Promise<Page<LocationWithCount>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<LocationCountRow>(
      `${SELECT_WITH_COUNT}
       ORDER BY l.is_system DESC, l.name COLLATE NOCASE ASC
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(rows.map(toWithCount), limit, offset);
  }

  /**
   * Every location as a flat list — the unpaginated counterpart to {@link getTree}, and
   * justified by the same reasoning: the location hierarchy is a bounded *physical* structure,
   * not the 100k+ item set the pagination mandate (§2.1) targets.
   *
   * The UI's flat list is not a "list" in the scrollable sense — it is the lookup table behind
   * the parent/location pickers, the ancestry and cycle maths, and the sidebar's search and tag
   * filters. All of those give *wrong* answers rather than merely short ones when a location is
   * missing from it (a search finds nothing, an ancestry breadcrumb stops early), so this read is
   * never capped. Use {@link list} where a genuine page is wanted.
   */
  async listAll(): Promise<LocationWithCount[]> {
    const rows = await this.driver.query<LocationCountRow>(
      `${SELECT_WITH_COUNT}
       ORDER BY l.is_system DESC, l.name COLLATE NOCASE ASC;`,
    );
    return rows.map(toWithCount);
  }

  /**
   * The full location hierarchy as a nested tree (powers `useLocationTree`).
   * Locations are a bounded physical hierarchy (not the 100k+ item set), so a
   * single bounded read assembled in memory is appropriate here; the strict RPC
   * pagination mandate (§2.1) targets the item lists feeding virtualisation.
   */
  async getTree(): Promise<LocationTreeNode[]> {
    const rows = await this.driver.query<LocationCountRow>(
      `${SELECT_WITH_COUNT}
       ORDER BY l.is_system DESC, l.name COLLATE NOCASE ASC;`,
    );
    return buildTree(rows.map(toWithCount));
  }

  async create(input: CreateLocationInput): Promise<Location> {
    this.assertPermission('locations:write');
    this.assertWritable();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A location must have a name.');
    }
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      await this.requireExists(parentId);
    }

    const id = crypto.randomUUID();
    const makeDefault = input.isDefault === true;
    const statements: SqlStatement[] = [];
    // Setting this new location as the default demotes any current default in the same
    // transaction, so at most one row ever carries the flag (§4 single-default invariant).
    if (makeDefault) {
      statements.push({ sql: 'UPDATE locations SET is_default = 0 WHERE is_default = 1;' });
    }
    statements.push({
      sql: `INSERT INTO locations (id, name, parent_id, description, color, kind, capacity, is_default,
                                   dead_stock_mode, dead_stock_days,
                                   width, height, depth, usable_volume, packing_factor, walk_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      params: [
        id,
        name,
        parentId,
        normaliseText(input.description),
        normaliseText(input.color),
        normaliseText(input.kind),
        normaliseCapacity(input.capacity),
        makeDefault ? 1 : 0,
        // Defaults to 'inherit' so a new location defers to its parent — dead-stock
        // reporting stays opt-in until the user says otherwise (issue #92).
        input.deadStockMode ?? 'inherit',
        normaliseDeadStockDays(input.deadStockDays),
        // Internal size (issue #457): canonical mm dimensions and the optional mm³ / packing
        // overrides, each coerced to a non-negative REAL (or null) so a bad value never trips
        // the CHECKs. `createPath` spreads the same input onto each leaf, so leaves inherit
        // these for free; the bare ancestors created above never carry them (they pass no
        // dimensions), which is correct — ancestors are structural.
        normaliseDimension(input.width),
        normaliseDimension(input.height),
        normaliseDimension(input.depth),
        normaliseDimension(input.usableVolume),
        normalisePackingFactor(input.packingFactor),
        // Walk-order ordinal (issue #461); null when unplaced, coerced to a non-negative
        // integer so a bad value can never trip the CHECK.
        normaliseWalkOrder(input.walkOrder),
      ],
    });
    await this.driver.transaction(statements);
    return (await this.getById(id))!;
  }

  /**
   * Create a whole branch of the hierarchy from the nested-create shortcut (spec §4), which
   * spans two axes at once (see {@link parseLocationBranch}):
   *
   * - a `/`- or `\`-separated **path** goes *down* the tree, e.g. `Workshop/Cabinet A/Drawer 3`
   *   yields Workshop → Cabinet A → Drawer 3;
   * - a `,`-separated **list** at the leaf level fans *across* into siblings, e.g.
   *   `Garage/Box 1, Box 2, Box 3` yields three boxes under Garage.
   *
   * Each ancestor level is created under the running parent **only if a same-named child
   * doesn't already exist** there — an existing ancestor is reused, never duplicated — so the
   * same path can be typed repeatedly and only the genuinely-missing levels are added. The
   * intermediate ancestors are created bare; every leaf carries the full input (description,
   * colour, kind, capacity, default), since those are the locations the user was configuring;
   * a leaf that already exists is reused untouched rather than clobbered. Returns each resolved
   * leaf, in the order given. A single plain name (no separator) is exactly one leaf and behaves
   * exactly like {@link create}.
   *
   * The branch is created level-by-level rather than in one transaction: the hierarchy is a
   * small, low-frequency physical structure, and each {@link create} already carries the
   * INSERT + single-default-demotion invariants we want to reuse verbatim.
   */
  async createPath(input: CreateLocationInput): Promise<Location[]> {
    this.assertPermission('locations:write');
    this.assertWritable();
    const { ancestors, leaves } = parseLocationBranch(input.name);
    if (leaves.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A location must have a name.');
    }

    let parentId = input.parentId ?? null;
    if (parentId !== null) {
      await this.requireExists(parentId);
    }

    // Walk the shared ancestor chain: reuse a level if present, else create it bare.
    for (const level of ancestors) {
      const existing = await this.findChildByName(parentId, level);
      parentId = existing ? existing.id : (await this.create({ name: level, parentId })).id;
    }

    // Create each leaf sibling under the resolved parent, reusing any that already exist so the
    // shortcut only ever fills in what's missing.
    const created: Location[] = [];
    for (const leafName of leaves) {
      const existingLeaf = await this.findChildByName(parentId, leafName);
      created.push(existingLeaf ?? (await this.create({ ...input, name: leafName, parentId })));
    }
    return created;
  }

  async update(id: string, input: UpdateLocationInput): Promise<Location> {
    this.assertPermission('locations:write');
    this.assertWritable();
    await this.assertMutable(id);

    if (input.parentId !== undefined) {
      await this.assertParentMoveValid(id, input.parentId);
    }

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A location must have a name.');
      }
      sets.push('name = ?');
      params.push(name);
    }
    if (input.parentId !== undefined) {
      sets.push('parent_id = ?');
      params.push(input.parentId);
    }
    if (input.description !== undefined) {
      sets.push('description = ?');
      params.push(normaliseText(input.description));
    }
    if (input.color !== undefined) {
      sets.push('color = ?');
      params.push(normaliseText(input.color));
    }
    if (input.kind !== undefined) {
      sets.push('kind = ?');
      params.push(normaliseText(input.kind));
    }
    if (input.capacity !== undefined) {
      sets.push('capacity = ?');
      params.push(normaliseCapacity(input.capacity));
    }
    if (input.isDefault !== undefined) {
      sets.push('is_default = ?');
      params.push(input.isDefault ? 1 : 0);
    }
    if (input.archivedAt !== undefined) {
      sets.push('archived_at = ?');
      params.push(input.archivedAt);
    }
    if (input.deadStockMode !== undefined) {
      // Dead-stock reporting for everything stored here (issue #92); 'inherit' hands the
      // decision back to the parent location. The DB CHECK mirrors DEAD_STOCK_MODES.
      sets.push('dead_stock_mode = ?');
      params.push(input.deadStockMode);
    }
    if (input.deadStockDays !== undefined) {
      // An idle-days override for this subtree; null defers up the tree to the global
      // preference. Clamped so a mistyped value can't disable the report or flag everything.
      sets.push('dead_stock_days = ?');
      params.push(normaliseDeadStockDays(input.deadStockDays));
    }
    // Internal size (issue #457): each is cleared-or-set independently, so an untouched field
    // (undefined) never rewrites the stored value. `null` clears; a number is coerced to a
    // safe non-negative REAL (dimensions/volume) or clamped to (0,1] (packing factor).
    if (input.width !== undefined) {
      sets.push('width = ?');
      params.push(normaliseDimension(input.width));
    }
    if (input.height !== undefined) {
      sets.push('height = ?');
      params.push(normaliseDimension(input.height));
    }
    if (input.depth !== undefined) {
      sets.push('depth = ?');
      params.push(normaliseDimension(input.depth));
    }
    if (input.usableVolume !== undefined) {
      sets.push('usable_volume = ?');
      params.push(normaliseDimension(input.usableVolume));
    }
    if (input.packingFactor !== undefined) {
      sets.push('packing_factor = ?');
      params.push(normalisePackingFactor(input.packingFactor));
    }
    // Picking-sweep position (issue #461): null clears (unplaced, sorts last), a number is
    // coerced to a non-negative integer. Undefined leaves the stored value untouched.
    if (input.walkOrder !== undefined) {
      sets.push('walk_order = ?');
      params.push(normaliseWalkOrder(input.walkOrder));
    }

    // Only guard when nesting under a real parent — a move to the root (null) can never cycle.
    const guardCycle = input.parentId != null;
    if (sets.length > 0) {
      const statements: SqlStatement[] = [];
      // Promoting this row to the default demotes any other default in the same
      // transaction (§4 single-default invariant); exclude self so the flag survives. The demotion
      // carries the SAME cycle guard as the main update below, so that if a concurrent re-parent
      // has made this an illegal move the whole transaction no-ops together — never clearing the
      // old default while the guarded main update refuses to set the new one.
      if (input.isDefault === true) {
        statements.push({
          sql: `UPDATE locations SET is_default = 0 WHERE is_default = 1 AND id <> ?${guardCycle ? ` AND ${PARENT_MOVE_CYCLE_GUARD}` : ''};`,
          params: guardCycle ? [id, input.parentId, id] : [id],
        });
      }
      // The cycle guard rides in the WHERE so the check is atomic with the write (see
      // PARENT_MOVE_CYCLE_GUARD): a concurrent re-parent cannot slip a loop past it. When it
      // vetoes the move the whole UPDATE matches zero rows — detected via the re-read below.
      statements.push({
        sql: `UPDATE locations SET ${sets.join(', ')} WHERE id = ?${guardCycle ? ` AND ${PARENT_MOVE_CYCLE_GUARD}` : ''};`,
        params: guardCycle ? [...params, id, input.parentId, id] : [...params, id],
      });
      await this.driver.transaction(statements);
    }
    const updated = (await this.getById(id))!;
    // If a requested (non-null) parent move didn't land, the atomic guard refused it because a
    // concurrent re-parent had already made the target a descendant between our pre-check and our
    // write. Surface the same cycle error the pre-check raises so the loser of the race is told,
    // rather than reporting a silent no-op as success.
    if (guardCycle && updated.parentId !== input.parentId) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Moving this location there would create a cyclical nesting loop.',
      );
    }
    return updated;
  }

  /**
   * Mark a location as the single default (pre-selected when adding items), or clear the
   * default entirely. Setting a new default demotes the previous one atomically; system
   * locations may never be the default.
   */
  async setDefault(id: string): Promise<Location> {
    this.assertPermission('locations:write');
    return this.update(id, { isDefault: true });
  }

  /** Soft-archive a location (hide it from the tree/pickers) or restore it. */
  async setArchived(id: string, archived: boolean): Promise<Location> {
    this.assertPermission('locations:write');
    return this.update(id, { archivedAt: archived ? Date.now() : null });
  }

  /**
   * Stamp a location as counted just now (spec §4.4 stock-take group G) — the durable
   * "last counted" record written whenever a cycle-count/audit-day walk completes at this
   * location, whether the count was clean or reconciled variances. Deliberately its own
   * method rather than a field on {@link update}: it carries no other input, needs no
   * cycle guard, and is called from the count engine rather than a location-edit form.
   *
   * A system location cannot be stamped: `trg_locations_protect_system_update` aborts *any*
   * UPDATE on one, so the guard here only surfaces that as a clear error rather than a raw
   * constraint failure. Counting one is still allowed — see `authoriseCount`, which simply
   * omits the stamp rather than failing the whole count over it (issue #301).
   */
  async markCounted(id: string, at: number = Date.now()): Promise<Location> {
    this.assertPermission('locations:write');
    this.assertWritable();
    await this.assertMutable(id);
    const { sql, params } = markCountedStatement(id, at);
    await this.driver.execute(sql, params ?? []);
    return (await this.getById(id))!;
  }

  /**
   * Delete a location. Orphaned items default to Unassigned (§4); child locations
   * are promoted to the deleted node's parent. The whole operation is one atomic
   * transaction, and each re-parented item gets an Activity Log entry. Deletes are
   * permitted even under the storage Hard Stop (they free space).
   *
   * Every tool still out *to* this location as a borrower is returned first (B4), inside this
   * same transaction (issue #301) rather than a preceding awaited call — so a failed delete
   * can't leave those loans force-returned against a location that still exists.
   */
  async delete(id: string): Promise<void> {
    this.assertPermission('locations:delete');
    const location = await this.getById(id);
    if (!location) return;
    if (location.isSystem) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'The Unassigned location is system-locked and cannot be deleted.',
      );
    }

    // Return every loan borrowed *by* this location before anything else, so the restored
    // stock lands while the location's placements still exist and is then re-homed to
    // Unassigned by the batch move below along with the rest. (This is the loan *target*; the
    // distinct `source_location_id` pointer is nulled separately further down.)
    const returns = await planCheckInAllForTarget(this.driver, 'location', id, this.actorId());

    const orphanedItems = await this.driver.query<{ id: string }>(
      'SELECT id FROM items WHERE location_id = ?;',
      [id],
    );

    const statements: SqlStatement[] = [...returns];

    // Re-parent orphaned items to Unassigned and log each move.
    if (orphanedItems.length > 0) {
      statements.push({
        sql: 'UPDATE items SET location_id = ? WHERE location_id = ?;',
        params: [UNASSIGNED_LOCATION_ID, id],
      });
      for (const item of orphanedItems) {
        statements.push(
          historyStatement(item.id, 'RE_PARENTED', this.actorId(), {
            note: `Re-parented to Unassigned: location "${location.name}" was deleted.`,
            metadata: { fromLocationId: id, toLocationId: UNASSIGNED_LOCATION_ID },
          }),
        );
      }
    }

    // Re-home every batch sitting at the deleted location into each item's Unassigned
    // placement (Phase 28 — `stock_batches` is the SSOT below `item_stock`), preserving each
    // lot's identity and merging same-key lots by the deterministic batch id. The recompute
    // triggers then re-derive `item_stock.quantity` (and `items.quantity`) at Unassigned, so
    // the grand total per item is preserved (the units just move home). The deleted
    // location's batch and placement rows are then dropped — otherwise their RESTRICT foreign
    // key would block the delete.
    statements.push({
      sql: `INSERT INTO stock_batches
              (id, item_id, location_id, batch_key, batch_number, lot_number, expiry_date, quantity)
            SELECT item_id || '|' || ? || '|' || batch_key, item_id, ?, batch_key,
                   batch_number, lot_number, expiry_date, quantity
            FROM stock_batches WHERE location_id = ? AND quantity > 0
            ON CONFLICT(id) DO UPDATE SET quantity = stock_batches.quantity + excluded.quantity;`,
      params: [UNASSIGNED_LOCATION_ID, UNASSIGNED_LOCATION_ID, id],
    });
    statements.push({ sql: 'DELETE FROM stock_batches WHERE location_id = ?;', params: [id] });
    statements.push({ sql: 'DELETE FROM item_stock WHERE location_id = ?;', params: [id] });

    // Clear the lend-from pointer on any checkout drawn from this location (Phase 26):
    // an open loan's returned stock will fall back to the item's primary location, and the
    // nullable FK would otherwise block the location's RESTRICT delete (mirrors the §7.5.2
    // sync `applyPlan` null-out).
    statements.push({
      sql: 'UPDATE checkouts SET source_location_id = NULL WHERE source_location_id = ?;',
      params: [id],
    });

    // Clear the per-location scope on any maintenance schedule pinned to this location
    // (Phase 30): the schedule reverts to item-level rather than vanishing, and the
    // nullable RESTRICT FK would otherwise block the delete (mirrors the §7.5.2 sync
    // `applyPlan` null-out and the checkout source above).
    statements.push({
      sql: 'UPDATE maintenance_schedules SET location_id = NULL WHERE location_id = ?;',
      params: [id],
    });

    // Promote child locations to the deleted node's parent.
    statements.push({
      sql: 'UPDATE locations SET parent_id = ? WHERE parent_id = ?;',
      params: [location.parentId, id],
    });

    statements.push({ sql: 'DELETE FROM locations WHERE id = ?;', params: [id] });
    // Propagate the hard delete on the next sync (§7.2). Re-parented items keep
    // their own (live) rows; only the removed location is tombstoned.
    statements.push(tombstoneStatement('locations', id));

    await this.driver.transaction(statements);
  }

  // --- internals -----------------------------------------------------------------

  /**
   * Find a direct child of `parentId` (or a root, when null) whose name matches `name`
   * case-insensitively — the "does this level already exist?" lookup that lets
   * {@link createPath} reuse an ancestor instead of duplicating it. The NOCASE match mirrors
   * the tree's `name COLLATE NOCASE` ordering, so `workshop` and `Workshop` are one level.
   */
  private async findChildByName(parentId: string | null, name: string): Promise<Location | undefined> {
    const trimmed = name.trim();
    const row = await this.driver.queryOne<LocationRow>(
      parentId === null
        ? 'SELECT * FROM locations WHERE parent_id IS NULL AND name = ? COLLATE NOCASE LIMIT 1;'
        : 'SELECT * FROM locations WHERE parent_id = ? AND name = ? COLLATE NOCASE LIMIT 1;',
      parentId === null ? [trimmed] : [parentId, trimmed],
    );
    return row ? rowToLocation(row) : undefined;
  }

  private async requireExists(id: string): Promise<void> {
    const exists = await this.driver.queryOne('SELECT 1 AS ok FROM locations WHERE id = ?;', [id]);
    if (!exists) {
      throw new DbError('SQLITE_CONSTRAINT_FOREIGNKEY', `Location "${id}" does not exist.`);
    }
  }

  private async assertMutable(id: string): Promise<void> {
    const location = await this.getById(id);
    if (!location) {
      throw new DbError('SQLITE_CONSTRAINT', `Location "${id}" does not exist.`);
    }
    if (location.isSystem) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'The Unassigned location is system-locked and cannot be modified.',
      );
    }
  }

  /**
   * Reject a parent move that would create a cycle (§7.5.3): a location may not
   * become its own descendant. Walks up from the proposed parent via a recursive
   * CTE; a cycle exists if the moving node appears in that ancestor chain.
   */
  private async assertParentMoveValid(id: string, newParentId: string | null): Promise<void> {
    if (newParentId === null) return;
    if (newParentId === id) {
      throw new DbError('SQLITE_CONSTRAINT', 'A location cannot be its own parent.');
    }
    await this.requireExists(newParentId);

    // UNION (not UNION ALL) terminates even if the data somehow already held a cycle
    // (issue #190) — otherwise this walk runs forever and hangs the database worker.
    const cycle = await this.driver.queryOne<{ id: string }>(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT ?
         UNION
         SELECT l.parent_id FROM locations l
         JOIN ancestors a ON l.id = a.id
         WHERE l.parent_id IS NOT NULL
       )
       SELECT id FROM ancestors WHERE id = ? LIMIT 1;`,
      [newParentId, id],
    );
    if (cycle) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Moving this location there would create a cyclical nesting loop.',
      );
    }
  }
}

function toWithCount(row: LocationCountRow): LocationWithCount {
  return {
    ...rowToLocation(row),
    itemCount: Number(row.item_count),
    volumeTotals: {
      usedVolume: Number(row.used_volume),
      measuredUnits: Number(row.measured_units),
      totalUnits: Number(row.total_units),
      measuredItems: Number(row.measured_items),
      totalItems: Number(row.total_items),
    },
  };
}

/** Trim a free-text/key field, collapsing blank/whitespace-only input to NULL. */
function normaliseText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Coerce a capacity to a non-negative integer, or NULL for "unbounded". A blank, NaN,
 * negative or non-finite value collapses to NULL so a cleared field means "no limit".
 */
function normaliseCapacity(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * Coerce a location dimension / usable-volume to a non-negative finite REAL, or NULL for "not
 * measured" (issue #457). Unlike {@link normaliseCapacity} these are REAL columns (canonical mm
 * / mm³, a 30.5 mm drawer is real), so the value is kept whole — **no `Math.floor`**. A blank,
 * NaN, negative or non-finite value collapses to NULL so a cleared field means "not measured".
 */
function normaliseDimension(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Coerce a per-location packing factor to the safe `[min, 1]` fraction, or NULL to defer to the
 * global `defaultPackingFactor` preference (issue #457). Zero, negative, > 1, NaN or non-finite
 * collapse to NULL ("no override"); a positive-but-below-floor value is clamped **up** to the same
 * floor the global default and the entry field enforce, so no write path (import, sync, API) can
 * store a near-zero factor that would make a measured location read as wildly over-full.
 */
function normalisePackingFactor(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0 || value > 1) return null;
  return Math.max(PACKING_FACTOR_BOUNDS.min, value);
}

/**
 * Coerce a walk-order ordinal to a non-negative integer, or NULL for "unplaced" (issue #461).
 * A blank, NaN, negative or non-finite value collapses to NULL so a cleared field drops the
 * location off the route — where it sorts after every placed location. Floored to a whole
 * number: walk order is a rung on a sequence, not a measured quantity.
 */
function normaliseWalkOrder(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * Normalise a location's dead-stock idle-days override (issue #92): null/blank/invalid ⇒
 * no override (defer up the tree), otherwise a whole number clamped to the same bounds the
 * global preference uses, so the DB's `> 0` CHECK can never be tripped by user input.
 */
function normaliseDeadStockDays(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return clampDeadStockDays(value);
}

/** Assemble flat rows into a parent/child tree, preserving input ordering. */
function buildTree(nodes: readonly LocationWithCount[]): LocationTreeNode[] {
  const byId = new Map<string, LocationTreeNode>();
  for (const node of nodes) byId.set(node.id, { ...node, children: [] });

  const roots: LocationTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId !== null && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
