/**
 * Assembly finalisation concern (spec §4 Composite Items & Assemblies). The three
 * terminal outcomes of a project — Container, Singular Object, Permanent Consumption —
 * each atomically transform the matched parts and mark the project COMPLETED, logging
 * every affected item to the immutable Activity Log in the same transaction.
 */
import type { SqlStatement } from '../../rpc/driver';
import { UNASSIGNED_LOCATION_ID } from '../constants';
import { historyStatement } from '../item/history';
import { consolidateStockStatements, setStockStatement } from '../stock';
import type { FinaliseAssemblyInput } from '../types';
import type { Constructor } from './mixin';
import type { ProjectCoreRepository } from './core';

/** The outcome of finalising an assembly — whichever artefacts it produced. */
export interface AssemblyResult {
  /** The new container location id (CONTAINER outcome). */
  readonly locationId?: string;
  /** The new singular-object item id (SINGULAR_OBJECT outcome). */
  readonly itemId?: string;
}

export function withAssembly<TBase extends Constructor<ProjectCoreRepository>>(Base: TBase) {
  return class ProjectAssemblyRepository extends Base {
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
          // Bring every placement of the part into the container (Phase 25), then point its
          // primary location at the container.
          statements.push(...consolidateStockStatements(itemId, locationId));
          statements.push({
            sql: 'UPDATE items SET location_id = ? WHERE id = ?;',
            params: [locationId, itemId],
          });
          statements.push(
            historyStatement(itemId, 'MOVED', {
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
        // Seed the new assembly's primary placement in the per-location ledger (Phase 25).
        statements.push(setStockStatement(itemId, locationId, 1));
        statements.push(
          historyStatement(itemId, 'ASSEMBLED', {
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

    /** Append soft-delete + CONSUMED ledger statements for each matched part. */
    private consume(statements: SqlStatement[], partIds: readonly string[], projectName: string): void {
      for (const itemId of partIds) {
        statements.push({
          sql: 'UPDATE items SET is_active = 0 WHERE id = ?;',
          params: [itemId],
        });
        statements.push(
          historyStatement(itemId, 'CONSUMED', {
            note: `Permanently consumed by assembly of "${projectName}".`,
          }),
        );
      }
    }
  };
}
