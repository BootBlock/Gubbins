import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from './ItemRepository';
import { isLow, isOutOfStock, type ReorderDefaults } from '@/features/inventory/reorder-policy';

/**
 * **Drift guard (issue #156).** "Running low" and "out of stock" are each decided twice: once
 * in SQL (`lowStockPredicateSql` / `outOfStockPredicateSql`, behind `listLowStock` and the
 * inventory list's status chips) and once in pure TypeScript (`isLow` / `isOutOfStock`, behind
 * the item card's badge, the supply-state seam and the bridge's Home Assistant / `/metrics`
 * counts). Two definitions of one concept is the parallel-exhaustive-list drift class, and it
 * had already drifted: only the SQL excluded abstract variant parents, so a parent left at
 * `quantity = 0` with an old reorder point was simultaneously low and not-low depending on
 * which surface you read.
 *
 * A doc comment saying "these must match" is what failed. So instead of asserting the two
 * predicates *individually*, these tests seed one deliberately awkward inventory and assert the
 * two answers are the **same set** — whichever of them a future change moves, the other has to
 * move with it or this fails.
 */
describe('low / out-of-stock — SQL predicate ↔ pure seam parity', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  /** A blanket that is on, so the opt-in gate isn't quietly doing all the excluding. */
  const DEFAULTS: ReorderDefaults = { qtyThreshold: 5, gaugePercent: 15 };

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  /**
   * One item per interesting shape — every tracking mode, both sides of each floor, the opt-in
   * and opt-out edges, unlimited supply, an inactive item, and (the issue) a variant parent
   * that keeps a stock level and reorder point from before it had children.
   */
  async function seedAwkwardInventory(): Promise<void> {
    await items.create({ name: 'DiscreteEmpty', trackingMode: 'DISCRETE', quantity: 0 });
    await items.create({ name: 'DiscreteLow', trackingMode: 'DISCRETE', quantity: 2 });
    await items.create({ name: 'DiscreteAtFloor', trackingMode: 'DISCRETE', quantity: 5 });
    await items.create({ name: 'DiscreteHealthy', trackingMode: 'DISCRETE', quantity: 50 });
    await items.create({ name: 'OwnHighFloor', trackingMode: 'DISCRETE', quantity: 15, reorderPoint: 20 });
    // Per-item opt-out: a 0 floor is "off" even while the blanket is on — but it is still *out*.
    await items.create({ name: 'OptedOutEmpty', trackingMode: 'DISCRETE', quantity: 0, reorderPoint: 0 });
    await items.create({ name: 'Unlimited', trackingMode: 'DISCRETE', quantity: 0, isUnlimited: true });
    await items.create({ name: 'Serialised', trackingMode: 'SERIALISED' });
    await items.create({ name: 'Untracked', trackingMode: 'UNTRACKED' });
    await items.create({
      name: 'GaugeLow',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 100 }, // 10%
    });
    await items.create({
      name: 'GaugeEmpty',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 0 },
    });
    await items.create({
      name: 'GaugeHealthy',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 800 }, // 80%
    });
    // (A gauge with no usable capacity can't be created — `resolveCreate` requires a positive
    // gross capacity — so that shared edge stays covered by the pure `reorder-policy` tests.)
    const inactive = await items.create({ name: 'Deleted', trackingMode: 'DISCRETE', quantity: 0 });
    await items.softDelete(inactive.id);

    // The issue's scenario: an ordinary low/empty item that *later* becomes a variant parent.
    // `setParent` writes the child's `parent_id` and nothing else, so the parent keeps the
    // quantity and reorder point it had when it held stock itself.
    const parent = await items.create({
      name: 'VariantParent',
      trackingMode: 'DISCRETE',
      quantity: 0,
      reorderPoint: 5,
    });
    const child = await items.create({ name: 'VariantChild', trackingMode: 'DISCRETE', quantity: 40 });
    await items.setParent(child.id, parent.id);
  }

  /** Every active item, read the way the card grid and the bridge scan read them. */
  async function allActiveItems() {
    const page = await items.list({ limit: 200 });
    return page.rows;
  }

  const names = (rows: readonly { name: string }[]) => rows.map((r) => r.name).sort();

  it('agrees on which items are low — SQL feed vs pure isLow', async () => {
    await seedAwkwardInventory();

    const fromSql = await items.listLowStock(DEFAULTS, { limit: 200 });
    const fromPure = (await allActiveItems()).filter((item) => isLow(item, DEFAULTS));

    expect(names(fromPure)).toEqual(names(fromSql.rows));
    // …and the set is non-trivial, so a bug that made *both* sides empty can't pass.
    expect(names(fromSql.rows)).toEqual([
      'DiscreteAtFloor',
      'DiscreteEmpty',
      'DiscreteLow',
      'GaugeEmpty',
      'GaugeLow',
      'OwnHighFloor',
    ]);
  });

  it('agrees on which items are low — inventory status chip vs pure isLow', async () => {
    await seedAwkwardInventory();

    const fromSql = await items.list({
      status: ['low-stock'],
      lowStockThresholds: DEFAULTS,
      limit: 200,
    });
    const fromPure = (await allActiveItems()).filter((item) => isLow(item, DEFAULTS));

    expect(names(fromPure)).toEqual(names(fromSql.rows));
  });

  it('agrees on which items are out of stock — status chip vs pure isOutOfStock', async () => {
    await seedAwkwardInventory();

    const fromSql = await items.list({ status: ['out-of-stock'], limit: 200 });
    const fromPure = (await allActiveItems()).filter((item) => isOutOfStock(item));

    expect(names(fromPure)).toEqual(names(fromSql.rows));
    // Out-of-stock is not opt-in, so the opted-out empty item is here while it is not "low".
    expect(names(fromSql.rows)).toEqual(['DiscreteEmpty', 'GaugeEmpty', 'OptedOutEmpty']);
  });

  it('excludes the abstract variant parent from both answers', async () => {
    await seedAwkwardInventory();

    const parent = (await allActiveItems()).find((i) => i.name === 'VariantParent')!;
    // It kept the stock level and reorder point that used to make it low, and is still at zero.
    expect(parent.quantity).toBe(0);
    expect(parent.reorderPoint).toBe(5);
    // …but it holds no stock of its own now, so neither predicate flags it.
    expect(parent.hasVariants).toBe(true);
    expect(isLow(parent, DEFAULTS)).toBe(false);
    expect(isOutOfStock(parent)).toBe(false);
  });
});

