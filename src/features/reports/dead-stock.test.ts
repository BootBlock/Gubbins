import { describe, expect, it } from 'vitest';
import { isDeadStockMode, resolveDeadStockPolicy, type DeadStockLocationPolicy } from './dead-stock';

/** A location link with the defaults an untouched location carries. */
function loc(
  id: string,
  overrides: Partial<Omit<DeadStockLocationPolicy, 'id'>> = {},
): DeadStockLocationPolicy {
  return { id, name: `Location ${id}`, mode: 'inherit', thresholdDays: null, ...overrides };
}

describe('isDeadStockMode', () => {
  it('accepts the three valid modes', () => {
    expect(isDeadStockMode('inherit')).toBe(true);
    expect(isDeadStockMode('always')).toBe(true);
    expect(isDeadStockMode('never')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const value of ['ALWAYS', '', 'on', null, undefined, 1, {}]) {
      expect(isDeadStockMode(value)).toBe(false);
    }
  });
});

describe('resolveDeadStockPolicy — whether the item is reported', () => {
  it('reports nothing by default (opt-in)', () => {
    const result = resolveDeadStockPolicy('inherit', [loc('a'), loc('b')], 90);
    expect(result.reported).toBe(false);
    expect(result.reportedSource).toBe('default');
    expect(result.reportedFrom).toBeNull();
  });

  it("honours the item's own opt-in", () => {
    const result = resolveDeadStockPolicy('always', [loc('a')], 90);
    expect(result).toMatchObject({ reported: true, reportedSource: 'item', reportedFrom: null });
  });

  it("lets the item's opt-out win over a location that opts in", () => {
    const result = resolveDeadStockPolicy('never', [loc('a', { mode: 'always' })], 90);
    expect(result).toMatchObject({ reported: false, reportedSource: 'item' });
  });

  it('inherits an opt-in from the location', () => {
    const result = resolveDeadStockPolicy('inherit', [loc('a', { mode: 'always' })], 90);
    expect(result.reported).toBe(true);
    expect(result.reportedSource).toBe('location');
    expect(result.reportedFrom).toEqual({ id: 'a', name: 'Location a' });
  });

  it('inherits from the nearest ancestor that decides, not the root', () => {
    const chain = [loc('shelf'), loc('cabinet', { mode: 'never' }), loc('garage', { mode: 'always' })];
    const result = resolveDeadStockPolicy('inherit', chain, 90);
    expect(result.reported).toBe(false);
    expect(result.reportedFrom).toEqual({ id: 'cabinet', name: 'Location cabinet' });
  });

  it('walks past inherit-mode locations to find the deciding ancestor', () => {
    const chain = [loc('shelf'), loc('cabinet'), loc('garage', { mode: 'always' })];
    const result = resolveDeadStockPolicy('inherit', chain, 90);
    expect(result.reported).toBe(true);
    expect(result.reportedFrom).toEqual({ id: 'garage', name: 'Location garage' });
  });

  it('falls back to not-reported when an empty chain offers nothing', () => {
    expect(resolveDeadStockPolicy('inherit', [], 90).reported).toBe(false);
  });
});

describe('resolveDeadStockPolicy — the idle threshold', () => {
  it('uses the global default when no location overrides it', () => {
    const result = resolveDeadStockPolicy('always', [loc('a'), loc('b')], 90);
    expect(result).toMatchObject({ thresholdDays: 90, thresholdSource: 'default', thresholdFrom: null });
  });

  it('takes the nearest location override', () => {
    const chain = [
      loc('shelf'),
      loc('cabinet', { thresholdDays: 30 }),
      loc('garage', { thresholdDays: 365 }),
    ];
    const result = resolveDeadStockPolicy('always', chain, 90);
    expect(result.thresholdDays).toBe(30);
    expect(result.thresholdSource).toBe('location');
    expect(result.thresholdFrom).toEqual({ id: 'cabinet', name: 'Location cabinet' });
  });

  it('resolves independently of what opted the item in', () => {
    // The garage opts its contents in; a shelf inside it sets only a threshold. The user
    // gets both, which is the whole point of resolving the two axes separately.
    const chain = [loc('shelf', { thresholdDays: 365 }), loc('garage', { mode: 'always' })];
    const result = resolveDeadStockPolicy('inherit', chain, 90);
    expect(result).toMatchObject({
      reported: true,
      reportedFrom: { id: 'garage', name: 'Location garage' },
      thresholdDays: 365,
      thresholdFrom: { id: 'shelf', name: 'Location shelf' },
    });
  });

  it('still resolves a threshold for an item that is not reported', () => {
    // The editor previews what *would* apply before the user switches reporting on.
    const result = resolveDeadStockPolicy('never', [loc('a', { thresholdDays: 14 })], 90);
    expect(result).toMatchObject({ reported: false, thresholdDays: 14 });
  });
});
