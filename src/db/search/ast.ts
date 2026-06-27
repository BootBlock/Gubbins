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
export type FilterOperator =
  | 'EQUALS'
  | 'CONTAINS'
  | 'GREATER_THAN'
  | 'LESS_THAN'
  | 'HAS_CAPABILITY';

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
