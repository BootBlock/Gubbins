import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { buildableCount } from '@/features/inventory/kit-availability';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';

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

/**
 * Kits v2 — the stock-moving `assemble`/`disassemble` operations. Assembly consumes
 * `qtyPerKit × count` of every component and produces `count` of the kit, all in one atomic
 * transaction guarded by the buildable ceiling; disassembly is its exact inverse, guarded by
 * the kit's on-hand quantity. Both log to the immutable Activity Log with correct deltas and
 * never write `items.quantity` directly (the per-location ledger triggers derive it).
 */
describe('ItemRepository — Kits v2 (assemble / disassemble)', () => {
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

  /** A first-aid kit needing 2 bandages + 1 scissors, seeded with ample component stock. */
  async function seedKit(opts?: { bandages?: number; scissors?: number }) {
    const kit = await items.create({ name: 'First-aid kit' });
    const bandage = await items.create({ name: 'Bandage', quantity: opts?.bandages ?? 10 });
    const scissors = await items.create({ name: 'Scissors', quantity: opts?.scissors ?? 3 });
    await items.addKitComponent(kit.id, bandage.id, 2);
    await items.addKitComponent(kit.id, scissors.id, 1);
    return { kit, bandage, scissors };
  }

  it('assembles kits: decrements every component and increments the kit atomically', async () => {
    const { kit, bandage, scissors } = await seedKit(); // 10/2 = 5, 3/1 = 3 → 3 buildable

    const updated = await items.assemble(kit.id, 2);

    expect(updated.quantity).toBe(2); // two kits produced
    expect((await items.getById(bandage.id))!.quantity).toBe(10 - 2 * 2); // 6
    expect((await items.getById(scissors.id))!.quantity).toBe(3 - 1 * 2); // 1
  });

  it('logs an ASSEMBLED entry on the kit and reciprocal CONSUMED entries with correct deltas', async () => {
    const { kit, bandage, scissors } = await seedKit();

    await items.assemble(kit.id, 2);

    const kitLog = await items.getHistory(kit.id);
    const assembled = kitLog.rows.find((h) => h.action === 'ASSEMBLED');
    expect(assembled).toBeDefined();
    expect(assembled!.quantityDelta).toBe(2);

    const bandageLog = await items.getHistory(bandage.id);
    const consumed = bandageLog.rows.find((h) => h.action === 'CONSUMED');
    expect(consumed).toBeDefined();
    expect(consumed!.quantityDelta).toBe(-4); // 2 per kit × 2 kits

    const scissorsConsumed = (await items.getHistory(scissors.id)).rows.find((h) => h.action === 'CONSUMED');
    expect(scissorsConsumed!.quantityDelta).toBe(-2);
  });

  it('rejects assembling more than the buildable ceiling and rolls back everything', async () => {
    const { kit, bandage, scissors } = await seedKit(); // ceiling = 3

    await expect(items.assemble(kit.id, 4)).rejects.toBeInstanceOf(DbError);

    // All-or-nothing: no stock moved, no kit produced, no history written.
    expect((await items.getById(kit.id))!.quantity).toBe(0);
    expect((await items.getById(bandage.id))!.quantity).toBe(10);
    expect((await items.getById(scissors.id))!.quantity).toBe(3);
    expect((await items.getHistory(kit.id)).rows.some((h) => h.action === 'ASSEMBLED')).toBe(false);
    expect((await items.getHistory(bandage.id)).rows.some((h) => h.action === 'CONSUMED')).toBe(false);
  });

  it('assembles exactly up to the ceiling, then refuses to over-draw', async () => {
    const { kit } = await seedKit(); // ceiling = 3
    await items.assemble(kit.id, 3);
    expect((await items.getById(kit.id))!.quantity).toBe(3);
    // Components are now exhausted for another whole kit.
    await expect(items.assemble(kit.id, 1)).rejects.toBeInstanceOf(DbError);
  });

  it('rejects a non-whole or non-positive count, and a kit with no components', async () => {
    const { kit } = await seedKit();
    await expect(items.assemble(kit.id, 0)).rejects.toBeInstanceOf(DbError);
    await expect(items.assemble(kit.id, 1.5)).rejects.toBeInstanceOf(DbError);
    await expect(items.disassemble(kit.id, -1)).rejects.toBeInstanceOf(DbError);

    const empty = await items.create({ name: 'Empty kit' });
    await expect(items.assemble(empty.id, 1)).rejects.toBeInstanceOf(DbError);
  });

  it('disassembles kits: the exact inverse of assemble (kit down, components back up)', async () => {
    const { kit, bandage, scissors } = await seedKit();
    await items.assemble(kit.id, 3); // kit 3; bandage 4; scissors 0

    const updated = await items.disassemble(kit.id, 2);

    expect(updated.quantity).toBe(1); // 3 − 2
    expect((await items.getById(bandage.id))!.quantity).toBe(4 + 2 * 2); // back to 8
    expect((await items.getById(scissors.id))!.quantity).toBe(0 + 1 * 2); // back to 2

    // A full round trip returns every stock level to where it started.
    await items.disassemble(kit.id, 1);
    expect((await items.getById(kit.id))!.quantity).toBe(0);
    expect((await items.getById(bandage.id))!.quantity).toBe(10);
    expect((await items.getById(scissors.id))!.quantity).toBe(3);
  });

  it('logs a DISASSEMBLED entry on the kit and reciprocal component gains', async () => {
    const { kit, bandage } = await seedKit();
    await items.assemble(kit.id, 2);

    await items.disassemble(kit.id, 1);

    const disassembled = (await items.getHistory(kit.id)).rows.find((h) => h.action === 'DISASSEMBLED');
    expect(disassembled).toBeDefined();
    expect(disassembled!.quantityDelta).toBe(-1);

    // The recovered component gains its per-kit quantity back (a plain QUANTITY_CHANGE).
    const bandageGain = (await items.getHistory(bandage.id)).rows.find(
      (h) => h.action === 'QUANTITY_CHANGE' && (h.quantityDelta ?? 0) > 0,
    );
    expect(bandageGain!.quantityDelta).toBe(2);
  });

  it('refuses to assemble/disassemble a non-DISCRETE kit or a non-DISCRETE component', async () => {
    // A serialised kit item can't be produced by count (its quantity is pinned at 1).
    const serialKit = await items.create({ name: 'Serial kit', trackingMode: 'SERIALISED' });
    const part = await items.create({ name: 'Part', quantity: 10 });
    await items.addKitComponent(serialKit.id, part.id, 1);
    await expect(items.assemble(serialKit.id, 1)).rejects.toBeInstanceOf(DbError);
    await expect(items.disassemble(serialKit.id, 1)).rejects.toBeInstanceOf(DbError);

    // A discrete kit with a serialised component can't consume it by quantity.
    const kit = await items.create({ name: 'Kit' });
    const serialPart = await items.create({ name: 'Serial part', trackingMode: 'SERIALISED' });
    await items.addKitComponent(kit.id, serialPart.id, 1);
    await expect(items.assemble(kit.id, 1)).rejects.toBeInstanceOf(DbError);
  });

  it('refuses to disassemble more kits than are on hand and rolls back', async () => {
    const { kit, bandage } = await seedKit();
    await items.assemble(kit.id, 1); // one kit on hand; bandage 8

    await expect(items.disassemble(kit.id, 2)).rejects.toBeInstanceOf(DbError);

    // Nothing changed — the kit and components stay put.
    expect((await items.getById(kit.id))!.quantity).toBe(1);
    expect((await items.getById(bandage.id))!.quantity).toBe(8);
  });
});

