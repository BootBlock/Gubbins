import { describe, expect, it } from 'vitest';
import { HISTORY_ACTIONS } from '@/db/repositories/constants';
import {
  actionInSql,
  CONSUMPTION_MATERIAL_ACTIONS,
  CONSUMPTION_UNIT_ACTIONS,
  RECOVERABLE_STOCK_OUT_ACTIONS,
} from './consumption-actions';

describe('consumption vocabulary (issue #571)', () => {
  it('names only actions that exist in the ledger vocabulary', () => {
    const known = new Set<string>(HISTORY_ACTIONS);
    for (const action of [
      ...CONSUMPTION_UNIT_ACTIONS,
      ...CONSUMPTION_MATERIAL_ACTIONS,
      ...RECOVERABLE_STOCK_OUT_ACTIONS,
    ]) {
      expect(known.has(action)).toBe(true);
    }
  });

  // The whole point of the seam is that a stock-out is either consumption or a recoverable
  // movement, never both — an action in both lists would make the answer depend on which report
  // asked, which is the bug the seam exists to close.
  it('never calls the same action both consumed and recoverable', () => {
    const recoverable = new Set<string>(RECOVERABLE_STOCK_OUT_ACTIONS);
    for (const action of [...CONSUMPTION_UNIT_ACTIONS, ...CONSUMPTION_MATERIAL_ACTIONS]) {
      expect(recoverable.has(action)).toBe(false);
    }
  });

  it('excludes a loan, a supplier return and a disassembly from consumption', () => {
    for (const action of ['CHECKED_OUT', 'CHECKED_IN', 'RETURNED_TO_SUPPLIER', 'DISASSEMBLED'] as const) {
      expect(CONSUMPTION_UNIT_ACTIONS).not.toContain(action);
      expect(CONSUMPTION_MATERIAL_ACTIONS).not.toContain(action);
    }
  });

  it('counts a sale, a write-off, an assembly draw, a manual reduction and a count variance', () => {
    for (const action of ['SOLD', 'WRITTEN_OFF', 'CONSUMED', 'QUANTITY_CHANGE', 'RECONCILED'] as const) {
      expect(CONSUMPTION_UNIT_ACTIONS).toContain(action);
    }
  });

  // A `SOLD` row's `net_value_delta` is the sale proceeds, not material — so the material list
  // must not admit it, or a sale would be counted in grams.
  it('counts only gauge-bearing actions as material, never a sale', () => {
    expect(CONSUMPTION_MATERIAL_ACTIONS).toEqual(['GAUGE_UPDATE', 'CONSUMED']);
  });

  it('builds an IN predicate over the given column', () => {
    expect(actionInSql('h.action', ['SOLD', 'WRITTEN_OFF'])).toBe("h.action IN ('SOLD', 'WRITTEN_OFF')");
  });
});
