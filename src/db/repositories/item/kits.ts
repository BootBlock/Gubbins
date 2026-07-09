/**
 * Kits / bundles concern (Kits v1 — definition + availability; Kits v2 — assemble /
 * disassemble stock operations).
 *
 * A kit is an item *composed of* fixed per-kit quantities of other items (a first-aid
 * kit = 2 bandages + 1 scissors + 5 plasters). This mixin owns the `kit_components`
 * edge table: listing a kit's components (joined to each component's name and current
 * on-hand stock), and adding / re-quantifying / removing an edge. Distinct from variants
 * (child SKUs of one identity) and a project BOM (transient work): a kit is a reusable
 * many-to-many item→component relationship.
 *
 * **v2** adds the stock-moving operation v1 deferred: {@link ItemKitRepository.assemble}
 * atomically consumes each component's stock (`qtyPerKit × count`) and produces `count` of
 * the kit item, and {@link ItemKitRepository.disassemble} is its exact inverse. Both move
 * stock through the per-location ledger (`item_stock` / `stock_batches`) via the shared
 * {@link placementDeltaStatements} — never writing `items.quantity` directly — and log the
 * whole thing to the immutable Activity Log in one atomic transaction, so a partial build can
 * never leave the ledger inconsistent. The buildable ceiling (the pure {@link buildableCount})
 * guards assembly; the kit's own on-hand quantity guards disassembly.
 *
 * The containment graph must stay acyclic (a kit cannot contain itself, directly or
 * transitively). The trivial one-hop case is caught by a DB CHECK; deeper transitive
 * cycles are rejected here by walking the proposed component's descendant set with a
 * recursive CTE and letting the pure `validateKitLink` decide — mirroring the variants
 * (`assertVariantLinkValid`) and nested-location cycle guards.
 */
import { DbError } from '../../errors';
import { kitRejectionMessage, validateKitLink } from '@/features/inventory/kits';
import { buildableCount } from '@/features/inventory/kit-availability';
import type { SqlStatement } from '../../rpc/driver';
import type { Item } from '../types';
import { placementDeltaStatements } from '../stock-batches';
import { historyStatement } from './history';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

/** One component line of a kit, joined to the component item's name and on-hand stock. */
export interface KitComponent {
  /** The `kit_components` row id (the stable handle for update/remove). */
  readonly id: string;
  /** The component item's id. */
  readonly componentItemId: string;
  /** The component item's name (for display). */
  readonly name: string;
  /** Units of this component consumed per whole kit (≥ 1). */
  readonly quantity: number;
  /** The component item's current on-hand stock (the SSOT `items.quantity`). */
  readonly stock: number;
  /** Manual ordering within the kit. */
  readonly sort: number;
}

interface KitComponentRow {
  readonly id: string;
  readonly component_item_id: string;
  readonly name: string;
  readonly quantity: number;
  readonly stock: number;
  readonly sort: number;
}

