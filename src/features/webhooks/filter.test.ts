/**
 * Tests for the declarative webhook filter (webhooks plan `W3`, §5.2).
 *
 * Two properties get the most attention, because both decide whether a user receives webhooks
 * they never asked for: an **unparseable** filter must become inert rather than falling back to
 * "no filter", and an **unconfirmable** fact must not match.
 */
import { describe, expect, it } from 'vitest';
import type { WebhookEventView } from './event-view';
import {
  evaluateWebhookFilter,
  MAX_WEBHOOK_FILTER_DEPTH,
  parseWebhookFilter,
  WEBHOOK_FILTER_NONE,
  type WebhookFilter,
} from './filter';

/** A ledger event about an item, with every fact a filter can test populated. */
function itemView(overrides: Partial<WebhookEventView> = {}): WebhookEventView {
  return {
    id: 'hist-1',
    type: 'stock.adjusted',
    occurredAt: '2026-07-18T10:00:00.000Z',
    item: {
      id: 'item-1',
      name: 'M3 screws',
      quantity: 4,
      locationId: 'loc-drawer',
      locationName: 'Drawer 2',
      locationPath: ['loc-workshop', 'loc-bench', 'loc-drawer'],
      categoryId: 'cat-fasteners',
      categoryName: 'Fasteners',
      tagIds: ['tag-metric', 'tag-consumable'],
    },
    change: {
      action: 'QUANTITY_CHANGE',
      kind: 'stock',
      label: 'Quantity changed',
      detail: null,
      delta: '−2',
      quantityDelta: -2,
      netValueDelta: null,
      actorUserId: 'user-ada',
      actorDisplayName: 'Ada Okafor',
    },
    ...overrides,
  };
}

/** An event that concerns no item at all — `lookup.resolved` / `events.truncated`. */
function itemlessView(): WebhookEventView {
  return {
    id: 'lookup:abc:1',
    type: 'lookup.resolved',
    occurredAt: '2026-07-18T10:00:00.000Z',
    item: null,
    change: null,
  };
}

