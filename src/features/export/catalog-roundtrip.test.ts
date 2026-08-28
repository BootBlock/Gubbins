/**
 * The catalogue CSV round-trip (issue #249).
 *
 * `CATALOG_CSV_COLUMNS` promises that a file exported by the wizard imports straight back
 * without a manual column-mapping step. Nothing enforced that promise, and drift here is
 * silent in the worst way: a header with no entry in `HEADER_SYNONYMS` infers as `null`, an
 * unmapped column is skipped rather than reported, and the user round-trips their catalogue
 * and quietly loses a field. The synonym list is also deliberately kept minimal (a loose
 * synonym shadows a same-named custom field), so *not* adding one is the path of least
 * resistance for a new column — which is exactly why this is a test and not a comment.
 */
import { describe, it, expect } from 'vitest';
import type { Item } from '@/db/repositories';
import { parseCsv } from '@/features/import/tabular';
import { buildCatalogCsv, buildCatalogNameLookup } from './export-data';
import {
  buildCatalogImportPlan,
  inferColumnMapping,
  type CatalogField,
} from '@/features/inventory/catalog-import';

/**
 * The logical field each exported column must import back as, written down where a test can
 * check it. Every header resolves to the catalog field of the same name, `sku` included — the
 * exporter writes the item's `mpn` under that header, and the importer renames it back later,
 * at value coercion rather than in the mapping this table describes.
 */
const EXPECTED_IMPORT_FIELD: Readonly<Record<string, CatalogField>> = {
  name: 'name',
  description: 'description',
  notes: 'notes',
  sku: 'sku',
  barcode: 'barcode',
  serialNumber: 'serialNumber',
  quantity: 'quantity',
  // Written under readable headers holding a location path and a category name (issue #596),
  // not the `…Id` the field is called.
  location: 'locationId',
  category: 'categoryId',
  trackingMode: 'trackingMode',
  unitOfMeasure: 'unitOfMeasure',
  grossCapacity: 'grossCapacity',
  tareWeight: 'tareWeight',
  currentNetValue: 'currentNetValue',
  costPerUnitOfMeasure: 'costPerUnitOfMeasure',
  manufacturer: 'manufacturer',
  unitCost: 'unitCost',
  weight: 'weight',
  width: 'width',
  height: 'height',
  depth: 'depth',
  batchNumber: 'batchNumber',
  lotNumber: 'lotNumber',
  expiryDate: 'expiryDate',
  condition: 'condition',
  reorderPoint: 'reorderPoint',
  reorderQty: 'reorderQty',
  isUnlimited: 'isUnlimited',
  tags: 'tags',
};

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    name: 'NE555 Timer',
    description: 'Classic timer IC',
    notes: 'Bought a reel of them',
    locationId: 'l1',
    categoryId: 'c1',
    trackingMode: 'DISCRETE',
    quantity: 12,
    serialNo: null,
    mpn: 'NE555P',
    barcode: '5012345678900',
    serialNumber: 'SN-4417',
    manufacturer: 'TI',
    unitCost: 0.25,
    weight: 1.4,
    width: 10,
    height: 4,
    depth: 7,
    batchNumber: 'B-9',
    lotNumber: 'L-3',
    expiryDate: Date.UTC(2026, 7, 1),
    condition: 'GOOD',
    reorderPoint: 5,
    reorderQty: 20,
    isUnlimited: false,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    gauge: null,
    thumbnailBlob: undefined,
    ...overrides,
  };
}

describe('catalogue CSV round-trip — header ↔ synonym coverage (issue #249)', () => {
  it('infers every export header back to the field the exporter wrote', () => {
    // Read off the emitted file rather than the column list, so a header the exporter *renames*
    // (issue #596) is checked as the reader will really meet it.
    const headers = buildCatalogCsv([makeItem()]).split('\r\n')[0]!.split(',');
    const mapping = inferColumnMapping(headers);
    const inferred = Object.fromEntries(headers.map((header, i) => [header, mapping[i]]));
    // `toEqual` rather than a per-column loop so a *new* export column with no synonym (which
    // infers as `null`) and a stale entry here both fail, instead of only the former.
    expect(inferred).toEqual(EXPECTED_IMPORT_FIELD);
  });
});

