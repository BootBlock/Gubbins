/**
 * Parent/Child variant linkage rules (spec §4 Variant/SKU), kept pure. Phase 9
 * shipped an *abstract, single-level* parent; Phase 18 lifts that cap to allow
 * arbitrarily-nested variants (grandparent SKUs and deeper), leaving cycle
 * rejection as the sole structural invariant — exactly the §7.5.3 discipline used
 * for infinitely-nested locations. The repository gathers the facts (the proposed
 * parent's ancestor chain, via a recursive CTE) and this pure validator decides,
 * so the decision is exhaustively unit-testable.
 */

/**
 * Why a proposed `child → parent` variant link was rejected, or `null` if valid:
 * - `SELF_PARENT` — an item cannot be its own parent.
 * - `CYCLE` — the child appears in the parent's ancestor chain, so the move would
 *   make an item its own descendant (the only structural rule now nesting is free).
 */
export type VariantRejection = 'SELF_PARENT' | 'CYCLE';

export interface VariantLinkFacts {
  /** The item being made a variant. */
  readonly childId: string;
  /** The item proposed as its parent. */
  readonly parentId: string;
  /** The proposed parent's ancestor ids (parent, grandparent, …) for cycle detection. */
  readonly parentAncestorIds: readonly string[];
}

export function validateVariantLink(facts: VariantLinkFacts): VariantRejection | null {
  if (facts.childId === facts.parentId) return 'SELF_PARENT';
  if (facts.parentAncestorIds.includes(facts.childId)) return 'CYCLE';
  return null;
}

/** Human-readable reason for a rejected variant link (British English, for toasts). */
export function variantRejectionMessage(reason: VariantRejection): string {
  switch (reason) {
    case 'SELF_PARENT':
      return 'An item cannot be a variant of itself.';
    case 'CYCLE':
      return 'That would create a circular variant relationship.';
  }
}
