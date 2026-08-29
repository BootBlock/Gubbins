/**
 * Assembly finalisation concern (spec §4 Composite Items & Assemblies). The three
 * terminal outcomes of a project — Container, Singular Object, Permanent Consumption —
 * each atomically transform the matched parts and mark the project COMPLETED, logging
 * every affected item to the immutable Activity Log in the same transaction.
 *
 * What a finalise takes is decided by the BOM, not by what happens to be on the shelf
 * (issue #647): each matched part is drawn by the quantity its lines add up to, through the same
 * per-location / batch ledger a kit assembly draws through, and the item is retired (or its
 * primary location repointed into the container) only when that draw actually empties it. A
 * requirement the stock cannot meet is a clean rejection rather than a silent success. The
 * arithmetic lives in the pure {@link planAssemblyDraw}, which the finalise dialog runs over the
 * same {@link ProjectAssemblyRepository.listAssemblyParts} read — so what a user is shown before
 * pressing an un-undoable button is the very plan that then runs.
 */
import { DbError } from '../../errors';
import type { SqlStatement } from '../../rpc/driver';
import { uuidv5 } from '../../../lib/derived-uuid';
import {
  assemblyShortfallMessage,
  isEmptyDraw,
  planAssemblyDraw,
  type AssemblyDraw,
  type AssemblyPart,
} from '@/features/projects/assembly';
import { UNASSIGNED_LOCATION_ID, type TrackingMode } from '../constants';
import { historyStatement } from '../item/history';
import { moveWholeItemStatements, setStockStatement } from '../stock';
import { itemConsumeStatements, itemMoveStatements, runStockDraw, withOperationKey } from '../stock-batches';
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

/** One matched part of a project, as the assembly read projects it. */
interface AssemblyPartRow {
  readonly item_id: string;
  readonly name: string;
  readonly tracking_mode: TrackingMode;
  readonly is_unlimited: number;
  readonly on_hand: number;
  readonly required_qty: number;
}

