import { describe, it, expect } from 'vitest';
import {
  CATALOGUE_FIELDS,
  CATALOGUE_MONEY_FIELDS,
  CATALOGUE_PRINT_LIMIT,
  CATALOGUE_PRINT_MEDIA_LIMIT,
  DEFAULT_CATALOGUE_FIELDS,
  UNASSIGNED_GROUP_LABEL,
  UNCATEGORISED_GROUP_LABEL,
  cataloguePrintLimit,
  estimateCataloguePages,
  finalisePartsCatalogueSummary,
  toCatalogueLine,
  type CatalogueFieldKey,
  type CatalogueGroupTally,
  type CatalogueItemInput,
  type CatalogueLocationInput,
} from './parts-catalogue';

const NOW = Date.parse('2026-07-09T00:00:00Z');
/** Every test reports in a 2dp currency unless it is specifically about the minor unit. */
const DP = 2;

/** A fully-specified item; each test overrides only the fields it exercises. */
function item(overrides: Partial<CatalogueItemInput> & Pick<CatalogueItemInput, 'id'>): CatalogueItemInput {
  return {
    name: overrides.id,
    locationId: null,
    category: null,
    description: null,
    thumbnail: null,
    quantity: 1,
    unitOfMeasure: null,
    condition: null,
    serialNo: null,
    mpn: null,
    manufacturer: null,
    supplier: null,
    unitCost: null,
    preferredSupplierCost: null,
    purchasePrice: null,
    acquiredAt: null,
    warrantyExpiresAt: null,
    notes: null,
    ...overrides,
  };
}

/** One grouped row as the repository's summary read returns it. */
function tally(overrides: Partial<CatalogueGroupTally> = {}): CatalogueGroupTally {
  return {
    groupId: null,
    groupName: null,
    itemCount: 1,
    subtotalMinorUnits: 0,
    totalQuantity: 0,
    pricedCount: 0,
    ...overrides,
  };
}

const LOCATIONS: CatalogueLocationInput[] = [
  { id: 'garage', name: 'Garage', parentId: null },
  { id: 'attic', name: 'Attic', parentId: null },
  { id: 'shelf-a', name: 'Shelf A', parentId: 'garage' },
];

