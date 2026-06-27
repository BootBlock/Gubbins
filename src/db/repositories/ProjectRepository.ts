/**
 * ProjectRepository (spec §2.1.1, §4 "Projects & BOMs", Phase 4).
 *
 * Owns projects, their BOM lines, reservations (Tentative vs Actual), the liminal
 * "In Transit" procurement lifecycle, BOM costing (Current Replacement Value vs
 * Point-in-Time Snapshot), the automated Shopping List, and the three terminal
 * assembly outcomes (Container / Singular Object / Permanent Consumption).
 *
 * All SQL lives here over the injected driver (§2.1.1) — components never write SQL.
 * Multi-row writes go through `driver.transaction` for atomicity, and every change
 * that affects a *matched* inventory item also appends to the immutable Activity
 * Log (`item_history`) in the same transaction, so the ledger never drifts.
 *
 * Reservations are modelled as ledger annotations on the BOM line: they do not
 * mutate an item's on-hand `quantity` (which tracks physical stock). The Shopping
 * List therefore computes shortfall as `required − reserved` per line.
 */
import { DbError } from '../errors';
import type { SqlStatement, SqlValue } from '../rpc/driver';
import { BaseRepository } from './base';
import { UNASSIGNED_LOCATION_ID } from './constants';
import type { CostingMode, ProcurementStatus, ReservationStatus } from './constants';
import { rowToBomLine, rowToProject } from './mappers';
import type {
  CreateBomLineInput,
  CreateProjectInput,
  FinaliseAssemblyInput,
  Page,
  PageParams,
  Project,
  ProjectBomLine,
  ProjectBomLineRow,
  ProjectCosting,
  ProjectRow,
  ProjectWithCount,
  ShoppingListEntry,
  UpdateBomLineInput,
  UpdateProjectInput,
} from './types';

interface ProjectCountRow extends ProjectRow {
  readonly line_count: number;
}

/** The outcome of finalising an assembly — whichever artefacts it produced. */
export interface AssemblyResult {
  /** The new container location id (CONTAINER outcome). */
  readonly locationId?: string;
  /** The new singular-object item id (SINGULAR_OBJECT outcome). */
  readonly itemId?: string;
}

export class ProjectRepository extends BaseRepository {
  // --- projects ------------------------------------------------------------------

  async getById(id: string): Promise<Project | undefined> {
    const row = await this.driver.queryOne<ProjectRow>('SELECT * FROM projects WHERE id = ?;', [id]);
    return row ? rowToProject(row) : undefined;
  }

