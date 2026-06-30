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
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import type { Item } from '@/db/repositories/types';
import {
  inferColumnMapping,
  buildCatalogImportPlan,
  applyCatalogImportPlan,
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
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    gauge: null,
    operationalMetadata: null,
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
    const existing = await repo.create({ name: 'LED Red', quantity: 50, unitCost: 0.10 });
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
