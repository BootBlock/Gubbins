/**
 * Unit tests for the catalog CSV importer (Phase 67).
 *
 * All tests run against pure logic — no DB, no React, no worker. The `:memory:`
 * apply tests at the bottom inject a minimal stub that matches the repository's
 * public interface.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { CategoryRepository } from '@/db/repositories/CategoryRepository';
import { TagRepository } from '@/db/repositories/TagRepository';
import { ADMIN_USER_ID, UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';
import type { CategoryField, Item } from '@/db/repositories/types';
import {
  inferColumnMapping,
  isCustomFieldTarget,
  buildCatalogImportPlan,
  applyCatalogImportPlan,
  normaliseTrackingMode,
  parseExpiryCell,
  parseNumericCell,
  parseNumericCountCell,
  parseTagsCell,
  type CatalogItemRepository,
  type ColumnMapping,
} from './catalog-import';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal Item stub for existing-item lists (only fields the importer reads). */
function stubItem(id: string, name: string, mpn: string | null = null): Item {
  return {
    id,
    name,
    mpn,
    description: null,
    locationId: UNASSIGNED_LOCATION_ID,
    categoryId: null,
    trackingMode: 'DISCRETE',
    quantity: 0,
    serialNo: null,
    manufacturer: null,
    unitCost: null,
    expiryDate: null,
    batchNumber: null,
    lotNumber: null,
    condition: null,
    parentId: null,
    reorderPoint: null,
    reorderGaugePercent: null,
    reorderQty: null,
    isUnlimited: false,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    gauge: null,
    operationalMetadata: null,
  };
}

