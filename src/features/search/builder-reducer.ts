/**
 * Pure reducer for the Visual-Builder AST (spec §5.1, §2.1 Tier 3).
 *
 * The ephemeral search tree is edited immutably here, addressed by a `path` — an
 * array of child indices from the root group (`[]` is the root itself, `[2,0]` is
 * `root.conditions[2].conditions[0]`). Keeping this logic pure (no React) makes the
 * tricky nested-tree operations directly unit-testable, with the
 * {@link SearchBuilderContext} merely holding the state.
 */
import {
  MAX_AST_GROUP_DEPTH,
  emptyAst,
  isGroupNode,
  type ASTGroupNode,
  type FilterCondition,
  type LogicalOperator,
} from '@/db/search/ast';

export type BuilderPath = readonly number[];

export type BuilderAction =
  | { type: 'addCondition'; path: BuilderPath }
  | { type: 'addGroup'; path: BuilderPath }
  | { type: 'remove'; path: BuilderPath }
  | { type: 'updateCondition'; path: BuilderPath; patch: Partial<FilterCondition> }
  | { type: 'setOperator'; path: BuilderPath; operator: LogicalOperator }
  | { type: 'reset' };

/** The default leaf inserted by "Add condition" — a free-text name search. */
export function defaultCondition(): FilterCondition {
  return { field: 'name', operator: 'CONTAINS', value: '' };
}

/** Count the leaf conditions in a tree — used to tell whether a search is "active". */
export function countConditions(node: ASTGroupNode): number {
  return node.conditions.reduce(
    (sum, child) => sum + (isGroupNode(child) ? countConditions(child) : 1),
    0,
  );
}

/** Can a *new* group be nested inside the group at `path` without breaching the cap? */
export function canAddGroup(path: BuilderPath): boolean {
  // Group at `path` sits at depth path.length + 1; its new child group would be one
  // deeper. That child's depth must not exceed MAX_AST_GROUP_DEPTH (spec §5.1).
  return path.length + 2 <= MAX_AST_GROUP_DEPTH;
}

export function builderReducer(ast: ASTGroupNode, action: BuilderAction): ASTGroupNode {
  switch (action.type) {
    case 'addCondition':
      return replaceGroupAtPath(ast, action.path, (g) => ({
        ...g,
        conditions: [...g.conditions, defaultCondition()],
      }));

    case 'addGroup':
      if (!canAddGroup(action.path)) return ast;
      return replaceGroupAtPath(ast, action.path, (g) => ({
        ...g,
        conditions: [...g.conditions, emptyAst('AND')],
      }));

    case 'setOperator':
      return replaceGroupAtPath(ast, action.path, (g) => ({
        ...g,
        logicalOperator: action.operator,
      }));

    case 'remove': {
      if (action.path.length === 0) return emptyAst(ast.logicalOperator);
      const parent = action.path.slice(0, -1);
      const index = action.path[action.path.length - 1];
      return replaceGroupAtPath(ast, parent, (g) => ({
        ...g,
        conditions: g.conditions.filter((_, i) => i !== index),
      }));
    }

    case 'updateCondition': {
      const parent = action.path.slice(0, -1);
      const index = action.path[action.path.length - 1];
      return replaceGroupAtPath(ast, parent, (g) => ({
        ...g,
        conditions: g.conditions.map((child, i) =>
          i === index && !isGroupNode(child) ? { ...child, ...action.patch } : child,
        ),
      }));
    }

    case 'reset':
      return emptyAst(ast.logicalOperator);

    default:
      return ast;
  }
}

/** Immutably replace the GROUP node at `path` with `fn(group)`. */
function replaceGroupAtPath(
  node: ASTGroupNode,
  path: BuilderPath,
  fn: (group: ASTGroupNode) => ASTGroupNode,
): ASTGroupNode {
  if (path.length === 0) return fn(node);
  const [head, ...rest] = path;
  return {
    ...node,
    conditions: node.conditions.map((child, i) =>
      i === head && isGroupNode(child) ? replaceGroupAtPath(child, rest, fn) : child,
    ),
  };
}
