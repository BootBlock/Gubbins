/**
 * The Visual Search Abstract Syntax Tree (spec §5.1, Phase 5).
 *
 * These interfaces are the **exact** schema mandated by §5.1 — the ephemeral tree
 * the Visual Builder edits (held in a Tier-3 `SearchBuilderContext`, §2.1) and the
 * sole input to {@link parseASTtoSQL}. They are deliberately serialisable plain
 * data: no methods, no class instances, so the tree can round-trip through React
 * state and (later) be persisted as a saved search.
 */

/** How sibling conditions in a group combine. */
export type LogicalOperator = 'AND' | 'OR';

/** The comparison a single condition applies to its field (spec §5.1). */
export type FilterOperator = 'EQUALS' | 'CONTAINS' | 'GREATER_THAN' | 'LESS_THAN' | 'HAS_CAPABILITY';

/** A single leaf predicate, e.g. `{ field: 'capability:voltage', operator: 'GREATER_THAN', value: 3.3 }`. */
export interface FilterCondition {
  /** A known item field (`name`, `mpn`, `quantity`, `category`…) or `capability:<key>`. */
  readonly field: string;
  readonly operator: FilterOperator;
  readonly value: string | number | boolean;
}

/** A boolean grouping of conditions and/or nested groups (the recursive node). */
export interface ASTGroupNode {
  readonly type: 'GROUP';
  readonly logicalOperator: LogicalOperator;
  readonly conditions: ReadonlyArray<ASTGroupNode | FilterCondition>;
  /**
   * Invert the whole group — "**not** any of this" (issue #139). Optional, so every tree
   * written before negation existed stays valid and reads as the un-negated default.
   *
   * Negation lives on the *group* rather than on each {@link FilterCondition} deliberately:
   * one flag, wrapped once around the group's emitted fragment by {@link parseASTtoSQL},
   * negates every predicate — including ones (FTS, EXISTS subqueries) that have no natural
   * inverted form of their own — so no individual predicate translator has to know about it.
   * A single condition is negated by wrapping it in a one-child negated group; {@link negated}
   * does exactly that.
   */
  readonly negate?: boolean;
}

/** The root of the Visual Builder is always a group (spec §5.1). */
export type SearchAST = ASTGroupNode;

/**
 * Hard cap on nested GROUP depth (spec §5.1). The root group is depth 1; each
 * nested group adds one. {@link parseASTtoSQL} throws past this to prevent stack
 * overflow / catastrophic backtracking from a hostile or runaway tree.
 */
export const MAX_AST_GROUP_DEPTH = 4;

/** Narrow a child node to a nested group vs a leaf condition. */
export function isGroupNode(node: ASTGroupNode | FilterCondition): node is ASTGroupNode {
  return (node as ASTGroupNode).type === 'GROUP';
}

/** An empty root group — the Visual Builder's initial "match everything" state. */
export function emptyAst(logicalOperator: LogicalOperator = 'AND'): ASTGroupNode {
  return { type: 'GROUP', logicalOperator, conditions: [] };
}

/**
 * Logically invert a node, returning the equivalent negated GROUP (issue #139).
 *
 * A group simply toggles its own {@link ASTGroupNode.negate} flag — so a double negation
 * cancels back to the plain group rather than stacking wrappers and eating a level of the
 * {@link MAX_AST_GROUP_DEPTH} budget. A bare condition has nowhere to carry the flag, so it
 * is wrapped in a one-child negated group.
 *
 * Shared by every front end that can express negation (the text-query lexer's `-term` /
 * `NOT` forms and the bridge's OData `not` / `ne`) so they all build the identical tree.
 */
export function negated(node: ASTGroupNode | FilterCondition): ASTGroupNode {
  if (!isGroupNode(node)) {
    return { type: 'GROUP', logicalOperator: 'AND', negate: true, conditions: [node] };
  }
  const { negate, ...rest } = node;
  // Drop the key entirely when cancelling, so an un-negated tree stays byte-identical to one
  // that never carried the flag (saved searches and tests compare these trees structurally).
  return negate === true ? rest : { ...rest, negate: true };
}
