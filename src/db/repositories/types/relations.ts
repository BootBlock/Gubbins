/**
 * Item-relation row + DTO types (feature-gap G6 — related-items cross-links).
 *
 * A directed link between two items (`from_item_id → to_item_id`) tagged with a `kind`
 * ("works with" / accessory / spare-for). The link is **reciprocal** — it surfaces on both
 * items — and its `id` is the deterministic canonical `from|to|kind` triple (see the pure
 * `item-relations.ts` seam), so concurrent identical adds merge by LWW rather than colliding.
 */
import type { RelationKind } from '@/features/inventory/item-relations';

export interface ItemRelationRow {
  readonly id: string;
  readonly from_item_id: string;
  readonly to_item_id: string;
  readonly kind: string;
  readonly note: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** A stored relation between two items. */
export interface ItemRelation {
  readonly id: string;
  readonly fromItemId: string;
  readonly toItemId: string;
  readonly kind: RelationKind;
  /** Optional free-text context for the link (e.g. "via USB-C adapter"); null when none. */
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * A relation joined with the *other* item's display fields, resolved for the viewing item — the
 * shape {@link ItemRepository.listRelations} returns. The reciprocal label/direction is derived
 * from `(viewingId, fromItemId, toItemId, kind)` by the pure `resolveRelationForItem` seam at the
 * hook/UI layer, so this stays a plain data row.
 */
export interface ItemRelationView extends ItemRelation {
  /** The other item in the relation (the one the viewing item links to). */
  readonly otherItemId: string;
  readonly otherItemName: string;
  /** The other item's SERIALISED instance number, when it is a serialised clone; null otherwise. */
  readonly otherItemSerialNo: number | null;
}

/** Parameters for adding a relation (feature-gap G6). */
export interface AddRelationInput {
  readonly fromItemId: string;
  readonly toItemId: string;
  /** One of the {@link RelationKind} values; normalised + validated by `planRelation`. */
  readonly kind: string;
  /** Optional free-text context for the link. */
  readonly note?: string | null;
}
