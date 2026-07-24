/**
 * Assembly finalisation concern (spec §4 Composite Items & Assemblies). The three
 * terminal outcomes of a project — Container, Singular Object, Permanent Consumption —
 * each atomically transform the matched parts and mark the project COMPLETED, logging
 * every affected item to the immutable Activity Log in the same transaction.
 */
import { DbError } from '../../errors';
import type { SqlStatement } from '../../rpc/driver';
import { uuidv5 } from '../../../lib/derived-uuid';
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

/**
 * Namespace for the deterministic ids a finalise mints (issue #195). Finalising is a one-shot
 * terminal operation: two devices can each run it offline before they sync. Deriving every
 * id it writes — the container location, the singular-object item, and each ledger row — from
 * the stable project id (rather than `crypto.randomUUID()`) means both devices compute the
 * *same* ids, so the merge collapses their writes to one artefact instead of keeping two.
 */
const ASSEMBLY_ID_NAMESPACE = '9b7c1f0a-1950-4e00-8b00-000000000195';

/**
 * The deterministic id a finalise gives to `kind` for `projectId` (see {@link ASSEMBLY_ID_NAMESPACE}).
 * A pure function of its inputs, which is exactly the convergence property: two devices finalising
 * the same project offline derive the same ids, so their writes merge to one artefact.
 *
 * @internal Exported for unit tests only.
 */
export function assemblyId(kind: string, projectId: string): Promise<string> {
  return uuidv5(`${kind}:${projectId}`, ASSEMBLY_ID_NAMESPACE);
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
    async finaliseAssembly(projectId: string, input: FinaliseAssemblyInput): Promise<AssemblyResult> {
      this.assertPermission('projects:write');
      this.assertPermission('stock:write');
      this.assertWritable();
      const project = await this.requireProject(projectId);

      // A finalise is terminal and one-shot: reject a second run of an already-finalised
      // project (issue #195). Deterministic ids make the *offline-concurrent* case converge on
      // merge; this guard is the local backstop, turning a re-finalise into a clean rejection
      // rather than a primary-key clash when it re-mints the same container/item id.
      if (project.status === 'COMPLETED') {
        throw new DbError('SQLITE_CONSTRAINT', `Project "${project.name}" has already been finalised.`);
      }

      const matched = await this.driver.query<{ item_id: string; is_unlimited: number }>(
        `SELECT DISTINCT l.item_id AS item_id, COALESCE(i.is_unlimited, 0) AS is_unlimited
           FROM project_bom_lines l JOIN items i ON i.id = l.item_id
          WHERE l.project_id = ? AND l.item_id IS NOT NULL;`,
        [projectId],
      );
      const partIds = matched.map((r) => r.item_id);
      // An unlimited-supply part (Phase 82) is an infinite source: consuming it must NOT
      // retire the item — it stays in inventory for the next build — though the CONSUMED
      // activity-log entry is still written (the ledger no-op rule; see `unlimited.ts`).
      const unlimitedIds = new Set(matched.filter((r) => Number(r.is_unlimited) === 1).map((r) => r.item_id));

      const statements: SqlStatement[] = [];
      const result: { locationId?: string; itemId?: string } = {};

      if (input.outcome === 'CONTAINER') {
        // Derived from the project id, so two devices finalising offline mint the *same*
        // container and the merge keeps one, not two (issue #195).
        const locationId = await assemblyId('container', projectId);
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
            historyStatement(itemId, 'MOVED', this.actorId(), {
              id: await assemblyId(`hist:MOVED:${itemId}`, projectId),
              note: `Assembled into container "${input.resultName ?? project.name}".`,
              metadata: { toLocationId: locationId, projectId },
            }),
          );
        }
      } else if (input.outcome === 'SINGULAR_OBJECT') {
        // Derived from the project id, so a concurrent offline finalise mints the *same*
        // assembled item and the merge keeps one, not two (issue #195).
        const itemId = await assemblyId('object', projectId);
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
          historyStatement(itemId, 'ASSEMBLED', this.actorId(), {
            id: await assemblyId(`hist:ASSEMBLED:${itemId}`, projectId),
            note: `Assembled from project "${project.name}".`,
            metadata: { projectId, fromParts: partIds },
          }),
        );
        await this.consume(statements, projectId, partIds, project.name, unlimitedIds);
      } else {
        // PERMANENT_CONSUMPTION
        await this.consume(statements, projectId, partIds, project.name, unlimitedIds);
      }

      statements.push({
        sql: "UPDATE projects SET status = 'COMPLETED' WHERE id = ?;",
        params: [projectId],
      });

      await this.driver.transaction(statements);
      return result;
    }

    /**
     * Append soft-delete + CONSUMED ledger statements for each matched part. An
     * unlimited-supply part (`unlimitedIds`, Phase 82) is an infinite source: it logs
     * CONSUMED for the activity trail but is **not** soft-deleted — it remains available
     * for the next build (consumption never depletes it).
     *
     * Each CONSUMED entry's id is derived from `(projectId, item)` so a concurrent offline
     * finalise unions to one entry per part rather than duplicating the ledger (issue #195).
     */
    private async consume(
      statements: SqlStatement[],
      projectId: string,
      partIds: readonly string[],
      projectName: string,
      unlimitedIds: ReadonlySet<string>,
    ): Promise<void> {
      for (const itemId of partIds) {
        if (!unlimitedIds.has(itemId)) {
          statements.push({
            sql: 'UPDATE items SET is_active = 0 WHERE id = ?;',
            params: [itemId],
          });
        }
        statements.push(
          historyStatement(itemId, 'CONSUMED', this.actorId(), {
            id: await assemblyId(`hist:CONSUMED:${itemId}`, projectId),
            note: unlimitedIds.has(itemId)
              ? `Consumed by assembly of "${projectName}" (unlimited supply — stock unchanged).`
              : `Permanently consumed by assembly of "${projectName}".`,
          }),
        );
      }
    }
  };
}