/** A minimal CategoryField definition stub for Phase-72 custom-field tests. */
function stubField(id: string, name: string, partial: Partial<CategoryField> = {}): CategoryField {
  return {
    id,
    categoryId: 'cat-1',
    name,
    fieldType: 'TEXT',
    options: null,
    isRequired: false,
    defaultValue: null,
    unit: null,
    minValue: null,
    maxValue: null,
    position: 0,
    updatedAt: 0,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// inferColumnMapping
// ---------------------------------------------------------------------------

describe('inferColumnMapping', () => {
  it('maps well-known exact header names', () => {
    const mapping = inferColumnMapping(['name', 'quantity', 'description']);
    expect(mapping).toEqual(['name', 'quantity', 'description']);
  });

  it('maps synonym headers case-insensitively', () => {
    const mapping = inferColumnMapping(['Item Name', 'Qty', 'MPN', 'Cost']);
    expect(mapping[0]).toBe('name');
    expect(mapping[1]).toBe('quantity');
    expect(mapping[2]).toBe('sku');
    expect(mapping[3]).toBe('unitCost');
  });

  it('maps unknown headers to null', () => {
    const mapping = inferColumnMapping(['frumble', 'zorp', 'name']);
    expect(mapping[0]).toBe(null);
    expect(mapping[1]).toBe(null);
    expect(mapping[2]).toBe('name');
  });

  it('assigns each logical field at most once (first header wins)', () => {
    // Two columns that both map to 'name' — first wins, second becomes null.
    const mapping = inferColumnMapping(['name', 'itemname']);
    expect(mapping[0]).toBe('name');
    expect(mapping[1]).toBe(null);
  });

  it('handles an empty header row', () => {
    expect(inferColumnMapping([])).toEqual([]);
  });

  it('handles headers with mixed punctuation / whitespace', () => {
    const mapping = inferColumnMapping(['Unit Cost', 'Batch Number', 'Lot Number']);
    expect(mapping[0]).toBe('unitCost');
    expect(mapping[1]).toBe('batchNumber');
    expect(mapping[2]).toBe('lotNumber');
  });
});

// ---------------------------------------------------------------------------
// buildCatalogImportPlan — empty / trivial inputs
// ---------------------------------------------------------------------------

describe('buildCatalogImportPlan — empty inputs', () => {
  it('returns an empty plan for an empty string', () => {
    const plan = buildCatalogImportPlan('', null, []);
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
    expect(plan.errors).toHaveLength(0);
  });

  it('returns an empty plan for a header-only CSV (no data rows)', () => {
    const plan = buildCatalogImportPlan('name,quantity\r\n', null, []);
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
    expect(plan.errors).toHaveLength(0);
  });

  it('returns an empty plan for a file of blank lines', () => {
    const plan = buildCatalogImportPlan('\r\n\r\n\r\n', null, []);
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
    expect(plan.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildCatalogImportPlan — create path
// ---------------------------------------------------------------------------

describe('buildCatalogImportPlan — create path', () => {
  it('creates an item when no existing items match by name', () => {
    const csv = 'name,quantity\r\nWidget A,10\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toHaveLength(1);
    expect(plan.update).toHaveLength(0);
    expect(plan.errors).toHaveLength(0);
    expect(plan.create[0]!.input.name).toBe('Widget A');
    expect(plan.create[0]!.input.quantity).toBe(10);
  });

  it('sets the default location when locationId is absent', () => {
    const csv = 'name\r\nGadget\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create[0]!.input.locationId).toBe(UNASSIGNED_LOCATION_ID);
  });

  it('coerces the quantity from a string', () => {
    const csv = 'name,quantity\r\nCap,42\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create[0]!.input.quantity).toBe(42);
  });

  it('coerces unitCost from a decimal string', () => {
    const csv = 'name,unitCost\r\nResistor,0.05\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create[0]!.input.unitCost).toBe(0.05);
  });

  it('maps sku column to mpn on CreateItemInput', () => {
    const csv = 'name,sku\r\nDiode,1N4148\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create[0]!.input.mpn).toBe('1N4148');
  });

  it('creates multiple items', () => {
    const csv = 'name,quantity\r\nAlpha,1\r\nBeta,2\r\nGamma,3\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toHaveLength(3);
    expect(plan.errors).toHaveLength(0);
  });

  it('defaults trackingMode to DISCRETE when not supplied', () => {
    const csv = 'name\r\nDoohickey\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create[0]!.input.trackingMode).toBe('DISCRETE');
  });
});

// ---------------------------------------------------------------------------
// buildCatalogImportPlan — update path (match by name)
// ---------------------------------------------------------------------------

describe('buildCatalogImportPlan — update path (match by name)', () => {
  const existingItems = [stubItem('item-1', 'Widget A'), stubItem('item-2', 'Widget B')];

  it('produces an update when an existing item name matches', () => {
    const csv = 'name,unitCost\r\nWidget A,1.50\r\n';
    const plan = buildCatalogImportPlan(csv, null, existingItems);
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]!.itemId).toBe('item-1');
    expect(plan.update[0]!.input.unitCost).toBe(1.5);
  });

  it('mixes creates and updates in the same CSV', () => {
    const csv = 'name,quantity\r\nWidget A,5\r\nNew Item,99\r\n';
    const plan = buildCatalogImportPlan(csv, null, existingItems);
    expect(plan.create).toHaveLength(1);
    expect(plan.update).toHaveLength(1);
    expect(plan.create[0]!.input.name).toBe('New Item');
    expect(plan.update[0]!.itemId).toBe('item-1');
  });

  it('does not include quantity in UpdateItemInput (quantity changes are a separate mutation)', () => {
    const csv = 'name,quantity,unitCost\r\nWidget A,50,2.00\r\n';
    const plan = buildCatalogImportPlan(csv, null, existingItems);
    // quantity is not a field on UpdateItemInput, so it must not appear
    const upd = plan.update[0]!.input;
    expect('quantity' in upd).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildCatalogImportPlan — update path (match by SKU/MPN)
// ---------------------------------------------------------------------------

describe('buildCatalogImportPlan — update path (match by sku)', () => {
  const existingItems = [
    stubItem('item-1', 'NPN Transistor', 'BC547'),
    stubItem('item-2', 'Op-amp', 'LM358'),
  ];

  it('matches an existing item by SKU/MPN', () => {
    const csv = 'sku,manufacturer\r\nBC547,Fairchild\r\n';
    const plan = buildCatalogImportPlan(csv, null, existingItems, { matchKey: 'sku' });
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]!.itemId).toBe('item-1');
    expect(plan.update[0]!.input.manufacturer).toBe('Fairchild');
  });

  it('creates when SKU does not match any existing item (and name is present)', () => {
    const csv = 'name,sku\r\nNew Transistor,2N3904\r\n';
    const plan = buildCatalogImportPlan(csv, null, existingItems, { matchKey: 'sku' });
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]!.input.name).toBe('New Transistor');
    expect(plan.create[0]!.input.mpn).toBe('2N3904');
  });
});

// ---------------------------------------------------------------------------
// buildCatalogImportPlan — error collection
// ---------------------------------------------------------------------------

describe('buildCatalogImportPlan — error collection', () => {
  it('reports an unclosed quote instead of silently dropping the merged rows (issue #591)', () => {
    const csv = ['name,quantity', 'Widget,2', '"Bad part,3', 'Gadget,4'].join('\r\n');
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toHaveLength(0);
    expect(plan.errors).toEqual([{ sourceRow: 0, message: expect.stringContaining('never closed') }]);
  });

  it('keeps an inch mark in a name rather than swallowing the rest of the file (issue #591)', () => {
    const csv = ['name,quantity', '3/4" ball valve,5', 'Widget,2'].join('\r\n');
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create.map((c) => c.input.name)).toEqual(['3/4" ball valve', 'Widget']);
  });

  it('collects a validation error for a row with a negative quantity', () => {
    const csv = 'name,quantity\r\nBad Item,-5\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.sourceRow).toBe(1);
    expect(plan.errors[0]!.message).toMatch(/negative/i);
    expect(plan.create).toHaveLength(0);
  });

  it('collects an error for a row with an invalid tracking mode', () => {
    const csv = 'name,trackingMode\r\nMyItem,NOT_A_MODE\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toHaveLength(1);
    expect(plan.create).toHaveLength(0);
  });

  it('collects an error for an intra-CSV duplicate match key', () => {
    const csv = 'name,quantity\r\nDuplicate,1\r\nDuplicate,2\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    // First occurrence → create; second → error.
    expect(plan.create).toHaveLength(1);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.sourceRow).toBe(2);
    expect(plan.errors[0]!.message).toMatch(/duplicate/i);
  });

  it('collects an error for a row with no name and no SKU (by-name matching)', () => {
    const csv = 'name,quantity\r\n,5\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.message).toMatch(/name/i);
  });

  it('does not throw — errors accumulate alongside valid rows', () => {
    const csv = 'name,quantity\r\nGood Item,10\r\nBad Item,-99\r\nAnother Good,3\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toHaveLength(2);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.sourceRow).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildCatalogImportPlan — explicit column mapping
// ---------------------------------------------------------------------------

describe('buildCatalogImportPlan — explicit column mapping', () => {
  it('respects a caller-supplied mapping', () => {
    // CSV: col 0 = description (ignored?), col 1 = name, col 2 = quantity
    const explicitMapping: ColumnMapping = [null, 'name', 'quantity'];
    const csv = 'ignore,item_name,item_qty\r\nfoo,My Part,7\r\n';
    const plan = buildCatalogImportPlan(csv, explicitMapping, []);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]!.input.name).toBe('My Part');
    expect(plan.create[0]!.input.quantity).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// buildCatalogImportPlan — type coercion
// ---------------------------------------------------------------------------

describe('buildCatalogImportPlan — type coercion', () => {
  it('coerces reorderPoint and reorderQty from strings', () => {
    const csv = 'name,reorderPoint,reorderQty\r\nItem,5,20\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create[0]!.input.reorderPoint).toBe(5);
    expect(plan.create[0]!.input.reorderQty).toBe(20);
  });

  it('leaves unitCost as null when the cell is empty', () => {
    const csv = 'name,unitCost\r\nNoCost,\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create[0]!.input.unitCost).toBeNull();
  });

  it('passes a valid condition through', () => {
    const csv = 'name,condition\r\nOld Scope,NEEDS_REPAIR\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create[0]!.input.condition).toBe('NEEDS_REPAIR');
  });
});

// ---------------------------------------------------------------------------
// buildCatalogImportPlan — RFC-4180 quoted fields
// ---------------------------------------------------------------------------

describe('buildCatalogImportPlan — RFC-4180 quoted fields', () => {
  it('handles quoted names containing commas', () => {
    const csv = 'name,quantity\r\n"Bolt, M3x8",100\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]!.input.name).toBe('Bolt, M3x8');
  });

  it('handles doubled-quote escapes inside quoted fields', () => {
    const csv = 'name\r\n"It\'s a ""test"""\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create[0]!.input.name).toBe('It\'s a "test"');
  });
});

// ---------------------------------------------------------------------------
// applyCatalogImportPlan — :memory: DB integration tests
// ---------------------------------------------------------------------------

describe('applyCatalogImportPlan — :memory: DB', () => {
  let driver: MemoryDriver;
  let repo: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    repo = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('creates items from a valid plan', async () => {
    const csv = 'name,quantity,unitCost\r\nResistor 10k,500,0.02\r\nCapacitor 100nF,200,0.05\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    const result = await applyCatalogImportPlan(plan, repo);

    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);

    const page = await repo.list({ limit: 10 });
    expect(page.rows).toHaveLength(2);
    const names = page.rows.map((r) => r.name).sort();
    expect(names).toEqual(['Capacitor 100nF', 'Resistor 10k']);
  });

  it('updates matched items', async () => {
    const existing = await repo.create({ name: 'LED Red', quantity: 50, unitCost: 0.1 });
    const csv = 'name,unitCost\r\nLED Red,0.08\r\n';
    const plan = buildCatalogImportPlan(csv, null, [existing]);
    const result = await applyCatalogImportPlan(plan, repo);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    const updated = await repo.getById(existing.id);
    expect(updated?.unitCost).toBe(0.08);
  });

  it('creates only valid rows when the plan contains errors', async () => {
    // plan.errors items are NOT applied — only plan.create / plan.update are.
    const csv = 'name,quantity\r\nGood Part,10\r\nBad Part,-1\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toHaveLength(1);

    const result = await applyCatalogImportPlan(plan, repo);
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);

    const page = await repo.list({ limit: 10 });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.name).toBe('Good Part');
  });

  it('honours the Hard Stop (WRITE_SUSPENDED)', async () => {
    // Create a locked repository instance.
    let locked = false;
    const lockedRepo = new ItemRepository(driver, { isWriteSuspended: () => locked });

    const csv = 'name,quantity\r\nFuse,10\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);

    locked = true;
    const result = await applyCatalogImportPlan(plan, lockedRepo);

    // The row is skipped, not thrown.
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.rows[0]!.error).toMatch(/suspended/i);
  });

  // Issue #683 — a gauge's stock is valued from its cost per unit of measure, so a catalogue
  // that round-trips without the column comes back unpriced and the inventory total drops by
  // every consumable's contents. `Unit cost` cannot stand in: it prices one countable unit.
  it('carries a gauge’s cost per unit of measure through an import', async () => {
    const csv =
      'name,Type,unitOfMeasure,grossCapacity,currentNetValue,costPerUnitOfMeasure\r\n' +
      'PLA filament,Consumable,g,1000,400,0.025\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    const result = await applyCatalogImportPlan(plan, repo);

    expect(result.created).toBe(1);
    const page = await repo.list({ limit: 10 });
    expect(page.rows[0]!.gauge).toMatchObject({ currentNetValue: 400, costPerUnitOfMeasure: 0.025 });
  });

  it('leaves a gauge unpriced when the cost column is absent, rather than worth nothing', async () => {
    const csv = 'name,Type,unitOfMeasure,grossCapacity\r\nResin,Consumable,ml,500\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    await applyCatalogImportPlan(plan, repo);

    const page = await repo.list({ limit: 10 });
    expect(page.rows[0]!.gauge?.costPerUnitOfMeasure).toBeNull();
  });

  it('creates a gauge-tracked item with its configuration intact (issue #341)', async () => {
    const csv =
      'name,Type,unitOfMeasure,grossCapacity,tareWeight,currentNetValue\r\nPLA filament,Consumable,g,1000,200,750\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    const result = await applyCatalogImportPlan(plan, repo);

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    const page = await repo.list({ limit: 10 });
    expect(page.rows[0]!.trackingMode).toBe('CONSUMABLE_GAUGE');
    expect(page.rows[0]!.gauge).toMatchObject({
      unitOfMeasure: 'g',
      grossCapacity: 1000,
      tareWeight: 200,
      currentNetValue: 750,
      percentageRemaining: 75,
    });
  });

  it('imports the rest of the batch when one gauge row is unusable (issue #341)', async () => {
    // The unusable row is now caught by the dry-run, so it never reaches the one atomic bulk
    // create that it used to abort — the other rows land instead of the import writing nothing.
    const csv =
      'name,Type\r\nResistor 10k,Bulk\r\nMystery goo,Consumable\r\nCapacitor 100nF,Bulk\r\nLED Red,Bulk\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    const result = await applyCatalogImportPlan(plan, repo);

    expect(result.created).toBe(3);
    expect(result.skipped).toBe(0);
    const page = await repo.list({ limit: 10 });
    expect(page.rows.map((r) => r.name).sort()).toEqual(['Capacitor 100nF', 'LED Red', 'Resistor 10k']);
  });

  it('applies a mixed creates-and-updates plan', async () => {
    const existing = await repo.create({ name: 'Op-amp LM358', quantity: 30 });
    const csv = 'name,quantity\r\nOp-amp LM358,30\r\nNew Relay,25\r\n';
    const plan = buildCatalogImportPlan(csv, null, [existing]);

    expect(plan.create).toHaveLength(1);
    expect(plan.update).toHaveLength(1);

    const result = await applyCatalogImportPlan(plan, repo);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyCatalogImportPlan — stub-based unit tests (no DB needed)
// ---------------------------------------------------------------------------

describe('applyCatalogImportPlan — stub repository', () => {
  it('returns skipped when a create throws', async () => {
    const csv = 'name\r\nFailing Item\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);

    const stub: CatalogItemRepository = {
      create: async () => {
        throw new Error('Simulated create failure');
      },
      update: async () => {
        throw new Error('Should not be called');
      },
    };

    const result = await applyCatalogImportPlan(plan, stub);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.rows[0]!.error).toMatch(/simulated/i);
  });
});

// ---------------------------------------------------------------------------
// applyCatalogImportPlan — bulk fast path (createMany)
// ---------------------------------------------------------------------------

describe('applyCatalogImportPlan — bulk create fast path', () => {
  it('creates the whole partition in a single createMany call', async () => {
    const csv = 'name,quantity\r\nA,1\r\nB,2\r\nC,3\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    const batchSizes: number[] = [];
    let n = 0;

    const stub: CatalogItemRepository = {
      create: async () => {
        throw new Error('per-row create must not be used when createMany exists');
      },
      update: async () => {
        throw new Error('no updates');
      },
      createMany: async (inputs) => {
        batchSizes.push(inputs.length);
        return inputs.map((input) => stubItem(`gen-${n++}`, input.name));
      },
    };

    const result = await applyCatalogImportPlan(plan, stub);
    expect(batchSizes).toEqual([3]); // one commit for all three rows
    expect(result.created).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it('skips every create row when the atomic batch throws', async () => {
    const csv = 'name\r\nX\r\nY\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);

    const stub: CatalogItemRepository = {
      create: async () => {
        throw new Error('unused');
      },
      update: async () => {
        throw new Error('unused');
      },
      createMany: async () => {
        throw new Error('WRITE_SUSPENDED: writes are suspended');
      },
    };

    const result = await applyCatalogImportPlan(plan, stub);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.rows.every((r) => /suspended/i.test(r.error ?? ''))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tracking-mode normalisation + location / tracking plan options
// ---------------------------------------------------------------------------

describe('normaliseTrackingMode', () => {
  it('accepts enum values and UI labels, case-insensitively', () => {
    expect(normaliseTrackingMode('SERIALISED')).toBe('SERIALISED');
    expect(normaliseTrackingMode('serialised')).toBe('SERIALISED');
    expect(normaliseTrackingMode('Bulk')).toBe('DISCRETE');
    expect(normaliseTrackingMode('discrete')).toBe('DISCRETE');
    expect(normaliseTrackingMode('Consumable')).toBe('CONSUMABLE_GAUGE');
    expect(normaliseTrackingMode('Untracked')).toBe('UNTRACKED');
  });

  it('returns null for an unrecognised value', () => {
    expect(normaliseTrackingMode('nonsense')).toBeNull();
  });
});

describe('buildCatalogImportPlan — location & tracking options', () => {
  it('resolves a location name to its id and applies a default tracking mode', () => {
    const csv = 'name,location\r\nWidget,Workshop\r\n';
    const plan = buildCatalogImportPlan(csv, null, [], {
      locations: [{ id: 'loc-1', name: 'Workshop' }],
      defaultTrackingMode: 'SERIALISED',
    });
    expect(plan.errors).toHaveLength(0);
    expect(plan.create[0]!.input.locationId).toBe('loc-1');
    expect(plan.create[0]!.input.trackingMode).toBe('SERIALISED');
  });

  it('applies the default location to a row without one', () => {
    const csv = 'name\r\nWidget\r\n';
    const plan = buildCatalogImportPlan(csv, null, [], { defaultLocationId: 'loc-9' });
    expect(plan.create[0]!.input.locationId).toBe('loc-9');
  });

  it('flags an unknown location name as a row error', () => {
    const csv = 'name,location\r\nWidget,Nowhere\r\n';
    const plan = buildCatalogImportPlan(csv, null, [], {
      locations: [{ id: 'loc-1', name: 'Workshop' }],
    });
    expect(plan.create).toHaveLength(0);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.message).toMatch(/Unknown location/);
  });
});

// ---------------------------------------------------------------------------
// Phase 72 — custom-field column mapping & coercion (pure)
// ---------------------------------------------------------------------------

describe('inferColumnMapping — custom fields', () => {
  it('resolves a header to a custom-field target by normalised name', () => {
    const fields = [stubField('f-res', 'Resistance', { fieldType: 'NUMBER' })];
    const mapping = inferColumnMapping(['name', 'Resistance'], fields);
    expect(mapping[0]).toBe('name');
    expect(mapping[1]).toEqual({ fieldId: 'f-res' });
    expect(isCustomFieldTarget(mapping[1] ?? null)).toBe(true);
  });

  it('resolves a header to a custom-field target by raw field id', () => {
    const fields = [stubField('00000000-aaaa', 'Tolerance')];
    const mapping = inferColumnMapping(['00000000-aaaa'], fields);
    expect(mapping[0]).toEqual({ fieldId: '00000000-aaaa' });
  });

  it('prefers a core synonym over a same-named custom field', () => {
    const fields = [stubField('f-name', 'Name')];
    const mapping = inferColumnMapping(['name'], fields);
    expect(mapping[0]).toBe('name');
  });

  it('assigns each custom field at most once (first header wins)', () => {
    const fields = [stubField('f-res', 'Resistance')];
    const mapping = inferColumnMapping(['Resistance', 'resistance'], fields);
    expect(mapping[0]).toEqual({ fieldId: 'f-res' });
    expect(mapping[1]).toBe(null);
  });
});

describe('buildCatalogImportPlan — custom-field columns', () => {
  it('coerces a valid custom-field value onto the create entry', () => {
    const fields = [stubField('f-res', 'Resistance', { fieldType: 'NUMBER' })];
    const csv = 'name,Resistance\r\nResistor,1.50\r\n';
    const plan = buildCatalogImportPlan(csv, null, [], { customFields: fields });
    expect(plan.errors).toHaveLength(0);
    expect(plan.create).toHaveLength(1);
    // NUMBER canonical coercion: '1.50' → '1.5' (Phase-70 seam).
    expect(plan.create[0]!.fieldValues).toEqual({ 'f-res': '1.5' });
  });

  it('carries custom-field values onto an update entry', () => {
    const fields = [stubField('f-grade', 'Grade', { fieldType: 'SELECT', options: ['A', 'B'] })];
    const existing = stubItem('item-1', 'Widget');
    const csv = 'name,Grade\r\nWidget,A\r\n';
    const plan = buildCatalogImportPlan(csv, null, [existing], { customFields: fields });
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]!.fieldValues).toEqual({ 'f-grade': 'A' });
  });

  it('COLLECTS an invalid custom-field value as a row error (never throws)', () => {
    const fields = [stubField('f-res', 'Resistance', { fieldType: 'NUMBER' })];
    const csv = 'name,Resistance\r\nResistor,not-a-number\r\n';
    const plan = buildCatalogImportPlan(csv, null, [], { customFields: fields });
    expect(plan.create).toHaveLength(0);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.message).toMatch(/must be a number/i);
  });

  it('enforces a required custom field (blank → error)', () => {
    const fields = [stubField('f-req', 'Serial', { isRequired: true })];
    const csv = 'name,Serial\r\nGadget,\r\n';
    const plan = buildCatalogImportPlan(csv, null, [], { customFields: fields });
    expect(plan.create).toHaveLength(0);
    expect(plan.errors[0]!.message).toMatch(/required/i);
  });

  it('clears a field when a non-required column is blank (value → null)', () => {
    const fields = [stubField('f-note', 'Note')];
    const csv = 'name,Note\r\nGadget,\r\n';
    const plan = buildCatalogImportPlan(csv, null, [], { customFields: fields });
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]!.fieldValues).toEqual({ 'f-note': null });
  });

  it('reports an unknown custom-field target (mapping id not in defs)', () => {
    const csv = 'name,Resistance\r\nResistor,10\r\n';
    const mapping: ColumnMapping = ['name', { fieldId: 'missing' }];
    const plan = buildCatalogImportPlan(csv, mapping, [], { customFields: [] });
    expect(plan.create).toHaveLength(0);
    expect(plan.errors[0]!.message).toMatch(/unknown custom field/i);
  });

  it('leaves entries free of fieldValues when no custom columns are mapped', () => {
    const csv = 'name,quantity\r\nPlain,5\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create[0]!.fieldValues).toBeUndefined();
  });

  it('silently skips an IMAGE column instead of erroring the row (issue #453)', () => {
    const fields = [stubField('f-cov', 'Cover art', { fieldType: 'IMAGE' })];
    // A round-tripped export carries the "[image]" marker, not a real image.
    const csv = 'name,Cover art\r\nFilm,[image]\r\n';
    const plan = buildCatalogImportPlan(csv, null, [], { customFields: fields });
    expect(plan.errors).toHaveLength(0);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]!.fieldValues).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 72 — :memory: apply persists custom fields via setItemFieldValues
// ---------------------------------------------------------------------------

describe('applyCatalogImportPlan — custom fields land on the item (:memory:)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let categories: CategoryRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    categories = new CategoryRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('persists an imported custom-field value through setItemFieldValues', async () => {
    const cat = await categories.create({ name: 'Resistors' });
    const field = await categories.addField(cat.id, { name: 'Resistance', fieldType: 'NUMBER' });

    // The CSV creates an item in this category and sets the custom field.
    const csv = `name,categoryId,Resistance\r\nResistor 10k,${cat.id},10000\r\n`;
    const defs = await categories.listFields(cat.id);
    const plan = buildCatalogImportPlan(csv, null, [], { customFields: defs });
    expect(plan.create).toHaveLength(1);

    const result = await applyCatalogImportPlan(plan, items, categories);
    expect(result.created).toBe(1);
    expect(result.rows[0]!.error).toBeUndefined();

    // The value landed on the item via the existing read path.
    const page = await items.list({ limit: 10 });
    const created = page.rows.find((r) => r.name === 'Resistor 10k')!;
    const resolved = await categories.resolveItemFields(created.id);
    const stored = resolved.find((f) => f.id === field.id)!;
    expect(stored.hasStoredValue).toBe(true);
    expect(stored.value).toBe('10000');
  });

  it('records a custom-field write error without failing the item create', async () => {
    // Field belongs to category A, but the item is created with NO category, so
    // setItemFieldValues rejects the field — the item still imports.
    const catA = await categories.create({ name: 'A' });
    const field = await categories.addField(catA.id, { name: 'Spec', fieldType: 'TEXT' });

    const csv = `name,Spec\r\nLoose Part,hello\r\n`;
    const plan = buildCatalogImportPlan(csv, null, [], { customFields: [field] });
    const result = await applyCatalogImportPlan(plan, items, categories);

    expect(result.created).toBe(1);
    expect(result.rows[0]!.error).toMatch(/category/i);
  });
});

describe('buildCatalogImportPlan — serialised quantity (issue #348)', () => {
  it('rejects a serialised row whose quantity is not 1 instead of silently coercing it', () => {
    const csv = 'name,trackingMode,quantity\r\nTorque wrench,SERIALISED,5';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toHaveLength(0);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.message).toMatch(/quantity must be 1/i);
    expect(plan.errors[0]!.message).toContain('5');
  });

  it('accepts a serialised row with quantity 1, or with no quantity at all', () => {
    const csv = 'name,trackingMode,quantity\r\nTorque wrench,SERIALISED,1\r\nSocket set,SERIALISED,';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create).toHaveLength(2);
  });

  it('rejects a serialised quantity that comes from the batch default tracking mode', () => {
    const csv = 'name,quantity\r\nTorque wrench,5';
    const plan = buildCatalogImportPlan(csv, null, [], { defaultTrackingMode: 'SERIALISED' });
    expect(plan.create).toHaveLength(0);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.message).toMatch(/quantity must be 1/i);
  });

  it('leaves a non-serialised row with a quantity above 1 alone', () => {
    const csv = 'name,trackingMode,quantity\r\nM3 bolt,DISCRETE,500';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create[0]?.input.quantity).toBe(500);
  });
});

describe('buildCatalogImportPlan — Consumable-Gauge configuration (issue #341)', () => {
  /** A gauge-tracked existing item, for the update-side tests. */
  function stubGaugeItem(id: string, name: string): Item {
    return {
      ...stubItem(id, name),
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: {
        unitOfMeasure: 'g',
        grossCapacity: 1000,
        tareWeight: 200,
        currentNetValue: 750,
        percentageRemaining: 75,
        currentGrossWeight: 950,
      },
    };
  }

  it('creates a gauge item from its unit-of-measure and capacity columns', () => {
    const csv =
      'name,trackingMode,unitOfMeasure,grossCapacity,tareWeight,currentNetValue\r\nPLA filament,Consumable,g,1000,200,750';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]!.input.trackingMode).toBe('CONSUMABLE_GAUGE');
    expect(plan.create[0]!.input.gauge).toEqual({
      unitOfMeasure: 'g',
      grossCapacity: 1000,
      tareWeight: 200,
      currentNetValue: 750,
    });
  });

  it('leaves tare and net remaining to the repository defaults when their columns are absent', () => {
    const csv = 'name,tracking,unitOfMeasure,grossCapacity\r\nResin,gauge,ml,500';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create[0]!.input.gauge).toEqual({ unitOfMeasure: 'ml', grossCapacity: 500 });
  });

  it('reports a gauge row with no unit or capacity instead of letting it fail at apply time', () => {
    // The dry-run used to pass this row on as valid; `resolveCreate` then threw while the bulk
    // create was still building its statements, taking the whole batch with it.
    const csv = 'name,Type\r\nMystery goo,Consumable';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toEqual([]);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.message).toMatch(/unit of measure and a gross capacity/i);
  });

  it('rejects a gross capacity of zero (the DB requires one above zero)', () => {
    const csv = 'name,tracking,unitOfMeasure,grossCapacity\r\nEmpty tin,consumable,g,0';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toEqual([]);
    expect(plan.errors[0]!.message).toMatch(/above zero/i);
  });

  it('rejects a net remaining above the gross capacity (a gauge cannot be more than full)', () => {
    // Not covered by the DB CHECK, but every other gauge write path clamps to the capacity —
    // importing 9000 g into a 500 g spool would render as 1800% remaining.
    const csv = 'name,tracking,unitOfMeasure,grossCapacity,currentNetValue\r\nOverfull,gauge,g,500,9000';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toEqual([]);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.message).toMatch(/cannot be more than the gross capacity/i);
  });

  it('imports a row that is not a consumable even when a gauge column is mapped', () => {
    // "Unit of measure" is an everyday ERP column. Erroring on it would cost a whole file its
    // import for a column that was harmlessly ignored before the importer knew the name.
    const csv = 'name,trackingMode,unitOfMeasure,grossCapacity\r\nM3 bolt,DISCRETE,EA,1000';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]!.input.gauge).toBeUndefined();
  });

  it('does not report an unreadable gauge cell on a row that ignores it', () => {
    // A shipping sheet's "Tare weight: 12 kg" is not a number, but a bulk row never reads it —
    // reporting it would cost the row its import over a cell the importer discards.
    const csv = 'name,tareWeight,quantity\r\nM3 bolt,12 kg,40';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create[0]!.input.quantity).toBe(40);
  });

  it('still reports an unreadable gauge cell on a consumable row', () => {
    const csv = 'name,tracking,unitOfMeasure,grossCapacity\r\nResin,gauge,ml,half a litre';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toEqual([]);
    expect(plan.errors[0]!.message).toMatch(/Gross capacity: "half a litre" is not a number/i);
  });

  it('lets a custom field of the same name keep its column', () => {
    // Unlike every other core field, a gauge column yields: it is ignored on a non-gauge row,
    // so shadowing the custom field would silently discard the value.
    const field = stubField('f-uom', 'Unit of measure');
    expect(inferColumnMapping(['name', 'Unit of measure'], [field])).toEqual(['name', { fieldId: 'f-uom' }]);

    const csv = 'name,Unit of measure\r\nM3 bolt,EA';
    const plan = buildCatalogImportPlan(csv, null, [], { customFields: [field] });
    expect(plan.errors).toEqual([]);
    expect(plan.create[0]!.fieldValues).toEqual({ 'f-uom': 'EA' });
  });

  it('costs only its own row, leaving the rest of the batch importable', () => {
    const csv =
      'name,Type\r\nResistor 10k,Bulk\r\nMystery goo,Consumable\r\nCapacitor 100nF,Bulk\r\nLED Red,Bulk';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.sourceRow).toBe(2);
    expect(plan.create.map((c) => c.input.name)).toEqual(['Resistor 10k', 'Capacitor 100nF', 'LED Red']);
  });

  it('reports rows one by one when the batch default tracking mode is Consumable-Gauge', () => {
    const csv = 'name\r\nGoo A\r\nGoo B';
    const plan = buildCatalogImportPlan(csv, null, [], { defaultTrackingMode: 'CONSUMABLE_GAUGE' });
    expect(plan.create).toEqual([]);
    expect(plan.errors.map((e) => e.sourceRow)).toEqual([1, 2]);
  });

  it('round-trips the gauge headers the catalogue export writes, and the wizard’s own labels', () => {
    expect(inferColumnMapping(['unitOfMeasure', 'grossCapacity', 'tareWeight', 'currentNetValue'])).toEqual([
      'unitOfMeasure',
      'grossCapacity',
      'tareWeight',
      'currentNetValue',
    ]);
    expect(inferColumnMapping(['Unit of measure', 'Gross capacity', 'Tare weight', 'Net remaining'])).toEqual(
      ['unitOfMeasure', 'grossCapacity', 'tareWeight', 'currentNetValue'],
    );
  });

  it('leaves a loosely-named column unmapped rather than guessing it is gauge configuration', () => {
    // "UOM" in an ERP dump, a battery's "Capacity", an invoice's "Net value" mean other things;
    // only the exported headers and the wizard's own labels auto-map (the rest by hand).
    expect(inferColumnMapping(['uom', 'capacity', 'tare', 'net value'])).toEqual([null, null, null, null]);
  });

  it('updates an existing gauge item without touching its gauge configuration', () => {
    // The gauge is re-based from the item itself, never overwritten by an import — so an
    // exported catalogue still re-imports cleanly however its cells were re-parsed.
    const existing = stubGaugeItem('i1', 'PLA filament');
    const csv =
      'name,unitOfMeasure,grossCapacity,tareWeight,currentNetValue,unitCost\r\nPLA filament,g,1000,200,120,18.50';
    const plan = buildCatalogImportPlan(csv, null, [existing]);
    expect(plan.errors).toEqual([]);
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]!.input.unitCost).toBe(18.5);
    expect(plan.update[0]!.input).not.toHaveProperty('gauge');
  });

  it('updates a non-gauge item whose file happens to carry a unit-of-measure column', () => {
    const csv = 'name,unitOfMeasure,quantity\r\nM3 bolt,EA,40';
    const plan = buildCatalogImportPlan(csv, null, [stubItem('i1', 'M3 bolt')]);
    expect(plan.errors).toEqual([]);
    expect(plan.update).toHaveLength(1);
  });

  it('rejects a negative tare or net remaining', () => {
    const csv = 'name,tracking,unitOfMeasure,grossCapacity,tareWeight\r\nResin,gauge,ml,500,-1';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toEqual([]);
    expect(plan.errors[0]!.message).toMatch(/tare weight cannot be negative/i);
  });
});

