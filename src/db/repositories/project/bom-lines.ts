/**
 * BOM-lines concern (spec §2.1, §4 "Projects & BOMs"). The declared bill of materials
 * for a project: add/update/remove lines and list them in declared order. A line may
 * match a local item (defaulting its descriptive fields and point-in-time cost
 * snapshot) or stand alone with free-text. Line deletion is tombstoned for sync (§7.2).
 */
import { DbError } from '../../errors';
import type { SqlValue } from '../../rpc/driver';
import { normaliseText } from '../item/normalise';
import { rowToBomLine } from '../mappers';
import { tombstoneStatement } from '../tombstone';
import type {
  CreateBomLineInput,
  Page,
  PageParams,
  ProjectBomLine,
  ProjectBomLineRow,
  UpdateBomLineInput,
} from '../types';
import type { Constructor } from './mixin';
import type { ProjectCoreRepository } from './core';

export function withBomLines<TBase extends Constructor<ProjectCoreRepository>>(Base: TBase) {
  return class ProjectBomLinesRepository extends Base {
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

      let mpn = normaliseText(input.mpn);
      let manufacturer = normaliseText(input.manufacturer);
      let description = normaliseText(input.description);
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

      if (!input.itemId && !mpn && !description && !normaliseText(input.designator)) {
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
          normaliseText(input.designator),
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
      if (input.designator !== undefined) set('designator', normaliseText(input.designator));
      if (input.mpn !== undefined) set('mpn', normaliseText(input.mpn));
      if (input.manufacturer !== undefined) set('manufacturer', normaliseText(input.manufacturer));
      if (input.description !== undefined) set('description', normaliseText(input.description));
      if (input.requiredQty !== undefined) set('required_qty', Math.max(0, Math.floor(input.requiredQty)));
      if (input.position !== undefined) set('position', input.position);

      if (sets.length > 0) {
        params.push(lineId);
        await this.driver.execute(`UPDATE project_bom_lines SET ${sets.join(', ')} WHERE id = ?;`, params);
      }
      return (await this.requireLine(lineId)).line;
    }

    async removeLine(lineId: string): Promise<void> {
      // Tombstone the line deletion (Phase 11: project_bom_lines is synced).
      await this.driver.transaction([
        { sql: 'DELETE FROM project_bom_lines WHERE id = ?;', params: [lineId] },
        tombstoneStatement('project_bom_lines', lineId),
      ]);
    }

    private async nextPosition(projectId: string): Promise<number> {
      const row = await this.driver.queryOne<{ next: number }>(
        'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM project_bom_lines WHERE project_id = ?;',
        [projectId],
      );
      return Number(row?.next ?? 0);
    }
  };
}
