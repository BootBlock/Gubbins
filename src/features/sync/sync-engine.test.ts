import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import {
  CheckoutRepository,
  ContactRepository,
  ItemRepository,
  LocationRepository,
  MaintenanceRepository,
  ProjectRepository,
  PurchaseOrderRepository,
  SupplierPartRepository,
  TagRepository,
  UNASSIGNED_LOCATION_ID,
} from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import { runSync, needsFullResync, TOMBSTONE_TTL_MS } from './sync-engine';

async function makeDevice(): Promise<{
  driver: MemoryDriver;
  items: ItemRepository;
  locations: LocationRepository;
  tags: TagRepository;
  contacts: ContactRepository;
  checkouts: CheckoutRepository;
  maintenance: MaintenanceRepository;
  projects: ProjectRepository;
  supplierParts: SupplierPartRepository;
  purchaseOrders: PurchaseOrderRepository;
}> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  return {
    driver,
    items: new ItemRepository(driver),
    locations: new LocationRepository(driver),
    tags: new TagRepository(driver),
    contacts: new ContactRepository(driver),
    checkouts: new CheckoutRepository(driver),
    maintenance: new MaintenanceRepository(driver),
    projects: new ProjectRepository(driver),
    supplierParts: new SupplierPartRepository(driver),
    purchaseOrders: new PurchaseOrderRepository(driver),
  };
}

const NO_QUOTA = { skipQuotaCheck: true } as const;

