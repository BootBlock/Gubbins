/**
 * Parent/Child variant linkage rules (spec §4 Variant/SKU Relationships, Phase 9),
 * kept pure. Phase 9 scope is an *abstract, single-level* parent: the parent holds
 * only shared metadata, child variants carry qty/location, and a variant may not
 * itself be a parent. These rules mirror the §7.5.3 cycle-rejection discipline used
 * for location nesting — the repository gathers the facts (via SQL) and this pure
 * validator decides, so the decision is exhaustively unit-testable.
 */

/**
 * Why a proposed `child → parent` variant link was rejected, or `null` if valid:
 * - `SELF_PARENT` — an item cannot be its own parent.
 * - `CYCLE` — the child appears in the parent's ancestor chain (defence in depth;
 *   single-level should make this unreachable, but we guard like §7.5.3).
 * - `PARENT_IS_VARIANT` — the chosen parent is itself a child variant (would create
 *   a second level, which the single-level model forbids).
 * - `CHILD_HAS_VARIANTS` — the child already has its own variants, so it is a parent
 *   and cannot also become a variant.
 */
export type VariantRejection =
  | 'SELF_PARENT'
  | 'CYCLE'
  | 'PARENT_IS_VARIANT'
  | 'CHILD_HAS_VARIANTS';

export interface VariantLinkFacts {
  /** The item being made a variant. */
  readonly childId: string;
  /** The item proposed as its parent. */
  readonly parentId: string;
  /** Whether the proposed parent already has a `parent_id` (is itself a variant). */
  readonly parentIsVariant: boolean;
  /** Whether the child already has child variants of its own. */
  readonly childHasVariants: boolean;
  /** The proposed parent's ancestor ids (parent, grandparent, …) for cycle detection. */
  readonly parentAncestorIds: readonly string[];
}

export function validateVariantLink(facts: VariantLinkFacts): VariantRejection | null {
  if (facts.childId === facts.parentId) return 'SELF_PARENT';
  if (facts.parentAncestorIds.includes(facts.childId)) return 'CYCLE';
  if (facts.parentIsVariant) return 'PARENT_IS_VARIANT';
  if (facts.childHasVariants) return 'CHILD_HAS_VARIANTS';
  return null;
}

/** Human-readable reason for a rejected variant link (British English, for toasts). */
export function variantRejectionMessage(reason: VariantRejection): string {
  switch (reason) {
    case 'SELF_PARENT':
      return 'An item cannot be a variant of itself.';
    case 'CYCLE':
      return 'That would create a circular variant relationship.';
    case 'PARENT_IS_VARIANT':
      return 'The chosen parent is already a variant; variants cannot be nested.';
    case 'CHILD_HAS_VARIANTS':
      return 'This item already has its own variants and cannot become a variant.';
  }
}
