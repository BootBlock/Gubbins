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
}

const SELECT_WITH_COUNT = `
  SELECT l.id, l.name, l.parent_id, l.is_system, l.description, l.color,
         l.kind, l.capacity, l.is_default, l.archived_at, l.last_counted_at,
         l.dead_stock_mode, l.dead_stock_days, l.updated_at,
         COUNT(i.id) AS item_count
  FROM locations l
  LEFT JOIN items i ON i.location_id = l.id AND i.is_active = 1
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
       GROUP BY l.id
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
       GROUP BY l.id
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
       GROUP BY l.id
       ORDER BY l.is_system DESC, l.name COLLATE NOCASE ASC;`,
    );
    return buildTree(rows.map(toWithCount));
  }

  async create(input: CreateLocationInput): Promise<Location> {
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
                                   dead_stock_mode, dead_stock_days)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
    return this.update(id, { isDefault: true });
  }

  /** Soft-archive a location (hide it from the tree/pickers) or restore it. */
  async setArchived(id: string, archived: boolean): Promise<Location> {
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

    const cycle = await this.driver.queryOne<{ id: string }>(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT ?
         UNION ALL
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
  return { ...rowToLocation(row), itemCount: Number(row.item_count) };
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