  /** Paginated list of projects with their BOM-line counts, newest first. */
  async list(params: PageParams = {}): Promise<Page<ProjectWithCount>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<ProjectCountRow>(
      `SELECT p.*, COUNT(l.id) AS line_count
       FROM projects p
       LEFT JOIN project_bom_lines l ON l.project_id = p.id
       GROUP BY p.id
       ORDER BY p.created_at DESC, p.name COLLATE NOCASE ASC
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(
      rows.map((r) => ({ ...rowToProject(r), lineCount: Number(r.line_count) })),
      limit,
      offset,
    );
  }

  async create(input: CreateProjectInput): Promise<Project> {
    this.assertWritable();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A project must have a name.');
    }
    const id = crypto.randomUUID();
    await this.driver.execute(
      'INSERT INTO projects (id, name, description, costing_mode) VALUES (?, ?, ?, ?);',
      [id, name, input.description ?? null, input.costingMode ?? 'CURRENT_REPLACEMENT'],
    );
    return (await this.getById(id))!;
  }

  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    this.assertWritable();
    await this.requireProject(id);

    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A project must have a name.');
      }
      sets.push('name = ?');
      params.push(name);
    }
    if (input.description !== undefined) {
      sets.push('description = ?');
      params.push(input.description);
    }
    if (input.status !== undefined) {
      sets.push('status = ?');
      params.push(input.status);
    }
    if (input.costingMode !== undefined) {
      sets.push('costing_mode = ?');
      params.push(input.costingMode);
    }
    if (sets.length > 0) {
      params.push(id);
      await this.driver.execute(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?;`, params);
    }
    return (await this.getById(id))!;
  }

  /** Set just the BOM costing mode (spec §4 toggle). */
  async setCostingMode(id: string, mode: CostingMode): Promise<Project> {
    return this.update(id, { costingMode: mode });
  }

  /** Hard delete a project; its BOM lines cascade away. Allowed under Hard Stop. */
  async delete(id: string): Promise<void> {
    await this.driver.execute('DELETE FROM projects WHERE id = ?;', [id]);
  }

  // --- BOM lines -----------------------------------------------------------------

  /** Paginated BOM lines for a project, in declared order (spec §2.1). */
  async listLines(projectId: string, params: PageParams = {}): Promise<Page<ProjectBomLine>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<ProjectBomLineRow>(
      `SELECT * FROM project_bom_lines WHERE project_id = ?
       ORDER BY position ASC, created_at ASC
       LIMIT ? OFFSET ?;`,
      [projectId, limit, offset],
    );
    return this.toPage(rows.map(rowToBomLine), limit, offset);
  }

  /**
   * Add a BOM line. When `itemId` matches a local item, the line's mpn,
   * manufacturer, description and point-in-time `unit_cost_snapshot` default from
   * that item (§4 BOM Costing snapshot). A line must carry at least an item match
   * or some descriptive text.
   */
  async addLine(projectId: string, input: CreateBomLineInput): Promise<ProjectBomLine> {
    this.assertWritable();
    await this.requireProject(projectId);

    let mpn = normalise(input.mpn);
    let manufacturer = normalise(input.manufacturer);
    let description = normalise(input.description);
    let snapshot: number | null = null;

    if (input.itemId) {
      const item = await this.driver.queryOne<{
        name: string;
        mpn: string | null;
        manufacturer: string | null;
        unit_cost: number | null;
      }>('SELECT name, mpn, manufacturer, unit_cost FROM items WHERE id = ?;', [input.itemId]);
      if (!item) {
        throw new DbError('SQLITE_CONSTRAINT_FOREIGNKEY', `Item "${input.itemId}" does not exist.`);
      }
      mpn ??= item.mpn;
      manufacturer ??= item.manufacturer;
      description ??= item.name;
      snapshot = item.unit_cost;
    }

    if (!input.itemId && !mpn && !description && !normalise(input.designator)) {
      throw new DbError('SQLITE_CONSTRAINT', 'A BOM line needs a matched item or a description.');
    }

    const requiredQty = Math.max(0, Math.floor(input.requiredQty ?? 1));
    const position = input.position ?? (await this.nextPosition(projectId));
    const id = crypto.randomUUID();

    await this.driver.execute(
      `INSERT INTO project_bom_lines
         (id, project_id, item_id, designator, mpn, manufacturer, description,
          required_qty, unit_cost_snapshot, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        projectId,
        input.itemId ?? null,
        normalise(input.designator),
        mpn,
        manufacturer,
        description,
        requiredQty,
        snapshot,
        position,
      ],
    );
    return (await this.requireLine(id)).line;
  }

  async updateLine(lineId: string, input: UpdateBomLineInput): Promise<ProjectBomLine> {
    this.assertWritable();
    await this.requireLine(lineId);

    const sets: string[] = [];
    const params: SqlValue[] = [];
    const set = (col: string, value: SqlValue) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };
    if (input.itemId !== undefined) set('item_id', input.itemId);
    if (input.designator !== undefined) set('designator', normalise(input.designator));
    if (input.mpn !== undefined) set('mpn', normalise(input.mpn));
    if (input.manufacturer !== undefined) set('manufacturer', normalise(input.manufacturer));
    if (input.description !== undefined) set('description', normalise(input.description));
    if (input.requiredQty !== undefined) set('required_qty', Math.max(0, Math.floor(input.requiredQty)));
    if (input.position !== undefined) set('position', input.position);

    if (sets.length > 0) {
      params.push(lineId);
      await this.driver.execute(
        `UPDATE project_bom_lines SET ${sets.join(', ')} WHERE id = ?;`,
        params,
      );
    }
    return (await this.requireLine(lineId)).line;
  }

  async removeLine(lineId: string): Promise<void> {
    await this.driver.execute('DELETE FROM project_bom_lines WHERE id = ?;', [lineId]);
  }

  // --- reservations (spec §4 Tentative vs Actual) --------------------------------

  /**
   * Set a BOM line's reservation. TENTATIVE is a soft hold; ACTUAL commits stock
   * and is recorded in the matched item's Activity Log (§4). The reserved quantity
   * defaults to the full requirement and is clamped to it. NONE clears the hold.
   */
  async setReservation(
    lineId: string,
    status: ReservationStatus,
    qty?: number,
  ): Promise<ProjectBomLine> {
    this.assertWritable();
    const { line } = await this.requireLine(lineId);

    const reservedQty =
      status === 'NONE'
        ? 0
        : Math.max(0, Math.min(line.requiredQty, Math.floor(qty ?? line.requiredQty)));

    const statements: SqlStatement[] = [
      {
        sql: 'UPDATE project_bom_lines SET reservation_status = ?, reserved_qty = ? WHERE id = ?;',
        params: [status, reservedQty, lineId],
      },
    ];

    if (line.itemId) {
      const enteringActual = status === 'ACTUAL' && line.reservationStatus !== 'ACTUAL';
      const leavingActual = status !== 'ACTUAL' && line.reservationStatus === 'ACTUAL';
      if (enteringActual) {
        statements.push(
          itemHistory(line.itemId, 'RESERVED', {
            quantityDelta: reservedQty,
            note: `Reserved ${reservedQty} for a project.`,
          }),
        );
      } else if (leavingActual) {
        statements.push(
          itemHistory(line.itemId, 'RESERVATION_CLEARED', {
            note: 'Project reservation released.',
          }),
        );
      }
    }

    await this.driver.transaction(statements);
    return (await this.requireLine(lineId)).line;
  }

  // --- procurement & In-Transit (spec §4 liminal procurement) --------------------

  /**
   * Move a BOM line through the procurement lifecycle (Ordered → In-Transit →
   * Received). Entering IN_TRANSIT logs a PROCURED entry against a matched item,
   * marking incoming stock as arriving (the "In Transit" liminal state, §4).
   */
  async setProcurement(lineId: string, status: ProcurementStatus): Promise<ProjectBomLine> {
    this.assertWritable();
    const { line } = await this.requireLine(lineId);

    const statements: SqlStatement[] = [
      {
        sql: 'UPDATE project_bom_lines SET procurement_status = ? WHERE id = ?;',
        params: [status, lineId],
      },
    ];
    if (line.itemId && status === 'IN_TRANSIT' && line.procurementStatus !== 'IN_TRANSIT') {
      statements.push(
        itemHistory(line.itemId, 'PROCURED', {
          quantityDelta: line.requiredQty,
          note: `${line.requiredQty} in transit for a project.`,
        }),
      );
    }
    await this.driver.transaction(statements);
    return (await this.requireLine(lineId)).line;
  }

  /**
   * Receive an ordered line into active inventory. For a matched DISCRETE item the
   * received quantity (default: the full requirement) is added to its on-hand stock
   * and, if a destination is given, it is moved there — both logged to the ledger.
   * Non-discrete or unmatched lines simply transition to RECEIVED.
   */
  async receiveLine(
    lineId: string,
    opts: { locationId?: string; quantity?: number } = {},
  ): Promise<ProjectBomLine> {
    this.assertWritable();
    const { line } = await this.requireLine(lineId);

    const statements: SqlStatement[] = [
      {
        sql: 'UPDATE project_bom_lines SET procurement_status = ? WHERE id = ?;',
        params: ['RECEIVED', lineId],
      },
    ];

    if (line.itemId) {
      const item = await this.driver.queryOne<{ tracking_mode: string; quantity: number; location_id: string }>(
        'SELECT tracking_mode, quantity, location_id FROM items WHERE id = ?;',
        [line.itemId],
      );
      if (item && item.tracking_mode === 'DISCRETE') {
        const qty = Math.max(0, Math.floor(opts.quantity ?? line.requiredQty));
        const nextQty = item.quantity + qty;
        const targetLocation = opts.locationId ?? item.location_id;

        statements.push({
          sql: 'UPDATE items SET quantity = ?, location_id = ? WHERE id = ?;',
          params: [nextQty, targetLocation, line.itemId],
        });
        statements.push(
          itemHistory(line.itemId, 'RECEIVED', {
            quantityDelta: qty,
            note: `Received ${qty} from procurement (now ${nextQty}).`,
            metadata:
              targetLocation !== item.location_id
                ? { fromLocationId: item.location_id, toLocationId: targetLocation }
                : undefined,
          }),
        );
      }
    }

    await this.driver.transaction(statements);
    return (await this.requireLine(lineId)).line;
  }

  // --- costing (spec §4 Current Replacement vs Point-in-Time) --------------------

  /**
   * Total a project's BOM cost under its active costing mode. CURRENT_REPLACEMENT
   * uses the live `items.unit_cost`; POINT_IN_TIME uses the `unit_cost_snapshot`
   * captured when each line was added. Lines whose unit cost is unknown under the
   * mode are counted separately and excluded from the total.
   */
  async getCosting(projectId: string): Promise<ProjectCosting> {
    const project = await this.requireProject(projectId);
    const costExpr =
      project.costingMode === 'POINT_IN_TIME' ? 'l.unit_cost_snapshot' : 'i.unit_cost';

    const row = await this.driver.queryOne<{
      line_count: number;
      total: number;
      unpriced: number;
    }>(
      `SELECT
         COUNT(*) AS line_count,
         COALESCE(SUM(CASE WHEN cost IS NOT NULL THEN required_qty * cost ELSE 0 END), 0) AS total,
         COALESCE(SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END), 0) AS unpriced
       FROM (
         SELECT l.required_qty AS required_qty, ${costExpr} AS cost
         FROM project_bom_lines l
         LEFT JOIN items i ON i.id = l.item_id
         WHERE l.project_id = ?
       );`,
      [projectId],
    );

    return {
      costingMode: project.costingMode,
      totalCost: Number(row?.total ?? 0),
      unpricedLineCount: Number(row?.unpriced ?? 0),
      lineCount: Number(row?.line_count ?? 0),
    };
  }

  // --- shopping list (spec §4 automated Shopping List) ---------------------------

  /**
   * The automated shopping list: lines still needing acquisition — not yet ordered
   * and short of their requirement — aggregated by matched item (unmatched lines
   * stay distinct). Bounded by a project's BOM size, so returned whole (the §2.1
   * pagination mandate targets the 100k+ item lists feeding virtualisation).
   */
  async getShoppingList(projectId: string): Promise<ShoppingListEntry[]> {
    const rows = await this.driver.query<{
      item_id: string | null;
      label: string | null;
      mpn: string | null;
      manufacturer: string | null;
      shortfall: number;
      unit_cost: number | null;
    }>(
      `SELECT
         l.item_id AS item_id,
         MAX(COALESCE(i.name, l.description, l.mpn, l.designator)) AS label,
         MAX(COALESCE(l.mpn, i.mpn)) AS mpn,
         MAX(COALESCE(l.manufacturer, i.manufacturer)) AS manufacturer,
         SUM(l.required_qty - l.reserved_qty) AS shortfall,
         MAX(i.unit_cost) AS unit_cost
       FROM project_bom_lines l
       LEFT JOIN items i ON i.id = l.item_id
       WHERE l.project_id = ?
         AND l.procurement_status = 'NONE'
         AND l.required_qty > l.reserved_qty
       GROUP BY CASE WHEN l.item_id IS NOT NULL THEN l.item_id ELSE l.id END
       ORDER BY label COLLATE NOCASE ASC;`,
      [projectId],
    );

    return rows.map((r) => {
      const shortfallQty = Number(r.shortfall);
      const unitCost = r.unit_cost == null ? null : Number(r.unit_cost);
      return {
        itemId: r.item_id,
        label: r.label ?? 'Unknown part',
        mpn: r.mpn,
        manufacturer: r.manufacturer,
        shortfallQty,
        unitCost,
        estimatedCost: unitCost == null ? null : unitCost * shortfallQty,
      };
    });
  }

  // --- assembly outcomes (spec §4 Composite Items & Assemblies) ------------------

  /**
   * Finalise a project's assembly into one of the three terminal outcomes (§4):
   * - CONTAINER: a new location is created and every matched part is moved into it.
   * - SINGULAR_OBJECT: a new item is created (logged ASSEMBLED) and the matched
   *   parts are soft-deleted (consumed).
   * - PERMANENT_CONSUMPTION: the matched parts are soft-deleted (consumed); nothing
   *   new is created.
   * The project is marked COMPLETED. Atomic.
   */
  async finaliseAssembly(
    projectId: string,
    input: FinaliseAssemblyInput,
  ): Promise<AssemblyResult> {
    this.assertWritable();
    const project = await this.requireProject(projectId);

    const matched = await this.driver.query<{ item_id: string }>(
      'SELECT DISTINCT item_id FROM project_bom_lines WHERE project_id = ? AND item_id IS NOT NULL;',
      [projectId],
    );
    const partIds = matched.map((r) => r.item_id);

    const statements: SqlStatement[] = [];
    const result: { locationId?: string; itemId?: string } = {};

    if (input.outcome === 'CONTAINER') {
      const locationId = crypto.randomUUID();
      result.locationId = locationId;
      statements.push({
        sql: 'INSERT INTO locations (id, name, parent_id, is_system) VALUES (?, ?, NULL, 0);',
        params: [locationId, (input.resultName ?? project.name).trim() || project.name],
      });
      for (const itemId of partIds) {
        statements.push({
          sql: 'UPDATE items SET location_id = ? WHERE id = ?;',
          params: [locationId, itemId],
        });
        statements.push(
          itemHistory(itemId, 'MOVED', {
            note: `Assembled into container "${input.resultName ?? project.name}".`,
            metadata: { toLocationId: locationId, projectId },
          }),
        );
      }
    } else if (input.outcome === 'SINGULAR_OBJECT') {
      const itemId = crypto.randomUUID();
      result.itemId = itemId;
      const name = (input.resultName ?? `${project.name} Assembly`).trim() || `${project.name} Assembly`;
      const locationId = input.resultLocationId ?? UNASSIGNED_LOCATION_ID;
      statements.push({
        sql: `INSERT INTO items (id, name, location_id, tracking_mode, quantity) VALUES (?, ?, ?, 'DISCRETE', 1);`,
        params: [itemId, name, locationId],
      });
      statements.push(
        itemHistory(itemId, 'ASSEMBLED', {
          note: `Assembled from project "${project.name}".`,
          metadata: { projectId, fromParts: partIds },
        }),
      );
      this.consume(statements, partIds, project.name);
    } else {
      // PERMANENT_CONSUMPTION
      this.consume(statements, partIds, project.name);
    }

    statements.push({
      sql: "UPDATE projects SET status = 'COMPLETED' WHERE id = ?;",
      params: [projectId],
    });

    await this.driver.transaction(statements);
    return result;
  }

  // --- internals -----------------------------------------------------------------

  /** Append soft-delete + CONSUMED ledger statements for each matched part. */
  private consume(statements: SqlStatement[], partIds: readonly string[], projectName: string): void {
    for (const itemId of partIds) {
      statements.push({
        sql: 'UPDATE items SET is_active = 0 WHERE id = ?;',
        params: [itemId],
      });
      statements.push(
        itemHistory(itemId, 'CONSUMED', {
          note: `Permanently consumed by assembly of "${projectName}".`,
        }),
      );
    }
  }

  private async nextPosition(projectId: string): Promise<number> {
    const row = await this.driver.queryOne<{ next: number }>(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM project_bom_lines WHERE project_id = ?;',
      [projectId],
    );
    return Number(row?.next ?? 0);
  }

  private async requireProject(id: string): Promise<Project> {
    const project = await this.getById(id);
    if (!project) {
      throw new DbError('SQLITE_CONSTRAINT', `Project "${id}" does not exist.`);
    }
    return project;
  }

  private async requireLine(id: string): Promise<{ line: ProjectBomLine }> {
    const row = await this.driver.queryOne<ProjectBomLineRow>(
      'SELECT * FROM project_bom_lines WHERE id = ?;',
      [id],
    );
    if (!row) {
      throw new DbError('SQLITE_CONSTRAINT', `BOM line "${id}" does not exist.`);
    }
    return { line: rowToBomLine(row) };
  }
}

interface ItemHistoryFields {
  readonly quantityDelta?: number;
  readonly netValueDelta?: number;
  readonly note?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Build an append-only Activity Log INSERT for inclusion in a write transaction. */
function itemHistory(itemId: string, action: string, fields: ItemHistoryFields = {}): SqlStatement {
  return {
    sql: `INSERT INTO item_history (id, item_id, action, quantity_delta, net_value_delta, note, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?);`,
    params: [
      crypto.randomUUID(),
      itemId,
      action,
      fields.quantityDelta ?? null,
      fields.netValueDelta ?? null,
      fields.note ?? null,
      fields.metadata ? JSON.stringify(fields.metadata) : null,
    ],
  };
}

/** Trim a free-text field, collapsing blank/whitespace-only input to NULL. */
function normalise(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
