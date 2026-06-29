/**
 * Parent/child variant concern (spec §4 Variant/SKU, Phase 9; nesting lifted Phase 18).
 * The parent holds shared metadata; the variant carries its own qty/location. Nesting is
 * arbitrarily deep, so the only structural rule enforced is cycle/self-parent rejection.
 */
import { DbError } from '../../errors';
import type { SqlStatement } from '../../rpc/driver';
import { validateVariantLink, variantRejectionMessage } from '@/features/lifecycle/variants';
import { rowToItem } from '../mappers';
import type { CreateItemInput, Item, ItemRow, Page } from '../types';
import { buildInsert, resolveCreate } from './create';
import { historyStatement } from './history';
import { THUMBNAIL_SUBQUERY } from './sql';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

export function withVariants<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemVariantRepository extends Base {
    /** The child variants of a parent item, ordered by name then serial (spec §4). */
    async listVariants(parentId: string): Promise<Page<Item>> {
      const rows = await this.driver.query<ItemRow>(
        `SELECT items.*, ${THUMBNAIL_SUBQUERY} FROM items WHERE parent_id = ?
         ORDER BY name COLLATE NOCASE ASC, serial_no ASC, created_at ASC;`,
        [parentId],
      );
      // Variant lists are inherently small (one SKU's variants); no offset needed.
      return this.toPage(rows.map(rowToItem), rows.length || 1, 0);
    }

    /**
     * Create a child variant under an existing parent (spec §4 Variant/SKU). The
     * parent holds shared metadata; the variant carries its own qty/location. Phase 18
     * lifts the single-level cap: the parent may itself be a variant (nesting is free),
     * so the only structural check before the INSERT is that the parent exists. The
     * brand-new id cannot create a cycle. Write-gated.
     */
    async createVariant(parentId: string, input: CreateItemInput): Promise<Item> {
      this.assertWritable();
      const id = crypto.randomUUID();
      await this.assertVariantLinkValid(id, parentId);
      const resolved = resolveCreate(input);
      await this.driver.transaction(buildInsert(id, resolved, null, parentId));
      return (await this.getById(id))!;
    }

    /**
     * Attach an existing item to a parent as a variant, or detach it (parentId null).
     * Phase 18 allows arbitrarily-deep nesting, so the only structural rule enforced is
     * cycle/self-parent rejection (§7.5.3) — checked against the parent's full ancestor
     * chain before writing. An item that already has its own variants may now become a
     * variant too (it carries its sub-tree along). Write-gated.
     */
    async setParent(childId: string, parentId: string | null): Promise<Item> {
      this.assertWritable();
      const child = await this.require(childId);
      if (parentId === child.parentId) return child;

      const statements: SqlStatement[] = [];
      if (parentId === null) {
        statements.push({ sql: 'UPDATE items SET parent_id = NULL WHERE id = ?;', params: [childId] });
      } else {
        await this.assertVariantLinkValid(childId, parentId);
        statements.push({ sql: 'UPDATE items SET parent_id = ? WHERE id = ?;', params: [parentId, childId] });
        statements.push(
          historyStatement(childId, 'VARIANT_CREATED', { note: 'Attached as a variant of a parent item.' }),
        );
      }
      await this.driver.transaction(statements);
      return (await this.getById(childId))!;
    }

    /**
     * Guard a proposed `child → parent` variant link (spec §4, §7.5.3). The parent
     * must exist; the link must not be self-parenting or form a cycle (the child
     * appearing in the parent's ancestor chain). Nesting depth is unbounded (Phase 18),
     * so this mirrors `LocationRepository.assertParentMoveValid`: walk up from the
     * proposed parent via a recursive CTE and let the pure `validateVariantLink`
     * decide. Throws a `DbError` on rejection.
     */
    private async assertVariantLinkValid(childId: string, parentId: string): Promise<void> {
      const parentExists = await this.driver.queryOne('SELECT 1 AS ok FROM items WHERE id = ?;', [parentId]);
      if (!parentExists) {
        throw new DbError('SQLITE_CONSTRAINT_FOREIGNKEY', `Parent item "${parentId}" does not exist.`);
      }

      // The proposed parent's ancestor chain (parent, grandparent, …) — a cycle exists
      // if the child being attached appears anywhere in it.
      const ancestorRows = await this.driver.query<{ id: string }>(
        `WITH RECURSIVE ancestors(id) AS (
           SELECT ?
           UNION ALL
           SELECT i.parent_id FROM items i
           JOIN ancestors a ON i.id = a.id
           WHERE i.parent_id IS NOT NULL
         )
         SELECT id FROM ancestors;`,
        [parentId],
      );

      const rejection = validateVariantLink({
        childId,
        parentId,
        parentAncestorIds: ancestorRows.map((r) => r.id),
      });
      if (rejection) {
        throw new DbError('SQLITE_CONSTRAINT', variantRejectionMessage(rejection));
      }
    }
  };
}