describe('parseWebhookFilter', () => {
  it('distinguishes "no filter" from "broken filter"', () => {
    // The whole point: null means match everything, none means match nothing.
    expect(parseWebhookFilter(null)).toBeNull();
    expect(parseWebhookFilter(undefined)).toBeNull();
    expect(parseWebhookFilter({ kind: 'nonsense' })).toEqual(WEBHOOK_FILTER_NONE);
  });

  it.each([
    ['a string', 'kind: location'],
    ['a number', 42],
    ['an array', [{ kind: 'item', itemIds: ['a'] }]],
    ['an empty object', {}],
    ['a missing discriminator', { locationIds: ['loc-1'] }],
  ])('rejects %s as inert', (_label, raw) => {
    expect(parseWebhookFilter(raw)).toEqual(WEBHOOK_FILTER_NONE);
  });

  it('parses each leaf node', () => {
    expect(parseWebhookFilter({ kind: 'item', itemIds: ['a', 'b'] })).toEqual({
      kind: 'item',
      itemIds: ['a', 'b'],
    });
    expect(parseWebhookFilter({ kind: 'category', categoryIds: ['c'] })).toEqual({
      kind: 'category',
      categoryIds: ['c'],
    });
    expect(parseWebhookFilter({ kind: 'tag', tagIds: ['t'] })).toEqual({ kind: 'tag', tagIds: ['t'] });
    expect(parseWebhookFilter({ kind: 'quantity', op: 'lt', value: 5 })).toEqual({
      kind: 'quantity',
      op: 'lt',
      value: 5,
    });
  });

  it('trims, de-duplicates and order-preserves id lists', () => {
    expect(parseWebhookFilter({ kind: 'item', itemIds: [' b ', 'a', 'b', '  '] })).toEqual({
      kind: 'item',
      itemIds: ['b', 'a'],
    });
  });

  it('treats an id list with nothing usable in it as inert, not as an empty set', () => {
    // An id filter matching no id would make the subscription silently inert either way; a parse
    // failure at least reads as one in the editor.
    expect(parseWebhookFilter({ kind: 'item', itemIds: [] })).toEqual(WEBHOOK_FILTER_NONE);
    expect(parseWebhookFilter({ kind: 'item', itemIds: ['  ', ''] })).toEqual(WEBHOOK_FILTER_NONE);
    expect(parseWebhookFilter({ kind: 'item', itemIds: ['ok', 7] })).toEqual(WEBHOOK_FILTER_NONE);
  });

  it('defaults a location filter to including descendants, and honours an explicit false', () => {
    expect(parseWebhookFilter({ kind: 'location', locationIds: ['l'] })).toEqual({
      kind: 'location',
      locationIds: ['l'],
      includeDescendants: true,
    });
    expect(
      parseWebhookFilter({ kind: 'location', locationIds: ['l'], includeDescendants: false }),
    ).toMatchObject({ includeDescendants: false });
  });

  it.each([
    ['an unknown operator', { kind: 'quantity', op: 'approximately', value: 1 }],
    ['a non-numeric value', { kind: 'quantity', op: 'lt', value: '5' }],
    ['NaN', { kind: 'quantity', op: 'lt', value: Number.NaN }],
    ['Infinity', { kind: 'quantity', op: 'gt', value: Number.POSITIVE_INFINITY }],
  ])('rejects a quantity filter with %s', (_label, raw) => {
    expect(parseWebhookFilter(raw)).toEqual(WEBHOOK_FILTER_NONE);
  });

  it('recurses into combinators, making a bad child inert without poisoning its siblings', () => {
    expect(
      parseWebhookFilter({
        kind: 'all',
        of: [{ kind: 'item', itemIds: ['a'] }, { kind: 'bogus' }],
      }),
    ).toEqual({ kind: 'all', of: [{ kind: 'item', itemIds: ['a'] }, WEBHOOK_FILTER_NONE] });
  });

  it('rejects a combinator whose children are not a list', () => {
    expect(parseWebhookFilter({ kind: 'all', of: 'everything' })).toEqual(WEBHOOK_FILTER_NONE);
  });

  /**
   * The one place substituting the inert node for a failed child would be *unsafe*: `not` inverts
   * it to `true`, which widens the subscription to every event of its types — the exact direction
   * this module must never fail in. A failed child therefore fails the whole `not`.
   */
  describe('a not node whose child cannot be parsed', () => {
    it.each([
      ['a missing child', { kind: 'not' }],
      ['an unknown child', { kind: 'not', of: { kind: 'weather', condition: 'rain' } }],
      ['a non-object child', { kind: 'not', of: 'everything' }],
      ['a doubly-nested failure', { kind: 'not', of: { kind: 'not', of: { kind: 'weather' } } }],
    ])('collapses %s to the inert node rather than negating a guess', (_label, raw) => {
      expect(parseWebhookFilter(raw)).toEqual(WEBHOOK_FILTER_NONE);
    });

    it('matches nothing once evaluated, rather than everything', () => {
      const filter = parseWebhookFilter({ kind: 'not', of: { kind: 'weather' } });
      expect(evaluateWebhookFilter(filter, itemView())).toBe(false);
      expect(evaluateWebhookFilter(filter, itemlessView())).toBe(false);
    });

    it('still negates a child that parsed successfully', () => {
      const filter = parseWebhookFilter({ kind: 'not', of: { kind: 'item', itemIds: ['other'] } });
      expect(evaluateWebhookFilter(filter, itemView())).toBe(true);
    });

    it('does not let a failed grandchild widen an enclosing all/any branch', () => {
      // Non-inverting parents may safely substitute the inert node: it can only narrow.
      expect(parseWebhookFilter({ kind: 'all', of: [{ kind: 'not', of: { kind: 'weather' } }] })).toEqual({
        kind: 'all',
        of: [WEBHOOK_FILTER_NONE],
      });
      expect(
        evaluateWebhookFilter(
          parseWebhookFilter({ kind: 'any', of: [{ kind: 'not', of: { kind: 'weather' } }] }),
          itemView(),
        ),
      ).toBe(false);
    });
  });

  it('bounds nesting depth, so a hostile synced filter cannot overflow the stack', () => {
    let deep: unknown = { kind: 'item', itemIds: ['a'] };
    for (let i = 0; i <= MAX_WEBHOOK_FILTER_DEPTH + 2; i++) deep = { kind: 'not', of: deep };
    // It parses without throwing, and the over-deep interior collapses to the inert node.
    const parsed = parseWebhookFilter(deep);
    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed)).toContain('"kind":"none"');
    expect(JSON.stringify(parsed)).not.toContain('itemIds');
  });

  it('round-trips through JSON, since that is how it is stored and synced', () => {
    const filter = parseWebhookFilter({
      kind: 'all',
      of: [
        { kind: 'location', locationIds: ['loc-drawer'] },
        { kind: 'quantity', op: 'lte', value: 5 },
      ],
    });
    expect(parseWebhookFilter(JSON.parse(JSON.stringify(filter)))).toEqual(filter);
  });
});

