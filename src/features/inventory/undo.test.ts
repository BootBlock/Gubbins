import { describe, it, expect } from 'vitest';
import type { Item } from '@/db/repositories';
import type { BulkEditSpec } from './bulk-edit';
import {
  EMPTY_UNDO_PLAN,
  isUndoPlanEmpty,
  planBulkEditUndo,
  planMoveUndo,
  planRemoveUndo,
  snapshotForUndo,
  type ItemUndoSnapshot,
} from './undo';

/**
 * Unit tests for the undo seam (issue #131) — the pure half of "put that back".
 *
 * The interesting decision is *which* fields a given item needs restoring: a bulk edit is
 * applied uniformly, but each item was in its own state beforehand, so the inverse is per-item
 * and covers only the fields that genuinely moved. Everything below pins that.
 */

const snap = (over: Partial<ItemUndoSnapshot> = {}): ItemUndoSnapshot => ({
  id: 'item-1',
  categoryId: 'cat-old',
  locationId: 'loc-old',
  condition: 'GOOD',
  isActive: true,
  ...over,
});

describe('planBulkEditUndo — restores only what the edit changed', () => {
  it('captures the previous value of every field the spec sets', () => {
    const spec: BulkEditSpec = {
      category: { value: 'cat-new' },
      location: { value: 'loc-new' },
      condition: { value: 'NEEDS_REPAIR' },
      active: { value: false },
    };

    expect(planBulkEditUndo(spec, [snap()])).toEqual({
      steps: [
        {
          id: 'item-1',
          categoryId: 'cat-old',
          locationId: 'loc-old',
          condition: 'GOOD',
          isActive: true,
        },
      ],
    });
  });

  it('leaves fields the spec does not mention out of the step', () => {
    const plan = planBulkEditUndo({ location: { value: 'loc-new' } }, [snap()]);
    expect(plan.steps).toEqual([{ id: 'item-1', locationId: 'loc-old' }]);
  });

  it('records a cleared field as a restorable null, not as "untouched"', () => {
    const plan = planBulkEditUndo({ category: { value: null } }, [snap({ categoryId: 'cat-old' })]);
    // `categoryId: null` would be the *other* direction — here the item had a category to go back to.
    expect(plan.steps).toEqual([{ id: 'item-1', categoryId: 'cat-old' }]);

    const cleared = planBulkEditUndo({ category: { value: 'cat-new' } }, [snap({ categoryId: null })]);
    expect(cleared.steps).toEqual([{ id: 'item-1', categoryId: null }]);
  });

  it('drops an item that was already at every target value', () => {
    const spec: BulkEditSpec = { location: { value: 'loc-old' }, condition: { value: 'GOOD' } };
    expect(planBulkEditUndo(spec, [snap()])).toEqual(EMPTY_UNDO_PLAN);
  });

  it('keeps only the fields that moved when an item was partly there already', () => {
    const spec: BulkEditSpec = { location: { value: 'loc-old' }, category: { value: 'cat-new' } };
    expect(planBulkEditUndo(spec, [snap()]).steps).toEqual([{ id: 'item-1', categoryId: 'cat-old' }]);
  });

  it('plans one step per item, so a mixed batch reverses each item to its own state', () => {
    const plan = planBulkEditUndo({ location: { value: 'loc-new' } }, [
      snap({ id: 'a', locationId: 'loc-bench' }),
      snap({ id: 'b', locationId: 'loc-new' }), // already there — nothing to undo
      snap({ id: 'c', locationId: 'loc-shelf' }),
    ]);
    expect(plan.steps).toEqual([
      { id: 'a', locationId: 'loc-bench' },
      { id: 'c', locationId: 'loc-shelf' },
    ]);
  });
});

describe('planBulkEditUndo — tags', () => {
  it('restores the previous tag set when adding a tag changes it', () => {
    const plan = planBulkEditUndo({ tags: { mode: 'add', names: ['smd'] } }, [
      snap({ tagNames: ['through-hole'] }),
    ]);
    expect(plan.steps).toEqual([{ id: 'item-1', tagNames: ['through-hole'] }]);
  });

  it('adds no step when the added tags were already on the item', () => {
    const plan = planBulkEditUndo({ tags: { mode: 'add', names: ['smd'] } }, [snap({ tagNames: ['smd'] })]);
    expect(isUndoPlanEmpty(plan)).toBe(true);
  });

  it('folds names the way the write does, so a re-cased duplicate is not mistaken for a change', () => {
    // `resolveItemTagNames` dedupes through `lib/name-fold` (issue #342), so adding "Resistance"
    // to an item already tagged "resistance" resolves to the set it already had.
    const plan = planBulkEditUndo({ tags: { mode: 'add', names: ['Resistance'] } }, [
      snap({ tagNames: ['resistance'] }),
    ]);
    expect(isUndoPlanEmpty(plan)).toBe(true);
  });

  it('restores the previous set when replace wipes it', () => {
    const plan = planBulkEditUndo({ tags: { mode: 'replace', names: ['smd'] } }, [
      snap({ tagNames: ['through-hole', 'spare'] }),
    ]);
    expect(plan.steps).toEqual([{ id: 'item-1', tagNames: ['through-hole', 'spare'] }]);
  });

  it('skips the tag comparison when the pre-edit tags were never read', () => {
    // `tagNames` absent means the caller had no snapshot of them, so the tag change is left out
    // of the reversal rather than guessed at.
    const plan = planBulkEditUndo({ tags: { mode: 'replace', names: ['smd'] } }, [snap()]);
    expect(isUndoPlanEmpty(plan)).toBe(true);
  });
});

describe('planMoveUndo / planRemoveUndo', () => {
  it('moves the item back to where it came from', () => {
    expect(planMoveUndo('item-1', 'loc-bench')).toEqual({
      steps: [{ id: 'item-1', locationId: 'loc-bench' }],
    });
  });

  it('offers nothing when the drag source had no location to return to', () => {
    expect(planMoveUndo('item-1', undefined)).toEqual(EMPTY_UNDO_PLAN);
  });

  it('puts a removed item back into active inventory', () => {
    expect(planRemoveUndo('item-1')).toEqual({ steps: [{ id: 'item-1', isActive: true }] });
  });
});

describe('snapshotForUndo', () => {
  it('keeps only the restorable fields, plus the tags when they were read', () => {
    const item = {
      id: 'item-1',
      name: 'NE555 timer',
      locationId: 'loc-old',
      categoryId: 'cat-old',
      condition: 'GOOD',
      isActive: true,
      quantity: 10,
      notes: 'irrelevant',
    } as unknown as Item;

    expect(snapshotForUndo(item)).toEqual({
      id: 'item-1',
      categoryId: 'cat-old',
      locationId: 'loc-old',
      condition: 'GOOD',
      isActive: true,
    });
    expect(snapshotForUndo(item, ['smd']).tagNames).toEqual(['smd']);
  });
});

describe('isUndoPlanEmpty', () => {
  it('is true for the empty plan and false once a step exists', () => {
    expect(isUndoPlanEmpty(EMPTY_UNDO_PLAN)).toBe(true);
    expect(isUndoPlanEmpty(planRemoveUndo('item-1'))).toBe(false);
  });
});
