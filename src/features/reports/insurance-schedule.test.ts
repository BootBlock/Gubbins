import { describe, it, expect } from 'vitest';
import {
  buildInsuranceSchedule,
  flattenLocationHierarchy,
  UNASSIGNED_GROUP_LABEL,
  type ScheduleItemInput,
  type ScheduleLocationInput,
} from './insurance-schedule';

const NOW = Date.parse('2026-07-09T00:00:00Z');

/** A fully-specified item; each test overrides only the fields it exercises. */
function item(overrides: Partial<ScheduleItemInput> & Pick<ScheduleItemInput, 'id'>): ScheduleItemInput {
  return {
    name: overrides.id,
    serialNo: null,
    condition: null,
    quantity: 1,
    acquiredAt: null,
    warrantyExpiresAt: null,
    purchasePrice: null,
    unitCost: null,
    locationId: null,
    ...overrides,
  };
}

const LOCATIONS: ScheduleLocationInput[] = [
  { id: 'garage', name: 'Garage', parentId: null },
  { id: 'attic', name: 'Attic', parentId: null },
  { id: 'shelf-a', name: 'Shelf A', parentId: 'garage' },
  { id: 'shelf-b', name: 'Shelf B', parentId: 'garage' },
];

describe('flattenLocationHierarchy', () => {
  it('orders roots alphabetically and nests children after their parent with depth + path', () => {
    const ordered = flattenLocationHierarchy(LOCATIONS);
    expect(ordered).toEqual([
      { id: 'attic', path: 'Attic', depth: 0 },
      { id: 'garage', path: 'Garage', depth: 0 },
      { id: 'shelf-a', path: 'Garage › Shelf A', depth: 1 },
      { id: 'shelf-b', path: 'Garage › Shelf B', depth: 1 },
    ]);
  });

  it('treats an item with an unresolved parent as a root', () => {
    const ordered = flattenLocationHierarchy([{ id: 'orphan', name: 'Orphan', parentId: 'ghost' }]);
    expect(ordered).toEqual([{ id: 'orphan', path: 'Orphan', depth: 0 }]);
  });

  it('is cycle-safe — a malformed parent loop emits each node at most once', () => {
    const cyclic: ScheduleLocationInput[] = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
    ];
    const ordered = flattenLocationHierarchy(cyclic);
    // Neither node has a resolvable path to a real root, so both are treated as roots; the
    // important guarantee is that the walk terminates and never duplicates a node.
    expect(ordered.map((o) => o.id).sort()).toEqual(['a', 'b']);
    expect(new Set(ordered.map((o) => o.id)).size).toBe(ordered.length);
  });

  it('returns nothing for no locations', () => {
    expect(flattenLocationHierarchy([])).toEqual([]);
  });
});

