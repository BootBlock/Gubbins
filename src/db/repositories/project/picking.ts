/**
 * Picking-worksheet concern (issue #121 — location-aware gather-and-tick).
 *
 * Surfaces the project's BOM as a walk-and-collect worksheet: each line carries a
 * per-line `picked` flag (marked as it is physically gathered) and, for a matched item,
 * the per-location breakdown of where its units sit — drawn from the `item_stock` ledger
 * (§4 per-location ledger, Phase 25), busiest location first. Picking is a *transient
 * annotation* on the line, not a stock movement, so toggling it writes only the flag and
 * appends nothing to the Activity Log; the actual consumption still happens at
 * {@link withAssembly.finaliseAssembly}, which "all picked" naturally leads into.
 */
import { orderByRoute } from '@/features/projects/picking';
import { rowToBomLine } from '../mappers';
import type { ItemStockPlacement, PickLine, ProjectBomLine, ProjectBomLineRow } from '../types';
import type { Constructor } from './mixin';
import type { ProjectCoreRepository } from './core';

export function withPicking<TBase extends Constructor<ProjectCoreRepository>>(Base: TBase) {
  return class ProjectPickingRepository extends Base {
    /**
     * The picking worksheet for a project: every BOM line paired with the per-location
     * breakdown of where its matched item's stock sits (empty for an unmatched line or one
     * with nothing on hand). The placements are gathered in a single batched query over
     * `item_stock` — the same shape as {@link ItemStockRepository.listStock} but for every
     * matched part at once — so the walk-and-tick view costs two reads regardless of the BOM's
     * size.
     *
     * Both the lines and each line's placements are ordered by the locations' **walk order**
     * (issue #461) so the worksheet reads as one physical picking sweep: within a part its
     * holding locations run in route order, and the lines themselves are ordered by the
     * earliest point on the route a part can be grabbed. An unplaced location (`walk_order`
     * NULL) sorts after every placed one, falling back to the prior busiest-first / declared
     * order — so a project whose locations carry no walk order is unaffected.
     */
    async listPickList(projectId: string): Promise<PickLine[]> {
      const lineRows = await this.driver.query<ProjectBomLineRow>(
        `SELECT * FROM project_bom_lines WHERE project_id = ?
         ORDER BY position ASC, created_at ASC;`,
        [projectId],
      );
      const lines = lineRows.map(rowToBomLine);

      const itemIds = [...new Set(lines.map((l) => l.itemId).filter((id): id is string => id !== null))];
      const placementsByItem = new Map<string, ItemStockPlacement[]>();
      // The lowest walk order among a part's holding locations — its position on the sweep.
      // `undefined` (or a location with a NULL walk order) means "unplaced", handled by orderByRoute.
      const routeKeyByItem = new Map<string, number>();
      if (itemIds.length > 0) {
        const placeholders = itemIds.map(() => '?').join(', ');
        const rows = await this.driver.query<{
          item_id: string;
          location_id: string;
          location_name: string;
          quantity: number;
          walk_order: number | null;
        }>(
          // Route order first (placed locations by ascending walk order), then the prior
          // busiest-first / name tie-break so an unplaced or tied location is unchanged.
          `SELECT s.item_id, s.location_id, l.name AS location_name, s.quantity, l.walk_order
           FROM item_stock s JOIN locations l ON l.id = s.location_id
           WHERE s.item_id IN (${placeholders}) AND s.quantity > 0
           ORDER BY (l.walk_order IS NULL), l.walk_order ASC, s.quantity DESC, l.name COLLATE NOCASE ASC;`,
          itemIds,
        );
        for (const r of rows) {
          const list = placementsByItem.get(r.item_id) ?? [];
          list.push({
            locationId: r.location_id,
            locationName: r.location_name,
            quantity: Number(r.quantity),
          });
          placementsByItem.set(r.item_id, list);
          if (r.walk_order !== null) {
            const current = routeKeyByItem.get(r.item_id);
            if (current === undefined || r.walk_order < current) routeKeyByItem.set(r.item_id, r.walk_order);
          }
        }
      }

      const worksheet = lines.map((line) => ({
        line,
        placements: line.itemId ? (placementsByItem.get(line.itemId) ?? []) : [],
      }));
      // Reorder the lines into sweep order; unplaced parts keep their declared order at the end.
      return orderByRoute(worksheet, (row) =>
        row.line.itemId ? (routeKeyByItem.get(row.line.itemId) ?? null) : null,
      );
    }

    /**
     * Tick (or un-tick) a BOM line as physically gathered. A pure flag write — picking moves
     * no stock and touches no matched item, so nothing is appended to the Activity Log; the
     * `updated_at` trigger stamps the change so it syncs LWW like any other line edit.
     */
    async setPicked(lineId: string, picked: boolean): Promise<ProjectBomLine> {
      this.assertPermission('projects:write');
      this.assertWritable();
      await this.requireLine(lineId);
      await this.driver.execute('UPDATE project_bom_lines SET picked = ? WHERE id = ?;', [
        picked ? 1 : 0,
        lineId,
      ]);
      return (await this.requireLine(lineId)).line;
    }
  };
}