describe('toCatalogueLine', () => {
  it('values a line at quantity × unit cost, quantised to the currency minor unit', () => {
    const line = toCatalogueLine(
      item({ id: 'widget', locationId: 'shelf-a', quantity: 3, unitCost: 2 }),
      NOW,
      DP,
    );
    expect(line.unitCost).toBe(2);
    expect(line.lineValue).toBe(6);
  });

  // Issue #288: a printed column of figures must add up to the subtotal beneath it, so the line
  // is quantised before anything sums it — not left at a precision the page cannot show.
  it('rounds a line to the reporting currency minor unit, not to a flat 2dp', () => {
    const third = item({ id: 'a', locationId: 'garage', quantity: 3, unitCost: 0.335 });
    expect(toCatalogueLine(third, NOW, 2).lineValue).toBe(1.01);
    expect(toCatalogueLine(third, NOW, 0).lineValue).toBe(1);
  });

  it('prefers a manual unit cost over the preferred supplier cost', () => {
    const line = toCatalogueLine(
      item({ id: 'a', locationId: 'garage', quantity: 2, unitCost: 4, preferredSupplierCost: 9 }),
      NOW,
      DP,
    );
    expect(line.unitCost).toBe(4);
    expect(line.lineValue).toBe(8);
  });

  it('falls back to the preferred supplier cost when there is no manual cost', () => {
    const line = toCatalogueLine(
      item({ id: 'a', locationId: 'garage', quantity: 3, unitCost: null, preferredSupplierCost: 5 }),
      NOW,
      DP,
    );
    expect(line.unitCost).toBe(5);
    expect(line.lineValue).toBe(15);
  });

  // Issue #683 — a gauge's count is always 0, so the catalogue would print "0 g" against a
  // line value of nothing and quietly under-total the document by every consumable on it.
  it('quantifies and values a gauge line by its contents, not its always-zero count', () => {
    const line = toCatalogueLine(
      item({
        id: 'spool',
        locationId: 'garage',
        quantity: 0,
        unitOfMeasure: 'g',
        unitCost: null,
        gauge: { netValue: 400, costPerUnitOfMeasure: 0.025 },
      }),
      NOW,
      DP,
    );
    expect(line.quantity).toBe(400);
    expect(line.unitCost).toBe(0.025);
    expect(line.lineValue).toBe(10);
    // …but 400 grams is not 400 units: the "in stock" count must not absorb a measure.
    expect(line.measured).toBe(true);
  });

  it('reads an unpriced gauge as unpriced, never as a line worth zero', () => {
    // A unit cost prices one countable unit, so it must not stand in per gram — that would be
    // wrong by the container's whole capacity. A manual current value is refused for the same
    // reason, even though it outranks every other source on a counted item (issue #706).
    const line = toCatalogueLine(
      item({
        id: 'cylinder',
        locationId: 'garage',
        quantity: 0,
        unitOfMeasure: 'g',
        unitCost: 25,
        preferredSupplierCost: 30,
        currentValuePerUnit: 40,
        gauge: { netValue: 500, costPerUnitOfMeasure: null },
      }),
      NOW,
      DP,
    );
    expect(line.quantity).toBe(500);
    expect(line.unitCost).toBeNull();
    expect(line.lineValue).toBeNull();
  });

  it('prices a revalued asset at its manual current value, above every source beneath it (issue #706)', () => {
    // The catalogue used to select no `current_value` at all, so an asset priced only by a manual
    // revaluation printed a dash in both money columns and added nothing to its room subtotal —
    // while the insurance schedule listed that same asset at that same figure.
    const coin = toCatalogueLine(
      item({ id: 'coin', locationId: 'garage', quantity: 2, currentValuePerUnit: 400 }),
      NOW,
      DP,
    );
    expect(coin.unitCost).toBe(400);
    expect(coin.lineValue).toBe(800);

    const guitar = toCatalogueLine(
      item({
        id: 'guitar',
        locationId: 'garage',
        quantity: 1,
        currentValuePerUnit: 900,
        unitCost: 300,
        preferredSupplierCost: 250,
        depreciatedPurchasePrice: 120,
      }),
      NOW,
      DP,
    );
    expect(guitar.unitCost).toBe(900);
    expect(guitar.lineValue).toBe(900);
  });

  it('leaves an unpriced item without a cost or line value (never a misleading zero)', () => {
    const line = toCatalogueLine(item({ id: 'a', locationId: 'garage', quantity: 4 }), NOW, DP);
    expect(line.unitCost).toBeNull();
    expect(line.lineValue).toBeNull();
  });

  it('carries every display field through onto the resolved line', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const line = toCatalogueLine(
      item({
        id: 'a',
        name: 'Resistor',
        locationId: 'garage',
        category: 'Passives',
        description: 'A 10k resistor',
        thumbnail: bytes,
        quantity: 100,
        unitOfMeasure: 'pcs',
        serialNo: null,
        mpn: 'RC0805',
        manufacturer: 'Acme',
        supplier: 'Parts Co',
        purchasePrice: 0.01,
        notes: 'bulk reel',
      }),
      NOW,
      DP,
    );
    expect(line).toMatchObject({
      category: 'Passives',
      description: 'A 10k resistor',
      thumbnail: bytes,
      unitOfMeasure: 'pcs',
      mpn: 'RC0805',
      manufacturer: 'Acme',
      supplier: 'Parts Co',
      purchasePrice: 0.01,
      notes: 'bulk reel',
    });
  });
});

