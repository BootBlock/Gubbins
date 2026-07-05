import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { MS_PER_DAY } from './constants';
import { ItemRepository, buildStatusFilter } from './ItemRepository';
import { ContactRepository } from './ContactRepository';
import { CheckoutRepository } from './CheckoutRepository';
import { MaintenanceRepository } from './MaintenanceRepository';

/**
 * The inventory list's derived-status "attention" filters (spec §3 / §4): the item `list`
 * can be narrowed to Low stock / Expiring / Overdue / Maintenance due, reusing each
 * concept's SSOT predicate. `now` is injected here so the time-based statuses are
 * deterministic (production stamps `Date.now()` at query time).
 */
describe('ItemRepository.list — derived-status filters', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let contacts: ContactRepository;
  let checkouts: CheckoutRepository;
  let maintenance: MaintenanceRepository;

  // A filter clock two days ahead of creation, so a freshly-created TIME maintenance
  // schedule with a 1-day interval reads as due while a 30-day one does not.
  const base = Date.now();
  const now = base + 2 * MS_PER_DAY;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    contacts = new ContactRepository(driver);
    checkouts = new CheckoutRepository(driver);
    maintenance = new MaintenanceRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  /** Seed one item per status plus a healthy "matches nothing" control. */
  async function seed() {
    // Low stock: its own positive reorder point (opt-in) with on-hand at/below it.
    const low = await items.create({
      name: 'LowOnly',
      trackingMode: 'DISCRETE',
      quantity: 1,
      reorderPoint: 5,
    });
    // Expiring: perishable due in 10 days (inside the default 30-day window).
    const expiring = await items.create({ name: 'ExpiringOnly', expiryDate: base + 10 * MS_PER_DAY });
    // Overdue: an open checkout whose due date is already in the past.
    const overdue = await items.create({ name: 'OverdueOnly', trackingMode: 'DISCRETE', quantity: 5 });
    const ada = await contacts.resolveOrCreate('Ada');
    await checkouts.checkout({
      itemId: overdue.id,
      contactId: ada.id,
      quantity: 1,
      dueDate: base - MS_PER_DAY,
    });
    // Maintenance due: a TIME schedule that falls due one day after creation.
    const maint = await items.create({ name: 'MaintOnly', trackingMode: 'DISCRETE', quantity: 3 });
    await maintenance.create({ itemId: maint.id, name: 'Calibrate', basis: 'TIME', intervalDays: 1 });
    // Control: healthy, not perishable, not on loan, no schedule.
    const plenty = await items.create({ name: 'Plenty', trackingMode: 'DISCRETE', quantity: 100 });

    return { low, expiring, overdue, maint, plenty };
  }

  it('filters to low-stock items only', async () => {
    await seed();
    const page = await items.list({ status: ['low-stock'], now });
    expect(page.rows.map((r) => r.name)).toEqual(['LowOnly']);
  });

  it('filters to expiring items only', async () => {
    await seed();
    const page = await items.list({ status: ['expiring'], now });
    expect(page.rows.map((r) => r.name)).toEqual(['ExpiringOnly']);
  });

  it('filters to overdue (past-due open checkout) items only', async () => {
    await seed();
    const page = await items.list({ status: ['overdue'], now });
    expect(page.rows.map((r) => r.name)).toEqual(['OverdueOnly']);
  });

  it('excludes an on-time or returned loan from overdue', async () => {
    const onTime = await items.create({ name: 'OnTime', trackingMode: 'DISCRETE', quantity: 5 });
    const bob = await contacts.resolveOrCreate('Bob');
    // Due comfortably in the future → not overdue at `now`.
    await checkouts.checkout({
      itemId: onTime.id,
      contactId: bob.id,
      quantity: 1,
      dueDate: base + 30 * MS_PER_DAY,
    });

    const returned = await items.create({ name: 'Returned', trackingMode: 'DISCRETE', quantity: 5 });
    const co = await checkouts.checkout({
      itemId: returned.id,
      contactId: bob.id,
      quantity: 1,
      dueDate: base - MS_PER_DAY,
    });
    await checkouts.checkIn(co.id);

    const page = await items.list({ status: ['overdue'], now });
    expect(page.rows).toHaveLength(0);
  });

  it('filters to maintenance-due items only', async () => {
    await seed();
    const page = await items.list({ status: ['maintenance-due'], now });
    expect(page.rows.map((r) => r.name)).toEqual(['MaintOnly']);
  });

  it('does not flag a maintenance schedule that is not yet due', async () => {
    const item = await items.create({ name: 'FreshlyServiced', trackingMode: 'DISCRETE', quantity: 3 });
    await maintenance.create({ itemId: item.id, name: 'Annual', basis: 'TIME', intervalDays: 30 });
    const page = await items.list({ status: ['maintenance-due'], now });
    expect(page.rows).toHaveLength(0);
  });

  it('OR-combines multiple statuses (any concern matches), excluding the healthy control', async () => {
    await seed();
    const page = await items.list({
      status: ['low-stock', 'expiring', 'overdue', 'maintenance-due'],
      now,
    });
    expect(page.rows.map((r) => r.name).sort()).toEqual([
      'ExpiringOnly',
      'LowOnly',
      'MaintOnly',
      'OverdueOnly',
    ]);
  });

  it('combines a status filter with the location scope (AND)', async () => {
    const { expiring } = await seed();
    // Only the expiring item, and only if it is in its own location.
    const scoped = await items.list({ status: ['expiring'], locationId: expiring.locationId, now });
    expect(scoped.rows.map((r) => r.name)).toEqual(['ExpiringOnly']);
    // A different (empty) location yields nothing even though the item is expiring.
    const elsewhere = await items.list({ status: ['expiring'], locationId: 'no-such-location', now });
    expect(elsewhere.rows).toHaveLength(0);
  });

  it('an empty status list applies no filtering', async () => {
    await seed();
    const all = await items.list({ status: [], now });
    expect(all.rows).toHaveLength(5);
  });

  it('count() honours the status filter', async () => {
    await seed();
    expect(await items.count({ status: ['low-stock'], now })).toBe(1);
    expect(await items.count({ status: ['low-stock', 'expiring'], now })).toBe(2);
  });
});

describe('buildStatusFilter — pure composer', () => {
  const ctx = { now: 1_700_000_000_000 };

  it('returns an empty clause for no statuses', () => {
    expect(buildStatusFilter([], ctx)).toEqual(['', []]);
  });

  it('emits statuses in canonical order regardless of selection order', () => {
    const [clause] = buildStatusFilter(['overdue', 'low-stock'], ctx);
    // low-stock (a quantity predicate) is emitted before overdue (an EXISTS subquery).
    expect(clause.indexOf('quantity')).toBeLessThan(clause.indexOf('checkouts'));
    // The whole group is parenthesised and OR-combined.
    expect(clause.startsWith('(')).toBe(true);
    expect(clause).toContain(' OR ');
  });

  it('binds the expiry cutoff and the checkout/maintenance clock', () => {
    const [, params] = buildStatusFilter(['expiring', 'overdue', 'maintenance-due'], {
      now: 1_000,
      expirySoonWindowDays: 30,
    });
    // expiring cutoff (now + 30d), then overdue now, then maintenance now×2.
    expect(params).toEqual([1_000 + 30 * MS_PER_DAY, 1_000, 1_000, 1_000]);
  });
});