describe('buildCatalogImportPlan — unlimited supply (Phase 82)', () => {
  it('auto-detects an `unlimited` column and carries the flag onto a create', () => {
    const csv = 'name,unlimited\r\nTap water,true\r\nM3 bolt,false';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create).toHaveLength(2);
    expect(plan.create.find((c) => c.input.name === 'Tap water')?.input.isUnlimited).toBe(true);
    expect(plan.create.find((c) => c.input.name === 'M3 bolt')?.input.isUnlimited).toBe(false);
  });

  it('rejects unlimited = true on a non-DISCRETE row with a clear error (mirrors the DB CHECK)', () => {
    const csv = 'name,trackingMode,unlimited\r\nSerial widget,SERIALISED,true';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toHaveLength(0);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.message).toMatch(/only discrete/i);
  });

  it('round-trips isUnlimited through the exported catalogue CSV headers', () => {
    // The `isUnlimited` header the exporter writes is auto-detected on re-import.
    const csv = 'name,quantity,isUnlimited\r\nTap water,,true';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create[0]?.input.isUnlimited).toBe(true);
  });
});

describe('parseNumericCell (issue #339)', () => {
  it('reads a spreadsheet’s grouped thousands rather than truncating at the separator', () => {
    expect(parseNumericCell('1,500')).toBe(1500);
    expect(parseNumericCell('1,234,567')).toBe(1234567);
    expect(parseNumericCell('1,234,567.25')).toBe(1234567.25);
    expect(parseNumericCell('1 500')).toBe(1500);
    expect(parseNumericCell('1\u00a0500')).toBe(1500); // non-breaking space
    expect(parseNumericCell('1\u202f500')).toBe(1500); // narrow no-break space
  });

  it('reads plain numbers, signs and decimals', () => {
    expect(parseNumericCell('42')).toBe(42);
    expect(parseNumericCell(' 7 ')).toBe(7);
    expect(parseNumericCell('0.05')).toBe(0.05);
    expect(parseNumericCell('-3')).toBe(-3);
    expect(parseNumericCell('1.5')).toBe(1.5);
  });

  it('strips a currency marker so a price column from another tool still reads', () => {
    // Migration sources map their price column straight through, symbol and all; the
    // value is unambiguous, so it must not cost the row its import.
    expect(parseNumericCell('$1.99')).toBe(1.99);
    expect(parseNumericCell('£1,234.56')).toBe(1234.56);
    expect(parseNumericCell('1.99 €')).toBe(1.99);
  });

  it('rejects a partially-numeric cell instead of truncating it', () => {
    // `parseInt` would have read the first two as 12.
    expect(parseNumericCell('12kg')).toBeNull();
    expect(parseNumericCell('12 units')).toBeNull();
    expect(parseNumericCell('abc')).toBeNull();
    expect(parseNumericCell('~12')).toBeNull();
    expect(parseNumericCell('n/a')).toBeNull();
    expect(parseNumericCell('')).toBeNull();
  });

  it('resolves a comma decimal the way the other importers do (issue #340)', () => {
    // A lone comma was previously reported as too ambiguous to read. It is now settled by
    // the shared heuristic instead, so one file imports the same through every importer:
    // a three-digit group is grouping, any other tail is a decimal fraction.
    expect(parseNumericCell('1,5')).toBe(1.5);
    expect(parseNumericCell('1,50')).toBe(1.5);
    expect(parseNumericCell('1.234,56')).toBe(1234.56);
    expect(parseNumericCell('£1,234.56')).toBe(1234.56);
    // ...and grouping still groups, so issue #339's cases are unchanged.
    expect(parseNumericCell('1,500')).toBe(1500);
    expect(parseNumericCell('1 500')).toBe(1500);
    expect(parseNumericCell('1,234,567.25')).toBe(1234567.25);
  });

  it('keeps a sub-penny unit price intact (issue #340)', () => {
    expect(parseNumericCell('0.005')).toBe(0.005);
    expect(parseNumericCell('0.0012')).toBe(0.0012);
  });
});