describe('catalogue CSV round-trip — values survive the trip (issue #249)', () => {
  it('re-creates a discrete item with every exported field intact', () => {
    const item = makeItem();
    const csv = buildCatalogCsv([item], [], new Map(), new Map([['i1', ['fridge', 'perishable']]]));

    const plan = buildCatalogImportPlan(csv, null, []);

    expect(plan.errors).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]!.input).toEqual({
      name: 'NE555 Timer',
      description: 'Classic timer IC',
      notes: 'Bought a reel of them',
      locationId: 'l1',
      categoryId: 'c1',
      trackingMode: 'DISCRETE',
      quantity: 12,
      // Exported under the `sku` header, resolved back to the manufacturer part number.
      mpn: 'NE555P',
      barcode: '5012345678900',
      serialNumber: 'SN-4417',
      expiryDate: Date.UTC(2026, 7, 1),
      manufacturer: 'TI',
      unitCost: 0.25,
      weight: 1.4,
      width: 10,
      height: 4,
      depth: 7,
      batchNumber: 'B-9',
      lotNumber: 'L-3',
      condition: 'GOOD',
      reorderPoint: 5,
      reorderQty: 20,
      isUnlimited: false,
    });
    expect(plan.create[0]!.tags).toEqual(['fridge', 'perishable']);
  });

  it('re-creates an unlimited-supply item as unlimited', () => {
    // The fixture above carries `isUnlimited: false`, which is also the importer's fallback for
    // an absent column — so on its own it cannot tell a round-tripped flag from a dropped one.
    // A separate row rather than a change to the fixture, because the flag is DISCRETE-only and
    // the gauge case below reuses the same factory.
    const plan = buildCatalogImportPlan(buildCatalogCsv([makeItem({ isUnlimited: true })]), null, []);

    expect(plan.errors).toEqual([]);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]!.input.isUnlimited).toBe(true);
    // The catalogue export keeps the stored count on an unlimited row — unlike the items CSV,
    // which blanks it — so the last finite quantity survives the trip rather than resetting.
    expect(plan.create[0]!.input.quantity).toBe(12);
  });

  it('re-creates a gauge item with its stored configuration intact', () => {
    const item = makeItem({
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: {
        unitOfMeasure: 'g',
        grossCapacity: 1000,
        tareWeight: 200,
        currentNetValue: 750,
        costPerUnitOfMeasure: 0.02,
        percentageRemaining: 75,
        currentGrossWeight: 950,
      },
    });

    const plan = buildCatalogImportPlan(buildCatalogCsv([item]), null, []);

    expect(plan.errors).toEqual([]);
    expect(plan.create).toHaveLength(1);
    // Only the stored parameters round-trip; `percentageRemaining` / `currentGrossWeight` are
    // derived from them on the way back in, so the exporter never writes them.
    expect(plan.create[0]!.input.gauge).toEqual({
      unitOfMeasure: 'g',
      grossCapacity: 1000,
      tareWeight: 200,
      currentNetValue: 750,
      costPerUnitOfMeasure: 0.02,
    });
  });

  it('matches an existing item by name and updates it rather than duplicating it', () => {
    const item = makeItem();
    const plan = buildCatalogImportPlan(buildCatalogCsv([item]), null, [item]);

    expect(plan.errors).toEqual([]);
    expect(plan.create).toEqual([]);
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]!.itemId).toBe('i1');
  });
});

