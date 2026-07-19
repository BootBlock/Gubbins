import { describe, it, expect } from 'vitest';
import {
  accumulateScheduleLine,
  buildInsuranceSchedule,
  createScheduleTotals,
  finaliseScheduleSummary,
  flattenLocationHierarchy,
  resolveScheduleGroupKey,
  scheduleSlices,
  toScheduleLine,
  UNASSIGNED_GROUP_LABEL,
  type ScheduleGroupSummary,
  type ScheduleItemInput,
  type ScheduleLocationInput,
} from './insurance-schedule';
import { sumMoney } from '@/lib/money';

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

  // Issue #292: the scale is the currency's minor unit, not a flat 2dp.
  describe('currency minor unit', () => {
    it('quantises every rung to whole units for a 0-decimal currency (JPY)', () => {
      const schedule = buildInsuranceSchedule(
        [
          item({ id: 'a', locationId: 'garage', quantity: 3, unitCost: 100.5 }),
          item({ id: 'b', locationId: 'garage', quantity: 1, unitCost: 200.4 }),
          item({ id: 'c', locationId: 'attic', quantity: 2, unitCost: 50.25 }),
        ],
        LOCATIONS,
        NOW,
        0,
      );
      const garage = schedule.groups.find((g) => g.locationId === 'garage')!;
      const attic = schedule.groups.find((g) => g.locationId === 'attic')!;
      // 3 × 100.5 = 301.5 → 302 (half away from zero); a JPY line cannot hold half a yen.
      expect(garage.lines.map((l) => l.replacementValue)).toEqual([302, 200]);
      // The #288 guarantee still holds at this scale: each rung sums the rung below as printed.
      expect(garage.subtotal).toBe(502);
      expect(attic.subtotal).toBe(101);
      expect(schedule.grandTotal).toBe(603);
      expect(schedule.grandTotal).toBe(garage.subtotal + attic.subtotal);
    });

    it('preserves the third digit for a 3-decimal currency (BHD)', () => {
      const schedule = buildInsuranceSchedule(
        [item({ id: 'a', locationId: 'garage', quantity: 3, unitCost: 1.0005 })],
        LOCATIONS,
        NOW,
        3,
      );
      // 3 × 1.0005 = 3.0015 → 3.002. At the default 2dp this would flatten to 3.00 and discard
      // a fils the amount genuinely has.
      expect(schedule.groups[0]!.lines[0]!.replacementValue).toBe(3.002);
      expect(schedule.groups[0]!.subtotal).toBe(3.002);
      expect(schedule.grandTotal).toBe(3.002);
    });
  });
});

/** A deterministic PRNG, so a randomised fixture is reproducible rather than flaky. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a randomised but reproducible spread of assets across the fixture locations. */
function randomItems(count: number, seed: number): ScheduleItemInput[] {
  const rand = mulberry32(seed);
  const locationIds = [...LOCATIONS.map((l) => l.id), null, 'ghost-location'];
  return Array.from({ length: count }, (_, i) =>
    item({
      id: `item-${i}`,
      name: `Asset ${Math.floor(rand() * 1000)}`,
      locationId: locationIds[Math.floor(rand() * locationIds.length)]!,
      quantity: Math.floor(rand() * 9) + 1,
      unitCost: Math.round(rand() * 100_000) / 100,
    }),
  );
}

/** Fold every item through the accumulator, in the order given. */
function tally(items: readonly ScheduleItemInput[], decimals: number, now = NOW) {
  const known = new Set(LOCATIONS.map((l) => l.id));
  const totals = createScheduleTotals();
  for (const it of items) {
    const line = toScheduleLine(it, now, decimals);
    accumulateScheduleLine(
      totals,
      resolveScheduleGroupKey(it.locationId, known),
      line.replacementValue,
      decimals,
    );
  }
  return totals;
}