describe('evaluateWebhookFilter', () => {
  it('passes everything when there is no filter', () => {
    expect(evaluateWebhookFilter(null, itemView())).toBe(true);
    expect(evaluateWebhookFilter(null, itemlessView())).toBe(true);
  });

  it('matches nothing for the inert node', () => {
    expect(evaluateWebhookFilter(WEBHOOK_FILTER_NONE, itemView())).toBe(false);
  });

  describe('item, category and tag', () => {
    it('matches on membership', () => {
      expect(evaluateWebhookFilter({ kind: 'item', itemIds: ['item-1', 'x'] }, itemView())).toBe(true);
      expect(evaluateWebhookFilter({ kind: 'item', itemIds: ['x'] }, itemView())).toBe(false);
      expect(evaluateWebhookFilter({ kind: 'category', categoryIds: ['cat-fasteners'] }, itemView())).toBe(
        true,
      );
      expect(evaluateWebhookFilter({ kind: 'category', categoryIds: ['cat-tools'] }, itemView())).toBe(false);
    });

    it('matches a tag filter when the item carries any one of the tags', () => {
      expect(evaluateWebhookFilter({ kind: 'tag', tagIds: ['tag-consumable'] }, itemView())).toBe(true);
      expect(evaluateWebhookFilter({ kind: 'tag', tagIds: ['tag-loose', 'tag-metric'] }, itemView())).toBe(
        true,
      );
      expect(evaluateWebhookFilter({ kind: 'tag', tagIds: ['tag-loose'] }, itemView())).toBe(false);
    });

    it('does not match an uncategorised item', () => {
      const view = itemView({ item: { ...itemView().item!, categoryId: null } });
      expect(evaluateWebhookFilter({ kind: 'category', categoryIds: ['cat-fasteners'] }, view)).toBe(false);
    });
  });

  describe('location', () => {
    it('matches anywhere in the subtree by default', () => {
      // The item is in the drawer; the filter names the workshop two levels up.
      expect(evaluateWebhookFilter({ kind: 'location', locationIds: ['loc-workshop'] }, itemView())).toBe(
        true,
      );
    });

    it('matches only the exact location when descendants are excluded', () => {
      const filter: WebhookFilter = {
        kind: 'location',
        locationIds: ['loc-workshop'],
        includeDescendants: false,
      };
      expect(evaluateWebhookFilter(filter, itemView())).toBe(false);
      expect(
        evaluateWebhookFilter(
          { kind: 'location', locationIds: ['loc-drawer'], includeDescendants: false },
          itemView(),
        ),
      ).toBe(true);
    });

    it('falls back to the direct location when the hierarchy could not be resolved', () => {
      const view = itemView({ item: { ...itemView().item!, locationPath: [] } });
      expect(evaluateWebhookFilter({ kind: 'location', locationIds: ['loc-drawer'] }, view)).toBe(true);
      expect(evaluateWebhookFilter({ kind: 'location', locationIds: ['loc-workshop'] }, view)).toBe(false);
    });

    it('does not match an item with no location at all', () => {
      const view = itemView({ item: { ...itemView().item!, locationId: null, locationPath: [] } });
      expect(evaluateWebhookFilter({ kind: 'location', locationIds: ['loc-drawer'] }, view)).toBe(false);
    });
  });

  describe('quantity', () => {
    it.each([
      ['lt', 5, true],
      ['lt', 4, false],
      ['lte', 4, true],
      ['gt', 3, true],
      ['gt', 4, false],
      ['gte', 4, true],
      ['eq', 4, true],
      ['eq', 5, false],
      ['neq', 5, true],
      ['neq', 4, false],
    ] as const)('%s %d against a quantity of 4 → %s', (op, value, expected) => {
      expect(evaluateWebhookFilter({ kind: 'quantity', op, value }, itemView())).toBe(expected);
    });

    it('never matches an unlimited-supply item, in either direction', () => {
      // `quantity: null` means "no finite count" — treating it as a very large or very small
      // number would make one of gt/lt fire on every mains-water event.
      const view = itemView({ item: { ...itemView().item!, quantity: null } });
      expect(evaluateWebhookFilter({ kind: 'quantity', op: 'lt', value: 5 }, view)).toBe(false);
      expect(evaluateWebhookFilter({ kind: 'quantity', op: 'gt', value: 5 }, view)).toBe(false);
      expect(evaluateWebhookFilter({ kind: 'quantity', op: 'neq', value: 5 }, view)).toBe(false);
    });

    it('matches a genuine zero, which is not the same as no quantity', () => {
      const view = itemView({ item: { ...itemView().item!, quantity: 0 } });
      expect(evaluateWebhookFilter({ kind: 'quantity', op: 'lte', value: 0 }, view)).toBe(true);
    });
  });

  describe('an event with no item', () => {
    it.each([
      ['item', { kind: 'item', itemIds: ['item-1'] }],
      ['category', { kind: 'category', categoryIds: ['cat-fasteners'] }],
      ['tag', { kind: 'tag', tagIds: ['tag-metric'] }],
      ['location', { kind: 'location', locationIds: ['loc-drawer'] }],
      ['quantity', { kind: 'quantity', op: 'lt', value: 5 }],
    ] as const)('does not satisfy a %s filter', (_label, filter) => {
      expect(evaluateWebhookFilter(filter, itemlessView())).toBe(false);
    });

    it('still inverts under not — "not in the shed" is true of an event with no shed', () => {
      expect(
        evaluateWebhookFilter(
          { kind: 'not', of: { kind: 'location', locationIds: ['loc-drawer'] } },
          itemlessView(),
        ),
      ).toBe(true);
    });
  });

  describe('combinators', () => {
    const inShed: WebhookFilter = { kind: 'location', locationIds: ['loc-workshop'] };
    const lowStock: WebhookFilter = { kind: 'quantity', op: 'lt', value: 5 };
    const wrongCategory: WebhookFilter = { kind: 'category', categoryIds: ['cat-tools'] };

    it('ands and ors', () => {
      expect(evaluateWebhookFilter({ kind: 'all', of: [inShed, lowStock] }, itemView())).toBe(true);
      expect(evaluateWebhookFilter({ kind: 'all', of: [inShed, wrongCategory] }, itemView())).toBe(false);
      expect(evaluateWebhookFilter({ kind: 'any', of: [wrongCategory, lowStock] }, itemView())).toBe(true);
      expect(evaluateWebhookFilter({ kind: 'any', of: [wrongCategory] }, itemView())).toBe(false);
    });

    it('treats an empty all as vacuously true and an empty any as false', () => {
      // Standard quantifier semantics, and the safe pair: "all of nothing" adds no narrowing,
      // "any of nothing" has no disjunct to satisfy.
      expect(evaluateWebhookFilter({ kind: 'all', of: [] }, itemView())).toBe(true);
      expect(evaluateWebhookFilter({ kind: 'any', of: [] }, itemView())).toBe(false);
    });

    it('negates', () => {
      expect(evaluateWebhookFilter({ kind: 'not', of: wrongCategory }, itemView())).toBe(true);
      expect(evaluateWebhookFilter({ kind: 'not', of: lowStock }, itemView())).toBe(false);
    });

    it('nests to arbitrary (bounded) depth', () => {
      const filter: WebhookFilter = {
        kind: 'all',
        of: [
          inShed,
          { kind: 'any', of: [wrongCategory, { kind: 'not', of: { kind: 'item', itemIds: ['x'] } }] },
        ],
      };
      expect(evaluateWebhookFilter(filter, itemView())).toBe(true);
    });

    it('makes a whole all-branch fail when one child is the inert node', () => {
      expect(evaluateWebhookFilter({ kind: 'all', of: [inShed, WEBHOOK_FILTER_NONE] }, itemView())).toBe(
        false,
      );
    });
  });
});
