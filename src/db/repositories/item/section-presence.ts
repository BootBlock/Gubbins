/**
 * "Which of this item's sections actually hold data?" (issue #618).
 *
 * A category can hide the capabilities its items don't have — a Movie has no maintenance
 * schedule — but hiding must never make *existing* data invisible. So a hidden section is
 * still shown when it holds something, and this is how the UI finds out.
 *
 * It is one query on purpose. The obvious alternative — compose the several hooks the child
 * editors already use — would defeat the item dialog's active-panel-only mounting and load
 * every section's data on every open, for a question that is a handful of `EXISTS` probes
 * against indexed columns. The dialog also only asks when the item's category hides something,
 * so an inventory that hides nothing pays nothing.
 *
 * Only table-backed sections appear here. Presence for anything already to hand is read from
 * what the caller holds — the expiry and batch columns on the item row, the lot rows the stock
 * breakdown has loaded — so spending a subquery on those would be waste.
 */
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

/** Raw 0/1 flags as SQLite returns them. */
interface SectionPresenceRow {
  readonly has_maintenance: number;
  readonly has_kit: number;
  readonly has_tags: number;
  readonly has_attachments: number;
  readonly has_capabilities: number;
  readonly has_custom_fields: number;
  readonly has_placements: number;
}

/**
 * Whether each table-backed item-detail section holds anything for one item.
 *
 * Every member answers exactly one question — "would this section have something to show?" —
 * so the caller never has to know which table backs which section.
 */
export interface ItemSectionPresence {
  /** Any maintenance schedule. */
  readonly maintenance: boolean;
  /** Any kit component, i.e. this item is assembled from others. */
  readonly kit: boolean;
  /** Any tag. */
  readonly tags: boolean;
  /** Any attachment/datasheet. */
  readonly attachments: boolean;
  /** Any weighted capability. */
  readonly capabilities: boolean;
  /**
   * Any stored custom-field value, including one the item is deliberately inheriting from a
   * location (choosing to inherit writes a row). A value showing only because the *category*
   * supplies a default is not the item's own data and does not count.
   */
  readonly customFields: boolean;
  /** Any location-region placement. */
  readonly placements: boolean;
}

/** Nothing anywhere — the answer for an item whose category hides nothing. */
export const NO_SECTION_PRESENCE: ItemSectionPresence = {
  maintenance: false,
  kit: false,
  tags: false,
  attachments: false,
  capabilities: false,
  customFields: false,
  placements: false,
};

export function withSectionPresence<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemSectionPresenceRepository extends Base {
    /**
     * Which table-backed sections hold data for `itemId`.
     *
     * One row, seven `EXISTS` subqueries, every one of them against an indexed `item_id`.
     * `EXISTS` stops at the first hit rather than counting, so this stays flat as an item
     * accumulates history.
     *
     * Batches are absent by design: both batch surfaces already hold the data they gate on —
     * the stock breakdown has the lot rows, the lifecycle editor has the item's batch and lot
     * numbers — so probing for them here would be a subquery with no reader.
     */
    async getSectionPresence(itemId: string): Promise<ItemSectionPresence> {
      const rows = await this.driver.query<SectionPresenceRow>(
        `SELECT
           EXISTS(SELECT 1 FROM maintenance_schedules WHERE item_id = ?1)              AS has_maintenance,
           EXISTS(SELECT 1 FROM kit_components        WHERE kit_item_id = ?1)          AS has_kit,
           EXISTS(SELECT 1 FROM item_tags             WHERE item_id = ?1)              AS has_tags,
           EXISTS(SELECT 1 FROM item_attachments      WHERE item_id = ?1)              AS has_attachments,
           EXISTS(SELECT 1 FROM capabilities          WHERE item_id = ?1)              AS has_capabilities,
           EXISTS(SELECT 1 FROM item_field_values     WHERE item_id = ?1)              AS has_custom_fields,
           EXISTS(SELECT 1 FROM item_regions          WHERE item_id = ?1)              AS has_placements;`,
        [itemId],
      );
      const row = rows[0];
      if (row === undefined) return NO_SECTION_PRESENCE;
      return {
        maintenance: row.has_maintenance === 1,
        kit: row.has_kit === 1,
        tags: row.has_tags === 1,
        attachments: row.has_attachments === 1,
        capabilities: row.has_capabilities === 1,
        customFields: row.has_custom_fields === 1,
        placements: row.has_placements === 1,
      };
    }
  };
}