describe('parseNumericCountCell (whole-count fields — issue #391)', () => {
  it('keeps the leading integer of a unit-suffixed quantity, as the BOM importer does', () => {
    expect(parseNumericCountCell('3 pcs')).toBe(3);
    expect(parseNumericCountCell('10 units')).toBe(10);
  });

  it('still reads a plain, grouped or currency-marked count exactly as the amount rule does', () => {
    expect(parseNumericCountCell('42')).toBe(42);
    expect(parseNumericCountCell('1,500')).toBe(1500);
  });

  it('passes a fraction through unrounded so the schema still reports it (issue #339 intact)', () => {
    // This must NOT round 1.5 to 2 — the whole-number rule reports it instead.
    expect(parseNumericCountCell('1.5')).toBe(1.5);
    expect(parseNumericCountCell('2.0')).toBe(2);
  });

  it('does not guess a suffix run together with the digits, matching the shared rule', () => {
    // The shared leading-integer rule needs a boundary after the digits, so "2x" is unreadable
    // in the BOM importer too; leaving it null keeps the importers consistent.
    expect(parseNumericCountCell('2x')).toBeNull();
  });

  it('still rejects a cell with no leading number at all', () => {
    expect(parseNumericCountCell('abc')).toBeNull();
    expect(parseNumericCountCell('~12')).toBeNull();
    expect(parseNumericCountCell('n/a')).toBeNull();
    expect(parseNumericCountCell('')).toBeNull();
  });
});