describe('catalogue CSV round-trip — readable location & category (issue #596)', () => {
  const NAMES = {
    locationPathById: new Map([['l1', 'Workshop / Cabinet A / Drawer 3']]),
    categoryNameById: new Map([['c1', 'Passives']]),
  };

  function cellsOf(csv: string): Record<string, string> {
    // Parsed rather than split on commas: the location path is a quoted cell.
    const [header, row] = csv.split('\r\n');
    return Object.fromEntries(parseCsv(header!)[0]!.map((h, i) => [h, parseCsv(row!)[0]![i] ?? '']));
  }

  it('writes the location path and the category name, not their ids', () => {
    const cells = cellsOf(buildCatalogCsv([makeItem()], [], new Map(), new Map(), NAMES));
    expect(cells.location).toBe('Workshop / Cabinet A / Drawer 3');
    expect(cells.category).toBe('Passives');
  });

  it('falls back to the stored id when a name cannot be resolved', () => {
    // A row is never worth losing its place over: an id the caller could not name still
    // resolves inside the database that produced it.
    const cells = cellsOf(buildCatalogCsv([makeItem()], [], new Map(), new Map(), {}));
    expect(cells.location).toBe('l1');
    expect(cells.category).toBe('c1');
  });

  it('leaves the category blank for an uncategorised item', () => {
    const csv = buildCatalogCsv([makeItem({ categoryId: null })], [], new Map(), new Map(), NAMES);
    expect(cellsOf(csv).category).toBe('');
  });

  it('lands the named cells back on the same ids when imported into the same database', () => {
    const csv = buildCatalogCsv([makeItem()], [], new Map(), new Map(), NAMES);

    const plan = buildCatalogImportPlan(csv, null, [], {
      locations: [
        { id: 'l0', name: 'Workshop', parentId: null },
        { id: 'lc', name: 'Cabinet A', parentId: 'l0' },
        { id: 'l1', name: 'Drawer 3', parentId: 'lc' },
      ],
      categories: [{ id: 'c1', name: 'Passives' }],
    });

    expect(plan.errors).toEqual([]);
    expect(plan.create[0]!.input.locationId).toBe('l1');
    expect(plan.create[0]!.input.categoryId).toBe('c1');
  });

  it('keeps the stored id for a category two categories share the name of', () => {
    // Nothing makes a category name unique, and the id used to round-trip exactly. Writing the
    // shared name would take a row that always imported and make it unimportable, so the row
    // keeps its id and only loses the readability it could not honestly have had.
    const names = buildCatalogNameLookup(
      [{ id: 'l1', path: 'Workshop / Cabinet A / Drawer 3' }],
      [
        { id: 'c1', name: 'Spares' },
        { id: 'c2', name: 'spares' },
      ],
    );
    const cells = cellsOf(buildCatalogCsv([makeItem()], [], new Map(), new Map(), names));
    expect(cells.category).toBe('c1');
    expect(cells.location).toBe('Workshop / Cabinet A / Drawer 3');
  });

  it('keeps the stored id for a location path two locations share', () => {
    const names = buildCatalogNameLookup(
      [
        { id: 'l1', path: 'Shed / Drawer 1' },
        { id: 'l2', path: 'Shed / Drawer 1' },
      ],
      [{ id: 'c1', name: 'Passives' }],
    );
    const cells = cellsOf(buildCatalogCsv([makeItem()], [], new Map(), new Map(), names));
    expect(cells.location).toBe('l1');
    expect(cells.category).toBe('Passives');
  });

  it('names the second install the place it has never heard of', () => {
    // The issue's "carry it to another Gubbins install" case: the path is reported as unknown
    // with the value the file gave, so the reviewer can see what to create.
    const csv = buildCatalogCsv([makeItem()], [], new Map(), new Map(), NAMES);

    const plan = buildCatalogImportPlan(csv, null, [], {
      locations: [{ id: 'other', name: 'Garage', parentId: null }],
      categories: [{ id: 'other-c', name: 'Semiconductors' }],
    });

    expect(plan.create).toEqual([]);
    expect(plan.errors[0]!.message).toMatch(/Unknown location "Workshop \/ Cabinet A \/ Drawer 3"/);
  });

  it('names the unknown category too, rather than failing the row on a foreign key', () => {
    // Location resolution runs first and skips the row on failure, so the second install needs
    // the *place* to resolve before the category is reached at all — which is what makes this a
    // separate case rather than an extra assertion on the one above (issue #407).
    const csv = buildCatalogCsv([makeItem()], [], new Map(), new Map(), NAMES);

    const plan = buildCatalogImportPlan(csv, null, [], {
      locations: [
        { id: 'l0', name: 'Workshop', parentId: null },
        { id: 'lc', name: 'Cabinet A', parentId: 'l0' },
        { id: 'l1', name: 'Drawer 3', parentId: 'lc' },
      ],
      categories: [{ id: 'other-c', name: 'Semiconductors' }],
    });

    expect(plan.create).toEqual([]);
    expect(plan.errors[0]!.message).toMatch(/Unknown category "Passives"/);
  });
});
