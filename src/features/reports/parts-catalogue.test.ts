import { describe, it, expect } from 'vitest';
import {
  buildPartsCatalogue,
  CATALOGUE_FIELDS,
  CATALOGUE_MONEY_FIELDS,
  DEFAULT_CATALOGUE_FIELDS,
  UNASSIGNED_GROUP_LABEL,
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
    expect(catalogue.groups.map((g) => g.locationPath)).toEqual(['Attic', 'Garage', 'Garage › Shelf A']);
    expect(catalogue.groups.find((g) => g.locationId === 'shelf-a')?.subtotal).toBe(6);
    expect(catalogue.itemCount).toBe(3);
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
    expect(last.locationPath).toBe(UNASSIGNED_GROUP_LABEL);
    expect(last.locationId).toBeNull();
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
    expect(catalogue.groups[0]!.locationId).toBe('garage');
    expect(catalogue.groups[0]!.lines.map((l) => l.name)).toEqual(['Apple', 'Zebra']);
  });

  it('returns an empty catalogue for no items', () => {
    const catalogue = buildPartsCatalogue([], LOCATIONS, NOW);
    expect(catalogue).toEqual({
      groups: [],
      grandTotal: 0,
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
