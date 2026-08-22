/**
 * BOM costing & the automated shopping list (spec §4 Current Replacement vs
 * Point-in-Time costing, and the automated Shopping List). Both are read-only
 * projections over a project's BOM lines.
 */
import { fromStoredMoney } from '@/lib/money';
import type { ItemAvailability } from '@/features/projects/reservations';
import { isOpenProjectStatus, readAvailability } from '../reservations';
import type { ProjectCosting, ShoppingListEntry } from '../types';
import type { Constructor } from './mixin';
import type { ProjectCoreRepository } from './core';

export function withCosting<TBase extends Constructor<ProjectCoreRepository>>(Base: TBase) {
  return class ProjectCostingRepository extends Base {
    /**
     * Total a project's BOM cost under its active costing mode. CURRENT_REPLACEMENT
     * uses the live `items.unit_cost`; POINT_IN_TIME uses the `unit_cost_snapshot`
     * captured when each line was added. Lines whose unit cost is unknown under the
     * mode are counted separately and excluded from the total.
     */
    async getCosting(projectId: string): Promise<ProjectCosting> {
      const project = await this.requireProject(projectId);
      const costExpr = project.costingMode === 'POINT_IN_TIME' ? 'l.unit_cost_snapshot' : 'i.unit_cost';

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
        // `total` is SUM(required_qty × cost) over integer micro-unit costs — exact — converted
        // back to a major-unit amount here at the repository boundary (issue #286).
        totalCost: fromStoredMoney(Number(row?.total ?? 0)),
        unpricedLineCount: Number(row?.unpriced ?? 0),
        lineCount: Number(row?.line_count ?? 0),
      };
    }

    /**
     * The automated shopping list: lines still needing acquisition — not yet ordered and
     * short of their requirement — aggregated by matched item (unmatched lines stay
     * distinct). Bounded by a project's BOM size, so returned whole (the §2.1 pagination
     * mandate targets the 100k+ item lists feeding virtualisation).
     *
     * A line's reservation only reduces what it has to buy **to the extent real stock backs
     * it** (issue #653). A reservation claims units that already exist; it never creates any,
     * and nothing stops two projects claiming the same ones. Subtracting the raw
     * `reserved_qty` therefore used to let every project over-committed on a part report
     * nothing missing, with the shortage surfacing at the bench after the first build took
     * the parts. The shared `readAvailability` reader shares each item's stock out across
     * every live claim on it — firm before soft, oldest first — and whatever this project's
     * lines did not win is a shortfall like any other.
     *
     * Two kinds of line are taken at face value instead. An **unmatched** line (no `item_id`)
     * has no stock record to check against, so its reservation is the user's own assertion that
     * the parts are in hand and Gubbins has nothing to contradict it with. And a **closed**
     * project's lines were never in the allocation at all — a `COMPLETED`/`ARCHIVED` project has
     * drawn its parts or been put aside — so reading their absence from it as "this claim lost
     * out" would tell the user to re-buy a build that is already done.
     */
    async getShoppingList(projectId: string): Promise<ShoppingListEntry[]> {
      // A closed project is not in the allocation at all, so its lines would come back with no
      // backing and every reserved part would read as something still to buy. Its reservations
      // are a record of a build already drawn or put aside, so they stand as written.
      const project = await this.requireProject(projectId);
      const allocated = isOpenProjectStatus(project.status);

      const rows = await this.driver.query<{
        line_id: string;
        item_id: string | null;
        label: string | null;
        mpn: string | null;
        manufacturer: string | null;
        required_qty: number;
        reserved_qty: number;
        unit_cost: number | null;
      }>(
        `SELECT
           l.id      AS line_id,
           l.item_id AS item_id,
           COALESCE(i.name, l.description, l.mpn, l.designator) AS label,
           COALESCE(l.mpn, i.mpn) AS mpn,
           COALESCE(l.manufacturer, i.manufacturer) AS manufacturer,
           l.required_qty AS required_qty,
           l.reserved_qty AS reserved_qty,
           i.unit_cost AS unit_cost
         FROM project_bom_lines l
         LEFT JOIN items i ON i.id = l.item_id
         WHERE l.project_id = ?
           AND l.procurement_status = 'NONE'
           -- An unlimited-supply component (Phase 82) is always satisfiable — never a
           -- shortfall, so it never surfaces on the shopping list. Unmatched lines
           -- (i.is_unlimited IS NULL via the LEFT JOIN) still count.
           AND COALESCE(i.is_unlimited, 0) = 0
         ORDER BY label COLLATE NOCASE ASC, l.id ASC;`,
        [projectId],
      );

      // One batched read for every matched line on the list; the pure seam does the
      // allocation. Lines whose reservation is already zero still go through it — their
      // backing is zero either way, and asking per-line would be an N+1.
      const availability = allocated
        ? await readAvailability(
            this.driver,
            rows.map((r) => r.item_id).filter((id): id is string => id !== null),
          )
        : new Map<string, ItemAvailability>();

      // Grouped by matched item (unmatched lines stay distinct), first-seen order — the query
      // is already sorted, so this preserves the label ordering without re-sorting in JS.
      const merged = new Map<string, ShoppingListEntry>();
      for (const r of rows) {
        const requiredQty = Number(r.required_qty);
        const reservedQty = Number(r.reserved_qty);
        // What this line's own reservation is actually worth. An unmatched line has no stock to
        // allocate, and a closed project was never in the allocation, so both stand as written.
        const backedQty =
          r.item_id === null || !allocated
            ? reservedQty
            : (availability.get(r.item_id)?.backingByLine.get(r.line_id)?.backedQty ?? 0);
        const shortfallQty = Math.max(0, requiredQty - backedQty);
        if (shortfallQty === 0) continue;

        const key = r.item_id ?? r.line_id;
        const existing = merged.get(key);
        // `unit_cost` is stored in integer micro-units (issue #286); back to major units here.
        const unitCost = r.unit_cost == null ? null : fromStoredMoney(Number(r.unit_cost));
        // Claimed units this line lost to a competing project — why it is on the list at all
        // despite being reserved. Zero for a line that was simply never reserved.
        const unbackedQty = Math.max(0, reservedQty - backedQty);
        if (existing === undefined) {
          merged.set(key, {
            itemId: r.item_id,
            label: r.label ?? 'Unknown part',
            mpn: r.mpn,
            manufacturer: r.manufacturer,
            shortfallQty,
            unbackedQty,
            unitCost,
            estimatedCost: null,
          });
        } else {
          merged.set(key, {
            ...existing,
            shortfallQty: existing.shortfallQty + shortfallQty,
            unbackedQty: existing.unbackedQty + unbackedQty,
            mpn: existing.mpn ?? r.mpn,
            manufacturer: existing.manufacturer ?? r.manufacturer,
            unitCost: existing.unitCost ?? unitCost,
          });
        }
      }

      return [...merged.values()].map((entry) => ({
        ...entry,
        estimatedCost: entry.unitCost == null ? null : entry.unitCost * entry.shortfallQty,
      }));
    }
  };
}
