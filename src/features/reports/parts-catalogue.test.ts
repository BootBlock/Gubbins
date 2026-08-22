import { describe, it, expect } from 'vitest';
import {
  buildPartsCatalogue,
  CATALOGUE_FIELDS,
  CATALOGUE_MONEY_FIELDS,
  CATALOGUE_PRINT_LIMIT,
  CATALOGUE_PRINT_MEDIA_LIMIT,
  DEFAULT_CATALOGUE_FIELDS,
  UNASSIGNED_GROUP_LABEL,
  cataloguePrintLimit,
  estimateCataloguePages,
  type CatalogueFieldKey,
  type CatalogueItemInput,
  type CatalogueLocationInput,
} from './parts-catalogue';

const NOW = Date.parse('2026-07-09T00:00:00Z');

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

const LOCATIONS: CatalogueLocationInput[] = [
  { id: 'garage', name: 'Garage', parentId: null },
  { id: 'attic', name: 'Attic', parentId: null },
  { id: 'shelf-a', name: 'Shelf A', parentId: 'garage' },
];

describe('buildPartsCatalogue', () => {
  it('groups items by location, ordered by the hierarchy, with per-line values and totals', () => {
    const catalogue = buildPartsCatalogue(
      [
        item({ id: 'widget', locationId: 'shelf-a', quantity: 3, unitCost: 2 }),
        item({ id: 'anvil', locationId: 'garage', quantity: 1, unitCost: 10 }),
        item({ id: 'box', locationId: 'attic', quantity: 2, unitCost: 5 }),
      ],
      LOCATIONS,
      NOW,
    );

    // Attic (root, alphabetical) → Garage → Garage › Shelf A.
    expect(catalogue.groups.map((g) => g.groupLabel)).toEqual(['Attic', 'Garage', 'Garage › Shelf A']);
    const shelf = catalogue.groups.find((g) => g.groupId === 'shelf-a')!;
    expect(shelf.subtotal).toBe(6);
    expect(shelf.totalQuantity).toBe(3);
    expect(catalogue.itemCount).toBe(3);
    expect(catalogue.totalQuantity).toBe(6); // 3 + 1 + 2
    expect(catalogue.grandTotal).toBe(10 + 6 + 10); // box 10 + widget 6 + anvil 10
    expect(catalogue.hasValue).toBe(true);
    expect(catalogue.generatedAt).toBe(NOW);
  });

  it('prefers a manual unit cost over the preferred supplier cost', () => {
    const catalogue = buildPartsCatalogue(
      [item({ id: 'a', locationId: 'garage', quantity: 2, unitCost: 4, preferredSupplierCost: 9 })],
      LOCATIONS,
      NOW,
    );
    const line = catalogue.groups[0]!.lines[0]!;
    expect(line.unitCost).toBe(4);
    expect(line.lineValue).toBe(8);
  });

  // Issue #683 — a gauge's count is always 0, so the catalogue would print "0 g" against a
  // line value of nothing and quietly under-total the document by every consumable on it.
  it('quantifies and values a gauge line by its contents, not its always-zero count', () => {
    const catalogue = buildPartsCatalogue(
      [
        item({
          id: 'spool',
          locationId: 'garage',
          quantity: 0,
          unitOfMeasure: 'g',
          unitCost: null,
          gauge: { netValue: 400, costPerUnitOfMeasure: 0.025 },
        }),
      ],
      LOCATIONS,
      NOW,
    );
    const line = catalogue.groups[0]!.lines[0]!;
    expect(line.quantity).toBe(400);
    expect(line.unitCost).toBe(0.025);
    expect(line.lineValue).toBe(10);
    expect(catalogue.grandTotal).toBe(10);
    // …but 400 grams is not 400 units: the "in stock" count must not absorb a measure.
    expect(line.measured).toBe(true);
    expect(catalogue.totalQuantity).toBe(0);
    expect(catalogue.groups[0]!.totalQuantity).toBe(0);
  });

  it('reads an unpriced gauge as unpriced, never as a line worth zero', () => {
    // A unit cost prices one countable unit, so it must not stand in per gram — that would be
    // wrong by the container's whole capacity. A manual current value is refused for the same
    // reason, even though it outranks every other source on a counted item (issue #706).
    const catalogue = buildPartsCatalogue(
      [
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
      ],
      LOCATIONS,
      NOW,
    );
    const line = catalogue.groups[0]!.lines[0]!;
    expect(line.quantity).toBe(500);
    expect(line.unitCost).toBeNull();
    expect(line.lineValue).toBeNull();
    expect(catalogue.hasValue).toBe(false);
  });

  it('falls back to the preferred supplier cost when there is no manual cost', () => {
    const catalogue = buildPartsCatalogue(
      [item({ id: 'a', locationId: 'garage', quantity: 3, unitCost: null, preferredSupplierCost: 5 })],
      LOCATIONS,
      NOW,
    );
    const line = catalogue.groups[0]!.lines[0]!;
    expect(line.unitCost).toBe(5);
    expect(line.lineValue).toBe(15);
  });

  it('prices a revalued asset at its manual current value, and counts it in the totals (issue #706)', () => {
    // The catalogue used to select no `current_value` at all, so an asset priced only by a manual
    // revaluation printed a dash in both money columns and added nothing to its room subtotal —
    // while the insurance schedule listed that same asset at that same figure.
    const catalogue = buildPartsCatalogue(
      [
        item({ id: 'coin', locationId: 'garage', quantity: 2, currentValuePerUnit: 400 }),
        // …and it still outranks every source beneath it, exactly as it does everywhere else.
        item({
          id: 'guitar',
          locationId: 'garage',
          quantity: 1,
          currentValuePerUnit: 900,
          unitCost: 300,
          preferredSupplierCost: 250,
          depreciatedPurchasePrice: 120,
        }),
      ],
      LOCATIONS,
      NOW,
    );
    const [coin, guitar] = catalogue.groups[0]!.lines;
    expect(coin!.unitCost).toBe(400);
    expect(coin!.lineValue).toBe(800);
    expect(guitar!.unitCost).toBe(900);
    expect(guitar!.lineValue).toBe(900);
    expect(catalogue.groups[0]!.subtotal).toBe(1700);
    expect(catalogue.grandTotal).toBe(1700);
    expect(catalogue.hasValue).toBe(true);
  });

  it('leaves an unpriced item without a cost or line value (never a misleading zero)', () => {
    const catalogue = buildPartsCatalogue(
      [item({ id: 'a', locationId: 'garage', quantity: 4 })],
      LOCATIONS,
      NOW,
    );
    const line = catalogue.groups[0]!.lines[0]!;
    expect(line.unitCost).toBeNull();
    expect(line.lineValue).toBeNull();
    expect(catalogue.groups[0]!.subtotal).toBe(0);
    expect(catalogue.hasValue).toBe(false);
    expect(catalogue.grandTotal).toBe(0);
  });

  it('collects items with an unknown or missing location into a trailing "Unassigned" group', () => {
    const catalogue = buildPartsCatalogue(
      [
        item({ id: 'homed', locationId: 'garage' }),
        item({ id: 'ghost', locationId: 'nowhere' }),
        item({ id: 'nolocation', locationId: null }),
      ],
      LOCATIONS,
      NOW,
    );
    const last = catalogue.groups.at(-1)!;
    expect(last.groupLabel).toBe(UNASSIGNED_GROUP_LABEL);
    expect(last.groupId).toBeNull();
    expect(last.lines.map((l) => l.id).sort()).toEqual(['ghost', 'nolocation']);
  });

  it('omits locations that hold no items and sorts lines within a group by name', () => {
    const catalogue = buildPartsCatalogue(
      [
        item({ id: 'z', name: 'Zebra', locationId: 'garage' }),
        item({ id: 'a', name: 'Apple', locationId: 'garage' }),
      ],
      LOCATIONS,
      NOW,
    );
    expect(catalogue.groups).toHaveLength(1);
    expect(catalogue.groups[0]!.groupId).toBe('garage');
    expect(catalogue.groups[0]!.lines.map((l) => l.name)).toEqual(['Apple', 'Zebra']);
  });

  it('returns an empty catalogue for no items', () => {
    const catalogue = buildPartsCatalogue([], LOCATIONS, NOW);
    expect(catalogue).toEqual({
      groups: [],
      grandTotal: 0,
      totalQuantity: 0,
      itemCount: 0,
      hasValue: false,
      generatedAt: NOW,
    });
  });

  it('carries every display field through onto the resolved line', () => {
    const catalogue = buildPartsCatalogue(
      [
        item({
          id: 'a',
          name: 'Resistor',
          locationId: 'garage',
          category: 'Passives',
          quantity: 100,
          unitOfMeasure: 'pcs',
          serialNo: null,
          mpn: 'RC0805',
          manufacturer: 'Acme',
          supplier: 'Parts Co',
          purchasePrice: 0.01,
          notes: 'bulk reel',
        }),
      ],
      LOCATIONS,
      NOW,
    );
    const line = catalogue.groups[0]!.lines[0]!;
    expect(line).toMatchObject({
      category: 'Passives',
      unitOfMeasure: 'pcs',
      mpn: 'RC0805',
      manufacturer: 'Acme',
      supplier: 'Parts Co',
      purchasePrice: 0.01,
      notes: 'bulk reel',
    });
  });

  it('groups by category (alphabetical), uncategorised items trailing', () => {
    const catalogue = buildPartsCatalogue(
      [
        item({ id: 'r1', category: 'Resistors', locationId: 'garage' }),
        item({ id: 'c1', category: 'Capacitors', locationId: 'attic' }),
        item({ id: 'x1', category: null, locationId: 'garage' }),
      ],
      LOCATIONS,
      NOW,
      { groupBy: 'category' },
    );
    expect(catalogue.groups.map((g) => g.groupLabel)).toEqual(['Capacitors', 'Resistors', 'Uncategorised']);
    expect(catalogue.groups[0]!.groupId).toBe('category:Capacitors');
  });

  it('supports a single unheaded section with "no grouping"', () => {
    const catalogue = buildPartsCatalogue(
      [
        item({ id: 'b', name: 'Bolt', locationId: 'garage' }),
        item({ id: 'a', name: 'Anvil', locationId: 'attic' }),
      ],
      LOCATIONS,
      NOW,
      { groupBy: 'none' },
    );
    expect(catalogue.groups).toHaveLength(1);
    expect(catalogue.groups[0]!.groupLabel).toBe('');
    expect(catalogue.groups[0]!.lines.map((l) => l.name)).toEqual(['Anvil', 'Bolt']);
  });

  it('sorts by value (high to low) and by quantity (high to low)', () => {
    const items = [
      item({ id: 'lo', name: 'Cheap', locationId: 'garage', quantity: 1, unitCost: 1 }),
      item({ id: 'hi', name: 'Dear', locationId: 'garage', quantity: 10, unitCost: 5 }),
    ];
    const byValue = buildPartsCatalogue(items, LOCATIONS, NOW, { groupBy: 'none', sortBy: 'value' });
    expect(byValue.groups[0]!.lines.map((l) => l.id)).toEqual(['hi', 'lo']); // 50 before 1
    const byQty = buildPartsCatalogue(items, LOCATIONS, NOW, { groupBy: 'none', sortBy: 'quantity' });
    expect(byQty.groups[0]!.lines.map((l) => l.id)).toEqual(['hi', 'lo']); // 10 before 1
  });

  it('carries the description and thumbnail through onto the line', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const catalogue = buildPartsCatalogue(
      [item({ id: 'a', locationId: 'garage', description: 'A 10k resistor', thumbnail: bytes })],
      LOCATIONS,
      NOW,
    );
    const line = catalogue.groups[0]!.lines[0]!;
    expect(line.description).toBe('A 10k resistor');
    expect(line.thumbnail).toBe(bytes);
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