describe('buildCatalogImportPlan — numeric cells (issue #339)', () => {
  it('imports a grouped-thousands quantity at full value', () => {
    const csv = 'name,quantity\r\nM3 bolt,"1,500"';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create[0]!.input.quantity).toBe(1500);
  });

  it('rejects an unreadable quantity instead of creating the item with zero stock', () => {
    const csv = 'name,quantity\r\nMystery part,abc';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toHaveLength(0);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.message).toMatch(/Quantity: "abc" is not a number/);
  });

  it('reports a fractional quantity as a whole-number error rather than truncating it', () => {
    const csv = 'name,quantity\r\nHalf a widget,1.5';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toHaveLength(0);
    expect(plan.errors[0]!.message).toMatch(/whole number/i);
  });

  it('rejects an unreadable unit cost, weight or reorder point', () => {
    const csv = 'name,unitCost\r\nPriced part,~2.50';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.create).toHaveLength(0);
    expect(plan.errors[0]!.message).toMatch(/Unit cost: "~2\.50" is not a number/);

    const reorder = buildCatalogImportPlan('name,reorderPoint\r\nPart,n/a', null, []);
    expect(reorder.create).toHaveLength(0);
    expect(reorder.errors[0]!.message).toMatch(/Reorder point: "n\/a" is not a number/);
  });

  it('names every unreadable cell in the row so one pass fixes the sheet', () => {
    const csv = 'name,quantity,unitCost\r\nBad row,abc,xyz';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]!.message).toMatch(/Quantity: "abc"/);
    expect(plan.errors[0]!.message).toMatch(/Unit cost: "xyz"/);
  });

  it('leaves an empty numeric cell as "not supplied" (no error)', () => {
    const csv = 'name,quantity,unitCost\r\nSparse row,,';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create[0]!.input.quantity).toBe(0);
    expect(plan.create[0]!.input.unitCost).toBeNull();
  });
});