describe('resolveScheduleGroupKey', () => {
  const known = new Set(['garage']);

  it('keeps a location that resolves', () => {
    expect(resolveScheduleGroupKey('garage', known)).toBe('garage');
  });

  it('buckets an unset location as Unassigned', () => {
    expect(resolveScheduleGroupKey(null, known)).toBeNull();
  });

  it('buckets a dangling location as Unassigned rather than dropping the asset', () => {
    // The rule that must not degrade to `IS NULL`: an item pointing at a deleted location is
    // still on the schedule, because an insurer cannot claim for what the document omits.
    expect(resolveScheduleGroupKey('deleted-room', known)).toBeNull();
  });
});

describe('the schedule totals accumulator', () => {
  it('is independent of the order rows arrive in', () => {
    // The streamed read visits rows in rowid order; the builder visits them in caller order.
    // Integer minor-unit accumulation makes the two provably identical.
    const items = randomItems(500, 1234);
    const shuffled = [...items].sort(() => mulberry32(99)() - 0.5).reverse();

    const forward = finaliseScheduleSummary(tally(items, 2), LOCATIONS, NOW, 2);
    const backward = finaliseScheduleSummary(tally(shuffled, 2), LOCATIONS, NOW, 2);

    expect(backward.grandTotal).toBe(forward.grandTotal);
    expect(backward.groups.map((g) => g.subtotal)).toEqual(forward.groups.map((g) => g.subtotal));
    expect(backward.groups.map((g) => g.locationId)).toEqual(forward.groups.map((g) => g.locationId));
  });

  it.each([0, 2, 3])('agrees with sumMoney over already-rounded lines at %i decimals', (decimals) => {
    const items = randomItems(400, 20260719 + decimals);
    const summary = finaliseScheduleSummary(tally(items, decimals), LOCATIONS, NOW, decimals);
    const known = new Set(LOCATIONS.map((l) => l.id));

    for (const group of summary.groups) {
      const expected = sumMoney(
        items
          .filter((it) => resolveScheduleGroupKey(it.locationId, known) === group.locationId)
          .map((it) => toScheduleLine(it, NOW, decimals).replacementValue),
        decimals,
      );
      expect(group.subtotal).toBe(expected);
    }
  });

  it('rounds half away from zero on the values that expose binary drift', () => {
    // 1.005 / 2.675 / 8.165 are the classic cases where `value * 100` lands just below the tie.
    const items = [
      item({ id: 'a', locationId: 'garage', quantity: 1, unitCost: 1.005 }),
      item({ id: 'b', locationId: 'garage', quantity: 1, unitCost: 2.675 }),
      item({ id: 'c', locationId: 'garage', quantity: 1, unitCost: 8.165 }),
    ];
    const summary = finaliseScheduleSummary(tally(items, 2), LOCATIONS, NOW, 2);
    // Each rounds up rather than one-up-one-down: 1.01 + 2.68 + 8.17.
    expect(summary.groups[0]!.subtotal).toBe(11.86);
    expect(summary.grandTotal).toBe(11.86);
  });

  it('counts every asset, including those in the Unassigned bucket', () => {
    const items = randomItems(250, 77);
    const summary = finaliseScheduleSummary(tally(items, 2), LOCATIONS, NOW, 2);
    expect(summary.itemCount).toBe(250);
  });

  it('omits a location that holds nothing', () => {
    const summary = finaliseScheduleSummary(
      tally([item({ id: 'a', locationId: 'garage', unitCost: 5 })], 2),
      LOCATIONS,
      NOW,
      2,
    );
    expect(summary.groups.map((g) => g.locationId)).toEqual(['garage']);
  });

  it('falls back to float summation when the tally leaves exact-integer range', () => {
    // Beyond ~£90tn at 2dp the minor-unit tally can no longer be exact; the figure degrades to
    // the pre-#163 float sum rather than becoming silently wrong.
    const huge = item({ id: 'huge', locationId: 'garage', quantity: 1, unitCost: 1e15 });
    const totals = tally([huge, huge], 2);
    expect(totals.exact).toBe(false);
    const summary = finaliseScheduleSummary(totals, LOCATIONS, NOW, 2);
    expect(summary.groups[0]!.subtotal).toBe(2e15);
  });

  it('produces the same groups, subtotals and totals as the whole-document builder', () => {
    // The equivalence the paged read depends on, asserted at the pure level.
    const items = randomItems(600, 4242);
    const built = buildInsuranceSchedule(items, LOCATIONS, NOW, 2);
    const summary = finaliseScheduleSummary(tally(items, 2), LOCATIONS, NOW, 2);

    expect(summary.grandTotal).toBe(built.grandTotal);
    expect(summary.itemCount).toBe(built.itemCount);
    expect(
      summary.groups.map((g) => [g.locationId, g.locationPath, g.depth, g.itemCount, g.subtotal]),
    ).toEqual(built.groups.map((g) => [g.locationId, g.locationPath, g.depth, g.lines.length, g.subtotal]));
  });
});

