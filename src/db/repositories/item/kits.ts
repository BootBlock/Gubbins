/**
 * Kits / bundles concern (Kits v1 — definition + availability).
 *
 * A kit is an item *composed of* fixed per-kit quantities of other items (a first-aid
 * kit = 2 bandages + 1 scissors + 5 plasters). This mixin owns the `kit_components`
 * edge table: listing a kit's components (joined to each component's name and current
 * on-hand stock), and adding / re-quantifying / removing an edge. It is deliberately
 * *definition-only* — the stock-moving assemble/disassemble operation is a separate v2
 * piece. Distinct from variants (child SKUs of one identity) and a project BOM (transient
 * work): a kit is a reusable many-to-many item→component relationship.
 *
 * The containment graph must stay acyclic (a kit cannot contain itself, directly or
 * transitively). The trivial one-hop case is caught by a DB CHECK; deeper transitive
 * cycles are rejected here by walking the proposed component's descendant set with a
 * recursive CTE and letting the pure `validateKitLink` decide — mirroring the variants
 * (`assertVariantLinkValid`) and nested-location cycle guards.
 */
import { DbError } from '../../errors';
import { kitRejectionMessage, validateKitLink } from '@/features/inventory/kits';
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