describe('buildCatalogImportPlan — unit-suffixed counts match the BOM importer (issue #391)', () => {
  it('imports a unit-suffixed quantity by its leading integer, like the BOM importer', () => {
    const csv = 'name,quantity,reorderPoint,reorderQty\r\nM3 bolt,3 pcs,5 units,10 pcs';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create[0]!.input.quantity).toBe(3);
    expect(plan.create[0]!.input.reorderPoint).toBe(5);
    expect(plan.create[0]!.input.reorderQty).toBe(10);
  });

  it('still rejects a unit suffix on a measured or monetary cell, never dropping its fraction', () => {
    // A leading-integer fallback on `1.5 kg` would silently import 1, so amounts stay strict.
    const weight = buildCatalogImportPlan('name,weight\r\nSpool,1.5 kg', null, []);
    expect(weight.create).toHaveLength(0);
    expect(weight.errors[0]!.message).toMatch(/Weight \(g\): "1\.5 kg" is not a number/);

    const cost = buildCatalogImportPlan('name,unitCost\r\nWidget,2.50 each', null, []);
    expect(cost.create).toHaveLength(0);
    expect(cost.errors[0]!.message).toMatch(/Unit cost: "2\.50 each" is not a number/);
  });
});

describe('buildCatalogImportPlan — one numeric rule for every importer (issue #340)', () => {
  it('imports a eurozone supplier CSV with its prices intact', () => {
    const csv = ['name,quantity,unitCost', 'Widerstand,2,"1,50"', 'Kondensator,1,"1.234,56 €"'].join('\r\n');
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create.map((r) => r.input.unitCost)).toEqual([1.5, 1234.56]);
  });

  it('reads a UK-convention price the same way', () => {
    const csv = 'name,unitCost\r\nResistor,"£1,234.56"';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create[0]!.input.unitCost).toBe(1234.56);
  });

  it('keeps a sub-penny unit cost rather than inflating it', () => {
    const csv = 'name,unitCost\r\nSMD resistor,0.005';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create[0]!.input.unitCost).toBe(0.005);
  });

  it('reads a comma-decimal weight and dimension too, not just price', () => {
    const csv = 'name,weight,width\r\nBracket,"12,5","3,25"';
    const plan = buildCatalogImportPlan(csv, null, []);
    expect(plan.errors).toEqual([]);
    expect(plan.create[0]!.input.weight).toBe(12.5);
    expect(plan.create[0]!.input.width).toBe(3.25);
  });
});

