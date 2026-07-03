/**
 * Migration-mapper tests (Phase EI-3). Each fixture is a *synthetic* export from the
 * named tool — made-up parts, `example.com`, no real or personal data — asserting that
 * the mapper reshapes the columns into the canonical Gubbins fields, folds unrecognised
 * columns into provenance notes, and flows cleanly through the *unchanged*
 * `buildImportPlanFromRows` pipeline.
 */
import { describe, expect, it } from 'vitest';
import {
  MIGRATION_SOURCE_IDS,
  MIGRATION_SOURCE_LABELS,
  detectMigrationSource,
  mapMigration,
  type MigrationSourceId,
} from './migrations';
import { buildImportPlanFromRows, type CatalogImportPlan } from '../catalog-import';
import { applyMigration, extractImport } from '../text-import';

/** Split a header + data-rows fixture written as a delimited block into a matrix. */
function rows(block: string, delimiter = ','): { header: string[]; data: string[][] } {
  const lines = block
    .trim()
    .split('\n')
    .map((l) => l.split(delimiter).map((c) => c.trim()));
  return { header: lines[0]!, data: lines.slice(1) };
}

/** Build a plan from a mapped source, with no existing items (all creates). */
function planFor(source: MigrationSourceId, header: string[], data: string[][]): CatalogImportPlan {
  const mapped = mapMigration(source, header, data);
  return buildImportPlanFromRows(mapped.headerRow, mapped.dataRows, mapped.mapping, []);
}

// ---------------------------------------------------------------------------
// Synthetic fixtures — one per source
// ---------------------------------------------------------------------------

const HOMEBOX = `
HB.import_ref,HB.location,HB.labels,HB.quantity,HB.name,HB.description,HB.manufacturer,HB.model_number,HB.notes,HB.purchase_price,HB.serial_number,HB.warranty_expires
ref-1,Workshop,tools,3,Cordless Drill,18V drill,Acme Tools,AC-DRL-18,Kept on the top shelf,89.99,SN-0001,2027-01-01
ref-2,Garage,,1,Torque Wrench,,Bolt Co,BC-TW-200,,45.00,SN-0002,
`;

const GROCY = `
product,description,location,amount,quantity_unit,product_group,barcode,min_stock_amount,last_price
Olive Oil,Extra virgin,Pantry,4,bottle,Cooking,50000001,2,6.49
Kitchen Roll,,Cupboard,12,roll,Household,50000002,6,
`;

const SORTLY = `
Name,Notes,Quantity,Price,Tags,Serial Number,Barcode,Min Level,Item Type,Folder
Label Printer,Office device,1,120.00,office,LP-77,60000001,1,Item,Office
Sticky Notes,,40,2.50,,,60000002,10,Item,Supplies Cupboard
`;

const SNIPEIT = `
Asset Tag,Name,Serial,Model Number,Manufacturer,Category,Status,Location,Purchase Cost,Notes
GB-0001,Laptop 13",LT-SN-1,MB-13-M3,Fruit Computers,Laptops,Deployed,Desk 4,1299.00,Assigned to reception
GB-0002,Monitor 27",MN-SN-9,MON-27-4K,PixelWorks,Monitors,Ready,Storeroom,299.00,
`;

