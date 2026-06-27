import { describe, it, expect } from 'vitest';
import { emptyAst, isGroupNode, type ASTGroupNode } from '@/db/search/ast';
import {
  builderReducer,
  canAddGroup,
  countConditions,
  type BuilderAction,
} from './builder-reducer';

/** Apply a sequence of actions to an empty tree. */
function run(...actions: BuilderAction[]): ASTGroupNode {
  return actions.reduce(builderReducer, emptyAst('AND'));
}

describe('builderReducer (spec §5.1, Tier 3)', () => {
  it('adds a default condition to the root group', () => {
    const ast = run({ type: 'addCondition', path: [] });
    expect(ast.conditions).toHaveLength(1);
    expect(ast.conditions[0]).toEqual({ field: 'name', operator: 'CONTAINS', value: '' });
  });

  it('updates a condition at a path immutably', () => {
    const before = run({ type: 'addCondition', path: [] });
    const after = builderReducer(before, {
      type: 'updateCondition',
      path: [0],
      patch: { field: 'quantity', operator: 'GREATER_THAN', value: 10 },
    });
    expect(after.conditions[0]).toEqual({ field: 'quantity', operator: 'GREATER_THAN', value: 10 });
    // The previous state is untouched (no mutation).
    expect((before.conditions[0] as { field: string }).field).toBe('name');
  });

  it('toggles a group operator', () => {
    const ast = builderReducer(emptyAst('AND'), { type: 'setOperator', path: [], operator: 'OR' });
    expect(ast.logicalOperator).toBe('OR');
  });

  it('nests a group and edits inside it', () => {
    const ast = run(
      { type: 'addCondition', path: [] },
      { type: 'addGroup', path: [] },
      { type: 'addCondition', path: [1] },
      { type: 'updateCondition', path: [1, 0], patch: { field: 'manufacturer', value: 'TI' } },
    );
    expect(ast.conditions).toHaveLength(2);
    const nested = ast.conditions[1] as ASTGroupNode;
    expect(isGroupNode(nested)).toBe(true);
    expect(nested.conditions[0]).toMatchObject({ field: 'manufacturer', value: 'TI' });
  });

  it('removes a node by path', () => {
    const ast = run(
      { type: 'addCondition', path: [] },
      { type: 'addCondition', path: [] },
      { type: 'remove', path: [0] },
    );
    expect(ast.conditions).toHaveLength(1);
  });

  it('resetting (or removing the root) yields an empty group keeping the operator', () => {
    const seeded = run({ type: 'setOperator', path: [], operator: 'OR' }, {
      type: 'addCondition',
      path: [],
    });
    expect(builderReducer(seeded, { type: 'reset' })).toEqual(emptyAst('OR'));
    expect(builderReducer(seeded, { type: 'remove', path: [] })).toEqual(emptyAst('OR'));
  });

  it('counts leaf conditions across nesting', () => {
    const ast = run(
      { type: 'addCondition', path: [] },
      { type: 'addGroup', path: [] },
      { type: 'addCondition', path: [1] },
      { type: 'addCondition', path: [1] },
    );
    expect(countConditions(ast)).toBe(3);
  });

  it('enforces the depth cap when nesting groups', () => {
    // root(1) → [0]group(2) → [0,0]group(3): the next nest would be depth 4 — allowed;
    // a further nest would be depth 5 — refused.
    expect(canAddGroup([])).toBe(true); // child at depth 2
    expect(canAddGroup([0])).toBe(true); // child at depth 3
    expect(canAddGroup([0, 0])).toBe(true); // child at depth 4
    expect(canAddGroup([0, 0, 0])).toBe(false); // child at depth 5 — over cap

    // The reducer is a no-op past the cap.
    const deep = run(
      { type: 'addGroup', path: [] },
      { type: 'addGroup', path: [0] },
      { type: 'addGroup', path: [0, 0] },
    );
    const blocked = builderReducer(deep, { type: 'addGroup', path: [0, 0, 0] });
    expect(blocked).toBe(deep); // unchanged reference — refused
  });
});
