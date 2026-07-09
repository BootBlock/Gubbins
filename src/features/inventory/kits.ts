/**
 * Kit → component linkage rules (Kits v1), kept pure.
 *
 * A kit is a reusable many-to-many item→component definition: the kit item is composed
 * of fixed per-kit quantities of other items. The only structural invariant is that the
 * containment graph stays acyclic — a kit cannot contain itself, directly or transitively
 * (§7.5.3-style discipline, exactly as nested locations and variants). The repository
 * gathers the facts (the proposed component's descendant set, via a recursive CTE) and
 * this pure validator decides, so the decision is exhaustively unit-testable.
 */

/**
 * Why a proposed `kit → component` link was rejected, or `null` if valid:
 * - `SELF` — an item cannot be a component of itself.
 * - `CYCLE` — the kit already appears in the component's own sub-component tree, so the
 *   link would make the kit contain itself transitively (the sole structural rule).
 */
export type KitRejection = 'SELF' | 'CYCLE';

export interface KitLinkFacts {
  /** The kit gaining a component. */
  readonly kitId: string;
  /** The item proposed as a component of it. */
  readonly componentId: string;
  /**
   * The component's own descendant ids (every item reachable *below* it through the
   * containment graph), for cycle detection. The component itself may be included; only
   * the kit's presence matters.
   */
  readonly componentDescendantIds: readonly string[];
}

export function validateKitLink(facts: KitLinkFacts): KitRejection | null {
  if (facts.kitId === facts.componentId) return 'SELF';
  if (facts.componentDescendantIds.includes(facts.kitId)) return 'CYCLE';
  return null;
}

/** Human-readable reason for a rejected kit link (British English, for toasts). */
export function kitRejectionMessage(reason: KitRejection): string {
  switch (reason) {
    case 'SELF':
      return 'A kit cannot contain itself as a component.';
    case 'CYCLE':
      return 'That would create a circular kit relationship.';
  }
}