const INVENTREE = `
IPN,Name,Description,Category,In Stock,Minimum Stock,Default Location,Keywords,Notes
R-0402-10K,10k Resistor,0402 1% resistor,Passives/Resistors,5000,1000,Reel Store,smd resistor,Reel A3
C-0603-100N,100nF Capacitor,0603 X7R,Passives/Capacitors,3000,500,Reel Store,,
`;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('detectMigrationSource', () => {
  it.each([
    ['homebox', HOMEBOX],
    ['grocy', GROCY],
    ['sortly', SORTLY],
    ['snipeit', SNIPEIT],
    ['inventree', INVENTREE],
  ] as const)('recognises a %s export from its headers', (id, fixture) => {
    expect(detectMigrationSource(rows(fixture).header)).toBe(id);
  });

  it('returns null for a generic spreadsheet header', () => {
    expect(detectMigrationSource(['Name', 'Quantity', 'SKU'])).toBeNull();
  });

  it('returns null for an empty header', () => {
    expect(detectMigrationSource([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Homebox
// ---------------------------------------------------------------------------

describe('Homebox mapper', () => {
  it('maps core fields and folds the rest into provenance notes', () => {
    const { header, data } = rows(HOMEBOX);
    const plan = planFor('homebox', header, data);
    expect(plan.errors).toEqual([]);
    expect(plan.create).toHaveLength(2);

    const drill = plan.create[0]!.input;
    expect(drill.name).toBe('Cordless Drill');
    expect(drill.description).toBe('18V drill');
    expect(drill.quantity).toBe(3);
    expect(drill.locationId).toBe('Workshop'); // resolved to an id later; passed through here
    expect(drill.manufacturer).toBe('Acme Tools');
    expect(drill.mpn).toBe('AC-DRL-18');
    expect(drill.unitCost).toBe(89.99);
    // Native notes preserved, then a provenance block for the unmapped columns.
    expect(drill.notes).toContain('Kept on the top shelf');
    expect(drill.notes).toContain('Imported from Homebox:');
    expect(drill.notes).toContain('HB.serial_number: SN-0001');
    expect(drill.notes).toContain('HB.warranty_expires: 2027-01-01');
    // The import_ref / labels columns are folded, never mapped to a real field.
    expect(drill.notes).toContain('HB.import_ref: ref-1');
  });

  it('omits empty folded columns and the provenance block when there is nothing extra', () => {
    const { header, data } = rows(HOMEBOX);
    const wrench = planFor('homebox', header, data).create[1]!.input;
    expect(wrench.name).toBe('Torque Wrench');
    // Row 2 has no native notes and no warranty/serial values beyond ref → no blank labels.
    expect(wrench.notes).not.toContain('HB.warranty_expires:');
    expect(wrench.notes).toContain('HB.import_ref: ref-2');
  });
});

// ---------------------------------------------------------------------------
// Grocy
// ---------------------------------------------------------------------------

describe('Grocy mapper', () => {
  it('maps name/qty/location/price/reorder and the barcode as the identifier', () => {
    const { header, data } = rows(GROCY);
    const plan = planFor('grocy', header, data);
    expect(plan.errors).toEqual([]);
    const oil = plan.create[0]!.input;
    expect(oil.name).toBe('Olive Oil');
    expect(oil.quantity).toBe(4);
    expect(oil.locationId).toBe('Pantry');
    expect(oil.mpn).toBe('50000001'); // barcode → identifier slot
    expect(oil.reorderPoint).toBe(2);
    expect(oil.unitCost).toBe(6.49);
    // The product group (a category *name*, no id) is folded, not mis-mapped to categoryId.
    expect(oil.categoryId).toBeNull();
    expect(oil.notes).toContain('product_group: Cooking');
    expect(oil.notes).toContain('quantity_unit: bottle');
  });
});

// ---------------------------------------------------------------------------
// Sortly
// ---------------------------------------------------------------------------

describe('Sortly mapper', () => {
  it('maps entry name/notes/qty/price/barcode/min-level/folder', () => {
    const { header, data } = rows(SORTLY);
    const printer = planFor('sortly', header, data).create[0]!.input;
    expect(printer.name).toBe('Label Printer');
    expect(printer.notes).toContain('Office device');
    expect(printer.quantity).toBe(1);
    expect(printer.unitCost).toBe(120);
    expect(printer.mpn).toBe('60000001');
    expect(printer.reorderPoint).toBe(1);
    expect(printer.locationId).toBe('Office');
    // Tags / serial / item type folded.
    expect(printer.notes).toContain('Tags: office');
    expect(printer.notes).toContain('Serial Number: LP-77');
  });
});

// ---------------------------------------------------------------------------
// Snipe-IT (asset-like: synthesised quantity of 1)
// ---------------------------------------------------------------------------

describe('Snipe-IT mapper', () => {
  it('synthesises a quantity of 1 for each asset and folds the asset tag / serial', () => {
    const { header, data } = rows(SNIPEIT);
    const plan = planFor('snipeit', header, data);
    expect(plan.errors).toEqual([]);
    const laptop = plan.create[0]!.input;
    expect(laptop.name).toBe('Laptop 13"');
    expect(laptop.quantity).toBe(1); // synthesised — no source quantity column
    expect(laptop.mpn).toBe('MB-13-M3');
    expect(laptop.manufacturer).toBe('Fruit Computers');
    expect(laptop.locationId).toBe('Desk 4');
    expect(laptop.unitCost).toBe(1299);
    expect(laptop.notes).toContain('Assigned to reception');
    expect(laptop.notes).toContain('Asset Tag: GB-0001');
    expect(laptop.notes).toContain('Serial: LT-SN-1');
    // Category name folded, never mapped to categoryId.
    expect(laptop.notes).toContain('Category: Laptops');
    expect(laptop.categoryId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// InvenTree
// ---------------------------------------------------------------------------

describe('InvenTree mapper', () => {
  it('maps IPN as the identifier, stock as quantity, minimum stock as reorder point', () => {
    const { header, data } = rows(INVENTREE);
    const resistor = planFor('inventree', header, data).create[0]!.input;
    expect(resistor.name).toBe('10k Resistor');
    expect(resistor.description).toBe('0402 1% resistor');
    expect(resistor.mpn).toBe('R-0402-10K');
    expect(resistor.quantity).toBe(5000);
    expect(resistor.reorderPoint).toBe(1000);
    expect(resistor.locationId).toBe('Reel Store');
    expect(resistor.notes).toContain('Reel A3'); // native notes preserved
    expect(resistor.notes).toContain('Category: Passives/Resistors');
    expect(resistor.notes).toContain('Keywords: smd resistor');
  });
});

// ---------------------------------------------------------------------------
// mapMigration structure + edge cases
// ---------------------------------------------------------------------------

describe('mapMigration', () => {
  it('claims each target field once (first matching column wins)', () => {
    // Two columns both mapping to name; only the first is used, the second is folded.
    const out = mapMigration('inventree', ['IPN', 'Name', 'name'], [['X-1', 'First', 'Second']]);
    const plan = buildImportPlanFromRows(out.headerRow, out.dataRows, out.mapping, []);
    expect(plan.create[0]!.input.name).toBe('First');
    expect(plan.create[0]!.input.notes).toContain('name: Second');
  });

  it('always produces a single trailing notes column', () => {
    const out = mapMigration('grocy', rows(GROCY).header, rows(GROCY).data);
    expect(out.mapping.filter((m) => m === 'notes')).toHaveLength(1);
    expect(out.mapping[out.mapping.length - 1]).toBe('notes');
  });

  it('returns rows unchanged for an unknown source id', () => {
    const out = mapMigration('nope' as MigrationSourceId, ['A'], [['1']]);
    expect(out.headerRow).toEqual(['A']);
    expect(out.dataRows).toEqual([['1']]);
    expect(out.mapping).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyMigration bridge (extraction in → reshaped extraction out)
// ---------------------------------------------------------------------------

describe('applyMigration', () => {
  it('reshapes a parsed CSV extraction end-to-end', () => {
    const extraction = extractImport(HOMEBOX.trim());
    expect(extraction.isTabular).toBe(true);
    const migrated = applyMigration(extraction, 'homebox');
    expect(migrated.mapping).toContain('name');
    expect(migrated.mapping[migrated.mapping.length - 1]).toBe('notes');
    const plan = buildImportPlanFromRows(migrated.headerRow, migrated.dataRows, migrated.mapping, []);
    expect(plan.create[0]!.input.name).toBe('Cordless Drill');
  });

  it('is a no-op for a free-form line list (no source columns)', () => {
    const extraction = extractImport('Widget x5\nGadget x2');
    expect(extraction.isTabular).toBe(false);
    expect(applyMigration(extraction, 'homebox')).toBe(extraction);
  });
});

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------

describe('source registry', () => {
  it('exposes a label for every id', () => {
    for (const id of MIGRATION_SOURCE_IDS) {
      expect(MIGRATION_SOURCE_LABELS[id]).toBeTruthy();
    }
  });
});
