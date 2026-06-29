/**
 * BOM costing & the automated shopping list (spec §4 Current Replacement vs
 * Point-in-Time costing, and the automated Shopping List). Both are read-only
 * projections over a project's BOM lines.
 */
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
  };
}