// ---------------------------------------------------------------------------
// Issue #141 — barcode, serial number, expiry date and tags
// ---------------------------------------------------------------------------

describe('parseExpiryCell (issue #141)', () => {
  it('reads a bare ISO day as the midnight-UTC instant the item row stores', () => {
    expect(parseExpiryCell('2026-07-25')).toBe(Date.UTC(2026, 6, 25));
    expect(parseExpiryCell('  2026-07-25  ')).toBe(Date.UTC(2026, 6, 25));
  });

  it('rejects a day that does not exist rather than rolling it into the next month', () => {
    // `Date.parse('2026-02-31')` happily answers 3 March — an expiry silently moved by two days.
    expect(parseExpiryCell('2026-02-31')).toBeNull();
    expect(parseExpiryCell('2026-13-01')).toBeNull();
  });

  it('rejects an ambiguous or free-form date instead of guessing which half is the month', () => {
    for (const cell of ['07/08/2026', '25 July 2026', '2026/07/25', 'next Tuesday', '1784937600000']) {
      expect(parseExpiryCell(cell)).toBeNull();
    }
  });
});

describe('parseTagsCell (issue #141)', () => {
  it('splits on the comma the tag editor itself reserves, trimming and dropping blanks', () => {
    expect(parseTagsCell('fragile, heavy ,,on-loan')).toEqual(['fragile', 'heavy', 'on-loan']);
    expect(parseTagsCell('   ')).toEqual([]);
  });
});

