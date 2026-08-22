import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { ProjectRepository } from './ProjectRepository';

/**
 * A **lot's** expiry date reaching the attention surfaces (issue #684).
 *
 * `stock_batches.expiry_date` already drove FEFO consumption, but every expiry feed read the
 * `items.expiry_date` column alone, so a lot due next week raised nothing — no alert, no agenda
 * entry, no "Soon to Expire" row, no status chip, no bridge count — while the wiki said the
 * opposite. Nothing lifts a lot's date onto its item either: the stock-recompute triggers
 * propagate quantity, never dates. These pin the *effective* expiry (the earlier of the item's own
 * date and its earliest stocked lot's) at the seam every one of those surfaces reads through.
 *
 * A batch expiry can only be set through a real receipt, so the setup uses the BOM one rather
 * than writing `stock_batches` directly — the same path the app takes.
 */
describe('ItemRepository — a lot expiry reaches the expiry feeds (issue #684)', () => {
  const NOW = 1_700_000_000_000;
  const DAY = 86_400_000;

  let driver: MemoryDriver;
  let items: ItemRepository;
  let locations: LocationRepository;
  let projects: ProjectRepository;
  let drawerId: string;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
    projects = new ProjectRepository(driver);
    drawerId = (await locations.create({ name: 'Drawer A' })).id;
  });

  afterEach(async () => {
    await driver.close();
  });

  /** Receive `quantity` units of `itemId` into a lot dated `expiryDate`, through the BOM receipt. */
  async function receiveLot(
    itemId: string,
    quantity: number,
    expiryDate: number | null,
    lotNumber = 'LOT-1',
  ): Promise<void> {
    const project = await projects.create({ name: `Build ${itemId} ${lotNumber}` });
    const line = await projects.addLine(project.id, { itemId, requiredQty: quantity });
    await projects.setProcurement(line.id, 'IN_TRANSIT');
    await projects.receiveLine(line.id, {
      locationId: drawerId,
      quantity,
      batch: { batchNumber: null, lotNumber, expiryDate },
    });
  }

  it('projects the earliest stocked lot expiry onto every item read', async () => {
    const item = await items.create({ name: 'Reagent', quantity: 0, locationId: drawerId });
    await receiveLot(item.id, 5, NOW + 20 * DAY, 'LOT-LATE');
    await receiveLot(item.id, 5, NOW + 6 * DAY, 'LOT-EARLY');

    const read = await items.getById(item.id);
    // The item's own column stays untouched — it is what the edit form writes back.
    expect(read?.expiryDate).toBeNull();
    expect(read?.earliestBatchExpiryDate).toBe(NOW + 6 * DAY);
  });

  it('lists an item whose only expiry date lives on a lot', async () => {
    const item = await items.create({ name: 'Adhesive', quantity: 0, locationId: drawerId });
    await receiveLot(item.id, 4, NOW + 10 * DAY);

    const page = await items.listExpiringWithin(30, NOW);
    expect(page.rows.map((r) => r.name)).toEqual(['Adhesive']);
    expect(page.rows[0].id).toBe(item.id);
  });

  it('orders the feed by the effective expiry, not the bare item column', async () => {
    // Without the effective-expiry ORDER BY the lot-only rows sort first whatever their date,
    // because SQLite puts NULL ahead of every value ascending.
    const lotSoon = await items.create({ name: 'LotSoon', quantity: 0, locationId: drawerId });
    await receiveLot(lotSoon.id, 1, NOW + 8 * DAY);
    const lotLate = await items.create({ name: 'LotLate', quantity: 0, locationId: drawerId });
    await receiveLot(lotLate.id, 1, NOW + 25 * DAY);
    await items.create({ name: 'ItemDated', expiryDate: NOW + 15 * DAY });

    const page = await items.listExpiringWithin(30, NOW);
    expect(page.rows.map((r) => r.name)).toEqual(['LotSoon', 'ItemDated', 'LotLate']);
  });

  it('takes whichever of the item date and the lot date falls first', async () => {
    const itemFirst = await items.create({
      name: 'ItemFirst',
      quantity: 0,
      locationId: drawerId,
      expiryDate: NOW + 3 * DAY,
    });
    await receiveLot(itemFirst.id, 2, NOW + 20 * DAY);
    const lotFirst = await items.create({
      name: 'LotFirst',
      quantity: 0,
      locationId: drawerId,
      expiryDate: NOW + 20 * DAY,
    });
    await receiveLot(lotFirst.id, 2, NOW + 5 * DAY);

    const page = await items.listExpiringWithin(10, NOW);
    expect(page.rows.map((r) => r.name)).toEqual(['ItemFirst', 'LotFirst']);
  });

  it('drops a lot once it is emptied, and leaves an undated one out entirely', async () => {
    const consumed = await items.create({ name: 'Consumed', quantity: 0, locationId: drawerId });
    await receiveLot(consumed.id, 3, NOW + 7 * DAY, 'LOT-GONE');
    const undated = await items.create({ name: 'Undated', quantity: 0, locationId: drawerId });
    await receiveLot(undated.id, 3, null, 'LOT-PLAIN');

    // A depleted row is kept rather than deleted, so its batch identity survives — but nothing
    // is left on the shelf to go off.
    await items.reconcile([
      {
        itemId: consumed.id,
        counted: 0,
        locationName: 'Drawer A',
        locationId: drawerId,
        batch: { batchNumber: null, lotNumber: 'LOT-GONE', expiryDate: NOW + 7 * DAY },
      },
    ]);

    const page = await items.listExpiringWithin(30, NOW);
    expect(page.rows.map((r) => r.name)).toEqual([]);
    expect((await items.getById(consumed.id))?.earliestBatchExpiryDate).toBeNull();
    expect((await items.getById(undated.id))?.earliestBatchExpiryDate).toBeNull();
  });

  it('matches the inventory status filter and its count, as the widget feed does', async () => {
    const item = await items.create({ name: 'Culture', quantity: 0, locationId: drawerId });
    await receiveLot(item.id, 6, NOW + 12 * DAY);
    await items.create({ name: 'Bolt', quantity: 50 });

    const page = await items.list({ status: ['expiring'], now: NOW });
    expect(page.rows.map((r) => r.name)).toEqual(['Culture']);

    // The same predicate behind the filter-bar chip count and the bridge's `/api/v1/status`.
    const counts = await items.applicableStatuses({ now: NOW, candidates: ['expiring'] });
    expect(counts).toEqual([{ status: 'expiring', count: 1 }]);
  });
});