describe('runSync round-trip (§7.3)', () => {
  let a: Awaited<ReturnType<typeof makeDevice>>;
  let b: Awaited<ReturnType<typeof makeDevice>>;
  let provider: MemoryCloudProvider;

  beforeEach(async () => {
    a = await makeDevice();
    b = await makeDevice();
    provider = new MemoryCloudProvider();
  });

  afterEach(async () => {
    await a.driver.close();
    await b.driver.close();
  });

  it('publishes on first sync, then a peer pulls the new rows', async () => {
    const item = await a.items.create({ name: 'ESP32', locationId: UNASSIGNED_LOCATION_ID });
    const first = await runSync(a.driver, provider, NO_QUOTA);
    expect(first.status).toBe('PUBLISHED');

    const pull = await runSync(b.driver, provider, NO_QUOTA);
    expect(pull.status).toBe('SYNCED');
    expect(pull.pulled).toBeGreaterThanOrEqual(1);
    expect((await b.items.getById(item.id))?.name).toBe('ESP32');
  });

  it('round-trips the per-location stock ledger to a peer (Phase 25)', async () => {
    const drawerA = await a.locations.create({ name: 'Drawer A' });
    const drawerB = await a.locations.create({ name: 'Drawer B' });
    const item = await a.items.create({ name: 'Resistor', quantity: 100, locationId: drawerA.id });
    await a.items.transferStock(item.id, drawerA.id, drawerB.id, 40); // 60 @ A, 40 @ B
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // The derived total and the full per-location split both arrive on B.
    expect((await b.items.getById(item.id))?.quantity).toBe(100);
    const placements = await b.items.listStock(item.id);
    const byName = new Map(placements.map((p) => [p.locationName, p.quantity]));
    expect(byName.get('Drawer A')).toBe(60);
    expect(byName.get('Drawer B')).toBe(40);
  });

  it('round-trips a per-location checkout source to a peer (Phase 26)', async () => {
    const drawerA = await a.locations.create({ name: 'Drawer A' });
    const drawerB = await a.locations.create({ name: 'Drawer B' });
    const item = await a.items.create({ name: 'Drill', quantity: 10, locationId: drawerA.id });
    await a.items.transferStock(item.id, drawerA.id, drawerB.id, 4); // 6 @ A, 4 @ B
    const loan = await a.checkouts.checkout({
      itemId: item.id,
      contactName: 'Sam',
      quantity: 3,
      fromLocationId: drawerB.id,
    });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // The lend-from location syncs as an ordinary LWW column on the checkout row.
    expect((await b.checkouts.getById(loan.id))?.sourceLocationId).toBe(drawerB.id);
  });

  it('nulls an incoming checkout source whose location did not survive the merge (§7.5)', async () => {
    const drawerA = await a.locations.create({ name: 'Drawer A' });
    const drawerB = await a.locations.create({ name: 'Drawer B' });
    const item = await a.items.create({ name: 'Drill', quantity: 10, locationId: drawerA.id });
    await a.items.transferStock(item.id, drawerA.id, drawerB.id, 4);
    const loan = await a.checkouts.checkout({
      itemId: item.id,
      contactName: 'Sam',
      quantity: 3,
      fromLocationId: drawerB.id,
    });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // A deletes the source location (nulling its own pointer) and pushes; B, which holds the
    // checkout still pointing at B's id, must drop the dangling source rather than trip the FK.
    await a.locations.delete(drawerB.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect(await b.locations.getById(drawerB.id)).toBeUndefined();
    expect((await b.checkouts.getById(loan.id))?.sourceLocationId).toBeNull();
  });

  it('round-trips a per-location maintenance schedule scope to a peer (Phase 30)', async () => {
    const bench = await a.locations.create({ name: 'Workshop bench' });
    const tool = await a.items.create({ name: 'Lathe', locationId: bench.id });
    const sched = await a.maintenance.create({
      itemId: tool.id,
      name: 'Bench calibrate',
      basis: 'TIME',
      intervalDays: 30,
      locationId: bench.id,
    });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // The scope location syncs as an ordinary LWW column on the schedule row.
    const onB = await b.maintenance.getById(sched.id);
    expect(onB?.locationId).toBe(bench.id);
    expect(onB?.locationName).toBe('Workshop bench');
  });

  it('nulls an incoming maintenance scope whose location did not survive the merge (§7.5)', async () => {
    const bench = await a.locations.create({ name: 'Workshop bench' });
    const tool = await a.items.create({ name: 'Lathe', locationId: bench.id });
    const sched = await a.maintenance.create({
      itemId: tool.id,
      name: 'Bench calibrate',
      basis: 'TIME',
      intervalDays: 30,
      locationId: bench.id,
    });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // A deletes the scope location (nulling its own pointer) and pushes; B, still holding the
    // schedule pointing at the bench, must clear the dangling scope rather than trip the FK.
    await a.locations.delete(bench.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect(await b.locations.getById(bench.id)).toBeUndefined();
    const onB = await b.maintenance.getById(sched.id);
    expect(onB).toBeDefined(); // the schedule survives — it just reverts to item-level
    expect(onB?.locationId).toBeNull();
  });

  it('round-trips a project budget, its categories and its expense ledger (Phase 58)', async () => {
    const project = await a.projects.create({ name: 'Synth', budget: 500 });
    const cat = await a.projects.addBudgetCategory(project.id, { name: 'Parts', amount: 300 });
    await a.projects.addExpense(project.id, {
      description: 'PCB order',
      amount: 95,
      categoryId: cat.id,
    });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect((await b.projects.getById(project.id))?.budget).toBe(500);
    const onB = await b.projects.getBudget(project.id);
    expect(onB.manualExpenseTotal).toBe(95);
    expect(onB.categories).toHaveLength(1);
    expect(onB.categories[0]).toMatchObject({ name: 'Parts', amount: 300, spent: 95 });
  });

  it('propagates a project deletion, cascading its categories and expenses to the peer (Phase 58)', async () => {
    const project = await a.projects.create({ name: 'Scrapped', budget: 100 });
    const cat = await a.projects.addBudgetCategory(project.id, { name: 'Parts', amount: 50 });
    await a.projects.addExpense(project.id, { amount: 20, categoryId: cat.id });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.projects.getById(project.id)).toBeDefined();

    await a.projects.delete(project.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect(await b.projects.getById(project.id)).toBeUndefined();
    const cats = await b.driver.query('SELECT id FROM project_budget_categories WHERE project_id = ?;', [
      project.id,
    ]);
    const exps = await b.driver.query('SELECT id FROM project_expenses WHERE project_id = ?;', [project.id]);
    expect(cats).toHaveLength(0);
    expect(exps).toHaveLength(0);
  });

  it('un-categorises an incoming expense whose category did not survive the merge (Phase 58)', async () => {
    const project = await a.projects.create({ name: 'Build', budget: 100 });
    const cat = await a.projects.addBudgetCategory(project.id, { name: 'Shipping', amount: 50 });
    const expense = await a.projects.addExpense(project.id, {
      description: 'Courier',
      amount: 12,
      categoryId: cat.id,
    });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // A removes the category (its own expense is SET NULL locally) and pushes; B, still holding
    // the expense pointing at the category, must clear the dangling reference rather than trip
    // the FK — the spend survives, now uncategorised.
    await a.projects.removeBudgetCategory(cat.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    const onB = await b.projects.getBudget(project.id);
    expect(onB.manualExpenseTotal).toBe(12);
    expect(onB.uncategorisedExpenseTotal).toBe(12);
    const ledger = await b.projects.listExpenses(project.id);
    expect(ledger.rows.find((e) => e.id === expense.id)?.categoryId).toBeNull();
  });

  it('round-trips a supplier part to a peer and resolves a concurrent edit by LWW (Phase 60)', async () => {
    const item = await a.items.create({ name: 'Resistor', locationId: UNASSIGNED_LOCATION_ID });
    const sp = await a.supplierParts.create(item.id, {
      supplierName: 'DigiKey',
      orderCode: 'RES-1',
      unitCost: 0.1,
      isPreferred: true,
    });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    const onB = (await b.supplierParts.listForItem(item.id))[0];
    expect(onB?.supplierName).toBe('DigiKey');
    expect(onB?.orderCode).toBe('RES-1');
    expect(onB?.isPreferred).toBe(true);

    // B edits the order code later than A's last write, then both sync — A adopts B's value.
    await b.supplierParts.update(sp.id, { orderCode: 'RES-1-REV-B' });
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);
    expect((await a.supplierParts.getById(sp.id))?.orderCode).toBe('RES-1-REV-B');
  });

  it('drops an incoming supplier part whose item did not survive the merge (§7.5)', async () => {
    const item = await a.items.create({ name: 'Doomed', locationId: UNASSIGNED_LOCATION_ID });
    await a.supplierParts.create(item.id, { supplierName: 'RS' });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.supplierParts.listForItem(item.id)).toHaveLength(1);

    // A hard-deletes the item (cascading its supplier parts, leaving only the item tombstone)
    // and pushes; B, still holding the orphaned supplier part, must drop it rather than trip
    // the item FK on apply.
    await a.items.hardDelete(item.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect(await b.items.getById(item.id)).toBeUndefined();
    expect(await b.supplierParts.listForItem(item.id)).toHaveLength(0);
  });

  it('round-trips a purchase order and its lines to a peer, resolving a concurrent edit by LWW (Phase 62)', async () => {
    const item = await a.items.create({ name: 'ESP32', locationId: UNASSIGNED_LOCATION_ID });
    const po = await a.purchaseOrders.create({ supplierName: 'DigiKey', reference: 'PO-100' });
    const line = await a.purchaseOrders.addLine(po.id, { itemId: item.id, orderedQty: 10 });
    await a.purchaseOrders.setStatus(po.id, 'ORDERED');
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    const onB = await b.purchaseOrders.getWithLines(po.id);
    expect(onB?.supplierName).toBe('DigiKey');
    expect(onB?.reference).toBe('PO-100');
    expect(onB?.status).toBe('ORDERED');
    expect(onB?.lines).toHaveLength(1);
    expect(onB?.lines[0]?.orderedQty).toBe(10);

    // B edits the reference later than A's last write, then both sync — A adopts B's value.
    await b.purchaseOrders.update(po.id, { reference: 'PO-100-REV-B' });
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);
    expect((await a.purchaseOrders.getById(po.id))?.reference).toBe('PO-100-REV-B');

    // A removed supplier part (here the line carries none) is covered separately; an
    // unrelated line edit still round-trips.
    await b.purchaseOrders.updateLine(line.id, { orderedQty: 12 });
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);
    expect((await a.purchaseOrders.getLine(line.id))?.orderedQty).toBe(12);
  });

  it('NULLs a PO line supplier_part_id whose supplier part did not survive the merge (§7.5 SET NULL)', async () => {
    const item = await a.items.create({ name: 'Resistor', locationId: UNASSIGNED_LOCATION_ID });
    const sp = await a.supplierParts.create(item.id, { supplierName: 'RS', orderCode: 'R-1' });
    const po = await a.purchaseOrders.create({ supplierName: 'RS' });
    const line = await a.purchaseOrders.addLine(po.id, {
      itemId: item.id,
      supplierPartId: sp.id,
      orderedQty: 5,
    });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect((await b.purchaseOrders.getLine(line.id))?.supplierPartId).toBe(sp.id);

    // A deletes the supplier part (tombstoned) and pushes; B, still holding the line that
    // references it, must NULL the link rather than trip the FK on apply.
    await a.supplierParts.delete(sp.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    const onB = await b.purchaseOrders.getLine(line.id);
    expect(onB).toBeDefined();
    expect(onB?.supplierPartId).toBeNull();
    // The line itself survives (the order is real).
    expect(await b.purchaseOrders.getById(po.id)).toBeDefined();
  });

  it('drops PO lines whose order did not survive the merge (§7.5 CASCADE)', async () => {
    const item = await a.items.create({ name: 'Diode', locationId: UNASSIGNED_LOCATION_ID });
    const po = await a.purchaseOrders.create({ supplierName: 'Mouser' });
    const line = await a.purchaseOrders.addLine(po.id, { itemId: item.id, orderedQty: 3 });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.purchaseOrders.listLines(po.id)).toHaveLength(1);

    // A hard-deletes the whole PO (cascading its lines, leaving only the PO + line tombstones)
    // and pushes; B, still holding the orphaned line, must drop it rather than trip the po_id FK.
    await a.purchaseOrders.delete(po.id);
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    expect(await b.purchaseOrders.getById(po.id)).toBeUndefined();
    expect(await b.purchaseOrders.getLine(line.id)).toBeUndefined();
  });

  it('resolves a concurrent edit by Last-Write-Wins', async () => {
    const item = await a.items.create({ name: 'Original', locationId: UNASSIGNED_LOCATION_ID });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // B renames later than A's last write, then pushes.
    await b.items.update(item.id, { name: 'Renamed on B' });
    await runSync(b.driver, provider, NO_QUOTA);

    // A syncs and should adopt B's newer name.
    await runSync(a.driver, provider, NO_QUOTA);
    expect((await a.items.getById(item.id))?.name).toBe('Renamed on B');
  });

  it('propagates a hard delete via a tombstone', async () => {
    const item = await a.items.create({ name: 'Doomed', locationId: UNASSIGNED_LOCATION_ID });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);
    expect(await b.items.getById(item.id)).toBeDefined();

    await a.items.hardDelete(item.id);
    await runSync(a.driver, provider, NO_QUOTA);

    const pull = await runSync(b.driver, provider, NO_QUOTA);
    expect(pull.deleted).toBeGreaterThanOrEqual(1);
    expect(await b.items.getById(item.id)).toBeUndefined();
  });

  it('re-parents an item whose location was deleted on a peer (§7.5.2)', async () => {
    const loc = await a.locations.create({ name: 'Shelf' });
    const item = await a.items.create({ name: 'On shelf', locationId: loc.id });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // A deletes the location (its own copy re-parents locally), then pushes.
    await a.locations.delete(loc.id);
    await runSync(a.driver, provider, NO_QUOTA);

    // B, offline, makes a *newer* edit to the item still sitting in the doomed
    // location — the genuine §7.5.2 conflict. The unambiguous future timestamp makes
    // B's row win LWW deterministically (the location row stays old, so the remote
    // tombstone still removes it), so B's own reconcile must intercept-and-re-parent.
    await b.driver.execute('UPDATE items SET name = ?, updated_at = updated_at + 1000000 WHERE id = ?;', [
      'Still here on B',
      item.id,
    ]);
    const pull = await runSync(b.driver, provider, NO_QUOTA);

    expect(pull.reparented).toBeGreaterThanOrEqual(1);
    const moved = await b.items.getById(item.id);
    expect(moved?.locationId).toBe(UNASSIGNED_LOCATION_ID);
    expect(moved?.name).toBe('Still here on B'); // B's edit survived
    const history = await b.items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'RE_PARENTED')).toBe(true);
  });

  it('reconciles concurrent gauge consumption with Delta-CRDT, not LWW (§7.3)', async () => {
    const spool = await a.items.create({
      name: 'PLA spool',
      locationId: UNASSIGNED_LOCATION_ID,
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 0, currentNetValue: 1000 },
    });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, NO_QUOTA);

    // Concurrent offline usage: A uses 45 g, B uses 10 g.
    await a.items.adjustGauge(spool.id, { delta: -45 });
    await b.items.adjustGauge(spool.id, { delta: -10 });

    // B pushes first, then A reconciles.
    await runSync(b.driver, provider, NO_QUOTA);
    await runSync(a.driver, provider, NO_QUOTA);

    const merged = await a.items.getById(spool.id);
    expect(merged?.gauge?.currentNetValue).toBe(945);
  });

  it('Phase 11: syncs tag membership and propagates an unlink by tombstone', async () => {
    const item = await a.items.create({ name: 'ESP32', locationId: UNASSIGNED_LOCATION_ID });
    await a.tags.setForItem(item.id, ['wifi', 'mcu']);
    await runSync(a.driver, provider, NO_QUOTA);

    // B pulls and resolves the membership edges (FK-safe: tags + item exist first).
    const pull = await runSync(b.driver, provider, NO_QUOTA);
    expect(pull.tagEdgesAdded).toBeGreaterThanOrEqual(2);
    expect((await b.tags.getForItem(item.id)).map((t) => t.name).sort()).toEqual(['mcu', 'wifi']);

    // A unlinks one tag (recording an edge tombstone) and pushes.
    await a.tags.setForItem(item.id, ['mcu']);
    await runSync(a.driver, provider, NO_QUOTA);

    // B pulls — the removal propagates by membership, not LWW.
    const pull2 = await runSync(b.driver, provider, NO_QUOTA);
    expect(pull2.tagEdgesRemoved).toBeGreaterThanOrEqual(1);
    expect((await b.tags.getForItem(item.id)).map((t) => t.name)).toEqual(['mcu']);
  });

  it('Phase 11: unions the append-only Activity Ledger across devices', async () => {
    const item = await a.items.create({ name: 'Logged', locationId: UNASSIGNED_LOCATION_ID });
    await runSync(a.driver, provider, NO_QUOTA);

    const pull = await runSync(b.driver, provider, NO_QUOTA);
    expect(pull.historyInserted).toBeGreaterThanOrEqual(1);
    const history = await b.items.getHistory(item.id);
    expect(history.rows.length).toBeGreaterThanOrEqual(1);
  });
});

