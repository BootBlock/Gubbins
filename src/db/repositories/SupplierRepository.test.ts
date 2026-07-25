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

  describe('paging and searching (issue #386)', () => {
    /** `Supplier 001`…`Supplier 0NN`, so name order is predictable and stable. */
    const seed = async (n: number) => {
      for (let i = 1; i <= n; i += 1) {
        await repo.create({ name: `Supplier ${String(i).padStart(3, '0')}` });
      }
    };

    it('reaches suppliers past the first page by offset', async () => {
      // The gap this closes: anything sorting past one bounded read used to be unreachable, so
      // it could not be edited, merged or deleted.
      await seed(120);

      const second = await repo.list({ limit: 100, offset: 100 });

      expect(second.rows).toHaveLength(20);
      expect(second.rows[19]?.name).toBe('Supplier 120');
      expect(second.hasMore).toBe(false);
    });

    it('counts the whole dictionary, not the page', async () => {
      await seed(120);
      expect(await repo.count()).toBe(120);
      expect((await repo.list({ limit: 100 })).rows).toHaveLength(100);
    });

    it('filters on a substring of the name, ignoring case', async () => {
      await repo.create({ name: 'RS Components' });
      await repo.create({ name: 'Farnell' });
      await repo.create({ name: 'Mouser' });

      const page = await repo.list({ search: 'components' });

      expect(page.rows.map((s) => s.name)).toEqual(['RS Components']);
      expect(await repo.count({ search: 'components' })).toBe(1);
    });

    it('ignores spacing and punctuation, as every other name comparison does', async () => {
      // A user who half-remembers the punctuation should still find the supplier; a search box
      // that alone insisted on the exact spelling would be the odd one out in the app.
      await repo.create({ name: 'RS Components' });
      await repo.create({ name: 'Mouser' });

      for (const typed of ['rs-components', 'RS  Components', 'r.s. components']) {
        expect((await repo.list({ search: typed })).rows.map((s) => s.name)).toEqual(['RS Components']);
        expect(await repo.count({ search: typed })).toBe(1);
      }
    });

    it('surfaces near-duplicates together so a merge can reconcile them', async () => {
      // Two rows for one company — the case merge exists for. Both must come back for the name
      // they share, or the user cannot see there is anything to reconcile.
      await repo.create({ name: 'Farnell' });
      await repo.create({ name: 'Farnell UK Ltd.' });
      await repo.create({ name: 'Mouser' });

      expect((await repo.list({ search: 'farnell' })).rows.map((s) => s.name)).toEqual([
        'Farnell',
        'Farnell UK Ltd.',
      ]);
    });

    it('counts exactly what the same filter lists', async () => {
      // A count that disagreed with the list would size the page strip for a different result
      // set than the rows, stranding the user on a page that renders nothing.
      await repo.create({ name: 'Alpha Parts' });
      await repo.create({ name: 'Beta Parts' });
      await repo.create({ name: 'Gamma Supplies' });

      expect(await repo.count({ search: 'parts' })).toBe(2);
      expect((await repo.list({ search: 'parts' })).rows).toHaveLength(2);
    });

    it('treats LIKE wildcards in the search text as literal characters', async () => {
      // Typed as-is into a LIKE pattern, `%` would match every supplier — a search box has to
      // find what the user typed, not everything.
      await repo.create({ name: '50% Off Spares' });
      await repo.create({ name: 'Farnell' });

      expect((await repo.list({ search: '%' })).rows.map((s) => s.name)).toEqual(['50% Off Spares']);
      expect(await repo.count({ search: '%' })).toBe(1);
    });

    it('ignores a blank search rather than matching nothing', async () => {
      await repo.create({ name: 'Farnell' });
      expect((await repo.list({ search: '   ' })).rows).toHaveLength(1);
      expect(await repo.count({ search: '   ' })).toBe(1);
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