describe('finalisePartsCatalogueSummary', () => {
  it('orders location sections by the hierarchy and rolls the tallies up into the totals', () => {
    const summary = finalisePartsCatalogueSummary(
      [
        tally({
          groupId: 'shelf-a',
          itemCount: 1,
          subtotalMinorUnits: 600,
          totalQuantity: 3,
          pricedCount: 1,
        }),
        tally({
          groupId: 'garage',
          itemCount: 1,
          subtotalMinorUnits: 1000,
          totalQuantity: 1,
          pricedCount: 1,
        }),
        tally({ groupId: 'attic', itemCount: 1, subtotalMinorUnits: 1000, totalQuantity: 2, pricedCount: 1 }),
      ],
      LOCATIONS,
      NOW,
      { decimals: DP },
    );

    // Attic (root, alphabetical) → Garage → Garage › Shelf A.
    expect(summary.groups.map((g) => g.groupLabel)).toEqual(['Attic', 'Garage', 'Garage › Shelf A']);
    const shelf = summary.groups.find((g) => g.groupId === 'shelf-a')!;
    expect(shelf.subtotal).toBe(6);
    expect(shelf.totalQuantity).toBe(3);
    expect(shelf.ref).toEqual({ kind: 'location', locationId: 'shelf-a' });
    expect(summary.itemCount).toBe(3);
    expect(summary.totalQuantity).toBe(6);
    expect(summary.grandTotal).toBe(26);
    expect(summary.hasValue).toBe(true);
    expect(summary.generatedAt).toBe(NOW);
  });

  it('folds an unknown or missing location into a trailing "Unassigned" section', () => {
    const summary = finalisePartsCatalogueSummary(
      [
        tally({ groupId: 'garage', itemCount: 1 }),
        tally({ groupId: 'nowhere', itemCount: 2, subtotalMinorUnits: 500 }),
        tally({ groupId: null, itemCount: 3, subtotalMinorUnits: 250 }),
      ],
      LOCATIONS,
      NOW,
      { decimals: DP },
    );
    const last = summary.groups.at(-1)!;
    expect(last.groupLabel).toBe(UNASSIGNED_GROUP_LABEL);
    expect(last.groupId).toBeNull();
    // Both tallies land in the one bucket — an item pointing at a deleted room must still appear.
    expect(last.itemCount).toBe(5);
    expect(last.subtotal).toBe(7.5);
    expect(last.ref).toEqual({ kind: 'unassigned' });
  });

  it('omits locations that hold no items', () => {
    const summary = finalisePartsCatalogueSummary(
      [tally({ groupId: 'garage', itemCount: 2 })],
      LOCATIONS,
      NOW,
      { decimals: DP },
    );
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]!.groupId).toBe('garage');
  });

  it('groups by category (alphabetical), uncategorised trailing, and names each section’s ids', () => {
    const summary = finalisePartsCatalogueSummary(
      [
        tally({ groupId: 'cat-r', groupName: 'Resistors', itemCount: 1 }),
        tally({ groupId: 'cat-c', groupName: 'Capacitors', itemCount: 1 }),
        tally({ groupId: null, groupName: null, itemCount: 1 }),
      ],
      LOCATIONS,
      NOW,
      { groupBy: 'category', decimals: DP },
    );
    expect(summary.groups.map((g) => g.groupLabel)).toEqual([
      'Capacitors',
      'Resistors',
      UNCATEGORISED_GROUP_LABEL,
    ]);
    expect(summary.groups[0]!.groupId).toBe('category:Capacitors');
    expect(summary.groups[0]!.ref).toEqual({ kind: 'category', categoryIds: ['cat-c'] });
    expect(summary.groups[2]!.ref).toEqual({ kind: 'uncategorised', blankCategoryIds: [] });
  });

  // Category names carry no uniqueness constraint, so a heading can cover more than one category.
  // The section's page predicate has to cover both, or half its lines vanish from the document.
  it('merges categories that share a name into one section, over both of their ids', () => {
    const summary = finalisePartsCatalogueSummary(
      [
        tally({ groupId: 'cat-1', groupName: 'Fixings', itemCount: 2, subtotalMinorUnits: 300 }),
        tally({ groupId: 'cat-2', groupName: 'Fixings', itemCount: 3, subtotalMinorUnits: 200 }),
      ],
      LOCATIONS,
      NOW,
      { groupBy: 'category', decimals: DP },
    );
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]!.itemCount).toBe(5);
    expect(summary.groups[0]!.subtotal).toBe(5);
    expect(summary.groups[0]!.ref).toEqual({ kind: 'category', categoryIds: ['cat-1', 'cat-2'] });
  });

  // A blank name is no heading at all, so those items read as uncategorised — but the category
  // still exists, so the trailing bucket's predicate has to name it explicitly.
  it('treats a blank category name as uncategorised and carries its id into the bucket', () => {
    const summary = finalisePartsCatalogueSummary(
      [
        tally({ groupId: 'cat-blank', groupName: '   ', itemCount: 1 }),
        tally({ groupId: null, groupName: null, itemCount: 1 }),
      ],
      LOCATIONS,
      NOW,
      { groupBy: 'category', decimals: DP },
    );
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]!.groupLabel).toBe(UNCATEGORISED_GROUP_LABEL);
    expect(summary.groups[0]!.ref).toEqual({ kind: 'uncategorised', blankCategoryIds: ['cat-blank'] });
  });

  it('supports a single unheaded section with "no grouping"', () => {
    const summary = finalisePartsCatalogueSummary(
      [tally({ groupId: null, itemCount: 4, subtotalMinorUnits: 1234, totalQuantity: 9 })],
      LOCATIONS,
      NOW,
      { groupBy: 'none', decimals: DP },
    );
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]!.groupLabel).toBe('');
    expect(summary.groups[0]!.ref).toEqual({ kind: 'all' });
    expect(summary.groups[0]!.subtotal).toBe(12.34);
    expect(summary.itemCount).toBe(4);
  });

  it('reports no value when nothing in scope is priced', () => {
    const summary = finalisePartsCatalogueSummary(
      [tally({ groupId: 'garage', itemCount: 4, pricedCount: 0 })],
      LOCATIONS,
      NOW,
      { decimals: DP },
    );
    expect(summary.hasValue).toBe(false);
    expect(summary.grandTotal).toBe(0);
  });

  it('returns an empty summary for a scope holding nothing', () => {
    expect(finalisePartsCatalogueSummary([], LOCATIONS, NOW, { decimals: DP })).toEqual({
      groups: [],
      grandTotal: 0,
      totalQuantity: 0,
      itemCount: 0,
      hasValue: false,
      generatedAt: NOW,
    });
  });
});