describe('scheduleSlices', () => {
  const groups: ScheduleGroupSummary[] = [
    { locationId: 'a', locationPath: 'A', depth: 0, itemCount: 10, subtotal: 0 },
    { locationId: 'b', locationPath: 'B', depth: 0, itemCount: 5, subtotal: 0 },
    { locationId: null, locationPath: UNASSIGNED_GROUP_LABEL, depth: 0, itemCount: 3, subtotal: 0 },
  ];

  it('takes from the first group at offset 0', () => {
    expect(scheduleSlices(groups, 0, 4)).toEqual([{ locationId: 'a', offset: 0, limit: 4 }]);
  });

  it('addresses a mid-group offset within that group', () => {
    expect(scheduleSlices(groups, 6, 3)).toEqual([{ locationId: 'a', offset: 6, limit: 3 }]);
  });

  it('starts cleanly at an exact group boundary', () => {
    expect(scheduleSlices(groups, 10, 2)).toEqual([{ locationId: 'b', offset: 0, limit: 2 }]);
  });

  it('spans three groups when the window straddles both boundaries', () => {
    expect(scheduleSlices(groups, 8, 10)).toEqual([
      { locationId: 'a', offset: 8, limit: 2 },
      { locationId: 'b', offset: 0, limit: 5 },
      { locationId: null, offset: 0, limit: 3 },
    ]);
  });

  it('stops at the end of the document rather than over-requesting', () => {
    expect(scheduleSlices(groups, 16, 50)).toEqual([{ locationId: null, offset: 1, limit: 2 }]);
  });

  it('yields nothing past the end', () => {
    expect(scheduleSlices(groups, 18, 10)).toEqual([]);
  });

  it('yields nothing for a non-positive limit', () => {
    expect(scheduleSlices(groups, 0, 0)).toEqual([]);
  });

  it('skips a group that holds nothing', () => {
    const withEmpty: ScheduleGroupSummary[] = [
      { locationId: 'empty', locationPath: 'Empty', depth: 0, itemCount: 0, subtotal: 0 },
      ...groups,
    ];
    expect(scheduleSlices(withEmpty, 0, 2)).toEqual([{ locationId: 'a', offset: 0, limit: 2 }]);
  });

  it('covers every asset exactly once when walked page by page', () => {
    // The property that matters: paging the whole document neither drops nor repeats a line.
    const pageSize = 4;
    const total = groups.reduce((sum, g) => sum + g.itemCount, 0);
    const seen = new Map<string, number>();
    for (let offset = 0; offset < total; offset += pageSize) {
      for (const slice of scheduleSlices(groups, offset, pageSize)) {
        for (let i = 0; i < slice.limit; i += 1) {
          const key = `${slice.locationId}#${slice.offset + i}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }
    }
    expect(seen.size).toBe(total);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });
});
