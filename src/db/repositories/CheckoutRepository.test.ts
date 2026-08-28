import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { runMigrations } from '@/db/migrations';
import { migrations } from '@/db/migrations/index';
import { MS_PER_DAY, SYSTEM_USER_ID } from './constants';
import { CheckoutRepository, overdueCheckoutExistsSql } from './CheckoutRepository';
import { checkInId, planCheckIn } from './checkout-plan';
import { ContactRepository } from './ContactRepository';
import { ItemRepository } from './ItemRepository';
import { ProjectRepository } from './ProjectRepository';
import { LocationRepository } from './LocationRepository';

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

    it('refuses to lend an item that has been removed from active inventory (#661)', async () => {
      const itemId = await makeItem('Retired drill', 1);
      await items.softDelete(itemId);

      await expect(checkouts.checkout({ itemId, contactName: 'Bob' })).rejects.toThrow(/decommissioned/i);
      // The refusal is a guard, not a partial write: stock is untouched and no loan was opened.
      expect((await items.getById(itemId))?.quantity).toBe(1);
      expect((await checkouts.listOpen()).rows).toHaveLength(0);
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

    it('derives the CHECKED_IN entry and its stock movement from the loan so two devices converge', async () => {
      const itemId = await makeItem('Torque wrench', 1);
      const checkout = await checkouts.checkout({ itemId, contactName: 'Bob' });
      await checkouts.checkIn(checkout.id);

      // Both are pure functions of the loan's own id, not fresh random ones — the property that
      // makes two devices returning the same loan offline give the unit back once (issue #542).
      const entry = (await items.getHistory(itemId)).rows.find((h) => h.action === 'CHECKED_IN');
      expect(entry?.id).toBe(await checkInId('hist:CHECKED_IN', checkout.id));
      const delta = await driver.queryOne<{ id: string }>(
        'SELECT id FROM stock_deltas WHERE item_id = ? AND quantity_delta > 0 ORDER BY created_at DESC LIMIT 1;',
        [itemId],
      );
      expect(delta?.id).toContain(await checkInId('stock', checkout.id));
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

    it('collapses two returns that race past the read guard to one physical return (#296)', async () => {
      const itemId = await makeItem('Clamp meter', 5);
      const checkout = await checkouts.checkout({ itemId, contactName: 'Bob', quantity: 2 });
      expect((await items.getById(itemId))?.quantity).toBe(3);

      // The TOCTOU race: two check-ins each read the still-open loan (both see returned_at ===
      // null) before either writes — the worker never pairs a repository read with its later
      // transaction. Planning twice against the pre-write state captures exactly that, then both
      // transactions run in sequence as the serialised worker would apply them.
      const first = await planCheckIn(driver, checkout.id, SYSTEM_USER_ID);
      const second = await planCheckIn(driver, checkout.id, SYSTEM_USER_ID);
      await driver.transaction(first);
      await driver.transaction(second);

      // The loser no-ops at the database: stock is restored once and only one CHECKED_IN is logged.
      expect((await items.getById(itemId))?.quantity).toBe(5);
      const history = await items.getHistory(itemId);
      expect(history.rows.filter((h) => h.action === 'CHECKED_IN')).toHaveLength(1);
      expect((await checkouts.getById(checkout.id))?.returnedAt).not.toBeNull();
    });

    it('does not double-apply the condition change when two returns race (#296)', async () => {
      const drill = await items.create({ name: 'Hammer drill', quantity: 1, condition: 'MINT' });
      const checkout = await checkouts.checkout({ itemId: drill.id, contactName: 'Bob' });

      const first = await planCheckIn(driver, checkout.id, SYSTEM_USER_ID, { condition: 'NEEDS_REPAIR' });
      const second = await planCheckIn(driver, checkout.id, SYSTEM_USER_ID, { condition: 'NEEDS_REPAIR' });
      await driver.transaction(first);
      await driver.transaction(second);

      expect((await items.getById(drill.id))?.condition).toBe('NEEDS_REPAIR');
      const history = await items.getHistory(drill.id);
      expect(history.rows.filter((h) => h.action === 'CONDITION_CHANGED')).toHaveLength(1);
      expect(history.rows.filter((h) => h.action === 'CHECKED_IN')).toHaveLength(1);
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

  describe('renew (change due date in place, B3)', () => {
    it('updates the due date in place, preserving checked_out_at and the loan note', async () => {
      const itemId = await makeItem('Torque wrench', 1);
      const originalDue = Date.now() + MS_PER_DAY;
      const checkout = await checkouts.checkout({
        itemId,
        contactName: 'Bob',
        note: 'for the Henderson job',
        dueDate: originalDue,
      });

      const newDue = Date.now() + 14 * MS_PER_DAY;
      const renewed = await checkouts.renew(checkout.id, { dueDate: newDue });

      expect(renewed.dueDate).toBe(newDue);
      // The loan keeps its identity — same open row, original checkout timestamp and loan note.
      expect(renewed.returnedAt).toBeNull();
      expect(renewed.checkedOutAt).toBe(checkout.checkedOutAt);
      expect(renewed.note).toBe('for the Henderson job');
    });

    it('logs a LOAN_RENEWED history row recording the old → new due date', async () => {
      const itemId = await makeItem('Drill', 1);
      const originalDue = Date.now() + MS_PER_DAY;
      const checkout = await checkouts.checkout({ itemId, contactName: 'Bob', dueDate: originalDue });
      const newDue = Date.now() + 30 * MS_PER_DAY;
      await checkouts.renew(checkout.id, { dueDate: newDue });

      const history = await items.getHistory(itemId);
      const renewed = history.rows.find((h) => h.action === 'LOAN_RENEWED');
      expect(renewed).toBeDefined();
      expect(renewed?.metadata).toMatchObject({ from: originalDue, to: newDue, checkoutId: checkout.id });
    });

    it('clears the due date to null (an open-ended loan is a valid renew)', async () => {
      const itemId = await makeItem('Clamp meter', 1);
      const checkout = await checkouts.checkout({
        itemId,
        contactName: 'Bob',
        dueDate: Date.now() + MS_PER_DAY,
      });
      const renewed = await checkouts.renew(checkout.id, { dueDate: null });
      expect(renewed.dueDate).toBeNull();
    });

    it('can set a due date on a loan that started open-ended', async () => {
      const itemId = await makeItem('Saw', 1);
      const checkout = await checkouts.checkout({ itemId, contactName: 'Bob' }); // no dueDate
      const newDue = Date.now() + 7 * MS_PER_DAY;
      const renewed = await checkouts.renew(checkout.id, { dueDate: newDue });
      expect(renewed.dueDate).toBe(newDue);
    });

    it('throws when the checkout does not exist', async () => {
      await expect(checkouts.renew('does-not-exist', { dueDate: Date.now() })).rejects.toBeInstanceOf(
        DbError,
      );
    });

    it('throws when the loan has already been returned (a closed loan cannot be renewed)', async () => {
      const itemId = await makeItem('Multimeter', 1);
      const checkout = await checkouts.checkout({ itemId, contactName: 'Bob' });
      await checkouts.checkIn(checkout.id);
      await expect(checkouts.renew(checkout.id, { dueDate: Date.now() })).rejects.toBeInstanceOf(DbError);
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

    it('accumulates two loans of the same item planned together (issue #301)', async () => {
      // Both returns are planned against the same pre-transaction state, so a plan that *set*
      // the quantity rather than adding to it would silently lose one loan's units.
      const drill = await makeItem('Drill', 5);
      const bob = await contacts.resolveOrCreate('Bob');
      await checkouts.checkout({ itemId: drill, contactId: bob.id, quantity: 2 });
      await checkouts.checkout({ itemId: drill, contactId: bob.id, quantity: 1 });
      expect((await items.getById(drill))?.quantity).toBe(2);

      await checkouts.checkInAllForContact(bob.id);

      expect((await items.getById(drill))?.quantity).toBe(5);
    });
  });

  describe('borrower deletes are atomic with their returns (issue #301)', () => {
    it('deleting a contact returns their loans in the same transaction', async () => {
      const drill = await makeItem('Drill', 3);
      const bob = await contacts.resolveOrCreate('Bob');
      const loan = await checkouts.checkout({ itemId: drill, contactId: bob.id, quantity: 2 });
      expect((await items.getById(drill))?.quantity).toBe(1);

      await contacts.delete(bob.id);

      expect(await contacts.getById(bob.id)).toBeUndefined();
      expect(await checkouts.getById(loan.id)).toBeUndefined(); // cascaded away, but returned first
      expect((await items.getById(drill))?.quantity).toBe(3);
      const history = await items.getHistory(drill);
      expect(history.rows.some((h) => h.action === 'CHECKED_IN')).toBe(true);
    });

    it('leaves the loans untouched when the delete itself fails', async () => {
      const drill = await makeItem('Drill', 3);
      const bob = await contacts.resolveOrCreate('Bob');
      const loan = await checkouts.checkout({ itemId: drill, contactId: bob.id, quantity: 2 });

      // Force the delete half to fail; the whole transaction — returns included — must roll back.
      const original = driver.transaction.bind(driver);
      driver.transaction = async () => {
        throw new DbError('TRANSACTION_FAILED', 'simulated failure');
      };
      await expect(contacts.delete(bob.id)).rejects.toBeInstanceOf(DbError);
      driver.transaction = original;

      expect(await contacts.getById(bob.id)).toBeDefined();
      expect((await checkouts.getById(loan.id))?.returnedAt).toBeNull();
      expect((await items.getById(drill))?.quantity).toBe(1); // stock still out, not force-returned
    });

    it('deleting a project returns the tools still out on it', async () => {
      const projects = new ProjectRepository(driver);
      const saw = await makeItem('Saw', 4);
      const project = await projects.create({ name: 'Shed rebuild' });
      const loan = await checkouts.checkout({ itemId: saw, projectId: project.id, quantity: 3 });
      expect((await items.getById(saw))?.quantity).toBe(1);

      await projects.delete(project.id);

      expect(await checkouts.getById(loan.id)).toBeUndefined();
      expect((await items.getById(saw))?.quantity).toBe(4);
    });

    it('deleting a location returns the tools borrowed by it', async () => {
      const locations = new LocationRepository(driver);
      const van = await locations.create({ name: 'Van' });
      const saw = await makeItem('Saw', 4);
      const loan = await checkouts.checkout({ itemId: saw, locationId: van.id, quantity: 3 });
      expect((await items.getById(saw))?.quantity).toBe(1);

      await locations.delete(van.id);

      expect(await checkouts.getById(loan.id)).toBeUndefined();
      expect((await items.getById(saw))?.quantity).toBe(4);
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
      expect(open.rows[0].borrowerName).toBe('Bob');
      expect(open.rows[0].borrowerType).toBe('contact');
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

  // --- B4: polymorphic borrower (loan to a project or location) --------------------
  describe('borrower is a project or location (B4)', () => {
    let projects: ProjectRepository;
    let locations: LocationRepository;

    beforeEach(() => {
      projects = new ProjectRepository(driver);
      locations = new LocationRepository(driver);
    });

    it('checks a tool out to a project — stock decrements, borrower joins by name', async () => {
      const itemId = await makeItem('Impact driver', 5);
      const project = await projects.create({ name: 'Henderson job' });

      const checkout = await checkouts.checkout({ itemId, projectId: project.id, quantity: 2 });

      expect(checkout.borrowerType).toBe('project');
      expect(checkout.projectId).toBe(project.id);
      expect(checkout.contactId).toBeNull();
      expect(checkout.locationId).toBeNull();
      expect((await items.getById(itemId))?.quantity).toBe(3);

      const open = await checkouts.listForProject(project.id);
      expect(open.rows).toHaveLength(1);
      expect(open.rows[0].borrowerName).toBe('Henderson job');
      expect(open.rows[0].borrowerType).toBe('project');

      // The ledger note names the project, not a contact.
      const history = await items.getHistory(itemId);
      const out = history.rows.find((h) => h.action === 'CHECKED_OUT');
      expect(out?.note).toContain('Henderson job');
    });

    it('checks a tool out to a location ("in the van")', async () => {
      const itemId = await makeItem('Torque wrench', 1);
      const van = await locations.create({ name: 'The van' });

      const checkout = await checkouts.checkout({ itemId, locationId: van.id });

      expect(checkout.borrowerType).toBe('location');
      expect(checkout.locationId).toBe(van.id);
      const open = await checkouts.listForLocation(van.id);
      expect(open.rows).toHaveLength(1);
      expect(open.rows[0].borrowerName).toBe('The van');
    });

    it('rejects a checkout with no borrower', async () => {
      const itemId = await makeItem('Sander', 2);
      await expect(checkouts.checkout({ itemId })).rejects.toBeInstanceOf(DbError);
    });

    it('rejects a checkout with more than one borrower target', async () => {
      const itemId = await makeItem('Router', 2);
      const project = await projects.create({ name: 'Job A' });
      await expect(
        checkouts.checkout({ itemId, contactName: 'Bob', projectId: project.id }),
      ).rejects.toBeInstanceOf(DbError);
    });

    it('rejects a checkout to a non-existent project / location', async () => {
      const itemId = await makeItem('Level', 2);
      await expect(checkouts.checkout({ itemId, projectId: 'nope' })).rejects.toBeInstanceOf(DbError);
      await expect(checkouts.checkout({ itemId, locationId: 'nope' })).rejects.toBeInstanceOf(DbError);
    });

    it('checks in and renews a project loan regardless of target type', async () => {
      const itemId = await makeItem('Nail gun', 4);
      const project = await projects.create({ name: 'Deck build' });
      const checkout = await checkouts.checkout({ itemId, projectId: project.id, quantity: 2 });

      const due = Date.now() + 7 * MS_PER_DAY;
      const renewed = await checkouts.renew(checkout.id, { dueDate: due });
      expect(renewed.dueDate).toBe(due);

      const returned = await checkouts.checkIn(checkout.id, { note: 'back from the deck' });
      expect(returned.returnedAt).not.toBeNull();
      expect(returned.returnNote).toBe('back from the deck');
      expect((await items.getById(itemId))?.quantity).toBe(4); // stock restored
    });

    it('checkInAllForTarget returns every open loan for a project (delete safety net)', async () => {
      const drill = await makeItem('Drill', 3);
      const saw = await makeItem('Saw', 2);
      const project = await projects.create({ name: 'Big job' });
      const first = await checkouts.checkout({ itemId: drill, projectId: project.id, quantity: 1 });
      const second = await checkouts.checkout({ itemId: saw, projectId: project.id, quantity: 2 });

      await checkouts.checkInAllForTarget('project', project.id);

      expect((await checkouts.getById(first.id))?.returnedAt).not.toBeNull();
      expect((await checkouts.getById(second.id))?.returnedAt).not.toBeNull();
      expect((await items.getById(drill))?.quantity).toBe(3);
      expect((await items.getById(saw))?.quantity).toBe(2);
    });

    it('cascades checkout rows when the borrower project is deleted', async () => {
      const itemId = await makeItem('Saw', 2);
      const project = await projects.create({ name: 'Doomed job' });
      const checkout = await checkouts.checkout({ itemId, projectId: project.id, quantity: 1 });

      // Simulate the app's return-then-cascade (the hook returns open loans first), then delete.
      await checkouts.checkInAllForTarget('project', project.id);
      await projects.delete(project.id);

      expect(await checkouts.getById(checkout.id)).toBeUndefined();
    });

    it('cascades checkout rows when the borrower location is deleted', async () => {
      const itemId = await makeItem('Ladder', 2);
      const van = await locations.create({ name: 'Old van' });
      const checkout = await checkouts.checkout({ itemId, locationId: van.id, quantity: 1 });

      await checkouts.checkInAllForTarget('location', van.id);
      await locations.delete(van.id);

      expect(await checkouts.getById(checkout.id)).toBeUndefined();
    });
  });
});