describe('buildInsuranceSchedule', () => {
  it('returns an empty schedule for no items', () => {
    const schedule = buildInsuranceSchedule([], LOCATIONS, NOW);
    expect(schedule.groups).toEqual([]);
    expect(schedule.grandTotal).toBe(0);
    expect(schedule.itemCount).toBe(0);
    expect(schedule.generatedAt).toBe(NOW);
  });

  it('groups assets by home location in hierarchy order, omitting empty rooms', () => {
    const schedule = buildInsuranceSchedule(
      [
        item({ id: 'drill', name: 'Drill', locationId: 'garage', unitCost: 100 }),
        item({ id: 'skis', name: 'Skis', locationId: 'attic', unitCost: 200 }),
      ],
      LOCATIONS,
      NOW,
    );
    // Attic sorts before Garage; the empty shelves produce no group.
    expect(schedule.groups.map((g) => g.locationPath)).toEqual(['Attic', 'Garage']);
    expect(schedule.groups.map((g) => g.locationId)).toEqual(['attic', 'garage']);
  });

  it('carries each group its depth + full path for nested locations', () => {
    const schedule = buildInsuranceSchedule(
      [item({ id: 'saw', locationId: 'shelf-a', unitCost: 10 })],
      LOCATIONS,
      NOW,
    );
    expect(schedule.groups).toHaveLength(1);
    expect(schedule.groups[0]).toMatchObject({ locationPath: 'Garage › Shelf A', depth: 1 });
  });

  it('values a line as quantity × effective unit cost and rolls up subtotals + grand total', () => {
    const schedule = buildInsuranceSchedule(
      [
        item({ id: 'a', name: 'A', locationId: 'garage', quantity: 3, unitCost: 10 }), // 30
        item({ id: 'b', name: 'B', locationId: 'garage', quantity: 1, unitCost: 5 }), //  5
        item({ id: 'c', name: 'C', locationId: 'attic', quantity: 2, unitCost: 4 }), //   8
      ],
      LOCATIONS,
      NOW,
    );
    const garage = schedule.groups.find((g) => g.locationId === 'garage')!;
    const attic = schedule.groups.find((g) => g.locationId === 'attic')!;
    expect(garage.subtotal).toBe(35);
    expect(attic.subtotal).toBe(8);
    expect(schedule.grandTotal).toBe(43);
    expect(schedule.itemCount).toBe(3);
  });

  it('falls back to the preferred supplier cost when there is no manual unit cost', () => {
    const schedule = buildInsuranceSchedule(
      [item({ id: 'a', locationId: 'garage', quantity: 2, unitCost: null, preferredSupplierCost: 7 })],
      LOCATIONS,
      NOW,
    );
    expect(schedule.grandTotal).toBe(14);
  });

  it('values an unpriced item at zero without dropping it from the schedule', () => {
    const schedule = buildInsuranceSchedule(
      [item({ id: 'nopx', name: 'No price', locationId: 'garage' })],
      LOCATIONS,
      NOW,
    );
    expect(schedule.groups[0].lines[0].replacementValue).toBe(0);
    expect(schedule.itemCount).toBe(1);
    expect(schedule.grandTotal).toBe(0);
  });

  it('lets a manual current value (G9 hook) win over the replacement cost', () => {
    const schedule = buildInsuranceSchedule(
      [
        item({
          id: 'vinyl',
          locationId: 'attic',
          quantity: 2,
          unitCost: 5, // original replacement cost
          currentValuePerUnit: 40, // appreciated market value wins
        }),
      ],
      LOCATIONS,
      NOW,
    );
    expect(schedule.grandTotal).toBe(80);
  });

  it('clamps a negative quantity to zero value', () => {
    const schedule = buildInsuranceSchedule(
      [item({ id: 'weird', locationId: 'garage', quantity: -5, unitCost: 10 })],
      LOCATIONS,
      NOW,
    );
    expect(schedule.groups[0].lines[0].replacementValue).toBe(0);
  });

  it('passes through the photo thumbnail (or null when absent) and the untracked condition', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const schedule = buildInsuranceSchedule(
      [
        item({ id: 'withpic', name: 'A', locationId: 'garage', thumbnail: bytes, condition: 'MINT' }),
        item({ id: 'nopic', name: 'B', locationId: 'garage' }),
      ],
      LOCATIONS,
      NOW,
    );
    const [a, b] = schedule.groups[0].lines;
    expect(a.thumbnail).toBe(bytes);
    expect(a.condition).toBe('MINT');
    expect(b.thumbnail).toBeNull();
    expect(b.condition).toBeNull();
  });

  it('derives the warranty status from the expiry date', () => {
    const schedule = buildInsuranceSchedule(
      [
        item({ id: 'none', name: 'N', locationId: 'garage' }),
        item({ id: 'exp', name: 'E', locationId: 'garage', warrantyExpiresAt: '2020-01-01' }),
        item({ id: 'act', name: 'A', locationId: 'garage', warrantyExpiresAt: '2035-01-01' }),
      ],
      LOCATIONS,
      NOW,
    );
    const byId = Object.fromEntries(schedule.groups[0].lines.map((l) => [l.id, l.warranty]));
    expect(byId.none).toBe('none');
    expect(byId.exp).toBe('expired');
    expect(byId.act).toBe('active');
  });

  it('sorts lines within a group by name (then id)', () => {
    const schedule = buildInsuranceSchedule(
      [
        item({ id: '1', name: 'Zeta', locationId: 'garage', unitCost: 1 }),
        item({ id: '2', name: 'alpha', locationId: 'garage', unitCost: 1 }),
        item({ id: '3', name: 'Beta', locationId: 'garage', unitCost: 1 }),
      ],
      LOCATIONS,
      NOW,
    );
    expect(schedule.groups[0].lines.map((l) => l.name)).toEqual(['alpha', 'Beta', 'Zeta']);
  });

  it('puts items with an unresolved location in a trailing Unassigned group', () => {
    const schedule = buildInsuranceSchedule(
      [
        item({ id: 'homeless', name: 'X', locationId: 'ghost-room', unitCost: 9 }),
        item({ id: 'nulled', name: 'Y', locationId: null, unitCost: 1 }),
        item({ id: 'placed', name: 'Z', locationId: 'garage', unitCost: 2 }),
      ],
      LOCATIONS,
      NOW,
    );
    const last = schedule.groups[schedule.groups.length - 1];
    expect(last.locationId).toBeNull();
    expect(last.locationPath).toBe(UNASSIGNED_GROUP_LABEL);
    expect(last.lines.map((l) => l.name)).toEqual(['X', 'Y']);
    expect(last.subtotal).toBe(10);
  });

  // Issue #288: an insurer checks this document with a calculator, so each rung must sum the
  // rung below it exactly as printed.
  describe('monetary rounding', () => {
    it('adds up line → subtotal → grand total with no float drift', () => {
      const schedule = buildInsuranceSchedule(
        [
          item({ id: 'a', locationId: 'garage', quantity: 3, unitCost: 0.1 }),
          item({ id: 'b', locationId: 'garage', quantity: 3, unitCost: 0.1 }),
          item({ id: 'c', locationId: 'attic', quantity: 7, unitCost: 0.1 }),
        ],
        LOCATIONS,
        NOW,
      );
      const garage = schedule.groups.find((g) => g.locationId === 'garage')!;
      const attic = schedule.groups.find((g) => g.locationId === 'attic')!;
      expect(garage.lines.map((l) => l.replacementValue)).toEqual([0.3, 0.3]);
      expect(garage.subtotal).toBe(0.6);
      expect(attic.subtotal).toBe(0.7);
      expect(schedule.grandTotal).toBe(1.3);
    });

    it('quantises a line whose extended value is not a whole penny', () => {
      const schedule = buildInsuranceSchedule(
        [item({ id: 'a', locationId: 'garage', quantity: 3, unitCost: 1.005 })],
        LOCATIONS,
        NOW,
      );
      // 3 × 1.005 = 3.015 → 3.02 (half away from zero), not 3.01.
      expect(schedule.groups[0]!.lines[0]!.replacementValue).toBe(3.02);
      expect(schedule.grandTotal).toBe(3.02);
    });
  });
});
