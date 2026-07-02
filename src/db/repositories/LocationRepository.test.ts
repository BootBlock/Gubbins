import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { LocationRepository } from './LocationRepository';
import { ItemRepository } from './ItemRepository';
import { MaintenanceRepository } from './MaintenanceRepository';
import { UNASSIGNED_LOCATION_ID } from './constants';

describe('LocationRepository', () => {
  let driver: MemoryDriver;
  let locations: LocationRepository;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    locations = new LocationRepository(driver);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('exposes the seeded system-locked Unassigned location', async () => {
    const unassigned = await locations.getById(UNASSIGNED_LOCATION_ID);
    expect(unassigned?.name).toBe('Unassigned');
    expect(unassigned?.isSystem).toBe(true);
  });

  it('creates nested locations and exposes them as a tree', async () => {
    const workshop = await locations.create({ name: 'Workshop' });
    const cabinet = await locations.create({ name: 'Cabinet A', parentId: workshop.id });
    await locations.create({ name: 'Drawer 1', parentId: cabinet.id });

    const tree = await locations.getTree();
    const workshopNode = tree.find((n) => n.id === workshop.id);
    expect(workshopNode?.children).toHaveLength(1);
    expect(workshopNode?.children[0]?.children[0]?.name).toBe('Drawer 1');
  });

  it('rejects creating a child under a non-existent parent', async () => {
    await expect(locations.create({ name: 'Orphan', parentId: 'nope' })).rejects.toBeInstanceOf(DbError);
  });

  it('counts only active items per location', async () => {
    const shelf = await locations.create({ name: 'Shelf' });
    await items.create({ name: 'A', locationId: shelf.id });
    const b = await items.create({ name: 'B', locationId: shelf.id });
    await items.softDelete(b.id);

    const page = await locations.list();
    const shelfRow = page.rows.find((l) => l.id === shelf.id);
    expect(shelfRow?.itemCount).toBe(1);
  });

  it('refuses to modify or delete the Unassigned location', async () => {
    await expect(locations.update(UNASSIGNED_LOCATION_ID, { name: 'Nope' })).rejects.toBeInstanceOf(DbError);
    await expect(locations.delete(UNASSIGNED_LOCATION_ID)).rejects.toBeInstanceOf(DbError);
  });

  it('prevents a cyclical parent move (§7.5.3)', async () => {
    const x = await locations.create({ name: 'X' });
    const y = await locations.create({ name: 'Y', parentId: x.id });
    // Moving X under its own descendant Y would form a loop.
    await expect(locations.update(x.id, { parentId: y.id })).rejects.toBeInstanceOf(DbError);
  });

  it('allows a legitimate parent move', async () => {
    const a = await locations.create({ name: 'A' });
    const b = await locations.create({ name: 'B' });
    const moved = await locations.update(b.id, { parentId: a.id });
    expect(moved.parentId).toBe(a.id);
  });

  it('re-parents orphaned items to Unassigned on delete and logs it (§4)', async () => {
    const shelf = await locations.create({ name: 'Shelf' });
    const widget = await items.create({ name: 'Widget', locationId: shelf.id });

    await locations.delete(shelf.id);

    const moved = await items.getById(widget.id);
    expect(moved?.locationId).toBe(UNASSIGNED_LOCATION_ID);

    const history = await items.getHistory(widget.id);
    expect(history.rows.some((h) => h.action === 'RE_PARENTED')).toBe(true);
  });

  it('reverts a location-scoped maintenance schedule to item-level on delete (Phase 30)', async () => {
    const bench = await locations.create({ name: 'Workshop bench' });
    const tool = await items.create({ name: 'Lathe', locationId: bench.id });
    const maintenance = new MaintenanceRepository(driver);
    const sched = await maintenance.create({
      itemId: tool.id,
      name: 'Bench calibrate',
      basis: 'TIME',
      intervalDays: 30,
      locationId: bench.id,
    });

    // Deleting the scope location must not block on its RESTRICT FK, nor delete the schedule.
    await locations.delete(bench.id);

    const after = await maintenance.getById(sched.id);
    expect(after).toBeDefined();
    expect(after?.locationId).toBeNull(); // reverted to item-level
  });

  it('promotes child locations to the deleted parent', async () => {
    const root = await locations.create({ name: 'Root' });
    const mid = await locations.create({ name: 'Mid', parentId: root.id });
    const leaf = await locations.create({ name: 'Leaf', parentId: mid.id });

    await locations.delete(mid.id);

    const promoted = await locations.getById(leaf.id);
    expect(promoted?.parentId).toBe(root.id);
  });

  it('honours the storage Hard Stop on create but permits delete', async () => {
    let locked = false;
    const gated = new LocationRepository(driver, { isWriteSuspended: () => locked });
    const doomed = await gated.create({ name: 'Temp' });

    locked = true;
    await expect(gated.create({ name: 'Blocked' })).rejects.toMatchObject({
      code: 'WRITE_SUSPENDED',
    });
    // Deletes free space, so they must still work under the Hard Stop.
    await expect(gated.delete(doomed.id)).resolves.toBeUndefined();
  });

  it('persists the richer metadata (type, capacity, default)', async () => {
    const loc = await locations.create({
      name: 'Cabinet',
      kind: 'cabinet',
      capacity: 20,
      isDefault: true,
    });
    const read = await locations.getById(loc.id);
    expect(read).toMatchObject({ kind: 'cabinet', capacity: 20, isDefault: true });
  });

  it('coerces a blank/negative capacity to null (unbounded)', async () => {
    const loc = await locations.create({ name: 'Shelf', capacity: -5 });
    expect((await locations.getById(loc.id))?.capacity).toBeNull();
    const updated = await locations.update(loc.id, { capacity: 7.9 });
    expect(updated.capacity).toBe(7); // floored
  });

  it('keeps at most one default — a new default demotes the previous one', async () => {
    const a = await locations.create({ name: 'A', isDefault: true });
    const b = await locations.create({ name: 'B' });
    await locations.setDefault(b.id);

    expect((await locations.getById(a.id))?.isDefault).toBe(false);
    expect((await locations.getById(b.id))?.isDefault).toBe(true);
    // Exactly one default row remains.
    const list = await locations.list();
    expect(list.rows.filter((l) => l.isDefault)).toHaveLength(1);
  });

  it('archives and restores a location', async () => {
    const loc = await locations.create({ name: 'Attic' });
    const archived = await locations.setArchived(loc.id, true);
    expect(archived.archivedAt).toBeTypeOf('number');

    const restored = await locations.setArchived(loc.id, false);
    expect(restored.archivedAt).toBeNull();
  });

  it('refuses to make a system location the default or archive it', async () => {
    await expect(locations.setDefault(UNASSIGNED_LOCATION_ID)).rejects.toBeInstanceOf(DbError);
    await expect(locations.setArchived(UNASSIGNED_LOCATION_ID, true)).rejects.toBeInstanceOf(DbError);
  });
});
