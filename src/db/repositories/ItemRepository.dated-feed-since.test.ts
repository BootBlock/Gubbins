import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';

/**
 * The optional lower bound on the two dated item feeds (issue #607).
 *
 * Both feeds select everything at or before a cutoff and order it **ascending**, so their first
 * page is the oldest end of the set. That is right for a widget whose cutoff is a fortnight away
 * and wrong for the Upcoming agenda, whose cutoff is a century away: without a floor the query is
 * "every dated row that ever existed, oldest first", and the near future sits behind however much
 * settled history the inventory has accumulated.
 *
 * `since` is what lets such a caller say how far back it means. These pin both halves of the
 * contract — that the floor excludes what lapsed before it, and that omitting it still reaches
 * back forever, which every other caller relies on.
 */
describe('ItemRepository — the dated feeds take a lower bound (issue #607)', () => {
  const NOW = Date.parse('2026-06-30T12:00:00Z');
  const DAY = 86_400_000;
  /** The agenda's own window, so these exercise the value that actually ships. */
  const YEAR_AGO = NOW - 365 * DAY;

  let driver: MemoryDriver;
  let items: ItemRepository;
  let locations: LocationRepository;
  let drawerId: string;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
    drawerId = (await locations.create({ name: 'Drawer A' })).id;
  });

  afterEach(async () => {
    await driver.close();
  });

  /** `ms` as the 'YYYY-MM-DD' string the warranty column stores. */
  const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  describe('listExpiringWithin', () => {
    beforeEach(async () => {
      for (const [name, expiryDate] of [
        ['Ancient stock', NOW - 3000 * DAY],
        ['Lapsed last month', NOW - 30 * DAY],
        ['Due next week', NOW + 7 * DAY],
      ] as const) {
        await items.create({ name, quantity: 1, locationId: drawerId, expiryDate });
      }
    });

    it('reaches back forever when no bound is given', async () => {
      const page = await items.listExpiringWithin(36_500, NOW);
      expect(page.rows.map((r) => r.name)).toEqual(['Ancient stock', 'Lapsed last month', 'Due next week']);
    });

    it('drops what lapsed before the bound, keeping everything at or after it', async () => {
      const page = await items.listExpiringWithin(36_500, NOW, { since: YEAR_AGO });
      expect(page.rows.map((r) => r.name)).toEqual(['Lapsed last month', 'Due next week']);
    });

    it('includes a row dated exactly on the bound', async () => {
      await items.create({
        name: 'On the boundary',
        quantity: 1,
        locationId: drawerId,
        expiryDate: YEAR_AGO,
      });
      const page = await items.listExpiringWithin(36_500, NOW, { since: YEAR_AGO });
      expect(page.rows.map((r) => r.name)).toContain('On the boundary');
    });
  });

  describe('listWarrantyExpiring', () => {
    beforeEach(async () => {
      for (const [name, warrantyExpiresAt] of [
        ['Retired press', isoDay(NOW - 3000 * DAY)],
        ['Bench drill', isoDay(NOW - 30 * DAY)],
        ['New lathe', isoDay(NOW + 7 * DAY)],
      ] as const) {
        await items.create({ name, quantity: 1, locationId: drawerId, warrantyExpiresAt });
      }
    });

    it('reaches back forever when no bound is given', async () => {
      const page = await items.listWarrantyExpiring(36_500, NOW);
      expect(page.rows.map((r) => r.name)).toEqual(['Retired press', 'Bench drill', 'New lathe']);
    });

    it('drops what lapsed before the bound, keeping everything at or after it', async () => {
      const page = await items.listWarrantyExpiring(36_500, NOW, { since: YEAR_AGO });
      expect(page.rows.map((r) => r.name)).toEqual(['Bench drill', 'New lathe']);
    });

    it('includes a row dated exactly on the bound', async () => {
      await items.create({
        name: 'On the boundary',
        quantity: 1,
        locationId: drawerId,
        warrantyExpiresAt: isoDay(YEAR_AGO),
      });
      const page = await items.listWarrantyExpiring(36_500, NOW, { since: YEAR_AGO });
      expect(page.rows.map((r) => r.name)).toContain('On the boundary');
    });
  });

  /**
   * The bound is what makes the ascending order survive a page ceiling. Read one clamped page of
   * a century-wide window over a long-lived inventory and, unbounded, every row on it is history;
   * bounded, the page is the window the caller asked about.
   */
  it('keeps a near-future row on the first page that an unbounded read would have buried', async () => {
    // MAX_PAGE_SIZE is 100, so 100 long-lapsed rows fill a page on their own.
    for (let i = 0; i < 100; i += 1) {
      await items.create({
        name: `Lapsed ${String(i).padStart(3, '0')}`,
        quantity: 1,
        locationId: drawerId,
        expiryDate: NOW - (2000 + i) * DAY,
      });
    }
    await items.create({
      name: 'Due next week',
      quantity: 1,
      locationId: drawerId,
      expiryDate: NOW + 7 * DAY,
    });

    const unbounded = await items.listExpiringWithin(36_500, NOW, { limit: 100 });
    expect(unbounded.rows.map((r) => r.name)).not.toContain('Due next week');

    const bounded = await items.listExpiringWithin(36_500, NOW, { limit: 100, since: YEAR_AGO });
    expect(bounded.rows.map((r) => r.name)).toEqual(['Due next week']);
  });
});
