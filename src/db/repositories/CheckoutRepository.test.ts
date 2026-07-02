import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { runMigrations } from '@/db/migrations';
import { migrations } from '@/db/migrations/index';
import { CheckoutRepository } from './CheckoutRepository';
import { ContactRepository } from './ContactRepository';
import { ItemRepository } from './ItemRepository';

describe('ContactRepository & CheckoutRepository (borrowing, §4)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let contacts: ContactRepository;
  let checkouts: CheckoutRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    contacts = new ContactRepository(driver);
    checkouts = new CheckoutRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  async function makeItem(name: string, quantity: number): Promise<string> {
    const item = await items.create({ name, quantity });
    return item.id;
  }

  describe('ContactRepository', () => {
    it('resolves-or-creates a contact case-insensitively (low-friction, §4)', async () => {
      const a = await contacts.resolveOrCreate('Ada Lovelace');
      const b = await contacts.resolveOrCreate('ada lovelace');
      expect(b.id).toBe(a.id);
      const page = await contacts.list();
      expect(page.rows).toHaveLength(1);
    });

    it('rejects a blank name', async () => {
      await expect(contacts.create({ name: '   ' })).rejects.toBeInstanceOf(DbError);
    });

    it('counts a contact’s open checkouts', async () => {
      const itemId = await makeItem('Multimeter', 1);
      const ada = await contacts.resolveOrCreate('Ada');
      await checkouts.checkout({ itemId, contactId: ada.id });
      const page = await contacts.list();
      expect(page.rows.find((c) => c.id === ada.id)?.openCount).toBe(1);
    });
  });

  describe('checkout', () => {
    it('decrements on-hand stock and logs CHECKED_OUT', async () => {
      const itemId = await makeItem('Resistor pack', 10);
      const checkout = await checkouts.checkout({ itemId, contactName: 'Bob', quantity: 3 });

      expect(checkout.quantity).toBe(3);
      expect(checkout.returnedAt).toBeNull();
      const item = await items.getById(itemId);
      expect(item?.quantity).toBe(7);

      const history = await items.getHistory(itemId);
      expect(history.rows.some((h) => h.action === 'CHECKED_OUT' && h.quantityDelta === -3)).toBe(true);
    });

    it('auto-creates the contact from a typed name', async () => {
      const itemId = await makeItem('Soldering iron', 1);
      await checkouts.checkout({ itemId, contactName: 'Grace Hopper' });
      const found = await contacts.findByName('grace hopper');
      expect(found).toBeDefined();
    });

    it('refuses to over-borrow', async () => {
      const itemId = await makeItem('Last one', 1);
      await expect(checkouts.checkout({ itemId, contactName: 'Bob', quantity: 2 })).rejects.toBeInstanceOf(
        DbError,
      );
    });

    it('refuses to borrow a consumable-gauge item', async () => {
      const gauge = await items.create({
        name: 'Filament',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 200 },
      });
      await expect(checkouts.checkout({ itemId: gauge.id, contactName: 'Bob' })).rejects.toBeInstanceOf(
        DbError,
      );
    });

    it('lends a serialised item as one whole unit without breaking its quantity pin', async () => {
      const serial = await items.create({ name: 'Scope', trackingMode: 'SERIALISED' });
      const checkout = await checkouts.checkout({ itemId: serial.id, contactName: 'Bob', quantity: 5 });
      expect(checkout.quantity).toBe(1);
      // SERIALISED quantity is CHECK-pinned to 1; the loan does not decrement it.
      expect((await items.getById(serial.id))?.quantity).toBe(1);
      // ...but it cannot be borrowed twice while still out.
      await expect(checkouts.checkout({ itemId: serial.id, contactName: 'Carol' })).rejects.toBeInstanceOf(
        DbError,
      );
    });

    it('lets a returned serialised item be borrowed again', async () => {
      const serial = await items.create({ name: 'Scope', trackingMode: 'SERIALISED' });
      const first = await checkouts.checkout({ itemId: serial.id, contactName: 'Bob' });
      await checkouts.checkIn(first.id);
      const second = await checkouts.checkout({ itemId: serial.id, contactName: 'Carol' });
      expect(second.returnedAt).toBeNull();
      expect((await items.getById(serial.id))?.quantity).toBe(1);
    });
  });

  describe('checkIn', () => {
    it('restores stock, stamps returned_at and logs CHECKED_IN', async () => {
      const itemId = await makeItem('Clamp meter', 5);
      const checkout = await checkouts.checkout({ itemId, contactName: 'Bob', quantity: 2 });
      const returned = await checkouts.checkIn(checkout.id);

      expect(returned.returnedAt).not.toBeNull();
      expect((await items.getById(itemId))?.quantity).toBe(5);
      const history = await items.getHistory(itemId);
      expect(history.rows.some((h) => h.action === 'CHECKED_IN' && h.quantityDelta === 2)).toBe(true);
    });

    it('is idempotent on an already-returned checkout', async () => {
      const itemId = await makeItem('Clamp meter', 5);
      const checkout = await checkouts.checkout({ itemId, contactName: 'Bob', quantity: 2 });
      await checkouts.checkIn(checkout.id);
      const again = await checkouts.checkIn(checkout.id);
      expect(again.returnedAt).not.toBeNull();
      expect((await items.getById(itemId))?.quantity).toBe(5); // not double-restored
    });
  });

  describe('queries', () => {
    it('lists open checkouts with names and overdue flag', async () => {
      const itemId = await makeItem('Drill', 3);
      const past = Date.now() - 86_400_000;
      await checkouts.checkout({ itemId, contactName: 'Bob', dueDate: past });
      const open = await checkouts.listOpen();
      expect(open.rows).toHaveLength(1);
      expect(open.rows[0].itemName).toBe('Drill');
      expect(open.rows[0].contactName).toBe('Bob');
      expect(open.rows[0].status).toBe('OPEN');
      expect(open.rows[0].isOverdue).toBe(true);
    });

    it('excludes returned checkouts from the open list', async () => {
      const itemId = await makeItem('Drill', 3);
      const checkout = await checkouts.checkout({ itemId, contactName: 'Bob' });
      await checkouts.checkIn(checkout.id);
      const open = await checkouts.listOpen();
      expect(open.rows).toHaveLength(0);
    });

    it('lists a contact’s history', async () => {
      const itemId = await makeItem('Drill', 3);
      const ada = await contacts.resolveOrCreate('Ada');
      await checkouts.checkout({ itemId, contactId: ada.id });
      const page = await checkouts.listForContact(ada.id);
      expect(page.rows).toHaveLength(1);
    });
  });

  it('refuses checkout when storage is suspended (Hard Stop, §7.6.1)', async () => {
    const itemId = await makeItem('Drill', 3);
    const locked = new CheckoutRepository(driver, { isWriteSuspended: () => true });
    await expect(locked.checkout({ itemId, contactName: 'Bob' })).rejects.toBeInstanceOf(DbError);
  });
});