/**
 * Kits v3 — nested-kit roll-up (cascade assembly), a true cross-location FEFO draw, a
 * caller-chosen destination for the produced kit, and gauge (net-value) components. Assembly
 * stays one atomic, all-or-nothing transaction; the plan nets shared leaves so a diamond is
 * never over-drawn, and the buildable ceiling always matches the draw that realises it.
 */
describe('ItemRepository — Kits v3 (roll-up, cascade, cross-location, gauge)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('cross-location FEFO draw', () => {
    it('draws a component from its whole grand total, spanning locations', async () => {
      const a = await locations.create({ name: 'Drawer A' });
      const b = await locations.create({ name: 'Drawer B' });
      const kit = await items.create({ name: 'Kit', locationId: a.id });
      const widget = await items.create({ name: 'Widget', quantity: 10, locationId: a.id });
      await items.transferStock(widget.id, a.id, b.id, 4); // 6 at A, 4 at B
      await items.addKitComponent(kit.id, widget.id, 1);

      // Assemble 8 — more than either single placement holds, so the draw must cross both.
      await items.assemble(kit.id, 8);

      expect((await items.getById(widget.id))!.quantity).toBe(2); // 10 − 8, netted across A+B
      expect((await items.getById(kit.id))!.quantity).toBe(8);
    });

    it('places the produced kit at a chosen destination location', async () => {
      const home = await locations.create({ name: 'Workshop' });
      const shelf = await locations.create({ name: 'Finished goods' });
      const kit = await items.create({ name: 'Kit', locationId: home.id });
      const part = await items.create({ name: 'Part', quantity: 20, locationId: home.id });
      await items.addKitComponent(kit.id, part.id, 2);

      await items.assemble(kit.id, 3, { destinationLocationId: shelf.id });

      const stock = await items.listStock(kit.id);
      expect(stock).toEqual([{ locationId: shelf.id, locationName: 'Finished goods', quantity: 3 }]);
    });

    it('rejects an unknown destination location', async () => {
      const kit = await items.create({ name: 'Kit' });
      const part = await items.create({ name: 'Part', quantity: 5 });
      await items.addKitComponent(kit.id, part.id, 1);
      await expect(
        items.assemble(kit.id, 1, { destinationLocationId: 'no-such-location' }),
      ).rejects.toBeInstanceOf(DbError);
    });
  });

  describe('cascade assembly of nested kits', () => {
    /** A→B→C chain: A is built from B, B from C; only C is stocked. */
    async function seedChain(cStock = 10) {
      const a = await items.create({ name: 'A' });
      const b = await items.create({ name: 'B' });
      const c = await items.create({ name: 'C', quantity: cStock });
      await items.addKitComponent(b.id, c.id, 1);
      await items.addKitComponent(a.id, b.id, 1);
      return { a, b, c };
    }

    it('transitively assembles missing sub-kits in one transaction', async () => {
      const { a, b, c } = await seedChain(10);

      await items.assemble(a.id, 5, { cascade: true });

      expect((await items.getById(a.id))!.quantity).toBe(5); // produced
      expect((await items.getById(b.id))!.quantity).toBe(0); // built 5, all consumed by A
      expect((await items.getById(c.id))!.quantity).toBe(5); // 10 − 5

      // The whole tree is logged: A assembled, B assembled (as a sub-kit) then consumed, C consumed.
      expect((await items.getHistory(a.id)).rows.some((h) => h.action === 'ASSEMBLED')).toBe(true);
      const bLog = (await items.getHistory(b.id)).rows;
      expect(bLog.some((h) => h.action === 'ASSEMBLED')).toBe(true);
      expect(bLog.some((h) => h.action === 'CONSUMED')).toBe(true);
      expect((await items.getHistory(c.id)).rows.some((h) => h.action === 'CONSUMED')).toBe(true);
    });

    it('only builds the shortfall of an on-hand sub-kit', async () => {
      const { a, b, c } = await seedChain(10);
      // Pre-build 2 B on hand (consumes 2 C → 8 left).
      await items.assemble(b.id, 2);
      expect((await items.getById(b.id))!.quantity).toBe(2);
      expect((await items.getById(c.id))!.quantity).toBe(8);

      // Assemble 5 A: 2 B are on hand, only 3 more are built (consuming 3 C → 5 left).
      await items.assemble(a.id, 5, { cascade: true });
      expect((await items.getById(a.id))!.quantity).toBe(5);
      expect((await items.getById(b.id))!.quantity).toBe(0);
      expect((await items.getById(c.id))!.quantity).toBe(5);
    });

    it('is all-or-nothing: an infeasible cascade rolls the whole tree back', async () => {
      const { a, b, c } = await seedChain(10);

      // Each A needs 1 C via B; 20 A would need 20 C but only 10 are stocked.
      await expect(items.assemble(a.id, 20, { cascade: true })).rejects.toBeInstanceOf(DbError);

      expect((await items.getById(a.id))!.quantity).toBe(0);
      expect((await items.getById(b.id))!.quantity).toBe(0);
      expect((await items.getById(c.id))!.quantity).toBe(10);
      expect((await items.getHistory(a.id)).rows.some((h) => h.action === 'ASSEMBLED')).toBe(false);
      expect((await items.getHistory(c.id)).rows.some((h) => h.action === 'CONSUMED')).toBe(false);
    });

    it('refuses to build a missing sub-kit when cascade is off', async () => {
      const { a } = await seedChain(10); // no B on hand
      await expect(items.assemble(a.id, 1)).rejects.toBeInstanceOf(DbError);
      await expect(items.assemble(a.id, 1, { cascade: false })).rejects.toBeInstanceOf(DbError);
    });

    it('nets a shared leaf across a diamond rather than over-drawing it', async () => {
      // A needs 1 B + 1 C; B needs 2 D, C needs 3 D — each A costs 5 D. D stocks 12 → 2 A.
      const a = await items.create({ name: 'A' });
      const b = await items.create({ name: 'B' });
      const c = await items.create({ name: 'C' });
      const d = await items.create({ name: 'D', quantity: 12 });
      await items.addKitComponent(b.id, d.id, 2);
      await items.addKitComponent(c.id, d.id, 3);
      await items.addKitComponent(a.id, b.id, 1);
      await items.addKitComponent(a.id, c.id, 1);

      await items.assemble(a.id, 2, { cascade: true });
      expect((await items.getById(a.id))!.quantity).toBe(2);
      expect((await items.getById(d.id))!.quantity).toBe(2); // 12 − 10, not 12 − 2×5×2

      // A third A would need 15 D — over the 12 stocked, so it is refused.
      await expect(items.assemble(a.id, 3, { cascade: true })).rejects.toBeInstanceOf(DbError);
    });
  });

  describe('gauge (net-value) components', () => {
    async function seedGaugeKit(opts?: { net?: number; widgetStock?: number }) {
      const kit = await items.create({ name: 'Glued kit' });
      const adhesive = await items.create({
        name: 'Adhesive',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'ml', grossCapacity: 1000, currentNetValue: opts?.net ?? 220 },
      });
      await items.addKitComponent(kit.id, adhesive.id, 50); // 50 ml per kit
      let widget: { id: string } | undefined;
      if (opts?.widgetStock !== undefined) {
        widget = await items.create({ name: 'Widget', quantity: opts.widgetStock });
        await items.addKitComponent(kit.id, widget.id, 1);
      }
      return { kit, adhesive, widget };
    }

    it('draws a per-kit net value from a gauge component, capped by its ratio', async () => {
      const { kit, adhesive } = await seedGaugeKit({ net: 220 }); // floor(220/50) = 4 buildable

      await items.assemble(kit.id, 4);
      expect((await items.getById(kit.id))!.quantity).toBe(4);
      expect((await items.getById(adhesive.id))!.gauge!.currentNetValue).toBe(220 - 200); // 20 ml left

      // A fifth kit needs 250 ml but only 220 were ever there — refused from the start.
      const fresh = await seedGaugeKit({ net: 220 });
      await expect(items.assemble(fresh.kit.id, 5)).rejects.toBeInstanceOf(DbError);
    });

    it('mixes a gauge draw with a discrete component, limited by the scarcer', async () => {
      const { kit } = await seedGaugeKit({ net: 220, widgetStock: 3 }); // gauge → 4, widget → 3
      await items.assemble(kit.id, 3);
      expect((await items.getById(kit.id))!.quantity).toBe(3);
      await expect(items.assemble(kit.id, 1)).rejects.toBeInstanceOf(DbError); // widget exhausted
    });

    it('logs a GAUGE_UPDATE (not CONSUMED) for the gauge draw', async () => {
      const { kit, adhesive } = await seedGaugeKit({ net: 500 });
      await items.assemble(kit.id, 2); // 100 ml
      const gaugeLog = (await items.getHistory(adhesive.id)).rows.find((h) => h.action === 'GAUGE_UPDATE');
      expect(gaugeLog).toBeDefined();
      expect(gaugeLog!.netValueDelta).toBe(-100);
    });

    it('returns net value to a gauge component on disassembly, clamped to capacity', async () => {
      const { kit, adhesive } = await seedGaugeKit({ net: 220 });
      await items.assemble(kit.id, 4); // gauge 220 → 20
      await items.disassemble(kit.id, 2); // returns 2 × 50 = 100 ml
      expect((await items.getById(adhesive.id))!.gauge!.currentNetValue).toBe(120);
      expect((await items.getById(kit.id))!.quantity).toBe(2);
    });
  });
});