/**
 * `Item.hasVariants` is what makes the parity above possible, and it is derived per read rather
 * than stored — so every read that produces an `Item` has to project it. These lock that in for
 * each read path (they all share `ITEM_READ_COLUMNS`, and this is what notices if one stops).
 */
describe('Item.hasVariants — derived on every item read', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let parentId: string;
  let childId: string;
  let nestedId: string;
  let loneId: string;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);

    const parent = await items.create({ name: 'Resistor kit', quantity: 0 });
    const child = await items.createVariant(parent.id, { name: 'Resistor kit 10k', quantity: 100 });
    // A second child that is itself a parent (nesting is unbounded), so a read of the *variant
    // list* has both answers in it — an assertion of all-false there would pass even if the
    // read stopped projecting the column at all.
    const nested = await items.createVariant(parent.id, { name: 'Resistor kit SMD', quantity: 5 });
    await items.createVariant(nested.id, { name: 'Resistor kit SMD 0603', quantity: 20 });
    const lone = await items.create({ name: 'Solder', quantity: 3 });
    parentId = parent.id;
    childId = child.id;
    nestedId = nested.id;
    loneId = lone.id;
  });

  afterEach(async () => {
    await driver.close();
  });

  it('is set by getById / getManyById', async () => {
    expect((await items.getById(parentId))?.hasVariants).toBe(true);
    expect((await items.getById(childId))?.hasVariants).toBe(false);
    expect((await items.getById(loneId))?.hasVariants).toBe(false);

    const many = await items.getManyById([parentId, loneId]);
    expect(many.get(parentId)?.hasVariants).toBe(true);
    expect(many.get(loneId)?.hasVariants).toBe(false);
  });

  it('is set by the paginated list', async () => {
    const page = await items.list({ limit: 100 });
    const byName = new Map(page.rows.map((r) => [r.name, r.hasVariants]));
    expect(byName.get('Resistor kit')).toBe(true);
    expect(byName.get('Resistor kit 10k')).toBe(false);
    expect(byName.get('Solder')).toBe(false);
  });

  it('is set by listVariants and by an AST search', async () => {
    const variants = await items.listVariants(parentId);
    expect(new Map(variants.rows.map((r) => [r.name, r.hasVariants]))).toEqual(
      new Map([
        ['Resistor kit 10k', false],
        ['Resistor kit SMD', true], // itself a parent — so this read must project the column
      ]),
    );

    const found = await items.searchByAst({
      type: 'GROUP',
      logicalOperator: 'AND',
      conditions: [{ field: 'name', operator: 'CONTAINS', value: 'Resistor kit' }],
    });
    const byName = new Map(found.rows.map((r) => [r.name, r.hasVariants]));
    expect(byName.get('Resistor kit')).toBe(true);
    expect(byName.get('Resistor kit 10k')).toBe(false);
  });

  it('follows the parentage rather than a stored flag — detaching the last child clears it', async () => {
    await items.setParent(childId, null);
    expect((await items.getById(parentId))?.hasVariants).toBe(true); // `nested` is still attached

    await items.setParent(nestedId, null);
    expect((await items.getById(parentId))?.hasVariants).toBe(false);

    await items.setParent(childId, parentId);
    expect((await items.getById(parentId))?.hasVariants).toBe(true);
  });
});
