import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { runMigrations } from '@/db/migrations';
import { migrations } from '@/db/migrations/index';
import { MS_PER_DAY } from './constants';
import { CheckoutRepository, overdueCheckoutExistsSql } from './CheckoutRepository';
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

    it('records the return note in its own column without clobbering the loan note', async () => {
      const itemId = await makeItem('Torque wrench', 1);
      const checkout = await checkouts.checkout({
        itemId,
        contactName: 'Bob',
        note: 'for the Henderson job',
      });
      const returned = await checkouts.checkIn(checkout.id, { note: 'returned with a chipped blade' });

      // Both ends of the loan keep their own text — the return note no longer overwrites the loan note.
      expect(returned.note).toBe('for the Henderson job');
      expect(returned.returnNote).toBe('returned with a chipped blade');
    });

    it('leaves the return note null when a loan is returned without one', async () => {
      const itemId = await makeItem('Clamp meter', 5);
      const checkout = await checkouts.checkout({ itemId, contactName: 'Bob', quantity: 2 });
      const returned = await checkouts.checkIn(checkout.id);
      expect(returned.returnNote).toBeNull();
    });

    it('is idempotent on an already-returned checkout', async () => {
      const itemId = await makeItem('Clamp meter', 5);
      const checkout = await checkouts.checkout({ itemId, contactName: 'Bob', quantity: 2 });
      await checkouts.checkIn(checkout.id);
      const again = await checkouts.checkIn(checkout.id);
      expect(again.returnedAt).not.toBeNull();
      expect((await items.getById(itemId))?.quantity).toBe(5); // not double-restored
    });

    it('records the condition on return, updating the item and logging CONDITION_CHANGED (B2)', async () => {
      const drill = await items.create({ name: 'Hammer drill', quantity: 1, condition: 'MINT' });
      const checkout = await checkouts.checkout({ itemId: drill.id, contactName: 'Bob' });
      await checkouts.checkIn(checkout.id, { condition: 'NEEDS_REPAIR' });

      // The item's live condition now reflects how it came back...
      expect((await items.getById(drill.id))?.condition).toBe('NEEDS_REPAIR');
      // ...and the change is on the immutable ledger alongside the check-in.
      const history = await items.getHistory(drill.id);
      const changed = history.rows.find((h) => h.action === 'CONDITION_CHANGED');
      expect(changed).toBeDefined();
      expect(changed?.metadata).toMatchObject({ from: 'MINT', to: 'NEEDS_REPAIR' });
      expect(history.rows.some((h) => h.action === 'CHECKED_IN')).toBe(true);
    });

    it('records a condition on return even when the item had none set', async () => {
      const drill = await items.create({ name: 'Bare drill', quantity: 1 }); // no condition
      const checkout = await checkouts.checkout({ itemId: drill.id, contactName: 'Bob' });
      await checkouts.checkIn(checkout.id, { condition: 'GOOD' });
      expect((await items.getById(drill.id))?.condition).toBe('GOOD');
      const history = await items.getHistory(drill.id);
      expect(history.rows.some((h) => h.action === 'CONDITION_CHANGED')).toBe(true);
    });

    it('leaves the condition untouched and logs no CONDITION_CHANGED when none is given', async () => {
      const drill = await items.create({ name: 'Impact driver', quantity: 1, condition: 'GOOD' });
      const checkout = await checkouts.checkout({ itemId: drill.id, contactName: 'Bob' });
      await checkouts.checkIn(checkout.id, { note: 'back in the van' });

      expect((await items.getById(drill.id))?.condition).toBe('GOOD');
      const history = await items.getHistory(drill.id);
      expect(history.rows.some((h) => h.action === 'CONDITION_CHANGED')).toBe(false);
    });

    it('logs no CONDITION_CHANGED when the return re-affirms the same condition', async () => {
      const drill = await items.create({ name: 'Angle grinder', quantity: 1, condition: 'GOOD' });
      const checkout = await checkouts.checkout({ itemId: drill.id, contactName: 'Bob' });
      await checkouts.checkIn(checkout.id, { condition: 'GOOD' }); // unchanged

      expect((await items.getById(drill.id))?.condition).toBe('GOOD');
      const history = await items.getHistory(drill.id);
      expect(history.rows.some((h) => h.action === 'CONDITION_CHANGED')).toBe(false);
    });
  });

  describe('checkInAllForContact', () => {
    it('returns every open checkout for a contact, restoring stock and history', async () => {
      const drill = await makeItem('Drill', 3);
      const saw = await makeItem('Saw', 2);
      const bob = await contacts.resolveOrCreate('Bob');
      const first = await checkouts.checkout({ itemId: drill, contactId: bob.id, quantity: 1 });
      const second = await checkouts.checkout({ itemId: saw, contactId: bob.id, quantity: 2 });

      await checkouts.checkInAllForContact(bob.id);

      expect((await checkouts.getById(first.id))?.returnedAt).not.toBeNull();
      expect((await checkouts.getById(second.id))?.returnedAt).not.toBeNull();
      expect((await items.getById(drill))?.quantity).toBe(3);
      expect((await items.getById(saw))?.quantity).toBe(2);
      const drillHistory = await items.getHistory(drill);
      expect(drillHistory.rows.some((h) => h.action === 'CHECKED_IN')).toBe(true);
    });

    it('leaves already-returned checkouts and other contacts untouched', async () => {
      const drill = await makeItem('Drill', 3);
      const bob = await contacts.resolveOrCreate('Bob');
      const carol = await contacts.resolveOrCreate('Carol');
      const bobCheckout = await checkouts.checkout({ itemId: drill, contactId: bob.id, quantity: 1 });
      await checkouts.checkIn(bobCheckout.id);
      const carolCheckout = await checkouts.checkout({ itemId: drill, contactId: carol.id, quantity: 1 });

      await checkouts.checkInAllForContact(bob.id);

      expect((await checkouts.getById(carolCheckout.id))?.returnedAt).toBeNull();
      expect((await items.getById(drill))?.quantity).toBe(2); // Carol's unit still out
    });

    it('does nothing for a contact with no open checkouts', async () => {
      const bob = await contacts.resolveOrCreate('Bob');
      await expect(checkouts.checkInAllForContact(bob.id)).resolves.toBeUndefined();
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

  describe('overdue boundary (SSOT predicate)', () => {
    /** Count items the shared `overdueCheckoutExistsSql` predicate flags at instant `now`. */
    async function overdueItemCount(now: number): Promise<number> {
      const rows = await driver.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM items WHERE ${overdueCheckoutExistsSql()};`,
        [now],
      );
      return Number(rows[0]?.n ?? 0);
    }

    it('flags a loan due yesterday, but not one due later today (strict due_date < now)', async () => {
      const now = Date.now();
      const yesterdayId = await makeItem('Overdue drill', 3);
      const todayId = await makeItem('Due-later saw', 3);
      // Due yesterday → past its due date; due in an hour (still "today") → not yet due.
      await checkouts.checkout({ itemId: yesterdayId, contactName: 'Bob', dueDate: now - MS_PER_DAY });
      await checkouts.checkout({ itemId: todayId, contactName: 'Ada', dueDate: now + 60 * 60 * 1000 });

      // Row-level derived flag and the item-level SSOT predicate must agree on the boundary.
      const open = await checkouts.listOpen();
      const byName = Object.fromEntries(open.rows.map((r) => [r.itemName, r.isOverdue]));
      expect(byName['Overdue drill']).toBe(true);
      expect(byName['Due-later saw']).toBe(false);
      expect(await overdueItemCount(now)).toBe(1);
    });

    it('never flags an open-ended loan (no due date) as overdue', async () => {
      const now = Date.now();
      const itemId = await makeItem('Open-ended lend', 3);
      await checkouts.checkout({ itemId, contactName: 'Bob' }); // no dueDate
      const open = await checkouts.listOpen();
      expect(open.rows[0].isOverdue).toBe(false);
      expect(await overdueItemCount(now)).toBe(0);
    });

    it('stops flagging a loan once it is returned', async () => {
      const now = Date.now();
      const itemId = await makeItem('Returned late', 3);
      const checkout = await checkouts.checkout({
        itemId,
        contactName: 'Bob',
        dueDate: now - MS_PER_DAY,
      });
      expect(await overdueItemCount(now)).toBe(1);
      await checkouts.checkIn(checkout.id);
      expect(await overdueItemCount(now)).toBe(0);
    });
  });

  it('refuses checkout when storage is suspended (Hard Stop, §7.6.1)', async () => {
    const itemId = await makeItem('Drill', 3);
    const locked = new CheckoutRepository(driver, { isWriteSuspended: () => true });
    await expect(locked.checkout({ itemId, contactName: 'Bob' })).rejects.toBeInstanceOf(DbError);
  });
});
