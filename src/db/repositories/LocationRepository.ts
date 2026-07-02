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
import { BaseRepository } from './base';
import { UNASSIGNED_LOCATION_ID } from './constants';
import { rowToLocation } from './mappers';
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
         l.kind, l.capacity, l.is_default, l.archived_at, l.updated_at,
         COUNT(i.id) AS item_count
  FROM locations l
  LEFT JOIN items i ON i.location_id = l.id AND i.is_active = 1
`;

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
      sql: `INSERT INTO locations (id, name, parent_id, description, color, kind, capacity, is_default)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      params: [
        id,
        name,
        parentId,
        normaliseText(input.description),
        normaliseText(input.color),
        normaliseText(input.kind),
        normaliseCapacity(input.capacity),
        makeDefault ? 1 : 0,
      ],
    });
    await this.driver.transaction(statements);
    return (await this.getById(id))!;
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

    if (sets.length > 0) {
      const statements: SqlStatement[] = [];
      // Promoting this row to the default demotes any other default in the same
      // transaction (§4 single-default invariant); exclude self so the flag survives.
      if (input.isDefault === true) {
        statements.push({
          sql: 'UPDATE locations SET is_default = 0 WHERE is_default = 1 AND id <> ?;',
          params: [id],
        });
      }
      statements.push({
        sql: `UPDATE locations SET ${sets.join(', ')} WHERE id = ?;`,
        params: [...params, id],
      });
      await this.driver.transaction(statements);
    }
    return (await this.getById(id))!;
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
   * Delete a location. Orphaned items default to Unassigned (§4); child locations
   * are promoted to the deleted node's parent. The whole operation is one atomic
   * transaction, and each re-parented item gets an Activity Log entry. Deletes are
   * permitted even under the storage Hard Stop (they free space).
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

    const orphanedItems = await this.driver.query<{ id: string }>(
      'SELECT id FROM items WHERE location_id = ?;',
      [id],
    );

    const statements: SqlStatement[] = [];

    // Re-parent orphaned items to Unassigned and log each move.
    if (orphanedItems.length > 0) {
      statements.push({
        sql: 'UPDATE items SET location_id = ? WHERE location_id = ?;',
        params: [UNASSIGNED_LOCATION_ID, id],
      });
      for (const item of orphanedItems) {
        statements.push({
          sql: `INSERT INTO item_history (id, item_id, action, note, metadata)
                VALUES (?, ?, 'RE_PARENTED', ?, ?);`,
          params: [
            crypto.randomUUID(),
            item.id,
            `Re-parented to Unassigned: location "${location.name}" was deleted.`,
            JSON.stringify({ fromLocationId: id, toLocationId: UNASSIGNED_LOCATION_ID }),
          ],
        });
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
