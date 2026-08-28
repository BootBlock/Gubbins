import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import type { SqlValue } from '@/db/rpc/driver';
import { ItemRepository } from '../ItemRepository';
import { LocationRepository } from '../LocationRepository';
import {
  earliestBatchExpirySql,
  effectiveExpirySql,
  expiringPredicateSql,
  lowStockPredicateSql,
  notAVariantParentSql,
  outOfStockPredicateSql,
  variantParentSql,
  warrantyExpiringPredicateSql,
} from './attention-sql';

/**
 * The attention predicates, executed rather than read.
 *
 * Every fragment here decides whether an item reaches an attention surface — the dashboard
 * feeds, the alert centre, the inventory status chips and the bridge's status counts. A wrong
 * predicate fails silently: nothing errors, a list is simply short, and the user is never told
 * they are out of stock. So these run each fragment as real SQL against seeded rows in the
 * `:memory:` driver and assert the *selected set*, rather than asserting the SQL text (which
 * would pin the wording and prove nothing about the meaning).
 *
 * `stock-attention-parity.test.ts` covers a different question — that the low / out-of-stock
 * SQL agrees with the pure `isLow` / `isOutOfStock` seam. These pin what each predicate itself
 * selects, including the fragments (`variantParentSql`, `effectiveExpirySql`,
 * `warrantyExpiringPredicateSql`) that no parity test reaches.
 */