// Phase 11 roadmap audit: confirm maintenance_schedules (joined SYNC_TABLES in Phase 9)
// has correct §7.5-style relational-integrity coverage. A schedule whose item is hard-
// deleted on a peer relies on the FK ON DELETE CASCADE firing from the item's tombstone
// (no bespoke re-parent), rather than leaving an orphaned schedule.
describe('maintenance_schedules reconcile-coverage audit (§7.5, Phase 11)', () => {
  it('an item hard-deleted on a peer cascade-removes its synced schedule, leaving no orphan', async () => {
    const a = await makeDevice();
    const b = await makeDevice();
    const provider = new MemoryCloudProvider();
    const aMaint = new MaintenanceRepository(a.driver);
    const bMaint = new MaintenanceRepository(b.driver);

    try {
      const item = await a.items.create({ name: 'Drill', locationId: UNASSIGNED_LOCATION_ID });
      const sched = await aMaint.create({
        itemId: item.id,
        name: 'Annual service',
        basis: 'TIME',
        intervalDays: 365,
      });
      await runSync(a.driver, provider, NO_QUOTA);
      await runSync(b.driver, provider, NO_QUOTA);
      expect(await bMaint.getById(sched.id)).toBeDefined();

      // A hard-deletes the item (its own schedule cascades away) and pushes.
      await a.items.hardDelete(item.id);
      await runSync(a.driver, provider, NO_QUOTA);

      // B pulls: the item tombstone deletes the item, whose ON DELETE CASCADE removes the
      // schedule — no orphaned maintenance_schedules row survives, no bespoke re-parent.
      await runSync(b.driver, provider, NO_QUOTA);
      expect(await b.items.getById(item.id)).toBeUndefined();
      expect(await bMaint.getById(sched.id)).toBeUndefined();
    } finally {
      await a.driver.close();
      await b.driver.close();
    }
  });

  // Phase 22: the additive v11 accrue_checkout_hours opt-in is a synced property of a
  // schedule (a peer should see the same accrual mode). The schema dictionary reads
  // columns live via PRAGMA, so the new column joins the LWW payload with no registration.
  it('round-trips the accrue_checkout_hours opt-in by LWW (Phase 22)', async () => {
    const a = await makeDevice();
    const b = await makeDevice();
    const provider = new MemoryCloudProvider();
    const aMaint = new MaintenanceRepository(a.driver);
    const bMaint = new MaintenanceRepository(b.driver);

    try {
      const item = await a.items.create({ name: 'Torque wrench', locationId: UNASSIGNED_LOCATION_ID });
      const sched = await aMaint.create({
        itemId: item.id,
        name: 'Recalibrate',
        basis: 'USAGE',
        intervalUsage: 50,
        accrueCheckoutHours: true,
      });
      await runSync(a.driver, provider, NO_QUOTA);
      await runSync(b.driver, provider, NO_QUOTA);

      const onB = await bMaint.getById(sched.id);
      expect(onB?.accrueCheckoutHours).toBe(true);
      expect(onB?.usageUnit).toBe('hours');
    } finally {
      await a.driver.close();
      await b.driver.close();
    }
  });
});

