import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import {
  ItemRepository,
  SupplierPartRepository,
  SupplierRepository,
  TombstoneRepository,
  UNASSIGNED_LOCATION_ID,
} from './index';
import { effectiveUnitCost } from '@/features/inventory/supplier-cost';

describe('SupplierPartRepository (Phase 60)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let repo: SupplierPartRepository;
  let suppliers: SupplierRepository;
  let tombstones: TombstoneRepository;
  let itemId: string;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    items = new ItemRepository(driver);
    repo = new SupplierPartRepository(driver);
    suppliers = new SupplierRepository(driver);
    tombstones = new TombstoneRepository(driver);
    const item = await items.create({ name: 'Resistor', locationId: UNASSIGNED_LOCATION_ID });
    itemId = item.id;
  });

  afterEach(async () => {
    await driver.close();
  });

  it('creates and reads back a supplier part with all fields', async () => {
    const created = await repo.create(itemId, {
      supplier: { supplierName: 'DigiKey' },
      orderCode: '311-10KCRCT-ND',
      unitCost: 0.1,
      currency: 'USD',
      packQty: 100,
      minOrderQty: 1,
      priceBreaks: [
        { qty: 100, unitCost: 0.1 },
        { qty: 10, unitCost: 0.2 },
      ],
      url: 'https://example.test/p/1',
    });

    const fetched = await repo.getById(created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.supplierName).toBe('DigiKey');
    // The name is projected from the supplier the part points at, not stored on the part.
    expect(fetched?.supplierId).toBe((await suppliers.findByName('DigiKey'))?.id);
    expect(fetched?.orderCode).toBe('311-10KCRCT-ND');
    expect(fetched?.unitCost).toBe(0.1);
    expect(fetched?.currency).toBe('USD');
    expect(fetched?.packQty).toBe(100);
    expect(fetched?.minOrderQty).toBe(1);
    expect(fetched?.url).toBe('https://example.test/p/1');
    expect(fetched?.isPreferred).toBe(false);
    // Price-breaks are stored ascending by qty.
    expect(fetched?.priceBreaks).toEqual([
      { qty: 10, unitCost: 0.2 },
      { qty: 100, unitCost: 0.1 },
    ]);
  });

  it('stores the supplier by id, folding a re-typed name onto the same supplier (issue #384)', async () => {
    const digikey = await suppliers.create({ name: 'DigiKey' });
    const byId = await repo.create(itemId, { supplier: { supplierId: digikey.id } });
    expect(byId.supplierId).toBe(digikey.id);
    expect(byId.supplierName).toBe('DigiKey');

    // A differently-spelled name resolves onto the *same* supplier rather than minting one.
    const second = await items.create({ name: 'Capacitor', locationId: UNASSIGNED_LOCATION_ID });
    const byName = await repo.create(second.id, { supplier: { supplierName: 'digi-key' } });
    expect(byName.supplierId).toBe(digikey.id);
    expect(byName.supplierName).toBe('DigiKey');
  });

  it('re-points a part at a different supplier through update (issue #384)', async () => {
    const rs = await suppliers.create({ name: 'RS' });
    const mouser = await suppliers.create({ name: 'Mouser' });
    const part = await repo.create(itemId, { supplier: { supplierId: rs.id }, orderCode: 'ABC' });

    const moved = await repo.update(part.id, { supplier: { supplierId: mouser.id } });
    expect(moved.supplierId).toBe(mouser.id);
    expect(moved.supplierName).toBe('Mouser');
    expect(moved.orderCode).toBe('ABC'); // the offer itself is untouched
  });

  it('cascades supplier parts when their supplier is deleted (issue #384)', async () => {
    const rs = await suppliers.create({ name: 'RS' });
    const part = await repo.create(itemId, { supplier: { supplierId: rs.id } });
    await suppliers.delete(rs.id);
    expect(await repo.getById(part.id)).toBeUndefined();
  });

  it('lists parts for an item preferred-first then by supplier name', async () => {
    await repo.create(itemId, { supplier: { supplierName: 'RS' } });
    await repo.create(itemId, { supplier: { supplierName: 'Mouser' }, isPreferred: true });
    await repo.create(itemId, { supplier: { supplierName: 'Arrow' } });

    const list = await repo.listForItem(itemId);
    expect(list.map((p) => p.supplierName)).toEqual(['Mouser', 'Arrow', 'RS']);
    expect(list[0]?.isPreferred).toBe(true);
  });

  it('batch-lists parts for several items keyed by item id (issue #37)', async () => {
    const second = await items.create({ name: 'Capacitor', locationId: UNASSIGNED_LOCATION_ID });
    const third = await items.create({ name: 'Diode', locationId: UNASSIGNED_LOCATION_ID });
    await repo.create(itemId, { supplier: { supplierName: 'RS' } });
    await repo.create(itemId, { supplier: { supplierName: 'Mouser' }, isPreferred: true });
    await repo.create(second.id, { supplier: { supplierName: 'DigiKey' } });
    // `third` has no supplier parts and must be simply absent from the map.

    const byItem = await repo.listForItems([itemId, second.id, third.id]);
    expect(byItem.get(itemId)?.map((p) => p.supplierName)).toEqual(['Mouser', 'RS']);
    expect(byItem.get(second.id)?.map((p) => p.supplierName)).toEqual(['DigiKey']);
    expect(byItem.has(third.id)).toBe(false);
  });

  it('batch-lists nothing for an empty id set (issue #37)', async () => {
    const byItem = await repo.listForItems([]);
    expect(byItem.size).toBe(0);
  });

  it('updates fields and clears a nullable field with explicit null', async () => {
    const sp = await repo.create(itemId, {
      supplier: { supplierName: 'RS' },
      orderCode: 'ABC',
      unitCost: 1.5,
    });
    const updated = await repo.update(sp.id, { unitCost: 2, orderCode: null });
    expect(updated.unitCost).toBe(2);
    expect(updated.orderCode).toBeNull();
    expect(updated.supplierName).toBe('RS');
  });

  it('enforces a single preferred winner per item via setPreferred', async () => {
    const a = await repo.create(itemId, { supplier: { supplierName: 'A' }, isPreferred: true });
    const b = await repo.create(itemId, { supplier: { supplierName: 'B' } });
    const c = await repo.create(itemId, { supplier: { supplierName: 'C' } });

    await repo.setPreferred(b.id);
    let list = await repo.listForItem(itemId);
    expect(list.filter((p) => p.isPreferred).map((p) => p.id)).toEqual([b.id]);

    // Switching again clears the previous winner.
    await repo.setPreferred(c.id);
    list = await repo.listForItem(itemId);
    expect(list.filter((p) => p.isPreferred).map((p) => p.id)).toEqual([c.id]);
    expect((await repo.getById(a.id))?.isPreferred).toBe(false);
  });

  it('enforces a single price-source winner per item via setPriceSource (issue #28)', async () => {
    const a = await repo.create(itemId, { supplier: { supplierName: 'A' } });
    const b = await repo.create(itemId, { supplier: { supplierName: 'B' } });

    await repo.setPriceSource(a.id);
    expect((await repo.getById(a.id))?.isPriceSource).toBe(true);

    // Switching to another clears the previous source.
    await repo.setPriceSource(b.id);
    const list = await repo.listForItem(itemId);
    expect(list.filter((p) => p.isPriceSource).map((p) => p.id)).toEqual([b.id]);
    expect((await repo.getById(a.id))?.isPriceSource).toBe(false);
  });

  it('clears the pinned price source via clearPriceSource', async () => {
    const a = await repo.create(itemId, { supplier: { supplierName: 'A' } });
    await repo.setPriceSource(a.id);
    await repo.clearPriceSource(itemId);
    expect((await repo.getById(a.id))?.isPriceSource).toBe(false);
  });

  it('keeps price source independent of the preferred star', async () => {
    const a = await repo.create(itemId, { supplier: { supplierName: 'A' }, isPreferred: true });
    const b = await repo.create(itemId, { supplier: { supplierName: 'B' } });
    await repo.setPriceSource(b.id);
    // Pinning B as the source must not disturb A's preferred flag, and vice versa.
    expect((await repo.getById(a.id))?.isPreferred).toBe(true);
    expect((await repo.getById(a.id))?.isPriceSource).toBe(false);
    expect((await repo.getById(b.id))?.isPreferred).toBe(false);
    expect((await repo.getById(b.id))?.isPriceSource).toBe(true);
  });

  it('clears any existing preferred when creating a new preferred part', async () => {
    const a = await repo.create(itemId, { supplier: { supplierName: 'A' }, isPreferred: true });
    await repo.create(itemId, { supplier: { supplierName: 'B' }, isPreferred: true });
    const list = await repo.listForItem(itemId);
    expect(list.filter((p) => p.isPreferred).map((p) => p.supplierName)).toEqual(['B']);
    expect((await repo.getById(a.id))?.isPreferred).toBe(false);
  });

  it('marks preferred through update, clearing the previous winner', async () => {
    const a = await repo.create(itemId, { supplier: { supplierName: 'A' }, isPreferred: true });
    const b = await repo.create(itemId, { supplier: { supplierName: 'B' } });
    await repo.update(b.id, { isPreferred: true });
    expect((await repo.getById(a.id))?.isPreferred).toBe(false);
    expect((await repo.getById(b.id))?.isPreferred).toBe(true);
  });

  it('getPreferred returns the marked part or undefined', async () => {
    expect(await repo.getPreferred(itemId)).toBeUndefined();
    const p = await repo.create(itemId, { supplier: { supplierName: 'A' }, unitCost: 3, isPreferred: true });
    expect((await repo.getPreferred(itemId))?.id).toBe(p.id);
  });

  it('deletes a part and records a tombstone for sync', async () => {
    const sp = await repo.create(itemId, { supplier: { supplierName: 'RS' } });
    await repo.delete(sp.id);
    expect(await repo.getById(sp.id)).toBeUndefined();
    expect(await tombstones.has('supplier_parts', sp.id)).toBe(true);
  });

  it('cascades supplier parts when the parent item is hard-deleted', async () => {
    await repo.create(itemId, { supplier: { supplierName: 'RS' } });
    await items.hardDelete(itemId);
    expect(await repo.listForItem(itemId)).toHaveLength(0);
  });

  it('rejects a blank supplier name and a negative cost', async () => {
    await expect(repo.create(itemId, { supplier: { supplierName: '  ' } })).rejects.toThrow();
    await expect(repo.create(itemId, { supplier: { supplierName: 'X' }, unitCost: -1 })).rejects.toThrow();
  });

  it('feeds the cost-precedence helper: preferred supplier cost wins when manual is unset', async () => {
    await repo.create(itemId, { supplier: { supplierName: 'Cheap' }, unitCost: 1.0, isPreferred: false });
    await repo.create(itemId, { supplier: { supplierName: 'Pref' }, unitCost: 2.5, isPreferred: true });
    const parts = await repo.listForItem(itemId);

    expect(effectiveUnitCost({ unitCost: null }, parts)).toBe(2.5);
    expect(effectiveUnitCost({ unitCost: 9 }, parts)).toBe(9); // manual override wins
  });

  describe('price history (Phase 81)', () => {
    it('records a baseline point on create with a cost (tagged by source + currency)', async () => {
      const p = await repo.create(itemId, {
        supplier: { supplierName: 'RS' },
        unitCost: 1.5,
        currency: 'GBP',
      });
      const history = await repo.listPriceHistory(p.id);
      expect(history).toHaveLength(1);
      expect(history[0]?.unitCost).toBe(1.5);
      expect(history[0]?.currency).toBe('GBP');
      expect(history[0]?.source).toBe('MANUAL');
    });

    it('records no point when created without a cost', async () => {
      const p = await repo.create(itemId, { supplier: { supplierName: 'RS' } });
      expect(await repo.listPriceHistory(p.id)).toHaveLength(0);
    });

    it('records a point on a genuine cost change, and tags an explicit SCRAPE source', async () => {
      const p = await repo.create(itemId, { supplier: { supplierName: 'RS' }, unitCost: 1.0 });
      await repo.update(p.id, { unitCost: 1.25, source: 'SCRAPE' });
      const history = await repo.listPriceHistory(p.id);
      expect(history).toHaveLength(2);
      // Newest first.
      expect(history[0]?.unitCost).toBe(1.25);
      expect(history[0]?.source).toBe('SCRAPE');
      expect(history[1]?.unitCost).toBe(1.0);
    });

    it('does not record a no-op cost write (same value) or an unrelated field update', async () => {
      const p = await repo.create(itemId, { supplier: { supplierName: 'RS' }, unitCost: 2.0 });
      await repo.update(p.id, { unitCost: 2.0 }); // same value
      await repo.update(p.id, { orderCode: 'ABC-123' }); // no cost touched
      expect(await repo.listPriceHistory(p.id)).toHaveLength(1);
    });

    it('does not record a point when the cost is cleared to null', async () => {
      const p = await repo.create(itemId, { supplier: { supplierName: 'RS' }, unitCost: 2.0 });
      await repo.update(p.id, { unitCost: null });
      expect(await repo.listPriceHistory(p.id)).toHaveLength(1);
    });

    it('records a point even when the cost change rides a preferred-toggle transaction', async () => {
      const p = await repo.create(itemId, { supplier: { supplierName: 'RS' }, unitCost: 1.0 });
      await repo.update(p.id, { unitCost: 1.5, isPreferred: true });
      const history = await repo.listPriceHistory(p.id);
      expect(history).toHaveLength(2);
      expect(history[0]?.unitCost).toBe(1.5);
    });

    it('tracks the new currency when the cost and currency change together', async () => {
      const p = await repo.create(itemId, {
        supplier: { supplierName: 'RS' },
        unitCost: 1.0,
        currency: 'GBP',
      });
      await repo.update(p.id, { unitCost: 1.2, currency: 'EUR' });
      const history = await repo.listPriceHistory(p.id);
      expect(history[0]?.currency).toBe('EUR');
    });

    it('cascades price-history rows when the supplier part is deleted', async () => {
      const p = await repo.create(itemId, { supplier: { supplierName: 'RS' }, unitCost: 1.0 });
      await repo.delete(p.id);
      expect(await repo.listPriceHistory(p.id)).toHaveLength(0);
    });
  });
});
