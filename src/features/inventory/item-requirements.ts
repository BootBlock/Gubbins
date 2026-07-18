/**
 * Pure hard-dependency seam (issue #70 — "this item requires that one").
 *
 * The relation vocabulary in `item-relations.ts` is almost entirely **advisory**: "works with",
 * "is an accessory for", "is a spare for" describe affinity, and nothing in the app acts on them.
 * `REQUIRES` is the exception — it asserts that taking one item without another leaves you with
 * something unusable. This module owns the logic that turns those stored relations into the
 * "what's missing?" answer the loan and bill-of-materials surfaces render.
 *
 * Pure by design — no React, no repository, no SQL — so the arithmetic is exhaustively unit-testable
 * away from the query layer, matching the `item-relations.ts` / `reorder-policy.ts` seams.
 *
 * ## Depth is deliberately one level
 *
 * If A requires B and B requires C, checking out A reports **B only**, not C. A transitive walk
 * would need to fetch relations per newly-discovered item (an N+1 read that grows with the graph)
 * and a cycle guard, to surface prerequisites the user never linked to the thing in their hand.
 * One level matches what was actually recorded against the item, and B's own requirement surfaces
 * the moment B is the item in question.
 */
import {
  describeItemRelations,
  isDependencyKind,
  type ResolvedItemRelation,
  type StoredRelation,
} from './item-relations';

/**
 * A prerequisite of some item: the required item's id, plus the id of the relation that recorded it
 * (so a caller can link back to, or remove, the underlying link).
 */
export interface Requirement {
  readonly requiredItemId: string;
  readonly relationId: string;
}

/**
 * The items `itemId` **requires**, in the seam's stable display order.
 *
 * Only the *forward* end counts: a `REQUIRES` relation is directional, so `itemId` requires the
 * relation's `to` item. The reverse end ("Required by" — other things that need *this* item) is a
 * fact about those other items and is deliberately excluded; lending a PoE injector should not
 * nag about every access point that happens to need one.
 */
export function requirementsOf(itemId: string, relations: readonly StoredRelation[]): Requirement[] {
  return describeItemRelations(itemId, relations, isDependencyKind)
    .filter((r: ResolvedItemRelation) => r.direction === 'forward')
    .map((r) => ({ requiredItemId: r.otherItemId, relationId: r.id }));
}

/**
 * The subset of `requirements` whose item is **not** in `presentItemIds` — the prerequisites a
 * caller is about to take without. Order-preserving, so the seam's deterministic ordering survives.
 *
 * `presentItemIds` is whatever "already accounted for" means at the call site: the other lines of a
 * bill of materials, or the items already being lent in one checkout.
 */
export function missingRequirements(
  requirements: readonly Requirement[],
  presentItemIds: Iterable<string>,
): Requirement[] {
  const present = presentItemIds instanceof Set ? presentItemIds : new Set(presentItemIds);
  return requirements.filter((r) => !present.has(r.requiredItemId));
}

/**
 * Convenience for the single-item case: the prerequisites of `itemId` that aren't already covered.
 * `itemId` itself is always treated as present, so a (rejected upstream) self-relation can never
 * report the item as its own missing prerequisite.
 */
export function missingRequirementsOf(
  itemId: string,
  relations: readonly StoredRelation[],
  presentItemIds: Iterable<string> = [],
): Requirement[] {
  const present = new Set(presentItemIds);
  present.add(itemId);
  return missingRequirements(requirementsOf(itemId, relations), present);
}

/**
 * The per-line answer for a bill of materials (issue #70): for each item in `lineItemIds`, the
 * prerequisites that no *other* line covers. Every line's item counts as present — including the
 * line being examined — so a BOM that already lists both ends of a dependency reports nothing.
 *
 * `relationsByItem` maps an item id to the relations touching it (the bulk repository read); an
 * absent key simply means that item has no relations. Items with nothing missing are omitted from
 * the result, so an empty map means "the BOM is self-consistent".
 */
export function missingRequirementsByLine(
  lineItemIds: readonly string[],
  relationsByItem: ReadonlyMap<string, readonly StoredRelation[]>,
): Map<string, Requirement[]> {
  const present = new Set(lineItemIds);
  const out = new Map<string, Requirement[]>();
  for (const itemId of new Set(lineItemIds)) {
    const missing = missingRequirements(requirementsOf(itemId, relationsByItem.get(itemId) ?? []), present);
    if (missing.length > 0) out.set(itemId, missing);
  }
  return out;
}