export function withAssembly<TBase extends Constructor<ProjectCoreRepository>>(Base: TBase) {
  return class ProjectAssemblyRepository extends Base {
    /**
     * The project's matched parts as the finalise sees them — each with the quantity its BOM lines
     * add up to and what it has on hand. The input the finalise dialog's summary is planned from.
     *
     * Deliberately the parts rather than a finished plan: `planAssemblyDraw` is pure and the
     * outcome the user is choosing between changes the answer, so the dialog re-plans locally as
     * the radio moves instead of re-reading. Both sides then run the one function over the one
     * read, which is what keeps the preview from describing an operation the write does not
     * perform. A read: it moves nothing and records nothing.
     */
    async listAssemblyParts(projectId: string): Promise<AssemblyPart[]> {
      await this.requireProject(projectId);
      return this.readAssemblyParts(projectId);
    }

    /**
     * Finalise a project's assembly into one of the three terminal outcomes (§4):
     * - CONTAINER: a new location is created and each matched part's required quantity is moved
     *   into it (a part moves in its entirety, primary location and all, only when the move
     *   empties it).
     * - SINGULAR_OBJECT: a new item is created (logged ASSEMBLED) and each matched part's
     *   required quantity is consumed.
     * - PERMANENT_CONSUMPTION: each matched part's required quantity is consumed; nothing new is
     *   created.
     *
     * A part is soft-deleted only when the draw takes the last of it. Rejected up front — before
     * anything is written — when a part cannot supply what its lines ask for. The project is
     * marked COMPLETED. Atomic.
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

      const plan = planAssemblyDraw(await this.readAssemblyParts(projectId), input.outcome);
      // Short on a part is a rejection, not a partial build: taking what little there is would
      // still complete the project and still be un-undoable (issue #647).
      if (!plan.feasible) {
        throw new DbError('SQLITE_CONSTRAINT', assemblyShortfallMessage(project.name, plan.shortfalls));
      }

      const statements: SqlStatement[] = [];
      const result: { locationId?: string; itemId?: string } = {};

      if (input.outcome === 'CONTAINER') {
        // Derived from the project id, so two devices finalising offline mint the *same*
        // container and the merge keeps one, not two (issue #195).
        const locationId = await assemblyId('container', projectId);
        result.locationId = locationId;
        const containerName = (input.resultName ?? project.name).trim() || project.name;
        statements.push({
          sql: 'INSERT INTO locations (id, name, parent_id, is_system) VALUES (?, ?, NULL, 0);',
          params: [locationId, containerName],
        });
        for (const draw of plan.draws) {
          statements.push(...(await this.gather(projectId, draw, locationId, containerName, project.name)));
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
            metadata: { projectId, fromParts: plan.draws.map((d) => d.itemId) },
          }),
        );
        await this.consume(statements, projectId, plan.draws, project.name);
      } else {
        // PERMANENT_CONSUMPTION
        await this.consume(statements, projectId, plan.draws, project.name);
      }

      statements.push({
        sql: "UPDATE projects SET status = 'COMPLETED' WHERE id = ?;",
        params: [projectId],
      });

      // The whole finalise draws stock down, so a race that loses the last units surfaces as the
      // shared plain sentence rather than a raw `CHECK constraint failed` (issue #302).
      //
      // Every stock write in it belongs to the one terminal operation, so the lot is bracketed by
      // the finalise's own derived operation key (issue #696): two devices finalising the same
      // project offline then record the *same* stock movements rather than two copies of one draw,
      // which the merge would otherwise replay as two — taking each BOM line's quantity twice.
      await runStockDraw(this.driver, withOperationKey(await assemblyId('stock', projectId), statements));
      return result;
    }

    /**
     * Every matched part of the project, with the quantity its BOM lines add up to and what it
     * has on hand. Grouped by item, so a part listed on three lines is one part needing the sum
     * of the three — drawn once for the total rather than three times over. A gauge reports its
     * net value as its supply (its `quantity` is meaningless); an unmatched line has no part to
     * draw and is excluded.
     */
    private async readAssemblyParts(projectId: string): Promise<AssemblyPart[]> {
      const rows = await this.driver.query<AssemblyPartRow>(
        `SELECT l.item_id AS item_id,
                i.name AS name,
                i.tracking_mode AS tracking_mode,
                COALESCE(i.is_unlimited, 0) AS is_unlimited,
                CASE WHEN i.tracking_mode = 'CONSUMABLE_GAUGE' THEN COALESCE(i.current_net_value, 0)
                     ELSE i.quantity END AS on_hand,
                SUM(l.required_qty) AS required_qty
           FROM project_bom_lines l JOIN items i ON i.id = l.item_id
          WHERE l.project_id = ? AND l.item_id IS NOT NULL
          GROUP BY l.item_id
          ORDER BY i.name COLLATE NOCASE ASC, l.item_id ASC;`,
        [projectId],
      );
      return rows.map((r) => ({
        itemId: r.item_id,
        name: r.name,
        trackingMode: r.tracking_mode,
        isUnlimited: Number(r.is_unlimited) === 1,
        onHand: Number(r.on_hand),
        requiredQty: Number(r.required_qty),
      }));
    }

    /**
     * The statements that gather one part into the CONTAINER outcome's new location.
     *
     * A counted part moves only the quantity the BOM asks for — first-expiry-first-out across
     * every location it sits in, lot identity preserved — and keeps its primary location where it
     * is, because the rest of the stock is still on that shelf. Only a move that takes the last
     * of it repoints the item at the container, which is also the whole-item path a part with no
     * divisible quantity takes: a serialised instance, a presence-only item, and a gauge vessel
     * are each one physical thing, so the thing itself goes in the box.
     *
     * An infinite source (Phase 82) is the exception that moves nothing at all: a build draws on
     * it without emptying it, so relocating it into the container would take the tap off the wall.
     * It records the draw and stays where it is.
     */
    private async gather(
      projectId: string,
      draw: AssemblyDraw,
      locationId: string,
      containerName: string,
      projectName: string,
    ): Promise<SqlStatement[]> {
      if (isEmptyDraw(draw)) return [];
      if (draw.mode === 'UNLIMITED') {
        return [
          historyStatement(draw.itemId, 'CONSUMED', this.actorId(), {
            id: await assemblyId(`hist:CONSUMED:${draw.itemId}`, projectId),
            note: consumptionNote(draw, projectName),
            metadata: { projectId, quantity: draw.takeQty },
          }),
        ];
      }

      const statements: SqlStatement[] = [];
      // Anything without a countable slice to take — and any counted part whose draw empties it —
      // goes into the container whole, primary location and all.
      const wholeItem = draw.mode !== 'COUNT' || draw.takesAll;
      if (wholeItem) {
        // Bring every placement of the part into the container (Phase 25) and point its primary
        // location at the container. Through the shared builder, which is what lets a SERIALISED
        // part be drawn at all: emptying one placement and filling another is two writes, so a
        // per-statement recompute walks `items.quantity` through 2 or 0 and
        // `CHECK (tracking_mode <> 'SERIALISED' OR quantity = 1)` aborts the finalise (issue #640).
        statements.push(...moveWholeItemStatements(draw.itemId, locationId));
      } else {
        statements.push(...(await itemMoveStatements(this.driver, draw.itemId, draw.takeQty, locationId)));
      }
      statements.push(
        historyStatement(draw.itemId, 'MOVED', this.actorId(), {
          id: await assemblyId(`hist:MOVED:${draw.itemId}`, projectId),
          note: wholeItem
            ? `Assembled into container "${containerName}".`
            : `Moved ${draw.takeQty} into container "${containerName}".`,
          metadata: {
            toLocationId: locationId,
            projectId,
            ...(draw.mode === 'COUNT' ? { quantity: draw.takeQty } : {}),
          },
        }),
      );
      return statements;
    }

    /**
     * Append the statements that consume each matched part — the SINGULAR_OBJECT and
     * PERMANENT_CONSUMPTION outcomes.
     *
     * Each part is drawn by the quantity its BOM lines ask for: a counted part
     * first-expiry-first-out across every location it sits in, a gauge by a net-value decrement.
     * A part with no divisible quantity — a serialised instance, a presence-only (UNTRACKED) item —
     * has nothing to draw, so the item itself is what the build takes. The item is soft-deleted
     * **only** when the draw leaves nothing behind: a build that used 4 of a box of 500 leaves the
     * other 496 in active inventory.
     *
     * An unlimited-supply part (Phase 82) is an infinite source: consuming it moves no stock and
     * never retires it — it stays in inventory for the next build — though the CONSUMED
     * activity-log entry is still written (the ledger no-op rule; see `unlimited.ts`).
     *
     * Each CONSUMED entry's id is derived from `(projectId, item)` so a concurrent offline
     * finalise unions to one entry per part rather than duplicating the ledger (issue #195), and
     * carries the delta it actually moved so consumption analytics see the units the build used.
     */
    private async consume(
      statements: SqlStatement[],
      projectId: string,
      draws: readonly AssemblyDraw[],
      projectName: string,
    ): Promise<void> {
      for (const draw of draws) {
        if (isEmptyDraw(draw)) continue;
        if (draw.mode === 'COUNT') {
          statements.push(...(await itemConsumeStatements(this.driver, draw.itemId, draw.takeQty)));
        } else if (draw.mode === 'GAUGE') {
          // Relative in SQL, never an absolute value computed from a read taken before the
          // transaction (issue #297): §7.3 reconstructs a gauge as `grossCapacity + Σ deltas`,
          // so the write and the logged delta have to be the same relative amount.
          statements.push({
            sql: 'UPDATE items SET current_net_value = current_net_value - ? WHERE id = ?;',
            params: [draw.takeQty, draw.itemId],
          });
        }
        if (draw.takesAll) {
          statements.push({
            sql: 'UPDATE items SET is_active = 0 WHERE id = ?;',
            params: [draw.itemId],
          });
        }
        statements.push(
          historyStatement(draw.itemId, 'CONSUMED', this.actorId(), {
            id: await assemblyId(`hist:CONSUMED:${draw.itemId}`, projectId),
            quantityDelta: draw.mode === 'COUNT' ? -draw.takeQty : null,
            netValueDelta: draw.mode === 'GAUGE' ? -draw.takeQty : null,
            note: consumptionNote(draw, projectName),
            metadata: { projectId, ...(draw.mode === 'WHOLE' ? {} : { quantity: draw.takeQty }) },
          }),
        );
      }
    }
  };
}

/** The ledger note recording what a draw actually took, and whether it was the last of it. */
function consumptionNote(draw: AssemblyDraw, projectName: string): string {
  if (draw.mode === 'UNLIMITED') {
    return `Consumed ${draw.takeQty} by assembly of "${projectName}" (unlimited supply — stock unchanged).`;
  }
  if (draw.mode === 'WHOLE') {
    return `Permanently consumed by assembly of "${projectName}".`;
  }
  return draw.takesAll
    ? `Consumed ${draw.takeQty} by assembly of "${projectName}" — the last of the stock, so the item was archived.`
    : `Consumed ${draw.takeQty} by assembly of "${projectName}".`;
}