describe('buildCatalogImportPlan — identity columns (issue #141)', () => {
  it('auto-maps barcode / serial-number / expiry / tag headers and carries them onto a create', () => {
    const csv =
      'name,barcode,serialNumber,expiryDate,tags\r\n' +
      'Milk,5012345678900,SN-4417,2026-08-01,"perishable, fridge"\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);

    expect(plan.errors).toEqual([]);
    const [created] = plan.create;
    expect(created!.input.barcode).toBe('5012345678900');
    expect(created!.input.serialNumber).toBe('SN-4417');
    expect(created!.input.expiryDate).toBe(Date.UTC(2026, 7, 1));
    expect(created!.tags).toEqual(['perishable', 'fridge']);
  });

  it('auto-maps the common spreadsheet spellings of each column', () => {
    const mapping = inferColumnMapping(['GTIN', 'Serial No.', 'Best before', 'Tags']);
    expect(mapping).toEqual(['barcode', 'serialNumber', 'expiryDate', 'tags']);
  });

  it('leaves a bare "Serial" column to a same-named custom field rather than shadowing it', () => {
    // A short word like this is far more likely to be somebody's custom field than the core
    // serial-number column, so only the unambiguous spellings are core synonyms.
    const field: CategoryField = {
      id: 'f-serial',
      categoryId: 'c1',
      name: 'Serial',
      fieldType: 'TEXT',
      required: false,
      options: null,
      position: 0,
      updatedAt: 0,
    };
    expect(inferColumnMapping(['Serial'], [field])).toEqual([{ fieldId: 'f-serial' }]);
  });

  it('reports an unreadable expiry cell rather than importing the row with no expiry date', () => {
    const csv = 'name,expiryDate\r\nMilk,07/08/2026\r\n';
    const plan = buildCatalogImportPlan(csv, null, []);

    expect(plan.create).toHaveLength(0);
    expect(plan.errors[0]!.message).toMatch(/Expiry date: "07\/08\/2026" is not a date/);
  });

  it('updates the three item columns on a matched row, and clears one whose cell is blank', () => {
    const existing = stubItem('i1', 'Milk');
    const csv = 'name,barcode,serialNumber,expiryDate\r\nMilk,,SN-9,2026-08-01\r\n';
    const plan = buildCatalogImportPlan(csv, null, [existing]);

    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]!.input).toMatchObject({
      barcode: null,
      serialNumber: 'SN-9',
      expiryDate: Date.UTC(2026, 7, 1),
    });
  });

  it('leaves tags untouched when no tag column is mapped, and clears them when one is blank', () => {
    const existing = stubItem('i1', 'Milk');
    const untouched = buildCatalogImportPlan('name\r\nMilk\r\n', null, [existing]);
    expect(untouched.update[0]!.tags).toBeUndefined();

    const cleared = buildCatalogImportPlan('name,tags\r\nMilk,\r\n', null, [existing]);
    expect(cleared.update[0]!.tags).toEqual([]);
  });
});

describe('applyCatalogImportPlan — tags land through the tag repository (:memory:)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let tags: TagRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    tags = new TagRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('auto-creates the tags an imported row names and assigns them to the item', async () => {
    const plan = buildCatalogImportPlan('name,tags\r\nMilk,"perishable, fridge"\r\n', null, []);
    const result = await applyCatalogImportPlan(plan, items, undefined, tags);

    expect(result.created).toBe(1);
    expect(result.rows[0]!.error).toBeUndefined();

    const page = await items.list({ limit: 10 });
    const created = page.rows.find((r) => r.name === 'Milk')!;
    expect((await tags.getForItem(created.id)).map((t) => t.name)).toEqual(['fridge', 'perishable']);
  });

  it('reuses an existing tag case-insensitively rather than duplicating the dictionary', async () => {
    await tags.create('Fragile');
    const plan = buildCatalogImportPlan('name,tags\r\nVase,fragile\r\n', null, []);
    await applyCatalogImportPlan(plan, items, undefined, tags);

    const dictionary = await tags.list({ limit: 10 });
    expect(dictionary.rows.map((t) => t.name)).toEqual(['Fragile']);
  });

  it('replaces an existing item’s whole tag set, so a blank cell clears it', async () => {
    const item = await items.create({ name: 'Vase', locationId: UNASSIGNED_LOCATION_ID });
    await tags.setForItem(item.id, ['fragile', 'heavy']);

    const plan = buildCatalogImportPlan('name,tags\r\nVase,\r\n', null, [item]);
    const result = await applyCatalogImportPlan(plan, items, undefined, tags);

    expect(result.updated).toBe(1);
    expect(await tags.getForItem(item.id)).toEqual([]);
  });

  it('reports the tags as ignored when no tag repository is supplied, without failing the item', async () => {
    const plan = buildCatalogImportPlan('name,tags\r\nVase,fragile\r\n', null, []);
    const result = await applyCatalogImportPlan(plan, items);

    expect(result.created).toBe(1);
    expect(result.rows[0]!.error).toMatch(/tags were ignored/i);
  });
});

// ---------------------------------------------------------------------------
// applyCatalogImportPlan — the bulk-import permission boundary (issue #429)
// ---------------------------------------------------------------------------

describe('applyCatalogImportPlan is inside the permission boundary', () => {
  afterEach(() => {
    useSessionStore.getState().setResolved(UNRESTRICTED_AUTHORITY, ADMIN_USER_ID);
  });

  /** A stub that fails loudly if the gate lets a write through. */
  function refusingStub(): CatalogItemRepository {
    return {
      create: async () => {
        throw new Error('no row may be written once the import is refused');
      },
      update: async () => {
        throw new Error('no row may be written once the import is refused');
      },
      createMany: async () => {
        throw new Error('no row may be written once the import is refused');
      },
    };
  }

  it('refuses `items:write` alone — merging thousands of rows is its own act', async () => {
    // The per-row `items:write` the repository asserts is necessary but not sufficient:
    // editing one record and merging a supplier catalogue are different consequences.
    useSessionStore.getState().setResolved({ mode: 'granted', grants: new Set(['items:write']) }, 'u1');
    const plan = buildCatalogImportPlan('name,quantity\r\nA,1\r\n', null, []);

    await expect(applyCatalogImportPlan(plan, refusingStub())).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('allows a role holding `import:run` alongside the item writes', async () => {
    useSessionStore
      .getState()
      .setResolved({ mode: 'granted', grants: new Set(['items:write', 'import:run']) }, 'u1');
    const plan = buildCatalogImportPlan('name,quantity\r\nA,1\r\n', null, []);
    let n = 0;
    const stub: CatalogItemRepository = {
      create: async (input) => stubItem(`gen-${n++}`, input.name),
      update: async () => {
        throw new Error('no updates');
      },
    };

    const result = await applyCatalogImportPlan(plan, stub);
    expect(result.created).toBe(1);
  });
});
