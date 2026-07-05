import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { MS_PER_DAY } from './constants';
import { ItemRepository, buildStatusFilter } from './ItemRepository';
import { ContactRepository } from './ContactRepository';
import { CheckoutRepository } from './CheckoutRepository';
import { MaintenanceRepository } from './MaintenanceRepository';
import { CategoryRepository } from './CategoryRepository';
import { TagRepository } from './TagRepository';
import { LocationRepository } from './LocationRepository';

/** Format a UNIX-ms instant as the `YYYY-MM-DD` string the warranty column stores. */
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

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

  it('filters to out-of-stock items, excluding healthy, unlimited and abstract parents', async () => {
    await items.create({ name: 'ZeroDiscrete', trackingMode: 'DISCRETE', quantity: 0 });
    await items.create({
      name: 'EmptyGauge',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 0 },
    });
    await items.create({ name: 'Healthy', trackingMode: 'DISCRETE', quantity: 10 });
    // An unlimited source is never "out", even at zero on hand.
    const unlimited = await items.create({ name: 'Unlimited', trackingMode: 'DISCRETE', quantity: 0 });
    await items.update(unlimited.id, { isUnlimited: true });
    // An abstract parent holds no stock of its own — its variants do.
    const parent = await items.create({ name: 'AbstractParent', quantity: 0 });
    await items.createVariant(parent.id, { name: 'Variant', quantity: 3 });

    const page = await items.list({ status: ['out-of-stock'], now });
    expect(page.rows.map((r) => r.name).sort()).toEqual(['EmptyGauge', 'ZeroDiscrete']);
  });

  it('filters to items currently on loan (open checkout), overdue or not', async () => {
    const onTime = await items.create({ name: 'OnTime', trackingMode: 'DISCRETE', quantity: 5 });
    const late = await items.create({ name: 'Late', trackingMode: 'DISCRETE', quantity: 5 });
    await items.create({ name: 'Idle', trackingMode: 'DISCRETE', quantity: 5 });
    const ada = await contacts.resolveOrCreate('Ada');
    await checkouts.checkout({
      itemId: onTime.id,
      contactId: ada.id,
      quantity: 1,
      dueDate: base + 30 * MS_PER_DAY,
    });
    await checkouts.checkout({ itemId: late.id, contactId: ada.id, quantity: 1, dueDate: base - MS_PER_DAY });

    const page = await items.list({ status: ['on-loan'], now });
    expect(page.rows.map((r) => r.name).sort()).toEqual(['Late', 'OnTime']);
  });

  it('excludes a returned loan from on-loan', async () => {
    const returned = await items.create({ name: 'Returned', trackingMode: 'DISCRETE', quantity: 5 });
    const ada = await contacts.resolveOrCreate('Ada');
    const co = await checkouts.checkout({ itemId: returned.id, contactId: ada.id, quantity: 1 });
    await checkouts.checkIn(co.id);
    const page = await items.list({ status: ['on-loan'], now });
    expect(page.rows).toHaveLength(0);
  });

  it('filters to items whose warranty has expired or expires soon', async () => {
    await items.create({ name: 'WExpired', warrantyExpiresAt: isoDate(base - 2 * MS_PER_DAY) });
    await items.create({ name: 'WSoon', warrantyExpiresAt: isoDate(base + 10 * MS_PER_DAY) });
    await items.create({ name: 'WFar', warrantyExpiresAt: isoDate(base + 400 * MS_PER_DAY) });
    await items.create({ name: 'WNone' });

    const page = await items.list({ status: ['warranty'], now });
    expect(page.rows.map((r) => r.name).sort()).toEqual(['WExpired', 'WSoon']);
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

  it('reports which statuses currently match anything (filter-bar decluttering)', async () => {
    await seed();
    // Seed covers low-stock, expiring, overdue (also an open loan) and maintenance-due; the
    // expiring item is created with the default quantity 0, so it is out-of-stock too. No
    // warranty dates are set. Returned in canonical order.
    expect(await items.applicableStatuses({ now })).toEqual([
      'low-stock',
      'out-of-stock',
      'expiring',
      'on-loan',
      'overdue',
      'maintenance-due',
    ]);
  });

  it('reports no applicable statuses for an empty inventory', async () => {
    expect(await items.applicableStatuses({ now })).toEqual([]);
  });

  it('surfaces out-of-stock and warranty once such items exist', async () => {
    await items.create({ name: 'Zero', trackingMode: 'DISCRETE', quantity: 0 });
    await items.create({ name: 'Warranted', warrantyExpiresAt: isoDate(base - MS_PER_DAY) });
    const applicable = await items.applicableStatuses({ now });
    expect(applicable).toContain('out-of-stock');
    expect(applicable).toContain('warranty');
    expect(applicable).not.toContain('on-loan');
  });

  it('scopes applicability to a location, recomputed per selection', async () => {
    const locations = new LocationRepository(driver);
    const shed = await locations.create({ name: 'Shed' });
    const garage = await locations.create({ name: 'Garage' });
    // A low-stock part lives in the Shed; a perishable lives in the Garage.
    await items.create({
      name: 'ShedLow',
      trackingMode: 'DISCRETE',
      quantity: 1,
      reorderPoint: 5,
      locationId: shed.id,
    });
    await items.create({ name: 'GarageExp', expiryDate: base + 10 * MS_PER_DAY, locationId: garage.id });

    // Whole inventory: both concerns show.
    const all = await items.applicableStatuses({ now });
    expect(all).toContain('low-stock');
    expect(all).toContain('expiring');

    // Scoped to the Shed: only low-stock; the Garage's perishable is out of scope.
    const shedOnly = await items.applicableStatuses({ now, locationId: shed.id });
    expect(shedOnly).toContain('low-stock');
    expect(shedOnly).not.toContain('expiring');

    // Scoped to the Garage: only expiring (its item is qty-0, so also out-of-stock).
    const garageOnly = await items.applicableStatuses({ now, locationId: garage.id });
    expect(garageOnly).toContain('expiring');
    expect(garageOnly).not.toContain('low-stock');
  });

  it('only probes the candidate statuses it is given (disabled modules skipped)', async () => {
    await seed();
    // The caller (the hook) passes only the modules-enabled statuses. With every "attention"
    // module off, just the always-on core stock statuses are probed — so a matching
    // maintenance-due / overdue / on-loan item is never reported even though it exists.
    const coreOnly = await items.applicableStatuses({ now, candidates: ['low-stock', 'out-of-stock'] });
    expect(coreOnly).toEqual(['low-stock', 'out-of-stock']);
  });

  it('returns candidate matches in canonical order regardless of the candidate order', async () => {
    await seed();
    // Pass the candidates jumbled; the result is still in ITEM_STATUS_FILTERS order.
    const applicable = await items.applicableStatuses({
      now,
      candidates: ['maintenance-due', 'low-stock', 'overdue'],
    });
    expect(applicable).toEqual(['low-stock', 'overdue', 'maintenance-due']);
  });

  it('drops a matching status that is not among the candidates', async () => {
    await seed();
    // Maintenance is due in the seed, but with maintenance off it is not a candidate.
    const withoutMaintenance = await items.applicableStatuses({
      now,
      candidates: ['low-stock', 'out-of-stock', 'expiring', 'on-loan', 'overdue'],
    });
    expect(withoutMaintenance).not.toContain('maintenance-due');
    expect(withoutMaintenance).toContain('overdue');
  });

  it('returns nothing without a query when the candidate set is empty', async () => {
    await seed();
    expect(await items.applicableStatuses({ now, candidates: [] })).toEqual([]);
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

  it('composes the parameter-free statuses with the warranty date cutoff', () => {
    const [clause, params] = buildStatusFilter(['out-of-stock', 'warranty', 'on-loan'], ctx);
    // out-of-stock and on-loan bind nothing; warranty binds a single YYYY-MM-DD cutoff.
    expect(params).toHaveLength(1);
    expect(params[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(clause).toContain(' OR ');
  });
});

describe('ItemRepository.list — attribute facets (category & tags)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let categories: CategoryRepository;
  let tags: TagRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    categories = new CategoryRepository(driver);
    tags = new TagRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('filters by category', async () => {
    const resistors = await categories.create({ name: 'Resistors' });
    await items.create({ name: 'R1', categoryId: resistors.id });
    await items.create({ name: 'R2', categoryId: resistors.id });
    await items.create({ name: 'Uncategorised' });

    const page = await items.list({ categoryId: resistors.id });
    expect(page.rows.map((r) => r.name).sort()).toEqual(['R1', 'R2']);
  });

  it('filters by tags, matching any selected tag (OR within the facet)', async () => {
    const fragile = await items.create({ name: 'Fragile' });
    await tags.setForItem(fragile.id, ['fragile']);
    const electronic = await items.create({ name: 'Electronic' });
    await tags.setForItem(electronic.id, ['electronics']);
    const both = await items.create({ name: 'Both' });
    await tags.setForItem(both.id, ['fragile', 'electronics']);
    await items.create({ name: 'Untagged' });

    const dict = await tags.list();
    const id = (name: string) => dict.rows.find((t) => t.name === name)!.id;

    const single = await items.list({ tagIds: [id('fragile')] });
    expect(single.rows.map((r) => r.name).sort()).toEqual(['Both', 'Fragile']);

    const either = await items.list({ tagIds: [id('fragile'), id('electronics')] });
    expect(either.rows.map((r) => r.name).sort()).toEqual(['Both', 'Electronic', 'Fragile']);
  });

  it('ANDs a category facet with a tag facet', async () => {
    const cat = await categories.create({ name: 'Tools' });
    const inBoth = await items.create({ name: 'InBoth', categoryId: cat.id });
    await tags.setForItem(inBoth.id, ['loaner']);
    const catOnly = await items.create({ name: 'CatOnly', categoryId: cat.id });
    const tagOnly = await items.create({ name: 'TagOnly' });
    await tags.setForItem(tagOnly.id, ['loaner']);

    const dict = await tags.list();
    const loanerId = dict.rows.find((t) => t.name === 'loaner')!.id;

    const page = await items.list({ categoryId: cat.id, tagIds: [loanerId] });
    expect(page.rows.map((r) => r.name)).toEqual(['InBoth']);
    expect(catOnly.id).toBeTruthy(); // referenced to keep the seed intent explicit
  });
});