export function withKits<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemKitRepository extends Base {
    /**
     * A kit's component lines, each joined to the component item's name and current
     * on-hand stock (`items.quantity`, the per-location ledger's SSOT sum). Ordered by
     * the manual `sort` then name. The buildable count is derived from these by the pure
     * `buildableCount`, so this stays a plain read.
     */
    async listKitComponents(kitId: string): Promise<KitComponent[]> {
      const rows = await this.driver.query<KitComponentRow>(
        `SELECT kc.id, kc.component_item_id, kc.quantity, kc.sort, i.name, i.quantity AS stock
         FROM kit_components kc
         JOIN items i ON i.id = kc.component_item_id
         WHERE kc.kit_item_id = ?
         ORDER BY kc.sort ASC, i.name COLLATE NOCASE ASC;`,
        [kitId],
      );
      return rows.map((r) => ({
        id: r.id,
        componentItemId: r.component_item_id,
        name: r.name,
        quantity: Number(r.quantity),
        stock: Number(r.stock),
        sort: Number(r.sort),
      }));
    }

    /**
     * Add a component to a kit (Kits v1). The quantity is the per-kit requirement (≥ 1).
     * Both items must exist; the link must not be self-containment or form a cycle (the
     * kit already sitting somewhere in the component's own sub-tree) — checked against the
     * component's descendant set via a recursive CTE. The new row's `sort` appends it to
     * the end. Write-gated. Returns the refreshed component list.
     */
    async addKitComponent(kitId: string, componentItemId: string, quantity: number): Promise<KitComponent[]> {
      this.assertWritable();
      const qty = Math.max(1, Math.floor(quantity));
      await this.assertKitLinkValid(kitId, componentItemId);

      await this.driver.execute(
        `INSERT INTO kit_components (id, kit_item_id, component_item_id, quantity, sort)
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort) + 1, 0) FROM kit_components WHERE kit_item_id = ?));`,
        [crypto.randomUUID(), kitId, componentItemId, qty, kitId],
      );
      return this.listKitComponents(kitId);
    }

    /**
     * Change a component line's per-kit quantity (≥ 1). Write-gated. Returns the refreshed
     * component list for the owning kit.
     */
    async updateKitComponentQty(id: string, quantity: number): Promise<KitComponent[]> {
      this.assertWritable();
      const qty = Math.max(1, Math.floor(quantity));
      const row = await this.driver.queryOne<{ kit_item_id: string }>(
        'SELECT kit_item_id FROM kit_components WHERE id = ?;',
        [id],
      );
      if (!row) {
        throw new DbError('SQLITE_CONSTRAINT', `Kit component "${id}" does not exist.`);
      }
      await this.driver.execute('UPDATE kit_components SET quantity = ? WHERE id = ?;', [qty, id]);
      return this.listKitComponents(row.kit_item_id);
    }

    /**
     * Remove a component line from its kit. Write-gated (a definition edit). Returns the
     * refreshed component list for the owning kit.
     */
    async removeKitComponent(id: string): Promise<KitComponent[]> {
      this.assertWritable();
      const row = await this.driver.queryOne<{ kit_item_id: string }>(
        'SELECT kit_item_id FROM kit_components WHERE id = ?;',
        [id],
      );
      if (!row) return [];
      await this.driver.execute('DELETE FROM kit_components WHERE id = ?;', [id]);
      return this.listKitComponents(row.kit_item_id);
    }

    /**
     * Assemble `count` whole kits from their components (Kits v2). In one atomic transaction
     * each component's stock is drawn down by `qtyPerKit × count` and the kit item's stock is
     * grown by `count`, with a reciprocal `CONSUMED` entry per component and one `ASSEMBLED`
     * entry on the kit — so the immutable ledger records the whole build and can never drift.
     *
     * All-or-nothing: the operation is rejected outright unless every component can cover
     * `count`, validated up-front by the pure {@link buildableCount} (its scarcest-component
     * ceiling). Stock moves through the per-location ledger via {@link placementDeltaStatements}
     * — each component is drawn FEFO from its own primary location and the kit is produced at
     * its primary location (mirroring `adjustQuantity`), so `items.quantity` follows from the
     * recompute triggers and is never written directly. Write-gated. Returns the updated kit.
     */
    async assemble(kitId: string, count: number): Promise<Item> {
      this.assertWritable();
      const n = assertWholeCount(count, 'assemble');
      const kit = await this.require(kitId);
      assertDiscreteKit(kit);
      const components = await this.listKitComponents(kitId);
      if (components.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'This kit has no components to assemble.');
      }

      const { count: buildable, limiting } = buildableCount(components);
      if (n > buildable) {
        const short = limiting.map((c) => c.name).join(', ');
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `Not enough stock to assemble ${n} ${plural(n, 'kit')}: at most ${buildable} buildable` +
            (short ? ` (short on ${short}).` : '.'),
        );
      }

      const homeLocations = await this.resolveComponentPlacements(components);
      const statements: SqlStatement[] = [];
      for (const c of components) {
        const draw = c.quantity * n;
        statements.push(
          ...(await placementDeltaStatements(
            this.driver,
            c.componentItemId,
            homeLocations.get(c.componentItemId)!,
            -draw,
          )),
          historyStatement(c.componentItemId, 'CONSUMED', {
            quantityDelta: -draw,
            note: `Consumed ${draw} assembling ${n} × "${kit.name}".`,
            metadata: { kitId, count: n, quantityPerKit: c.quantity },
          }),
        );
      }
      statements.push(
        ...(await placementDeltaStatements(this.driver, kitId, kit.locationId, n)),
        historyStatement(kitId, 'ASSEMBLED', {
          quantityDelta: n,
          note: `Assembled ${n} ${plural(n, 'kit')} from components.`,
          metadata: {
            count: n,
            components: components.map((c) => ({ id: c.componentItemId, quantity: c.quantity * n })),
          },
        }),
      );
      await this.driver.transaction(statements);
      return (await this.getById(kitId))!;
    }

    /**
     * Break `count` whole kits back down into their components (Kits v2) — the exact inverse of
     * {@link ItemKitRepository.assemble}. The kit item's stock is drawn down by `count` and each
     * component's stock is grown by `qtyPerKit × count`, with a `DISASSEMBLED` entry on the kit
     * and a reciprocal `QUANTITY_CHANGE` entry per component recovered. Rejected unless the kit
     * has at least `count` on hand. Same per-location ledger discipline as `assemble` (the kit
     * is drawn FEFO from its primary location; recovered components land in each component's
     * primary-location default batch). Write-gated. Returns the updated kit.
     */
    async disassemble(kitId: string, count: number): Promise<Item> {
      this.assertWritable();
      const n = assertWholeCount(count, 'disassemble');
      const kit = await this.require(kitId);
      assertDiscreteKit(kit);
      const components = await this.listKitComponents(kitId);
      if (components.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'This kit has no components to disassemble into.');
      }
      if (n > kit.quantity) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `Not enough kits on hand to disassemble ${n}: ${kit.quantity} available.`,
        );
      }

      const homeLocations = await this.resolveComponentPlacements(components);
      const statements: SqlStatement[] = [
        ...(await placementDeltaStatements(this.driver, kitId, kit.locationId, -n)),
        historyStatement(kitId, 'DISASSEMBLED', {
          quantityDelta: -n,
          note: `Disassembled ${n} ${plural(n, 'kit')} back into components.`,
          metadata: {
            count: n,
            components: components.map((c) => ({ id: c.componentItemId, quantity: c.quantity * n })),
          },
        }),
      ];
      for (const c of components) {
        const give = c.quantity * n;
        statements.push(
          ...(await placementDeltaStatements(
            this.driver,
            c.componentItemId,
            homeLocations.get(c.componentItemId)!,
            give,
          )),
          historyStatement(c.componentItemId, 'QUANTITY_CHANGE', {
            quantityDelta: give,
            note: `Recovered ${give} from disassembling ${n} × "${kit.name}".`,
            metadata: { kitId, count: n, quantityPerKit: c.quantity },
          }),
        );
      }
      await this.driver.transaction(statements);
      return (await this.getById(kitId))!;
    }

    /**
     * Resolve each component to its primary (home) location id — the placement an assemble draws
     * from / a disassemble returns to (mirroring `adjustQuantity`'s home-location model) — in one
     * set-based read. Doubles as the component-side tracking-mode guard: assemble/disassemble move
     * stock by integer quantity, so every component must be DISCRETE (a SERIALISED, gauge or
     * unlimited component can't be consumed/produced by count) — rejected here with a clear message
     * rather than a downstream ledger `CHECK` failure. Gauge-tracked components are a v3 concern.
     */
    private async resolveComponentPlacements(
      components: readonly KitComponent[],
    ): Promise<Map<string, string>> {
      if (components.length === 0) return new Map();
      const ids = components.map((c) => c.componentItemId);
      const rows = await this.driver.query<{ id: string; location_id: string; tracking_mode: string }>(
        `SELECT id, location_id, tracking_mode FROM items WHERE id IN (${ids.map(() => '?').join(', ')});`,
        [...ids],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const c of components) {
        const row = byId.get(c.componentItemId);
        if (row && row.tracking_mode !== 'DISCRETE') {
          throw new DbError(
            'SQLITE_CONSTRAINT',
            `Kit components must be Discrete to move by quantity ("${c.name}" is ${row.tracking_mode}).`,
          );
        }
      }
      return new Map(rows.map((r) => [r.id, r.location_id]));
    }

    /**
     * Guard a proposed `kit → component` link. Both items must exist; the link must not be
     * self-containment or close a cycle. A cycle would form if the kit is already reachable
     * *below* the proposed component in the containment graph — so walk the component's
     * descendant set (every item it transitively contains) via a recursive CTE and let the
     * pure `validateKitLink` decide. Throws a `DbError` on rejection.
     */
    private async assertKitLinkValid(kitId: string, componentItemId: string): Promise<void> {
      const kitExists = await this.driver.queryOne('SELECT 1 AS ok FROM items WHERE id = ?;', [kitId]);
      if (!kitExists) {
        throw new DbError('SQLITE_CONSTRAINT_FOREIGNKEY', `Kit item "${kitId}" does not exist.`);
      }
      const componentExists = await this.driver.queryOne('SELECT 1 AS ok FROM items WHERE id = ?;', [
        componentItemId,
      ]);
      if (!componentExists) {
        throw new DbError(
          'SQLITE_CONSTRAINT_FOREIGNKEY',
          `Component item "${componentItemId}" does not exist.`,
        );
      }

      // Every item reachable *below* the proposed component through the containment graph
      // (its components, their components, …). A cycle exists iff the kit is among them.
      // UNION (not UNION ALL) terminates even if the data somehow already held a cycle.
      const descendantRows = await this.driver.query<{ id: string }>(
        `WITH RECURSIVE descendants(id) AS (
           SELECT ?
           UNION
           SELECT kc.component_item_id FROM kit_components kc
           JOIN descendants d ON kc.kit_item_id = d.id
         )
         SELECT id FROM descendants;`,
        [componentItemId],
      );

      const rejection = validateKitLink({
        kitId,
        componentId: componentItemId,
        componentDescendantIds: descendantRows.map((r) => r.id),
      });
      if (rejection) {
        throw new DbError('SQLITE_CONSTRAINT', kitRejectionMessage(rejection));
      }
    }
  };
}

/**
 * Validate an assemble/disassemble `count` is a whole number ≥ 1, returning the integer.
 * Rejects fractions and non-positive values with a clear constraint error rather than a raw
 * ledger `CHECK` failure downstream.
 */
function assertWholeCount(count: number, verb: 'assemble' | 'disassemble'): number {
  if (!Number.isInteger(count) || count < 1) {
    throw new DbError('SQLITE_CONSTRAINT', `The number of kits to ${verb} must be a whole number ≥ 1.`);
  }
  return count;
}

/**
 * Guard that the kit item itself is DISCRETE before its stock is grown/shrunk by assembly —
 * a SERIALISED (quantity pinned at 1), gauge or unlimited item can't be produced/consumed by
 * count. Mirrors the `transferStock` / `adjustQuantity` DISCRETE precondition.
 */
function assertDiscreteKit(kit: Item): void {
  if (kit.trackingMode !== 'DISCRETE') {
    throw new DbError(
      'SQLITE_CONSTRAINT',
      `Only Discrete items can be assembled or disassembled as kits ("${kit.name}" is ${kit.trackingMode}).`,
    );
  }
}

/** Local noun pluraliser for ledger notes (kept in-layer; the UI uses `@/lib/plural`). */
function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
