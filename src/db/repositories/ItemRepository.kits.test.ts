import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { buildableCount } from '@/features/inventory/kit-availability';
import { ItemRepository } from './ItemRepository';

/**
 * Kits v1 — the `kit_components` edge repository: list (joined to each component's name and
 * current on-hand stock), add / re-quantify / remove, and the acyclic-containment guard
 * (self + transitive cycle rejection via the recursive-CTE + pure `validateKitLink`). The
 * buildable count is derived from `listKitComponents` by the pure `buildableCount`, so it is
 * exercised here against seeded stock.
 */
describe('ItemRepository — Kits v1 (definition + availability)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('adds components and lists them joined to name + current stock, ordered by sort', async () => {
    const kit = await items.create({ name: 'First-aid kit' });
    const bandage = await items.create({ name: 'Bandage', quantity: 10 });
    const scissors = await items.create({ name: 'Scissors', quantity: 3 });

    await items.addKitComponent(kit.id, bandage.id, 2);
    const list = await items.addKitComponent(kit.id, scissors.id, 1);

    expect(list).toHaveLength(2);
    // Ordered by insertion (sort 0, 1).
    expect(list.map((c) => c.name)).toEqual(['Bandage', 'Scissors']);
    expect(list[0]).toMatchObject({ componentItemId: bandage.id, quantity: 2, stock: 10, sort: 0 });
    expect(list[1]).toMatchObject({ componentItemId: scissors.id, quantity: 1, stock: 3, sort: 1 });
  });

  it('computes the buildable count as the scarcest component (min floor(stock/qty))', async () => {
    const kit = await items.create({ name: 'First-aid kit' });
    const bandage = await items.create({ name: 'Bandage', quantity: 10 }); // 10/2 = 5
    const scissors = await items.create({ name: 'Scissors', quantity: 3 }); // 3/1  = 3 (limiting)
    const plaster = await items.create({ name: 'Plaster', quantity: 20 }); // 20/5 = 4

    await items.addKitComponent(kit.id, bandage.id, 2);
    await items.addKitComponent(kit.id, scissors.id, 1);
    await items.addKitComponent(kit.id, plaster.id, 5);

    const components = await items.listKitComponents(kit.id);
    const { count, limiting } = buildableCount(components);
    expect(count).toBe(3);
    expect(limiting.map((c) => c.name)).toEqual(['Scissors']);
  });

  it('re-quantifies a component line (clamped to ≥ 1)', async () => {
    const kit = await items.create({ name: 'Kit' });
    const part = await items.create({ name: 'Part', quantity: 100 });
    const [line] = await items.addKitComponent(kit.id, part.id, 1);

    let list = await items.updateKitComponentQty(line.id, 4);
    expect(list[0].quantity).toBe(4);

    // A non-positive request is clamped up to 1, never stored (the DB CHECK forbids ≤ 0).
    list = await items.updateKitComponentQty(line.id, 0);
    expect(list[0].quantity).toBe(1);
  });

  it('removes a component line', async () => {
    const kit = await items.create({ name: 'Kit' });
    const a = await items.create({ name: 'A' });
    const b = await items.create({ name: 'B' });
    const [, second] = await items
      .addKitComponent(kit.id, a.id, 1)
      .then(() => items.addKitComponent(kit.id, b.id, 1));
    const remaining = await items.removeKitComponent(second.id);
    expect(remaining.map((c) => c.name)).toEqual(['A']);
  });

  it('rejects self-containment (a kit cannot be its own component)', async () => {
    const kit = await items.create({ name: 'Kit' });
    await expect(items.addKitComponent(kit.id, kit.id, 1)).rejects.toBeInstanceOf(DbError);
  });

  it('rejects a direct cycle (A contains B, then B contains A)', async () => {
    const a = await items.create({ name: 'A' });
    const b = await items.create({ name: 'B' });
    await items.addKitComponent(a.id, b.id, 1);
    await expect(items.addKitComponent(b.id, a.id, 1)).rejects.toBeInstanceOf(DbError);
  });

  it('rejects a transitive cycle (A→B→C, then C contains A)', async () => {
    const a = await items.create({ name: 'A' });
    const b = await items.create({ name: 'B' });
    const c = await items.create({ name: 'C' });
    await items.addKitComponent(a.id, b.id, 1);
    await items.addKitComponent(b.id, c.id, 1);
    // C already sits below A (A→B→C), so making C contain A closes the loop.
    await expect(items.addKitComponent(c.id, a.id, 1)).rejects.toBeInstanceOf(DbError);
    // A shared component that is NOT an ancestor is fine (a diamond, not a cycle).
    const shared = await items.create({ name: 'Shared' });
    await expect(items.addKitComponent(a.id, shared.id, 1)).resolves.toBeDefined();
    await expect(items.addKitComponent(c.id, shared.id, 1)).resolves.toBeDefined();
  });

  it('rejects a duplicate component and a non-existent item', async () => {
    const kit = await items.create({ name: 'Kit' });
    const part = await items.create({ name: 'Part' });
    await items.addKitComponent(kit.id, part.id, 1);
    // The UNIQUE(kit_item_id, component_item_id) index forbids the same component twice.
    await expect(items.addKitComponent(kit.id, part.id, 1)).rejects.toBeInstanceOf(DbError);
    // A component that isn't a real item is refused before the insert.
    await expect(items.addKitComponent(kit.id, 'no-such-item', 1)).rejects.toBeInstanceOf(DbError);
  });

  it('cascade-deletes component edges when the kit or a component item is hard-deleted', async () => {
    const kit = await items.create({ name: 'Kit' });
    const part = await items.create({ name: 'Part' });
    await items.addKitComponent(kit.id, part.id, 1);

    // Deleting the component item prunes the edge (FK ON DELETE CASCADE).
    await items.hardDelete(part.id);
    expect(await items.listKitComponents(kit.id)).toHaveLength(0);
  });
});