describe('§7.3 NTP fallback time source (Phase 14)', () => {
  it('uses the injected serverTime when the provider has no clock of its own', async () => {
    const driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    // A provider that, like the File System folder, returns no authoritative time.
    const clocklessProvider = {
      id: 'clockless',
      label: 'clockless',
      getServerTime: async () => null,
      fetchSnapshot: async () => null,
      pushSnapshot: async () => {},
    };
    const outcome = await runSync(driver, clocklessProvider, {
      ...NO_QUOTA,
      now: () => 1_000,
      serverTime: async () => 6_000, // server is 5s ahead of local
    });
    expect(outcome.clockOffset).toBe(5_000);
    await driver.close();
  });

  it('falls back to the local clock (offset 0) when no source resolves a time', async () => {
    const driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    const clocklessProvider = {
      id: 'clockless',
      label: 'clockless',
      getServerTime: async () => null,
      fetchSnapshot: async () => null,
      pushSnapshot: async () => {},
    };
    const outcome = await runSync(driver, clocklessProvider, {
      ...NO_QUOTA,
      now: () => 1_000,
      serverTime: async () => null,
    });
    expect(outcome.clockOffset).toBe(0);
    await driver.close();
  });
});

describe('needsFullResync (§7.2 TTL)', () => {
  it('is false for a never-synced or recently-synced device', () => {
    expect(needsFullResync(0, 1_000_000)).toBe(false);
    expect(needsFullResync(1_000_000 - 1000, 1_000_000)).toBe(false);
  });
  it('is true once the last sync predates the tombstone TTL', () => {
    const now = 10 * TOMBSTONE_TTL_MS;
    expect(needsFullResync(now - TOMBSTONE_TTL_MS - 1, now)).toBe(true);
  });
});