describe('attention SQL predicates', () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;

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

  /** Names of the items an `items`-scoped predicate selects, ordered for a stable comparison. */
  async function selected(predicate: string, params: readonly SqlValue[] = []): Promise<string[]> {
    const rows = await driver.query<{ name: string }>(
      `SELECT items.name AS name FROM items WHERE ${predicate} ORDER BY items.name`,
      params,
    );
    return rows.map((row) => row.name);
  }

  /** Every item's name, so a predicate's selection can be checked against the whole table. */
  async function allNames(): Promise<string[]> {
    const rows = await driver.query<{ name: string }>('SELECT name FROM items ORDER BY name');
    return rows.map((row) => row.name);
  }

  describe('variantParentSql / notAVariantParentSql', () => {
    beforeEach(async () => {
      const parent = await items.create({ name: 'Parent', quantity: 0 });
      const child = await items.create({ name: 'Child', quantity: 4 });
      await items.setParent(child.id, parent.id);
      await items.create({ name: 'Standalone', quantity: 4 });
    });

    it('selects only items that have at least one child', async () => {
      expect(await selected(variantParentSql('items.id'))).toEqual(['Parent']);
    });

    it('negates exactly — the two polarities partition the table', async () => {
      const parents = await selected(variantParentSql('items.id'));
      const others = await selected(notAVariantParentSql('items.id'));

      expect(others).toEqual(['Child', 'Standalone']);
      expect([...parents, ...others].sort()).toEqual(await allNames());
    });

    it('correlates against whichever qualified column the caller passes', async () => {
      // The docstring's other supported shape: a joined query aliasing `items` as `i`. A bare
      // `id` would resolve against the subquery's own `child` table rather than the outer row.
      const rows = await driver.query<{ name: string }>(
        `SELECT i.name AS name FROM items i WHERE ${variantParentSql('i.id')} ORDER BY i.name`,
      );
      expect(rows.map((row) => row.name)).toEqual(['Parent']);
    });
  });

  describe('lowStockPredicateSql', () => {
    /** The blanket floors: 5 units for DISCRETE, 15% for CONSUMABLE_GAUGE. */
    const BINDS = [5, 5, 15, 15];

    it('selects a DISCRETE item at or below its floor, and no higher one', async () => {
      await items.create({ name: 'Below', quantity: 2 });
      await items.create({ name: 'AtFloor', quantity: 5 });
      await items.create({ name: 'Above', quantity: 6 });

      expect(await selected(lowStockPredicateSql(), BINDS)).toEqual(['AtFloor', 'Below']);
    });

    it("prefers the item's own reorder point to the global fallback", async () => {
      await items.create({ name: 'OwnHighFloor', quantity: 15, reorderPoint: 20 });
      await items.create({ name: 'OwnLowFloor', quantity: 4, reorderPoint: 1 });

      expect(await selected(lowStockPredicateSql(), BINDS)).toEqual(['OwnHighFloor']);
    });

    it('treats a zero floor as off, on the item and on the global fallback alike', async () => {
      await items.create({ name: 'OptedOut', quantity: 0, reorderPoint: 0 });
      await items.create({ name: 'OnBlanket', quantity: 0 });

      expect(await selected(lowStockPredicateSql(), BINDS)).toEqual(['OnBlanket']);
      // Blanket off: the opted-out item stays out, and the one relying on it drops away too.
      expect(await selected(lowStockPredicateSql(), [0, 0, 0, 0])).toEqual([]);
    });

    it('measures a CONSUMABLE_GAUGE item as a percentage of its gross capacity', async () => {
      const gauge = (currentNetValue: number) => ({
        unitOfMeasure: 'g',
        grossCapacity: 1000,
        currentNetValue,
      });
      await items.create({
        name: 'GaugeBelow',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: gauge(100),
      });
      await items.create({
        name: 'GaugeAtFloor',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: gauge(150),
      });
      await items.create({
        name: 'GaugeAbove',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: gauge(800),
      });

      expect(await selected(lowStockPredicateSql(), BINDS)).toEqual(['GaugeAtFloor', 'GaugeBelow']);
    });

    it('binds the quantity floor and the gauge floor separately, in the documented order', async () => {
      await items.create({ name: 'Discrete', quantity: 12 });
      await items.create({
        name: 'Gauge',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 120 }, // 12%
      });

      // A quantity floor of 20 catches the DISCRETE item alone; a 20% gauge floor the gauge alone.
      expect(await selected(lowStockPredicateSql(), [20, 20, 1, 1])).toEqual(['Discrete']);
      expect(await selected(lowStockPredicateSql(), [1, 1, 20, 20])).toEqual(['Gauge']);
    });

    it('never selects an unlimited item, a variant parent, or a non-bulk tracking mode', async () => {
      await items.create({ name: 'Unlimited', quantity: 0, isUnlimited: true });
      await items.create({ name: 'Serialised', trackingMode: 'SERIALISED' });
      await items.create({ name: 'Untracked', trackingMode: 'UNTRACKED' });
      const parent = await items.create({ name: 'Parent', quantity: 0, reorderPoint: 5 });
      const child = await items.create({ name: 'Child', quantity: 40 });
      await items.setParent(child.id, parent.id);

      expect(await selected(lowStockPredicateSql(), BINDS)).toEqual([]);
    });
  });

  describe('earliestBatchExpirySql / effectiveExpirySql', () => {
    let drawerId: string;

    beforeEach(async () => {
      drawerId = (await locations.create({ name: 'Drawer A' })).id;
    });

    /** Write a lot directly, so a depleted or undated one can be seeded exactly. */
    async function addLot(
      itemId: string,
      key: string,
      quantity: number,
      expiryDate: number | null,
    ): Promise<void> {
      await driver.execute(
        `INSERT INTO stock_batches (id, item_id, location_id, batch_key, lot_number, expiry_date, quantity)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [`batch-${key}`, itemId, drawerId, key, key, expiryDate, quantity],
      );
    }

    /** The scalar one fragment yields for one named item. */
    async function scalar(expression: string, name: string): Promise<number | null> {
      const row = await driver.queryOne<{ value: number | null }>(
        `SELECT ${expression} AS value FROM items WHERE items.name = ?`,
        [name],
      );
      return row?.value ?? null;
    }

    it('takes the earliest expiry among the lots that still hold stock', async () => {
      const item = await items.create({ name: 'Reagent', quantity: 0, locationId: drawerId });
      await addLot(item.id, 'late', 5, NOW + 20 * DAY);
      await addLot(item.id, 'early', 5, NOW + 6 * DAY);

      expect(await scalar(earliestBatchExpirySql(), 'Reagent')).toBe(NOW + 6 * DAY);
    });

    it('ignores a depleted lot and an undated one', async () => {
      const item = await items.create({ name: 'Reagent', quantity: 0, locationId: drawerId });
      await addLot(item.id, 'consumed', 0, NOW + DAY); // history, not stock on the shelf
      await addLot(item.id, 'undated', 5, null); // MIN skips NULL: it neither wins nor blocks
      await addLot(item.id, 'stocked', 5, NOW + 9 * DAY);

      expect(await scalar(earliestBatchExpirySql(), 'Reagent')).toBe(NOW + 9 * DAY);
    });

    it('is NULL when an item has no dated stocked lot at all', async () => {
      const item = await items.create({ name: 'Bare', quantity: 0, locationId: drawerId });
      await addLot(item.id, 'undated', 5, null);

      expect(await scalar(earliestBatchExpirySql(), 'Bare')).toBeNull();
    });

    it('takes whichever of the item date and the lot date is earlier', async () => {
      const lotFirst = await items.create({
        name: 'LotFirst',
        quantity: 0,
        locationId: drawerId,
        expiryDate: NOW + 30 * DAY,
      });
      await addLot(lotFirst.id, 'lf', 5, NOW + 3 * DAY);

      const itemFirst = await items.create({
        name: 'ItemFirst',
        quantity: 0,
        locationId: drawerId,
        expiryDate: NOW + 2 * DAY,
      });
      await addLot(itemFirst.id, 'if', 5, NOW + 40 * DAY);

      expect(await scalar(effectiveExpirySql(), 'LotFirst')).toBe(NOW + 3 * DAY);
      expect(await scalar(effectiveExpirySql(), 'ItemFirst')).toBe(NOW + 2 * DAY);
    });

    it('yields the one date that exists, and NULL when neither does', async () => {
      await items.create({ name: 'ItemOnly', quantity: 0, expiryDate: NOW + 5 * DAY });
      const lotOnly = await items.create({ name: 'LotOnly', quantity: 0, locationId: drawerId });
      await addLot(lotOnly.id, 'lo', 5, NOW + 7 * DAY);
      await items.create({ name: 'Neither', quantity: 0 });

      expect(await scalar(effectiveExpirySql(), 'ItemOnly')).toBe(NOW + 5 * DAY);
      expect(await scalar(effectiveExpirySql(), 'LotOnly')).toBe(NOW + 7 * DAY);
      expect(await scalar(effectiveExpirySql(), 'Neither')).toBeNull();
    });
  });

  describe('expiringPredicateSql', () => {
    it('selects everything due on or before the cutoff, the already expired included', async () => {
      await items.create({ name: 'Expired', quantity: 1, expiryDate: NOW - 10 * DAY });
      await items.create({ name: 'AtCutoff', quantity: 1, expiryDate: NOW + 7 * DAY });
      await items.create({ name: 'Soon', quantity: 1, expiryDate: NOW + 3 * DAY });
      await items.create({ name: 'Later', quantity: 1, expiryDate: NOW + 30 * DAY });
      await items.create({ name: 'NoDate', quantity: 1 });

      expect(await selected(expiringPredicateSql(), [NOW + 7 * DAY])).toEqual([
        'AtCutoff',
        'Expired',
        'Soon',
      ]);
    });

    it('matches on a lot date the item row itself never carries (issue #684)', async () => {
      const drawerId = (await locations.create({ name: 'Drawer A' })).id;
      const item = await items.create({ name: 'Reagent', quantity: 0, locationId: drawerId });
      await driver.execute(
        `INSERT INTO stock_batches (id, item_id, location_id, batch_key, expiry_date, quantity)
         VALUES ('batch-1', ?, ?, 'k1', ?, 5)`,
        [item.id, drawerId, NOW + 4 * DAY],
      );

      expect(await selected(expiringPredicateSql(), [NOW + 7 * DAY])).toEqual(['Reagent']);
    });
  });

  describe('outOfStockPredicateSql', () => {
    it('selects a depleted DISCRETE item whether or not any floor is configured', async () => {
      await items.create({ name: 'Empty', quantity: 0 });
      await items.create({ name: 'EmptyOptedOut', quantity: 0, reorderPoint: 0 });
      await items.create({ name: 'Remaining', quantity: 1 });

      expect(await selected(outOfStockPredicateSql())).toEqual(['Empty', 'EmptyOptedOut']);
    });

    it('selects an emptied CONSUMABLE_GAUGE item, but not one with contents left', async () => {
      await items.create({
        name: 'GaugeEmpty',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 0 },
      });
      await items.create({
        name: 'GaugeRemaining',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 1 },
      });

      expect(await selected(outOfStockPredicateSql())).toEqual(['GaugeEmpty']);
    });

    it('never selects an unlimited item, a variant parent, or a non-bulk tracking mode', async () => {
      await items.create({ name: 'Unlimited', quantity: 0, isUnlimited: true });
      await items.create({ name: 'Serialised', trackingMode: 'SERIALISED' });
      await items.create({ name: 'Untracked', trackingMode: 'UNTRACKED' });
      const parent = await items.create({ name: 'Parent', quantity: 0 });
      const child = await items.create({ name: 'Child', quantity: 40 });
      await items.setParent(child.id, parent.id);

      expect(await selected(outOfStockPredicateSql())).toEqual([]);
    });
  });

  describe('warrantyExpiringPredicateSql', () => {
    it('orders the TEXT date correctly and includes the cutoff day itself', async () => {
      await items.create({ name: 'WExpired', quantity: 1, warrantyExpiresAt: '2025-12-31' });
      await items.create({ name: 'WAtCutoff', quantity: 1, warrantyExpiresAt: '2026-03-01' });
      await items.create({ name: 'WSoon', quantity: 1, warrantyExpiresAt: '2026-02-09' });
      await items.create({ name: 'WFar', quantity: 1, warrantyExpiresAt: '2027-01-01' });
      await items.create({ name: 'WNone', quantity: 1 });

      expect(await selected(warrantyExpiringPredicateSql(), ['2026-03-01'])).toEqual([
        'WAtCutoff',
        'WExpired',
        'WSoon',
      ]);
    });

    it('never selects a variant parent, even one carrying a warranty date', async () => {
      const parent = await items.create({
        name: 'Parent',
        quantity: 0,
        warrantyExpiresAt: '2026-01-05',
      });
      const child = await items.create({ name: 'Child', quantity: 1 });
      await items.setParent(child.id, parent.id);

      expect(await selected(warrantyExpiringPredicateSql(), ['2026-03-01'])).toEqual([]);
    });
  });
});
