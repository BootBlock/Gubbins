import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { readAllPages } from '@/lib/read-all-pages';
import { planAssemblyDraw } from '@/features/projects/assembly';
import { IN_TRANSIT_LOCATION_ID, UNASSIGNED_LOCATION_ID } from './constants';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { ProjectRepository } from './ProjectRepository';
import { assemblyId } from './project/assembly';

describe('ProjectRepository (spec §4 Projects & BOMs)', () => {
  let driver: MemoryDriver;
  let projects: ProjectRepository;
  let items: ItemRepository;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    projects = new ProjectRepository(driver);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  // --- projects ------------------------------------------------------------------

  it('creates a project with sensible defaults', async () => {
    const project = await projects.create({ name: '  Bench PSU  ' });
    expect(project.name).toBe('Bench PSU');
    expect(project.status).toBe('PLANNING');
    expect(project.costingMode).toBe('CURRENT_REPLACEMENT');
    expect(project.icon).toBeNull();
  });

  it('stores an optional icon and normalises a blank one to null', async () => {
    const withIcon = await projects.create({ name: 'Rocket build', icon: 'Rocket' });
    expect(withIcon.icon).toBe('Rocket');

    const blank = await projects.create({ name: 'No icon', icon: '   ' });
    expect(blank.icon).toBeNull();
  });

  it('sets and clears a project icon on update', async () => {
    const p = await projects.create({ name: 'Icon test' });
    expect((await projects.update(p.id, { icon: 'Wrench' })).icon).toBe('Wrench');
    // An omitted icon is left untouched; an explicit null clears it.
    expect((await projects.update(p.id, { name: 'Icon test 2' })).icon).toBe('Wrench');
    expect((await projects.update(p.id, { icon: null })).icon).toBeNull();
  });

  it('rejects a blank project name', async () => {
    await expect(projects.create({ name: '   ' })).rejects.toBeInstanceOf(DbError);
  });

  it('lists projects with their BOM line counts, newest first', async () => {
    const a = await projects.create({ name: 'Alpha' });
    const b = await projects.create({ name: 'Beta' });
    await projects.addLine(a.id, { description: 'R1' });
    await projects.addLine(a.id, { description: 'R2' });

    const page = await projects.list();
    expect(page.rows.map((p) => p.id)).toContain(a.id);
    const alpha = page.rows.find((p) => p.id === a.id)!;
    const beta = page.rows.find((p) => p.id === b.id)!;
    expect(alpha.lineCount).toBe(2);
    expect(beta.lineCount).toBe(0);
  });

  // --- narrowing the list (issue #137) --------------------------------------------

  describe('search, status filter and sort (issue #137)', () => {
    /** Three projects with distinct names, statuses and creation instants. */
    async function seed() {
      const bench = await projects.create({ name: 'Bench PSU' });
      const rover = await projects.create({ name: 'Garden rover' });
      const lamp = await projects.create({ name: 'Desk lamp' });
      await projects.update(rover.id, { status: 'ACTIVE' });
      await projects.update(lamp.id, { status: 'COMPLETED' });
      // Stamp distinct creation instants: three inserts can land in the same millisecond, and a
      // tie would fall through to the name tiebreak and make the date orderings assert nothing.
      await driver.execute('UPDATE projects SET created_at = 1000 WHERE id = ?;', [bench.id]);
      await driver.execute('UPDATE projects SET created_at = 2000 WHERE id = ?;', [rover.id]);
      await driver.execute('UPDATE projects SET created_at = 3000 WHERE id = ?;', [lamp.id]);
      return { bench, rover, lamp };
    }

    it('narrows to names containing the term, case-insensitively', async () => {
      const { bench } = await seed();
      const page = await projects.list({ search: 'psu' });
      expect(page.rows.map((p) => p.id)).toEqual([bench.id]);
    });

    it('counts what the same filter would list, not the whole table', async () => {
      await seed();
      // A page strip sized from an unfiltered count would offer pages the filter cannot fill.
      expect(await projects.count()).toBe(3);
      expect(await projects.count({ search: 'psu' })).toBe(1);
      expect(await projects.count({ status: 'COMPLETED' })).toBe(1);
      expect(await projects.count({ search: 'rover', status: 'COMPLETED' })).toBe(0);
    });

    it('matches a typed wildcard literally rather than as a pattern', async () => {
      await projects.create({ name: '50% duty cycle' });
      await projects.create({ name: 'Bench PSU' });
      // Unescaped, `%` would match every project — the search box would silently lie.
      const page = await projects.list({ search: '50%' });
      expect(page.rows.map((p) => p.name)).toEqual(['50% duty cycle']);
    });

    it('combines the search and the status filter as an intersection', async () => {
      const { rover } = await seed();
      const page = await projects.list({ search: 'r', status: 'ACTIVE' });
      expect(page.rows.map((p) => p.id)).toEqual([rover.id]);
    });

    it('orders by each supported sort, defaulting to newest first', async () => {
      const { bench, rover, lamp } = await seed();
      const ids = async (sort?: Parameters<typeof projects.list>[0]) =>
        (await projects.list(sort)).rows.map((p) => p.id);

      expect(await ids()).toEqual([lamp.id, rover.id, bench.id]);
      expect(await ids({ sort: 'OLDEST' })).toEqual([bench.id, rover.id, lamp.id]);
      expect(await ids({ sort: 'NAME_ASC' })).toEqual([bench.id, lamp.id, rover.id]);
      expect(await ids({ sort: 'NAME_DESC' })).toEqual([rover.id, lamp.id, bench.id]);
    });

    it('keeps the BOM-line counts correct under a filter (the JOIN still groups per project)', async () => {
      const { bench } = await seed();
      await projects.addLine(bench.id, { description: 'R1' });
      await projects.addLine(bench.id, { description: 'R2' });
      const page = await projects.list({ search: 'bench' });
      expect(page.rows[0]?.lineCount).toBe(2);
    });

    it('pages the filtered set rather than filtering one page', async () => {
      for (let i = 0; i < 5; i += 1) await projects.create({ name: `Rig ${i}` });
      await projects.create({ name: 'Something else' });

      const first = await projects.list({ search: 'Rig', sort: 'NAME_ASC', limit: 2, offset: 0 });
      const last = await projects.list({ search: 'Rig', sort: 'NAME_ASC', limit: 2, offset: 4 });
      expect(first.rows.map((p) => p.name)).toEqual(['Rig 0', 'Rig 1']);
      // The fifth match is reachable, and the non-matching project never appears on any page.
      expect(last.rows.map((p) => p.name)).toEqual(['Rig 4']);
      expect(await projects.count({ search: 'Rig' })).toBe(5);
    });
  });

  it('updates a project and toggles the costing mode', async () => {
    const p = await projects.create({ name: 'X' });
    const updated = await projects.update(p.id, {
      name: 'X v2',
      costingMode: 'POINT_IN_TIME',
      status: 'ACTIVE',
    });
    expect(updated.name).toBe('X v2');
    expect(updated.costingMode).toBe('POINT_IN_TIME');
    expect(updated.status).toBe('ACTIVE');
  });

  it('hard-deletes a project, cascades its BOM lines and records a tombstone', async () => {
    const p = await projects.create({ name: 'Doomed' });
    await projects.addLine(p.id, { description: 'R1' });
    await projects.addLine(p.id, { description: 'R2' });

    await projects.delete(p.id);

    expect(await projects.getById(p.id)).toBeUndefined();
    // BOM lines cascade away with the parent project (no orphans left behind).
    const orphans = await driver.queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM project_bom_lines WHERE project_id = ?;',
      [p.id],
    );
    expect(Number(orphans?.n)).toBe(0);
    // The deletion is tombstoned so it propagates on the next sync (§7.2).
    const tomb = await driver.queryOne<{ ok: number }>(
      "SELECT 1 AS ok FROM tombstones WHERE table_name = 'projects' AND id = ?;",
      [p.id],
    );
    expect(tomb?.ok).toBe(1);
  });

  // --- BOM lines -----------------------------------------------------------------

  it('adds a manual (unmatched) BOM line', async () => {
    const p = await projects.create({ name: 'P' });
    const line = await projects.addLine(p.id, {
      designator: 'R1, R2',
      mpn: 'RC0805',
      description: '10k 0805',
      requiredQty: 5,
    });
    expect(line.itemId).toBeNull();
    expect(line.requiredQty).toBe(5);
    expect(line.mpn).toBe('RC0805');
    expect(line.reservationStatus).toBe('NONE');
    expect(line.procurementStatus).toBe('NONE');
  });

  it('snapshots cost, mpn and manufacturer from a matched item when adding a line', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({
      name: 'NE555',
      mpn: 'NE555P',
      manufacturer: 'TI',
      unitCost: 0.5,
    });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 3 });
    expect(line.itemId).toBe(item.id);
    expect(line.mpn).toBe('NE555P');
    expect(line.manufacturer).toBe('TI');
    expect(line.unitCostSnapshot).toBe(0.5);
  });

  it('lists and removes BOM lines', async () => {
    const p = await projects.create({ name: 'P' });
    const l1 = await projects.addLine(p.id, { description: 'A' });
    await projects.addLine(p.id, { description: 'B' });
    expect((await projects.listLines(p.id)).rows).toHaveLength(2);
    await projects.removeLine(l1.id);
    expect((await projects.listLines(p.id)).rows).toHaveLength(1);
  });

  it('counts every project, including those past the capped first page (issue #149)', async () => {
    expect(await projects.count()).toBe(0);

    for (let i = 0; i < 101; i += 1) await projects.create({ name: `P${i}` });

    // The list is clamped to the strict §2.1 ceiling, so the rows in hand undercount the set —
    // which is why the master list needs a separate total to page against.
    const firstPage = await projects.list({ limit: 100 });
    expect(firstPage.rows).toHaveLength(100);
    expect(firstPage.hasMore).toBe(true);
    expect(await projects.count()).toBe(101);
    expect((await projects.list({ limit: 100, offset: 100 })).rows).toHaveLength(1);
  });

  it('pages a BOM longer than one read, so every line is reachable (issue #149)', async () => {
    const p = await projects.create({ name: 'Big build' });
    for (let i = 0; i < 120; i += 1) await projects.addLine(p.id, { description: `R${i}` });

    // A single read stops at the ceiling — the bug behind a bill of materials (and an exported
    // BOM file) that looked complete while missing every part past the hundredth.
    const firstPage = await projects.listLines(p.id, { limit: 100 });
    expect(firstPage.rows).toHaveLength(100);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await projects.listLines(p.id, { limit: 100, offset: 100 });
    expect(secondPage.rows).toHaveLength(20);
    expect(secondPage.hasMore).toBe(false);
    // Declared order is preserved across the page boundary.
    expect(secondPage.rows[0]?.description).toBe('R100');

    // …and the read-everything seam the BOM screen and its export go through walks both pages,
    // in declared order, so neither is short (issue #149).
    const whole = await readAllPages((params) => projects.listLines(p.id, params));
    expect(whole.truncated).toBe(false);
    expect(whole.rows).toHaveLength(120);
    expect(whole.rows.map((l) => l.description)).toEqual(Array.from({ length: 120 }, (_, i) => `R${i}`));
  });

  it('reads a whole expense ledger longer than one page (issue #149)', async () => {
    const p = await projects.create({ name: 'Long ledger' });
    for (let i = 0; i < 105; i += 1) {
      await projects.addExpense(p.id, { amount: 1, description: `E${i}` });
    }

    // The hook used to ask for 200, which the repository clamped straight back to 100 — so
    // "fetched whole" quietly stopped being true the moment a ledger passed a hundred entries.
    expect((await projects.listExpenses(p.id, { limit: 200 })).rows).toHaveLength(100);

    const whole = await readAllPages((params) => projects.listExpenses(p.id, params));
    expect(whole.truncated).toBe(false);
    expect(whole.rows).toHaveLength(105);
  });

  // --- reservations (spec §4 Tentative vs Actual) --------------------------------

  it('sets a tentative reservation without logging to the item ledger', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'Cap', unitCost: 1 });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 10 });

    const reserved = await projects.setReservation(line.id, 'TENTATIVE', 4);
    expect(reserved.reservationStatus).toBe('TENTATIVE');
    expect(reserved.reservedQty).toBe(4);

    const history = await items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'RESERVED')).toBe(false);
  });

  it('clamps reserved quantity to the required quantity and defaults to the full requirement', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'Cap' });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 6 });

    const full = await projects.setReservation(line.id, 'ACTUAL');
    expect(full.reservedQty).toBe(6);
    const clamped = await projects.setReservation(line.id, 'ACTUAL', 99);
    expect(clamped.reservedQty).toBe(6);
  });

  it('logs an Activity-Log entry when stock is actually reserved and when cleared', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'Cap' });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 2 });

    await projects.setReservation(line.id, 'ACTUAL', 2);
    let history = await items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'RESERVED')).toBe(true);

    const cleared = await projects.setReservation(line.id, 'NONE');
    expect(cleared.reservationStatus).toBe('NONE');
    expect(cleared.reservedQty).toBe(0);
    history = await items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'RESERVATION_CLEARED')).toBe(true);
  });

  // --- procurement & In-Transit (spec §4 liminal procurement) --------------------

  it('marks a line ordered then in-transit, logging PROCURED for a matched item', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'IC' });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 4 });

    await projects.setProcurement(line.id, 'ORDERED');
    const intransit = await projects.setProcurement(line.id, 'IN_TRANSIT');
    expect(intransit.procurementStatus).toBe('IN_TRANSIT');

    const history = await items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'PROCURED')).toBe(true);
  });

  it('lists In-Transit BOM lines across projects with project + label (Phase 9)', async () => {
    const p = await projects.create({ name: 'Bench PSU' });
    const item = await items.create({ name: 'Toroid' });
    const matched = await projects.addLine(p.id, { itemId: item.id, requiredQty: 2 });
    const freeText = await projects.addLine(p.id, { description: 'Heatsink', requiredQty: 1 });
    const idle = await projects.addLine(p.id, { description: 'Knob', requiredQty: 1 });

    await projects.setProcurement(matched.id, 'IN_TRANSIT');
    await projects.setProcurement(freeText.id, 'IN_TRANSIT');
    void idle; // left at NONE — must not appear

    const inTransit = await projects.listInTransit();
    expect(inTransit.rows).toHaveLength(2);
    const labels = inTransit.rows.map((r) => r.label).sort();
    expect(labels).toEqual(['Heatsink', 'Toroid']);
    expect(inTransit.rows.every((r) => r.projectName === 'Bench PSU')).toBe(true);
  });

  it('receives a matched discrete line into a destination placement and logs RECEIVED', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'IC', quantity: 1 });
    const shelf = await locations.create({ name: 'Shelf A' });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 4 });

    const received = await projects.receiveLine(line.id, { locationId: shelf.id });
    expect(received.procurementStatus).toBe('RECEIVED');

    const updated = await items.getById(item.id);
    expect(updated?.quantity).toBe(5); // 1 on-hand + 4 received (total across locations)
    // Phase 25: the received units land at the destination as a per-location placement;
    // the item's primary location is unchanged and it is now multi-location.
    expect(updated?.locationId).not.toBe(shelf.id);
    const placements = await items.listStock(item.id);
    const shelfStock = placements.find((s) => s.locationId === shelf.id);
    expect(shelfStock?.quantity).toBe(4);
    const history = await items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'RECEIVED')).toBe(true);
  });

  it('receives a line in instalments, keeping it open until fully received (§4 split receipts)', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'IC', quantity: 1 });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 5 });
    await projects.setProcurement(line.id, 'IN_TRANSIT');

    // First instalment: 2 of 5 — the line stays IN_TRANSIT, on-hand grows by 2.
    const partial = await projects.receiveLine(line.id, { quantity: 2 });
    expect(partial.procurementStatus).toBe('IN_TRANSIT');
    expect(partial.receivedQty).toBe(2);
    expect((await items.getById(item.id))?.quantity).toBe(3); // 1 + 2
    // Only the outstanding remainder still surfaces as incoming.
    expect(await projects.inTransitQtyForItem(item.id)).toBe(3);

    // Final instalment defaults to the remainder (3) → completes the line.
    const done = await projects.receiveLine(line.id);
    expect(done.procurementStatus).toBe('RECEIVED');
    expect(done.receivedQty).toBe(5);
    expect((await items.getById(item.id))?.quantity).toBe(6); // 3 + 3
    expect(await projects.inTransitQtyForItem(item.id)).toBe(0);

    const history = await items.getHistory(item.id);
    const received = history.rows.filter((h) => h.action === 'RECEIVED');
    expect(received).toHaveLength(2); // one ledger entry per instalment
  });

  it('clamps an over-receipt to the outstanding remainder (never overshoots)', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'IC', quantity: 0 });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 4 });
    await projects.setProcurement(line.id, 'IN_TRANSIT');

    // Asking for 10 against a requirement of 4 accepts only 4 and completes the line.
    const received = await projects.receiveLine(line.id, { quantity: 10 });
    expect(received.procurementStatus).toBe('RECEIVED');
    expect(received.receivedQty).toBe(4);
    expect((await items.getById(item.id))?.quantity).toBe(4);
    expect(await projects.inTransitQtyForItem(item.id)).toBe(0);
  });

  it('exposes the system-locked In-Transit location', async () => {
    const loc = await locations.getById(IN_TRANSIT_LOCATION_ID);
    expect(loc?.name).toBe('In Transit');
    expect(loc?.isSystem).toBe(true);
  });

  // --- In-Transit physical quantity (spec §4 liminal procurement, Phase 20) -------

  it('derives an item In-Transit quantity distinct from on-hand stock', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'IC', quantity: 7 });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 4 });

    // Not yet ordered → nothing incoming; on-hand untouched.
    expect(await projects.inTransitQtyForItem(item.id)).toBe(0);
    expect((await items.getById(item.id))?.quantity).toBe(7);

    await projects.setProcurement(line.id, 'IN_TRANSIT');
    expect(await projects.inTransitQtyForItem(item.id)).toBe(4);
    // The incoming quantity is *distinct* — on-hand is not overloaded.
    expect((await items.getById(item.id))?.quantity).toBe(7);
  });

  it('sums In-Transit quantity across lines and projects for the same item', async () => {
    const a = await projects.create({ name: 'A' });
    const b = await projects.create({ name: 'B' });
    const item = await items.create({ name: 'Cap' });
    const l1 = await projects.addLine(a.id, { itemId: item.id, requiredQty: 3 });
    const l2 = await projects.addLine(b.id, { itemId: item.id, requiredQty: 5 });
    const other = await items.create({ name: 'Res' });
    const l3 = await projects.addLine(a.id, { itemId: other.id, requiredQty: 9 });

    await projects.setProcurement(l1.id, 'IN_TRANSIT');
    await projects.setProcurement(l2.id, 'IN_TRANSIT');
    await projects.setProcurement(l3.id, 'IN_TRANSIT'); // a different item — must not leak in

    expect(await projects.inTransitQtyForItem(item.id)).toBe(8);
    expect(await projects.inTransitQtyForItem(other.id)).toBe(9);
  });

  it('clears the derived In-Transit quantity when a line is received into stock', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'IC', quantity: 1 });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 4 });

    await projects.setProcurement(line.id, 'IN_TRANSIT');
    expect(await projects.inTransitQtyForItem(item.id)).toBe(4);

    await projects.receiveLine(line.id);
    // Received: the stock has arrived — incoming drops to nil and moves to on-hand.
    expect(await projects.inTransitQtyForItem(item.id)).toBe(0);
    expect((await items.getById(item.id))?.quantity).toBe(5);
  });

  it('drops the derived In-Transit quantity when the order is reverted or the line removed', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'IC' });
    const reverted = await projects.addLine(p.id, { itemId: item.id, requiredQty: 2 });
    const removed = await projects.addLine(p.id, { itemId: item.id, requiredQty: 6 });

    await projects.setProcurement(reverted.id, 'IN_TRANSIT');
    await projects.setProcurement(removed.id, 'IN_TRANSIT');
    expect(await projects.inTransitQtyForItem(item.id)).toBe(8);

    await projects.setProcurement(reverted.id, 'NONE'); // order cancelled
    expect(await projects.inTransitQtyForItem(item.id)).toBe(6);

    await projects.removeLine(removed.id); // line deleted entirely
    expect(await projects.inTransitQtyForItem(item.id)).toBe(0);
  });

  // --- costing (spec §4 Current Replacement vs Point-in-Time) --------------------

  it('costs with the live replacement value, reflecting later price changes', async () => {
    const p = await projects.create({ name: 'P', costingMode: 'CURRENT_REPLACEMENT' });
    const item = await items.create({ name: 'R', unitCost: 1 });
    await projects.addLine(p.id, { itemId: item.id, requiredQty: 10 }); // snapshot 1.0

    let costing = await projects.getCosting(p.id);
    expect(costing.totalCost).toBe(10);

    await items.update(item.id, { unitCost: 2 }); // price doubles
    costing = await projects.getCosting(p.id);
    expect(costing.costingMode).toBe('CURRENT_REPLACEMENT');
    expect(costing.totalCost).toBe(20); // live price wins
  });

  it('costs with the point-in-time snapshot, ignoring later price changes', async () => {
    const p = await projects.create({ name: 'P', costingMode: 'POINT_IN_TIME' });
    const item = await items.create({ name: 'R', unitCost: 1 });
    await projects.addLine(p.id, { itemId: item.id, requiredQty: 10 }); // snapshot 1.0

    await items.update(item.id, { unitCost: 5 });
    const costing = await projects.getCosting(p.id);
    expect(costing.costingMode).toBe('POINT_IN_TIME');
    expect(costing.totalCost).toBe(10); // frozen at snapshot
  });

  it('counts unpriced lines and excludes them from the total', async () => {
    const p = await projects.create({ name: 'P' });
    const priced = await items.create({ name: 'A', unitCost: 2 });
    const unpriced = await items.create({ name: 'B' }); // no unit cost
    await projects.addLine(p.id, { itemId: priced.id, requiredQty: 3 });
    await projects.addLine(p.id, { itemId: unpriced.id, requiredQty: 5 });

    const costing = await projects.getCosting(p.id);
    expect(costing.totalCost).toBe(6);
    expect(costing.unpricedLineCount).toBe(1);
    expect(costing.lineCount).toBe(2);
  });

  // --- shopping list (spec §4 automated Shopping List) ---------------------------

  it('lists shortfalls (required − backed reservation) for un-procured lines', async () => {
    const p = await projects.create({ name: 'P' });
    // 30 on hand, so the whole 30-unit reservation is backed by real stock.
    const item = await items.create({ name: 'R', unitCost: 0.1, quantity: 30 });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 100 });
    await projects.setReservation(line.id, 'ACTUAL', 30);

    const list = await projects.getShoppingList(p.id);
    expect(list).toHaveLength(1);
    expect(list[0].shortfallQty).toBe(70);
    expect(list[0].itemId).toBe(item.id);
    expect(list[0].estimatedCost).toBeCloseTo(7, 5);
  });

  it('omits fully-reserved and already-ordered lines from the shopping list', async () => {
    const p = await projects.create({ name: 'P' });
    const fully = await items.create({ name: 'A', quantity: 5 });
    const ordered = await items.create({ name: 'B' });
    const lineFull = await projects.addLine(p.id, { itemId: fully.id, requiredQty: 5 });
    const lineOrdered = await projects.addLine(p.id, { itemId: ordered.id, requiredQty: 5 });
    await projects.setReservation(lineFull.id, 'ACTUAL', 5);
    await projects.setProcurement(lineOrdered.id, 'ORDERED');

    const list = await projects.getShoppingList(p.id);
    expect(list).toHaveLength(0);
  });

  it('aggregates shortfall across lines sharing the same matched item', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'R', unitCost: 1 });
    await projects.addLine(p.id, { itemId: item.id, requiredQty: 3 });
    await projects.addLine(p.id, { itemId: item.id, requiredQty: 4 });

    const list = await projects.getShoppingList(p.id);
    expect(list).toHaveLength(1);
    expect(list[0].shortfallQty).toBe(7);
  });

  // --- reservations are claims on real stock (issue #653) -----------------------

  it('does not let a reservation with no stock behind it clear the shopping list', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'R', quantity: 0 });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 4 });
    await projects.setReservation(line.id, 'ACTUAL', 4);

    // Reserving 4 of an item there are none of buys nothing, so all 4 still have to be bought.
    const list = await projects.getShoppingList(p.id);
    expect(list).toHaveLength(1);
    expect(list[0].shortfallQty).toBe(4);
    expect(list[0].unbackedQty).toBe(4);
  });

  it('makes an over-committed item show up short on exactly one project', async () => {
    // The reported failure: 10 on hand, one project reserves 6 and another 9. 15 units are
    // committed against 10, and both shopping lists used to say there was nothing to buy.
    const item = await items.create({ name: 'Widget', quantity: 10 });
    const first = await projects.create({ name: 'First' });
    const second = await projects.create({ name: 'Second' });
    const firstLine = await projects.addLine(first.id, { itemId: item.id, requiredQty: 6 });
    const secondLine = await projects.addLine(second.id, { itemId: item.id, requiredQty: 9 });
    await projects.setReservation(firstLine.id, 'ACTUAL', 6);
    await projects.setReservation(secondLine.id, 'ACTUAL', 9);

    // Which project wins the stock is decided by the two claims' order, and both lines are
    // created inside the same millisecond here, so the assertion is on what must hold either
    // way: the 5 units that do not exist are on somebody's list, and the project that won its
    // claim in full has nothing to buy.
    const firstList = await projects.getShoppingList(first.id);
    const secondList = await projects.getShoppingList(second.id);
    const entries = [...firstList, ...secondList];
    expect(entries).toHaveLength(1);
    expect(entries[0].shortfallQty).toBe(5);
    expect(entries[0].unbackedQty).toBe(5);
  });

  it('serves a firm reservation before a tentative one made earlier', async () => {
    const item = await items.create({ name: 'Widget', quantity: 4 });
    const soft = await projects.create({ name: 'Soft' });
    const firm = await projects.create({ name: 'Firm' });
    const softLine = await projects.addLine(soft.id, { itemId: item.id, requiredQty: 4 });
    const firmLine = await projects.addLine(firm.id, { itemId: item.id, requiredQty: 4 });
    await projects.setReservation(softLine.id, 'TENTATIVE', 4);
    await projects.setReservation(firmLine.id, 'ACTUAL', 4);

    expect(await projects.getShoppingList(firm.id)).toHaveLength(0);
    const softList = await projects.getShoppingList(soft.id);
    expect(softList).toHaveLength(1);
    expect(softList[0].shortfallQty).toBe(4);
  });

  it('releases a reservation once its project is no longer open', async () => {
    const item = await items.create({ name: 'Widget', quantity: 5 });
    const done = await projects.create({ name: 'Done' });
    const live = await projects.create({ name: 'Live' });
    const doneLine = await projects.addLine(done.id, { itemId: item.id, requiredQty: 5 });
    const liveLine = await projects.addLine(live.id, { itemId: item.id, requiredQty: 5 });
    await projects.setReservation(doneLine.id, 'ACTUAL', 5);
    await projects.setReservation(liveLine.id, 'ACTUAL', 5);
    expect((await items.getItemAvailability(item.id))?.overCommittedQty).toBe(5);

    // An archived project has been put aside; its lines stop holding stock, so the live
    // project's claim is backed in full and it has nothing left to buy.
    await projects.update(done.id, { status: 'ARCHIVED' });
    expect((await items.getItemAvailability(item.id))?.overCommittedQty).toBe(0);
    expect(await projects.getShoppingList(live.id)).toHaveLength(0);
  });

  it('takes a closed project’s own reservation at face value on its own list', async () => {
    const item = await items.create({ name: 'Widget', quantity: 10 });
    const p = await projects.create({ name: 'Done' });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 10 });
    await projects.setReservation(line.id, 'ACTUAL', 10);
    expect(await projects.getShoppingList(p.id)).toHaveLength(0);

    // Completing the project takes its claim out of the allocation — it has drawn its parts.
    // Its own list must not then read that absence as "your reservation lost out" and tell it
    // to re-buy a build that is already done.
    await projects.update(p.id, { status: 'COMPLETED' });
    expect(await projects.getShoppingList(p.id)).toHaveLength(0);
  });

  it('reports an item as over-committed, naming every project holding it', async () => {
    const item = await items.create({ name: 'Widget', quantity: 10 });
    const first = await projects.create({ name: 'First' });
    const second = await projects.create({ name: 'Second' });
    const firstLine = await projects.addLine(first.id, { itemId: item.id, requiredQty: 6 });
    const secondLine = await projects.addLine(second.id, { itemId: item.id, requiredQty: 9 });
    await projects.setReservation(firstLine.id, 'ACTUAL', 6);
    await projects.setReservation(secondLine.id, 'ACTUAL', 9);

    const availability = await items.getItemAvailability(item.id);
    expect(availability?.onHandQty).toBe(10);
    expect(availability?.reservedQty).toBe(15);
    expect(availability?.availableQty).toBe(0);
    expect(availability?.overCommittedQty).toBe(5);
    expect([...(availability?.claims ?? [])].map((c) => c.projectName).sort()).toEqual(['First', 'Second']);
    // All 10 real units are held by somebody; the 5 that do not exist are held by nobody.
    const backed = [firstLine.id, secondLine.id].map(
      (id) => availability?.backingByLine.get(id)?.backedQty ?? 0,
    );
    expect(backed[0] + backed[1]).toBe(10);
  });

  it('reports an unreserved item as fully available', async () => {
    const item = await items.create({ name: 'Widget', quantity: 3 });
    const availability = await items.getItemAvailability(item.id);
    expect(availability?.availableQty).toBe(3);
    expect(availability?.reservedQty).toBe(0);
    expect(availability?.claims).toEqual([]);
  });

  it('has no availability to report for an id that matches no item', async () => {
    expect(await items.getItemAvailability('nope')).toBeUndefined();
  });

  // --- assembly outcomes (spec §4 Composite Items & Assemblies) ------------------

  it('CONTAINER: turns the project into a location holding the matched parts', async () => {
    const p = await projects.create({ name: 'Lamp' });
    const a = await items.create({ name: 'LED', quantity: 1 });
    const b = await items.create({ name: 'Resistor', quantity: 1 });
    await projects.addLine(p.id, { itemId: a.id, requiredQty: 1 });
    await projects.addLine(p.id, { itemId: b.id, requiredQty: 1 });

    const result = await projects.finaliseAssembly(p.id, { outcome: 'CONTAINER' });
    expect(result.locationId).toBeDefined();

    const movedA = await items.getById(a.id);
    const movedB = await items.getById(b.id);
    expect(movedA?.locationId).toBe(result.locationId);
    expect(movedB?.locationId).toBe(result.locationId);
    expect((await projects.getById(p.id))?.status).toBe('COMPLETED');
  });

  it('SINGULAR_OBJECT: creates one new item and consumes the parts', async () => {
    const p = await projects.create({ name: 'Sensor Board' });
    const a = await items.create({ name: 'MCU', quantity: 5 });
    await projects.addLine(p.id, { itemId: a.id, requiredQty: 1 });

    const result = await projects.finaliseAssembly(p.id, {
      outcome: 'SINGULAR_OBJECT',
      resultName: 'Sensor Board Assembly',
    });
    expect(result.itemId).toBeDefined();

    const assembled = await items.getById(result.itemId!);
    expect(assembled?.name).toBe('Sensor Board Assembly');

    // One of five consumed — the other four stay in active inventory (issue #647).
    const consumed = await items.getById(a.id);
    expect(consumed?.quantity).toBe(4);
    expect(consumed?.isActive).toBe(true);
    const history = await items.getHistory(a.id);
    expect(history.rows.some((h) => h.action === 'CONSUMED')).toBe(true);
  });

  it('PERMANENT_CONSUMPTION: draws the required quantity with no new item or location', async () => {
    const p = await projects.create({ name: 'Glue Job' });
    const a = await items.create({ name: 'Epoxy A', quantity: 1 });
    const b = await items.create({ name: 'Epoxy B', quantity: 3 });
    await projects.addLine(p.id, { itemId: a.id, requiredQty: 1 });
    await projects.addLine(p.id, { itemId: b.id, requiredQty: 1 });

    const result = await projects.finaliseAssembly(p.id, { outcome: 'PERMANENT_CONSUMPTION' });
    expect(result.itemId).toBeUndefined();
    expect(result.locationId).toBeUndefined();

    // The draw emptied A, so it retires; B keeps the two units the build didn't use.
    expect((await items.getById(a.id))?.isActive).toBe(false);
    expect((await items.getById(b.id))?.isActive).toBe(true);
    expect((await items.getById(b.id))?.quantity).toBe(2);
    expect((await projects.getById(p.id))?.status).toBe('COMPLETED');
  });

  it('does not place a SINGULAR_OBJECT result in a system-locked location by default', async () => {
    const p = await projects.create({ name: 'Thing' });
    const a = await items.create({ name: 'Part', quantity: 1 });
    await projects.addLine(p.id, { itemId: a.id, requiredQty: 1 });
    const result = await projects.finaliseAssembly(p.id, { outcome: 'SINGULAR_OBJECT' });
    const assembled = await items.getById(result.itemId!);
    expect(assembled?.locationId).toBe(UNASSIGNED_LOCATION_ID);
  });

  // --- assembly draws the BOM's quantities (issue #647) --------------------------

  it('consumes only the quantity the BOM asks for, leaving the rest in inventory', async () => {
    const p = await projects.create({ name: 'Shelf' });
    const screws = await items.create({ name: 'M3 screw', quantity: 500 });
    await projects.addLine(p.id, { itemId: screws.id, requiredQty: 4 });

    await projects.finaliseAssembly(p.id, { outcome: 'PERMANENT_CONSUMPTION' });

    const after = await items.getById(screws.id);
    expect(after?.quantity).toBe(496);
    expect(after?.isActive).toBe(true);
    // The ledger records what the build actually used, so consumption analytics can see it.
    const consumed = (await items.getHistory(screws.id)).rows.find((h) => h.action === 'CONSUMED');
    expect(consumed?.quantityDelta).toBe(-4);
  });

  it('sums every line matching the same part, drawing the total once', async () => {
    const p = await projects.create({ name: 'Bracket' });
    const screws = await items.create({ name: 'M3 screw', quantity: 10 });
    await projects.addLine(p.id, { itemId: screws.id, requiredQty: 3 });
    await projects.addLine(p.id, { itemId: screws.id, requiredQty: 4 });

    await projects.finaliseAssembly(p.id, { outcome: 'PERMANENT_CONSUMPTION' });
    expect((await items.getById(screws.id))?.quantity).toBe(3);
  });

  it('retires a part only when the draw takes the last of it', async () => {
    const p = await projects.create({ name: 'One-off' });
    const part = await items.create({ name: 'Bespoke bracket', quantity: 2 });
    await projects.addLine(p.id, { itemId: part.id, requiredQty: 2 });

    await projects.finaliseAssembly(p.id, { outcome: 'PERMANENT_CONSUMPTION' });
    const after = await items.getById(part.id);
    expect(after?.quantity).toBe(0);
    expect(after?.isActive).toBe(false);
  });

  it('rejects a finalise a part cannot supply, writing nothing at all', async () => {
    const p = await projects.create({ name: 'Optimistic' });
    const part = await items.create({ name: 'Rare chip', quantity: 0 });
    await projects.addLine(p.id, { itemId: part.id, requiredQty: 10 });

    await expect(projects.finaliseAssembly(p.id, { outcome: 'PERMANENT_CONSUMPTION' })).rejects.toThrow(
      /Rare chip/,
    );
    // Nothing happened: the project is still open and the part untouched.
    expect((await projects.getById(p.id))?.status).toBe('PLANNING');
    expect((await items.getById(part.id))?.isActive).toBe(true);
    expect((await items.getHistory(part.id)).rows.some((h) => h.action === 'CONSUMED')).toBe(false);
  });

  it('draws a part across every location it sits in, oldest expiry first', async () => {
    const garage = await locations.create({ name: 'Garage' });
    const loft = await locations.create({ name: 'Loft' });
    const p = await projects.create({ name: 'Split build' });
    const bolt = await items.create({ name: 'Bolt', quantity: 8, locationId: garage.id });
    await items.transferStock(bolt.id, garage.id, loft.id, 5); // Garage 3, Loft 5
    await projects.addLine(p.id, { itemId: bolt.id, requiredQty: 6 });

    await projects.finaliseAssembly(p.id, { outcome: 'PERMANENT_CONSUMPTION' });

    expect((await items.getById(bolt.id))?.quantity).toBe(2);
    // Two units are left somewhere; the point is that the draw spanned both placements rather
    // than stopping at the home location's three.
    const placements = await items.listStock(bolt.id);
    expect(placements.reduce((sum, s) => sum + s.quantity, 0)).toBe(2);
  });

  it('CONTAINER: moves only the required quantity, leaving the part where it lives', async () => {
    const garage = await locations.create({ name: 'Garage' });
    const p = await projects.create({ name: 'Lamp' });
    const screws = await items.create({ name: 'M3 screw', quantity: 500, locationId: garage.id });
    await projects.addLine(p.id, { itemId: screws.id, requiredQty: 4 });

    const result = await projects.finaliseAssembly(p.id, { outcome: 'CONTAINER' });

    // The box of screws stays on its own shelf; only the four the build used are in the box.
    const after = await items.getById(screws.id);
    expect(after?.locationId).toBe(garage.id);
    expect(after?.quantity).toBe(500);
    const placements = await items.listStock(screws.id);
    expect(placements.find((s) => s.locationId === result.locationId)?.quantity).toBe(4);
    expect(placements.find((s) => s.locationId === garage.id)?.quantity).toBe(496);
  });

  it('CONTAINER: moves the item itself once the move takes the last of it', async () => {
    const garage = await locations.create({ name: 'Garage' });
    const p = await projects.create({ name: 'Lamp' });
    const shade = await items.create({ name: 'Shade', quantity: 1, locationId: garage.id });
    await projects.addLine(p.id, { itemId: shade.id, requiredQty: 1 });

    const result = await projects.finaliseAssembly(p.id, { outcome: 'CONTAINER' });
    expect((await items.getById(shade.id))?.locationId).toBe(result.locationId);
  });

  it('draws a gauge part by net value and only archives an emptied one', async () => {
    const p = await projects.create({ name: 'Glue Job' });
    const glue = await items.create({
      name: 'Adhesive',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'ml', grossCapacity: 500, tareWeight: 0 },
    });
    await projects.addLine(p.id, { itemId: glue.id, requiredQty: 50 });

    await projects.finaliseAssembly(p.id, { outcome: 'PERMANENT_CONSUMPTION' });

    const after = await items.getById(glue.id);
    expect(after?.gauge?.currentNetValue).toBe(450);
    expect(after?.isActive).toBe(true);
    const consumed = (await items.getHistory(glue.id)).rows.find((h) => h.action === 'CONSUMED');
    expect(consumed?.netValueDelta).toBe(-50);
  });

  it('takes a presence-only part whole — it has no quantity to slice', async () => {
    const p = await projects.create({ name: 'Manual job' });
    const manual = await items.create({ name: 'Reference manual', trackingMode: 'UNTRACKED' });
    await projects.addLine(p.id, { itemId: manual.id, requiredQty: 1 });

    await projects.finaliseAssembly(p.id, { outcome: 'PERMANENT_CONSUMPTION' });
    expect((await items.getById(manual.id))?.isActive).toBe(false);
  });

  it('takes a serialised instance whole rather than drawing its pinned quantity by count', async () => {
    // A SERIALISED row's quantity is pinned at 1 by a table CHECK, so a count draw would abort the
    // whole transaction instead of consuming the instance.
    const p = await projects.create({ name: 'Meter job' });
    const meter = await items.create({ name: 'Multimeter', trackingMode: 'SERIALISED' });
    await projects.addLine(p.id, { itemId: meter.id, requiredQty: 1 });

    await projects.finaliseAssembly(p.id, { outcome: 'PERMANENT_CONSUMPTION' });
    const after = await items.getById(meter.id);
    expect(after?.isActive).toBe(false);
    expect(after?.quantity).toBe(1);
  });

  it('CONTAINER: carries a gauge vessel in whole, and never calls it short there', async () => {
    // The bottle goes in the box; there is no slice of glue to move, so a requirement larger than
    // what is left must not block the move.
    const p = await projects.create({ name: 'Glue box' });
    const glue = await items.create({
      name: 'Adhesive',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'ml', grossCapacity: 500, tareWeight: 0, currentNetValue: 100 },
    });
    await projects.addLine(p.id, { itemId: glue.id, requiredQty: 600 });

    const result = await projects.finaliseAssembly(p.id, { outcome: 'CONTAINER' });
    const after = await items.getById(glue.id);
    expect(after?.locationId).toBe(result.locationId);
    // Moving the vessel consumes none of its contents.
    expect(after?.gauge?.currentNetValue).toBe(100);
  });

  it('lists the parts a finalise plans from, and moves nothing doing so', async () => {
    const p = await projects.create({ name: 'Shelf' });
    const screws = await items.create({ name: 'M3 screw', quantity: 500 });
    const rare = await items.create({ name: 'Rare chip', quantity: 1 });
    await projects.addLine(p.id, { itemId: screws.id, requiredQty: 4 });
    await projects.addLine(p.id, { itemId: rare.id, requiredQty: 3 });
    // An unmatched line has no part to draw and never reaches the summary.
    await projects.addLine(p.id, { description: 'Custom bracket' });

    const parts = await projects.listAssemblyParts(p.id);
    expect(parts.map((d) => [d.name, d.requiredQty, d.onHand])).toEqual([
      ['M3 screw', 4, 500],
      ['Rare chip', 3, 1],
    ]);
    // The plan the dialog draws from is the one the write rejects on.
    const plan = planAssemblyDraw(parts, 'PERMANENT_CONSUMPTION');
    expect(plan.feasible).toBe(false);
    expect(plan.shortfalls.map((s) => s.shortfallQty)).toEqual([2]);
    await expect(projects.finaliseAssembly(p.id, { outcome: 'PERMANENT_CONSUMPTION' })).rejects.toThrow(
      /Rare chip/,
    );
    // Reading the parts moves nothing.
    expect((await items.getById(screws.id))?.quantity).toBe(500);
  });

  // --- assembly idempotency under sync (issue #195) ------------------------------

  it('CONTAINER: derives the container id from the project so concurrent finalises converge', async () => {
    const p = await projects.create({ name: 'Lamp' });
    const a = await items.create({ name: 'LED', quantity: 1 });
    await projects.addLine(p.id, { itemId: a.id, requiredQty: 1 });

    const result = await projects.finaliseAssembly(p.id, { outcome: 'CONTAINER' });
    // The container id is a pure function of the project id, not a fresh random UUID — the
    // property that makes two devices' offline finalises mint the *same* location and merge
    // to one, rather than leaving two identical containers.
    expect(result.locationId).toBe(await assemblyId('container', p.id));
  });

  it('SINGULAR_OBJECT: derives the assembled item id from the project so concurrent finalises converge', async () => {
    const p = await projects.create({ name: 'Sensor Board' });
    const a = await items.create({ name: 'MCU', quantity: 1 });
    await projects.addLine(p.id, { itemId: a.id, requiredQty: 1 });

    const result = await projects.finaliseAssembly(p.id, { outcome: 'SINGULAR_OBJECT' });
    expect(result.itemId).toBe(await assemblyId('object', p.id));
  });

  it('derives assembly ledger-entry ids from the project so the union-by-id log does not duplicate', async () => {
    const p = await projects.create({ name: 'Glue Job' });
    const a = await items.create({ name: 'Epoxy', quantity: 1 });
    await projects.addLine(p.id, { itemId: a.id, requiredQty: 1 });

    await projects.finaliseAssembly(p.id, { outcome: 'PERMANENT_CONSUMPTION' });
    const consumed = (await items.getHistory(a.id)).rows.find((h) => h.action === 'CONSUMED');
    expect(consumed?.id).toBe(await assemblyId(`hist:CONSUMED:${a.id}`, p.id));
  });

  it('rejects finalising an already-completed project', async () => {
    const p = await projects.create({ name: 'Done Already' });
    const a = await items.create({ name: 'Part', quantity: 2 });
    await projects.addLine(p.id, { itemId: a.id, requiredQty: 1 });

    await projects.finaliseAssembly(p.id, { outcome: 'PERMANENT_CONSUMPTION' });
    // A second finalise is a one-shot violation — rejected cleanly rather than re-minting the
    // same derived ids into a primary-key clash.
    await expect(projects.finaliseAssembly(p.id, { outcome: 'CONTAINER' })).rejects.toBeInstanceOf(DbError);
  });

  // --- picking worksheet (issue #121 location-aware gather-and-tick) --------------

  it('lists a picking worksheet with each matched line’s per-location stock, busiest first', async () => {
    const garage = await locations.create({ name: 'Garage' });
    const loft = await locations.create({ name: 'Loft' });
    const p = await projects.create({ name: 'Kit' });

    // A matched part split across two locations (3 in Garage, 5 in Loft after the transfer).
    const bolt = await items.create({ name: 'Bolt', quantity: 8, locationId: garage.id });
    await items.transferStock(bolt.id, garage.id, loft.id, 5);
    const boltLine = await projects.addLine(p.id, { itemId: bolt.id, requiredQty: 4 });
    // A matched part with nothing on hand, and a free-text (unmatched) line.
    const empty = await items.create({ name: 'Nut', quantity: 0 });
    await projects.addLine(p.id, { itemId: empty.id, requiredQty: 2 });
    await projects.addLine(p.id, { description: 'Custom bracket' });

    const worksheet = await projects.listPickList(p.id);
    expect(worksheet).toHaveLength(3);

    // Declared order is preserved; the first line carries its per-location breakdown.
    const first = worksheet[0];
    expect(first.line.id).toBe(boltLine.id);
    expect(first.placements.map((s) => [s.locationName, s.quantity])).toEqual([
      ['Loft', 5],
      ['Garage', 3],
    ]);
    // Matched-but-empty and unmatched lines carry no placements to walk to.
    expect(worksheet[1].placements).toEqual([]);
    expect(worksheet[2].placements).toEqual([]);
  });

  it('orders the worksheet by walk order — lines and placements follow the picking sweep (issue #461)', async () => {
    const near = await locations.create({ name: 'Near bench', walkOrder: 1 });
    const far = await locations.create({ name: 'Far shelf', walkOrder: 5 });
    const p = await projects.create({ name: 'Kit' });

    // A part split across both: most of its stock is far away, but the sweep passes Near first.
    const split = await items.create({ name: 'Split', quantity: 10, locationId: far.id });
    await items.transferStock(split.id, far.id, near.id, 1); // Far 9, Near 1
    // A part only far away, declared FIRST; a part only near, declared LAST.
    const farOnly = await items.create({ name: 'FarOnly', quantity: 3, locationId: far.id });
    const nearOnly = await items.create({ name: 'NearOnly', quantity: 3, locationId: near.id });

    const splitLine = await projects.addLine(p.id, { itemId: split.id, requiredQty: 1 });
    const farLine = await projects.addLine(p.id, { itemId: farOnly.id, requiredQty: 1 });
    const nearLine = await projects.addLine(p.id, { itemId: nearOnly.id, requiredQty: 1 });

    const worksheet = await projects.listPickList(p.id);

    // Lines run in sweep order by each part's earliest location: split & nearOnly both start at
    // Near (walk order 1), farOnly at Far (5). The two ties fall back to declared order (split
    // was added before nearOnly), so the declared-first far-only part is pushed to the end.
    expect(worksheet.map((w) => w.line.id)).toEqual([splitLine.id, nearLine.id, farLine.id]);

    // Within the split part, the nearer location leads despite holding far less stock —
    // busiest-first would have put Far first.
    const splitRow = worksheet.find((w) => w.line.id === splitLine.id)!;
    expect(splitRow.placements.map((s) => [s.locationName, s.quantity])).toEqual([
      ['Near bench', 1],
      ['Far shelf', 9],
    ]);
  });

  it('ticks and un-ticks a line as picked without moving stock or logging history', async () => {
    const p = await projects.create({ name: 'Kit' });
    const item = await items.create({ name: 'Bolt', quantity: 5 });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 2 });
    expect(line.picked).toBe(false);
    const historyBefore = (await items.getHistory(item.id)).rows.length;

    const picked = await projects.setPicked(line.id, true);
    expect(picked.picked).toBe(true);
    // Picking is a transient annotation — no stock movement, no new ledger entry.
    expect((await items.getById(item.id))?.quantity).toBe(5);
    expect((await items.getHistory(item.id)).rows).toHaveLength(historyBefore);

    const cleared = await projects.setPicked(line.id, false);
    expect(cleared.picked).toBe(false);
  });

  it('rejects picking a line that does not exist', async () => {
    await expect(projects.setPicked('nope', true)).rejects.toBeInstanceOf(DbError);
  });
});