describe('catalogue field metadata', () => {
  it('marks exactly the money columns and never lists name (always shown)', () => {
    const keys = CATALOGUE_FIELDS.map((f) => f.key);
    expect(keys).not.toContain('name' as never);
    expect([...CATALOGUE_MONEY_FIELDS].sort()).toEqual(['lineValue', 'purchasePrice', 'unitCost']);
  });

  it('defaults to a subset of real fields', () => {
    const keys = new Set(CATALOGUE_FIELDS.map((f) => f.key));
    for (const key of DEFAULT_CATALOGUE_FIELDS) expect(keys.has(key)).toBe(true);
  });
});

/** The print ceiling and the page estimate that make a catalogue's size knowable (issue #338). */
describe('catalogue print ceiling', () => {
  const fields = (...keys: CatalogueFieldKey[]): ReadonlySet<CatalogueFieldKey> => new Set(keys);

  it('drops to the media ceiling as soon as a media column is on', () => {
    expect(cataloguePrintLimit(fields())).toBe(CATALOGUE_PRINT_LIMIT);
    expect(cataloguePrintLimit(fields('category', 'quantity', 'mpn'))).toBe(CATALOGUE_PRINT_LIMIT);
    expect(cataloguePrintLimit(fields('photo'))).toBe(CATALOGUE_PRINT_MEDIA_LIMIT);
    expect(cataloguePrintLimit(fields('qr'))).toBe(CATALOGUE_PRINT_MEDIA_LIMIT);
    expect(cataloguePrintLimit(fields('photo', 'qr', 'category'))).toBe(CATALOGUE_PRINT_MEDIA_LIMIT);
  });

  it('keeps the media ceiling below the text one, so turning a media column on can only lower it', () => {
    expect(CATALOGUE_PRINT_MEDIA_LIMIT).toBeLessThan(CATALOGUE_PRINT_LIMIT);
  });

  it('estimates at least one page, even for an empty document', () => {
    expect(estimateCataloguePages({ lineCount: 0, groupCount: 0, photos: false, qr: false })).toBe(1);
  });

  it('grows with the line count, and never shrinks as lines are added', () => {
    const pages = (lineCount: number) =>
      estimateCataloguePages({ lineCount, groupCount: 1, photos: false, qr: false });
    expect(pages(10)).toBe(1);
    expect(pages(2_000)).toBeGreaterThan(pages(200));
    expect(pages(200)).toBeGreaterThanOrEqual(pages(199));
  });

  it('estimates more pages once a media column makes each row taller', () => {
    const input = { lineCount: 500, groupCount: 5 };
    const text = estimateCataloguePages({ ...input, photos: false, qr: false });
    const photos = estimateCataloguePages({ ...input, photos: true, qr: false });
    const qr = estimateCataloguePages({ ...input, photos: false, qr: true });
    expect(photos).toBeGreaterThan(text);
    // A QR is the taller of the two, so it wins even where both columns are on.
    expect(qr).toBeGreaterThan(photos);
    expect(estimateCataloguePages({ ...input, photos: true, qr: true })).toBe(qr);
  });

  it('charges each section for its heading and table header', () => {
    const flat = estimateCataloguePages({ lineCount: 100, groupCount: 1, photos: false, qr: false });
    const grouped = estimateCataloguePages({ lineCount: 100, groupCount: 60, photos: false, qr: false });
    expect(grouped).toBeGreaterThan(flat);
  });
});
