/**
 * Related-items cross-link concern (feature-gap G6). A synced many-to-many relation *between*
 * items — "works with" / accessory / spare-for — distinct from variants (`parent_id`) and kits.
 *
 * Relations participate in synchronisation (§7.1): `item_relations` is an LWW leaf carrying its own
 * `updated_at`, so an add is a plain INSERT and a remove is a DELETE + tombstone in the same
 * transaction (so the deletion propagates instead of being resurrected from a peer, §7.2). The row
 * `id` is the **deterministic** canonical `from|to|kind` triple (`itemRelationId`), so two devices
 * adding the same logical relation mint the same id and merge by LWW — hence an add is idempotent
 * (a matching relation is returned untouched rather than duplicated). All vocabulary/validation is
 * in the pure `item-relations.ts` seam; this mixin is the thin SQL glue around it.
 */
import { DbError } from '../../errors';
import type { SqlStatement } from '../../rpc/driver';
import { planRelation, type RelationPlanError } from '@/features/inventory/item-relations';
import { rowToItemRelation, rowToItemRelationView } from '../mappers';
import { tombstoneStatement } from '../tombstone';
import type { AddRelationInput, ItemRelation, ItemRelationView } from '../types';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

/** User-facing message for each reason `planRelation` can reject a proposed relation. */
const REJECTION_MESSAGE: Record<RelationPlanError, string> = {
  SELF: 'An item cannot be related to itself.',
  INVALID_KIND: 'Unknown relationship type.',
};

export function withRelations<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemRelationRepository extends Base {
    /**
     * Every relation touching `itemId` (either endpoint), resolved with the *other* item's name +
     * serial for display, ordered by the other item's name. The reciprocal label/direction is
     * derived at the hook/UI layer by the pure `resolveRelationForItem` seam, so this returns plain
     * joined rows. Bounded per item; strictly-paginated reads are unnecessary for this small set.
     */
    async listRelations(itemId: string): Promise<ItemRelationView[]> {
      const rows = await this.driver.query<Parameters<typeof rowToItemRelationView>[0]>(
        `SELECT r.*,
                CASE WHEN r.from_item_id = ?1 THEN r.to_item_id ELSE r.from_item_id END AS other_item_id,
                oi.name      AS other_item_name,
                oi.serial_no AS other_item_serial_no
         FROM item_relations r
         JOIN items oi
           ON oi.id = CASE WHEN r.from_item_id = ?1 THEN r.to_item_id ELSE r.from_item_id END
         WHERE r.from_item_id = ?1 OR r.to_item_id = ?1
         ORDER BY other_item_name COLLATE NOCASE ASC, r.kind ASC;`,
        [itemId],
      );
      return rows.map(rowToItemRelationView);
    }

    /**
     * Add a relation between two items (feature-gap G6). The pair + kind are validated and
     * canonicalised by the pure `planRelation` seam (a self-relation or unknown kind is rejected);
     * both items must exist. **Idempotent**: because the id is the deterministic canonical triple,
     * re-adding an existing relation (in either direction, for a symmetric kind) returns the stored
     * row unchanged rather than duplicating it. Write-gated (it grows storage).
     */
    async addRelation(input: AddRelationInput): Promise<ItemRelation> {
      this.assertWritable();

      const plan = planRelation(input.fromItemId, input.toItemId, input.kind);
      if (!plan.ok) {
        throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE[plan.reason]);
      }
      // Both endpoints must exist (the FK would reject otherwise, but a clear error is friendlier).
      await this.require(plan.spec.fromItemId);
      await this.require(plan.spec.toItemId);

      const existing = await this.getRelation(plan.id);
      if (existing) return existing;

      const note = input.note?.trim() || null;
      await this.driver.execute(
        `INSERT INTO item_relations (id, from_item_id, to_item_id, kind, note) VALUES (?, ?, ?, ?, ?);`,
        [plan.id, plan.spec.fromItemId, plan.spec.toItemId, plan.spec.kind, note],
      );
      return (await this.getRelation(plan.id))!;
    }

    /**
     * Remove a relation by id — DELETE + tombstone in the same transaction so the removal
     * propagates on the next sync (§7.2). Always permitted (a delete frees storage). A genuine
     * no-op when the id doesn't exist: no tombstone is recorded (tombstoning an id this device
     * never held would wrongly instruct peers to delete it).
     */
    async removeRelation(relationId: string): Promise<void> {
      if (!(await this.getRelation(relationId))) return;
      const statements: SqlStatement[] = [
        { sql: 'DELETE FROM item_relations WHERE id = ?;', params: [relationId] },
        tombstoneStatement('item_relations', relationId),
      ];
      await this.driver.transaction(statements);
    }

    /** Fetch a single relation by id, or undefined when absent (internal helper). */
    private async getRelation(relationId: string): Promise<ItemRelation | undefined> {
      const row = await this.driver.queryOne<Parameters<typeof rowToItemRelation>[0]>(
        'SELECT * FROM item_relations WHERE id = ?;',
        [relationId],
      );
      return row ? rowToItemRelation(row) : undefined;
    }
  };
}
