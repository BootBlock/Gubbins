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

  it('listAll returns every location, past the default page size (issue #129)', async () => {
    // `list` is capped by the default page size; the flat list the UI works from must not be —
    // a location missing from it makes pickers, ancestry maths and the sidebar search wrong
    // rather than merely short.
    const created = 120;
    for (let i = 0; i < created; i += 1) await locations.create({ name: `Bay ${i}` });

    const paged = await locations.list();
    const all = await locations.listAll();

    expect(paged.rows.length).toBeLessThan(created);
    // Everything created, plus whatever system locations the schema seeds.
    expect(all.length).toBeGreaterThanOrEqual(created);
    expect(all.filter((l) => l.name.startsWith('Bay ')).length).toBe(created);
    // Same ordering as the paged read, so the two never disagree about sequence.
    expect(all.slice(0, paged.rows.length).map((l) => l.id)).toEqual(paged.rows.map((l) => l.id));
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

  describe('dead-stock reporting fields (issue #92)', () => {
    it('defaults to inheriting, with no idle-threshold override', async () => {
      const loc = await locations.create({ name: 'Shelf' });
      expect(loc.deadStockMode).toBe('inherit');
      expect(loc.deadStockDays).toBeNull();
    });

    it('round-trips the mode and threshold through update and getById', async () => {
      const loc = await locations.create({ name: 'Deep storage' });
      const saved = await locations.update(loc.id, { deadStockMode: 'always', deadStockDays: 365 });
      expect(saved.deadStockMode).toBe('always');
      expect(saved.deadStockDays).toBe(365);

      const reread = await locations.getById(loc.id);
      expect(reread?.deadStockMode).toBe('always');
      expect(reread?.deadStockDays).toBe(365);
    });

    /**
     * The list/tree read enumerates its columns explicitly (unlike `getById`'s `SELECT *`),
     * so a new column is only returned if it was added there too. The edit dialog is fed
     * from this read, so omitting it silently showed every location as un-configured while
     * the value sat correctly in the database.
     */
    it('returns the fields from the list read that feeds the location tree', async () => {
      const loc = await locations.create({ name: 'Deep storage' });
      await locations.update(loc.id, { deadStockMode: 'always', deadStockDays: 365 });

      const listed = (await locations.list()).rows.find((l) => l.id === loc.id);
      expect(listed?.deadStockMode).toBe('always');
      expect(listed?.deadStockDays).toBe(365);
    });

    it('clamps an out-of-range threshold rather than tripping the DB CHECK', async () => {
      const loc = await locations.create({ name: 'Shelf' });
      const saved = await locations.update(loc.id, { deadStockDays: 0 });
      expect(saved.deadStockDays).toBe(1); // clamped up to the floor
    });

    it('clears the threshold override back to null', async () => {
      const loc = await locations.create({ name: 'Shelf' });
      await locations.update(loc.id, { deadStockDays: 30 });
      const cleared = await locations.update(loc.id, { deadStockDays: null });
      expect(cleared.deadStockDays).toBeNull();
    });
  });

  describe('createPath (nested-create shortcut §4)', () => {
    it('creates the whole branch from a slash-separated path and returns the leaf', async () => {
      const [leaf] = await locations.createPath({ name: 'Workshop/Cabinet A/Drawer 3' });
      expect(leaf!.name).toBe('Drawer 3');

      const tree = await locations.getTree();
      const workshop = tree.find((n) => n.name === 'Workshop');
      const cabinet = workshop?.children[0];
      expect(cabinet?.name).toBe('Cabinet A');
      expect(cabinet?.children[0]?.name).toBe('Drawer 3');
      expect(cabinet?.children[0]?.id).toBe(leaf!.id);
    });

    it('applies the metadata to the leaf only; ancestors are bare', async () => {
      const [leaf] = await locations.createPath({
        name: 'Workshop/Drawer 3',
        kind: 'drawer',
        capacity: 12,
      });
      expect(leaf!.kind).toBe('drawer');
      expect(leaf!.capacity).toBe(12);

      const workshop = (await locations.getTree()).find((n) => n.name === 'Workshop');
      expect(workshop?.kind).toBeNull();
      expect(workshop?.capacity).toBeNull();
    });

    it('reuses existing levels instead of duplicating them', async () => {
      await locations.createPath({ name: 'Workshop/Cabinet A/Drawer 1' });
      await locations.createPath({ name: 'Workshop/Cabinet A/Drawer 2' });

      const tree = await locations.getTree();
      const workshops = tree.filter((n) => n.name === 'Workshop');
      expect(workshops).toHaveLength(1);
      const cabinets = workshops[0]!.children.filter((n) => n.name === 'Cabinet A');
      expect(cabinets).toHaveLength(1);
      expect(cabinets[0]!.children.map((n) => n.name).sort()).toEqual(['Drawer 1', 'Drawer 2']);
    });

    it('matches existing levels case-insensitively', async () => {
      const [first] = await locations.createPath({ name: 'Workshop/Cabinet A' });
      const [second] = await locations.createPath({ name: 'workshop/cabinet a' });
      // The second path resolves to the same rows; the leaf is the already-created one.
      expect(second!.id).toBe(first!.id);
      const workshops = (await locations.getTree()).filter((n) => n.name === 'Workshop');
      expect(workshops).toHaveLength(1);
    });

    it('nests the whole path under an explicit starting parent', async () => {
      const building = await locations.create({ name: 'Building' });
      const [leaf] = await locations.createPath({ name: 'Room 1/Shelf', parentId: building.id });

      const buildingNode = (await locations.getTree()).find((n) => n.id === building.id);
      const room = buildingNode?.children.find((n) => n.name === 'Room 1');
      expect(room?.children[0]?.name).toBe('Shelf');
      expect(room?.children[0]?.id).toBe(leaf!.id);
    });

    it('behaves like a plain create for a separator-free name', async () => {
      const [leaf] = await locations.createPath({ name: 'Shelf', capacity: 5 });
      expect(leaf!.parentId).toBeNull();
      expect(leaf!.capacity).toBe(5);
    });

    it('rejects a path that has no usable segments', async () => {
      await expect(locations.createPath({ name: ' / \\ ' })).rejects.toBeInstanceOf(DbError);
    });

    it('fans a comma-separated leaf out into siblings under the shared parent', async () => {
      const created = await locations.createPath({ name: 'Garage/Box 1, Box 2, Box 3' });
      expect(created.map((l) => l.name)).toEqual(['Box 1', 'Box 2', 'Box 3']);

      const garage = (await locations.getTree()).find((n) => n.name === 'Garage');
      expect(garage?.children.map((n) => n.name).sort()).toEqual(['Box 1', 'Box 2', 'Box 3']);
      // All three share the one Garage parent — the ancestor is created once, not per sibling.
      expect(created.every((l) => l.parentId === garage!.id)).toBe(true);
    });

    it('applies the shared metadata to every fanned-out sibling', async () => {
      const created = await locations.createPath({
        name: 'Garage/Box 1, Box 2',
        kind: 'box',
        capacity: 8,
      });
      expect(created.every((l) => l.kind === 'box' && l.capacity === 8)).toBe(true);
    });

    it('reuses an existing sibling and only creates the missing ones', async () => {
      const [existing] = await locations.createPath({ name: 'Garage/Box 1' });
      const created = await locations.createPath({ name: 'Garage/Box 1, Box 2' });
      // Box 1 is reused (same id), Box 2 is freshly created.
      expect(created[0]!.id).toBe(existing!.id);

      const garage = (await locations.getTree()).find((n) => n.name === 'Garage');
      expect(garage?.children.map((n) => n.name).sort()).toEqual(['Box 1', 'Box 2']);
    });

    it('honours the doubled-comma escape to create one literal-comma name', async () => {
      const created = await locations.createPath({ name: 'Garage/Bay 1,, 2' });
      expect(created).toHaveLength(1);
      expect(created[0]!.name).toBe('Bay 1, 2');
    });
  });

  it('cannot commit a cycle across two interleaved re-parents (§7.5.3)', async () => {
    const a = await locations.create({ name: 'A' });
    const b = await locations.create({ name: 'B' });
    // Fire A→B and B→A together WITHOUT awaiting in between, so their check-then-write steps
    // interleave (the memory driver wraps synchronous SQLite in async methods, so each `await`
    // yields). Before the guard lived in the write, both moves passed the separate pre-check
    // against pre-move state and both committed, forming A→B→A and orphaning the pair from the
    // tree. Now at most one may win; the loser must be refused and no loop may ever land.
    const results = await Promise.allSettled([
      locations.update(a.id, { parentId: b.id }),
      locations.update(b.id, { parentId: a.id }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(DbError);

    // Exactly one is now nested under the other; the winner stays a root — never a mutual loop.
    const freshA = await locations.getById(a.id);
    const freshB = await locations.getById(b.id);
    const oneWayNesting =
      (freshA?.parentId === b.id && freshB?.parentId === null) ||
      (freshB?.parentId === a.id && freshA?.parentId === null);
    expect(oneWayNesting).toBe(true);
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

  it('promotes a new default and re-parents in one update (guarded demotion still fires)', async () => {
    // A combined edit that both re-nests a location AND makes it the default: the parent move is
    // cycle-guarded, and the same guard now rides the default-demotion — so a legitimate move
    // still demotes the old default and sets the new one together.
    const old = await locations.create({ name: 'Old default', isDefault: true });
    const parent = await locations.create({ name: 'Parent' });
    const child = await locations.create({ name: 'Child' });

    const updated = await locations.update(child.id, { parentId: parent.id, isDefault: true });
    expect(updated.parentId).toBe(parent.id);
    expect(updated.isDefault).toBe(true);

    expect((await locations.getById(old.id))?.isDefault).toBe(false);
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
