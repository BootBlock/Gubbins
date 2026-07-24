import { describe, it, expect } from 'vitest';
import { summarisePicking, describePlacements, totalOnHand, orderByRoute } from './picking';

describe('summarisePicking (issue #121 gather-and-tick progress)', () => {
  it('rolls up picked vs total with the completed fraction', () => {
    const progress = summarisePicking([
      { picked: true },
      { picked: false },
      { picked: true },
      { picked: false },
    ]);
    expect(progress).toEqual({
      total: 4,
      pickedCount: 2,
      remaining: 2,
      allPicked: false,
      fraction: 0.5,
    });
  });

  it('reports allPicked only once every line is gathered', () => {
    const progress = summarisePicking([{ picked: true }, { picked: true }]);
    expect(progress).toEqual({
      total: 2,
      pickedCount: 2,
      remaining: 0,
      allPicked: true,
      fraction: 1,
    });
  });

  it('never reports allPicked for an empty worksheet (nothing to finalise)', () => {
    expect(summarisePicking([])).toEqual({
      total: 0,
      pickedCount: 0,
      remaining: 0,
      allPicked: false,
      fraction: 0,
    });
  });
});

describe('describePlacements', () => {
  it('renders a compact, location-ordered "where to go" phrase', () => {
    expect(
      describePlacements([
        { locationName: 'Garage · Shelf B', quantity: 3 },
        { locationName: 'Loft bin 4', quantity: 2 },
      ]),
    ).toBe('3 in Garage · Shelf B, 2 in Loft bin 4');
  });

  it('is empty for a part with nothing on hand (caller shows its own affordance)', () => {
    expect(describePlacements([])).toBe('');
  });

  it('handles a single placement without a trailing separator', () => {
    expect(describePlacements([{ locationName: 'Workshop', quantity: 5 }])).toBe('5 in Workshop');
  });
});

describe('totalOnHand', () => {
  it('sums the quantity across every placement', () => {
    expect(
      totalOnHand([
        { locationName: 'A', quantity: 3 },
        { locationName: 'B', quantity: 2 },
      ]),
    ).toBe(5);
  });

  it('is zero for a part with no placements', () => {
    expect(totalOnHand([])).toBe(0);
  });
});

describe('orderByRoute (issue #461 picking-sweep order)', () => {
  const keyOf = (line: { key: number | null }) => line.key;

  it('sorts placed lines by ascending route key', () => {
    const ordered = orderByRoute(
      [
        { id: 'a', key: 3 },
        { id: 'b', key: 1 },
        { id: 'c', key: 2 },
      ],
      keyOf,
    );
    expect(ordered.map((l) => l.id)).toEqual(['b', 'c', 'a']);
  });

  it('sends unplaced lines (null key) to the end, keeping their original relative order', () => {
    const ordered = orderByRoute(
      [
        { id: 'a', key: null },
        { id: 'b', key: 5 },
        { id: 'c', key: null },
        { id: 'd', key: 1 },
      ],
      keyOf,
    );
    expect(ordered.map((l) => l.id)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('is a stable no-op when nothing is placed (every key null → original order)', () => {
    const lines = [
      { id: 'a', key: null },
      { id: 'b', key: null },
      { id: 'c', key: null },
    ];
    expect(orderByRoute(lines, keyOf).map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties on the original order (a stable sort)', () => {
    const lines = [
      { id: 'a', key: 2 },
      { id: 'b', key: 2 },
      { id: 'c', key: 1 },
      { id: 'd', key: 2 },
    ];
    expect(orderByRoute(lines, keyOf).map((l) => l.id)).toEqual(['c', 'a', 'b', 'd']);
  });
});
