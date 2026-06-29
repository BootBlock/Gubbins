/**
 * Reusable SQL fragments for item reads, shared across the {@link ItemRepository}
 * concern modules. Keeping them here means the correlated thumbnail subquery and the
 * capability "best match" score are defined once rather than copied per query.
 */

/**
 * A correlated subquery yielding an item's *primary* thumbnail blob (lowest
 * `position`) and nothing else from `item_images` (spec §4.2.4: list/detail reads
 * JOIN the image table but select the thumbnail only — never the full-res path).
 */
export const THUMBNAIL_SUBQUERY = `(
  SELECT thumbnail_blob FROM item_images
  WHERE item_images.item_id = items.id
  ORDER BY position ASC, rowid ASC LIMIT 1
) AS thumbnail_blob`;

/**
 * A correlated subquery yielding an item's "best match" relevance score (spec §4,
 * §5.1): the summed `weight` of the queried capabilities the item actually carries.
 * The `keyCount` placeholders are bound to the de-duplicated capability keys the AST
 * filters on (case-insensitive). An item missing every queried capability scores 0.
 */
export function capabilityMatchScore(keyCount: number): string {
  const placeholders = Array.from({ length: keyCount }, () => '?').join(', ');
  return `(
    SELECT COALESCE(SUM(c.weight), 0) FROM capabilities c
    WHERE c.item_id = items.id AND c.key COLLATE NOCASE IN (${placeholders})
  ) AS match_score`;
}
