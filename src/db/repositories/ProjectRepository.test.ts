import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { IN_TRANSIT_LOCATION_ID, UNASSIGNED_LOCATION_ID } from './constants';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { ProjectRepository } from './ProjectRepository';

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

  it('receives a matched discrete line into stock, moving it and logging RECEIVED', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'IC', quantity: 1 });
    const shelf = await locations.create({ name: 'Shelf A' });
    const line = await projects.addLine(p.id, { itemId: item.id, requiredQty: 4 });

    const received = await projects.receiveLine(line.id, { locationId: shelf.id });
    expect(received.procurementStatus).toBe('RECEIVED');

    const updated = await items.getById(item.id);
    expect(updated?.quantity).toBe(5); // 1 on-hand + 4 received
    expect(updated?.locationId).toBe(shelf.id);
    const history = await items.getHistory(item.id);
    expect(history.rows.some((h) => h.action === 'RECEIVED')).toBe(true);
  });

  it('exposes the system-locked In-Transit location', async () => {
    const loc = await locations.getById(IN_TRANSIT_LOCATION_ID);
    expect(loc?.name).toBe('In Transit');
    expect(loc?.isSystem).toBe(true);
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

  it('lists shortfalls (required − reserved) for un-procured lines', async () => {
    const p = await projects.create({ name: 'P' });
    const item = await items.create({ name: 'R', unitCost: 0.1 });
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
    const fully = await items.create({ name: 'A' });
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

  // --- assembly outcomes (spec §4 Composite Items & Assemblies) ------------------

  it('CONTAINER: turns the project into a location holding the matched parts', async () => {
    const p = await projects.create({ name: 'Lamp' });
    const a = await items.create({ name: 'LED' });
    const b = await items.create({ name: 'Resistor' });
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

    const consumed = await items.getById(a.id);
    expect(consumed?.isActive).toBe(false); // part consumed
    const history = await items.getHistory(a.id);
    expect(history.rows.some((h) => h.action === 'CONSUMED')).toBe(true);
  });

  it('PERMANENT_CONSUMPTION: soft-deletes the parts with no new item or location', async () => {
    const p = await projects.create({ name: 'Glue Job' });
    const a = await items.create({ name: 'Epoxy A' });
    const b = await items.create({ name: 'Epoxy B' });
    await projects.addLine(p.id, { itemId: a.id, requiredQty: 1 });
    await projects.addLine(p.id, { itemId: b.id, requiredQty: 1 });

    const result = await projects.finaliseAssembly(p.id, { outcome: 'PERMANENT_CONSUMPTION' });
    expect(result.itemId).toBeUndefined();
    expect(result.locationId).toBeUndefined();

    expect((await items.getById(a.id))?.isActive).toBe(false);
    expect((await items.getById(b.id))?.isActive).toBe(false);
    expect((await projects.getById(p.id))?.status).toBe('COMPLETED');
  });

  it('does not place a SINGULAR_OBJECT result in a system-locked location by default', async () => {
    const p = await projects.create({ name: 'Thing' });
    const a = await items.create({ name: 'Part' });
    await projects.addLine(p.id, { itemId: a.id, requiredQty: 1 });
    const result = await projects.finaliseAssembly(p.id, { outcome: 'SINGULAR_OBJECT' });
    const assembled = await items.getById(result.itemId!);
    expect(assembled?.locationId).toBe(UNASSIGNED_LOCATION_ID);
  });
});
