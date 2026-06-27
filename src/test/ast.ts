/**
 * Test-only builders for the Visual-Search AST (spec §5.1). Keeps the verbose
 * `{ type: 'GROUP', logicalOperator, conditions }` shape out of test bodies.
 */
import type {
  ASTGroupNode,
  FilterCondition,
  FilterOperator,
} from '@/db/search/ast';

export function and(...conditions: Array<ASTGroupNode | FilterCondition>): ASTGroupNode {
  return { type: 'GROUP', logicalOperator: 'AND', conditions };
}

export function or(...conditions: Array<ASTGroupNode | FilterCondition>): ASTGroupNode {
  return { type: 'GROUP', logicalOperator: 'OR', conditions };
}

export function leaf(
  field: string,
  operator: FilterOperator,
  value: string | number | boolean,
): FilterCondition {
  return { field, operator, value };
}
