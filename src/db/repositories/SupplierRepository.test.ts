import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import {
  ItemRepository,
  PurchaseOrderRepository,
  SupplierPartRepository,
  SupplierRepository,
  UNASSIGNED_LOCATION_ID,
} from './index';

describe('SupplierRepository (issue #384)', () => {
  let driver: MemoryDriver;
  let repo: SupplierRepository;
  let items: ItemRepository;
  let parts: SupplierPartRepository;
  let orders: PurchaseOrderRepository;
  let itemId: string;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    repo = new SupplierRepository(driver);
    items = new ItemRepository(driver);
    parts = new SupplierPartRepository(driver);
    orders = new PurchaseOrderRepository(driver);
    const item = await items.create({ name: 'Resistor', locationId: UNASSIGNED_LOCATION_ID });
    itemId = item.id;
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('canonical names', () => {
    it('stores the name with internal whitespace collapsed', async () => {
      const supplier = await repo.create({ name: '  RS   Components ' });
      expect(supplier.name).toBe('RS Components');
    });

    it('resolves case, spacing and punctuation variants onto one supplier', async () => {
      const first = await repo.resolveOrCreate('RS Components');
      for (const variant of ['rs components', 'RS  Components', 'RS-Components', 'R.S. Components']) {
        expect((await repo.resolveOrCreate(variant)).id).toBe(first.id);
      }
      const page = await repo.list();
      expect(page.rows).toHaveLength(1);
    });

    it('rejects a blank or punctuation-only name', async () => {
      await expect(repo.create({ name: '   ' })).rejects.toThrow(/must have a name/i);
      await expect(repo.create({ name: '---' })).rejects.toThrow(/must have a name/i);
    });

    it('refuses a rename that collides with another supplier, pointing at merge', async () => {
      const farnell = await repo.create({ name: 'Farnell' });
      await repo.create({ name: 'Mouser' });
      await expect(repo.update(farnell.id, { name: 'mouser' })).rejects.toThrow(/merge them instead/i);
    });

    it('allows a rename that only changes the supplier’s own casing', async () => {
      const supplier = await repo.create({ name: 'digikey' });
      const renamed = await repo.update(supplier.id, { name: 'DigiKey' });
      expect(renamed.name).toBe('DigiKey');
    });
  });

  describe('rename propagation', () => {
    it('renames the supplier everywhere at once', async () => {
      const supplier = await repo.create({ name: 'RS-Components' });
      const part = await parts.create(itemId, { supplier: { supplierId: supplier.id } });
      const order = await orders.create({ supplier: { supplierId: supplier.id } });

      await repo.update(supplier.id, { name: 'RS Components' });

      expect((await parts.getById(part.id))?.supplierName).toBe('RS Components');
      expect((await orders.getById(order.id))?.supplierName).toBe('RS Components');
    });
  });

  describe('merge', () => {
    it('re-points parts and orders onto the target, then deletes the source', async () => {
      const target = await repo.create({ name: 'RS Components' });
      const source = await repo.create({ name: 'RS Comps' });
      const part = await parts.create(itemId, { supplier: { supplierId: source.id } });
      const order = await orders.create({ supplier: { supplierId: source.id } });

      await repo.merge(source.id, target.id);

      expect(await repo.getById(source.id)).toBeUndefined();
      expect((await parts.getById(part.id))?.supplierId).toBe(target.id);
      expect((await orders.getById(order.id))?.supplierId).toBe(target.id);
    });

    it('refuses to merge a supplier into itself', async () => {
      const supplier = await repo.create({ name: 'Farnell' });
      await expect(repo.merge(supplier.id, supplier.id)).rejects.toThrow(/into itself/i);
    });

    it('rejects an unknown supplier on either side', async () => {
      const supplier = await repo.create({ name: 'Farnell' });
      await expect(repo.merge('nope', supplier.id)).rejects.toThrow(/does not exist/i);
      await expect(repo.merge(supplier.id, 'nope')).rejects.toThrow(/does not exist/i);
    });
  });

  describe('delete', () => {
    it('cascades the supplier’s parts away with it', async () => {
      const supplier = await repo.create({ name: 'Farnell' });
      const part = await parts.create(itemId, { supplier: { supplierId: supplier.id } });

      await repo.delete(supplier.id);

      expect(await repo.getById(supplier.id)).toBeUndefined();
      expect(await parts.getById(part.id)).toBeUndefined();
    });

    it('keeps a supplier’s purchase orders, unlinking them (SET NULL)', async () => {
      // Spend history survives tidying of the supplier list: the order keeps its record, it
      // just stops naming a supplier.
      const supplier = await repo.create({ name: 'Farnell' });
      const po = await orders.create({ supplier: { supplierId: supplier.id } });

      await repo.delete(supplier.id);

      expect(await repo.getById(supplier.id)).toBeUndefined();
      const after = await orders.getById(po.id);
      expect(after).toBeDefined();
      expect(after?.supplierId).toBeNull();
    });
  });

  describe('list counts', () => {
    it('reports the part and order counts that gate deletion', async () => {
      const supplier = await repo.create({ name: 'Farnell' });
      await parts.create(itemId, { supplier: { supplierId: supplier.id } });
      await orders.create({ supplier: { supplierId: supplier.id } });

      const row = (await repo.list()).rows.find((s) => s.id === supplier.id);
      expect(row).toMatchObject({ partCount: 1, orderCount: 1 });
    });
  });

  describe('resolveRef', () => {
    it('returns an existing id unchanged and creates from a name', async () => {
      const supplier = await repo.create({ name: 'Farnell' });
      expect(await repo.resolveRef({ supplierId: supplier.id })).toBe(supplier.id);
      expect(await repo.resolveRef({ supplierName: 'farnell' })).toBe(supplier.id);
      expect(await repo.resolveRef({ supplierName: 'Mouser' })).not.toBe(supplier.id);
    });

    it('rejects an id that does not exist rather than silently creating one', async () => {
      await expect(repo.resolveRef({ supplierId: 'nope' })).rejects.toThrow(/does not exist/i);
    });
  });
});
