import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { EXPIRY_SOON_WINDOW_DAYS, WARRANTY_SOON_WINDOW_DAYS } from '@/db/repositories/constants';
import { localDayWindowCutoff } from '@/lib/calendar-days';
import { toDateInputValue } from '@/lib/date-input';
import { effectiveExpiryDate, expiryStatus } from '@/features/lifecycle/expiry';
import { warrantyStatus } from '@/features/inventory/asset-lifecycle';
import { ItemRepository } from './ItemRepository';

/**
 * **Drift guard (issue #498).** "Expiring soon" and "warranty expiring soon" are each decided in
 * three places: the repository feeds (`listExpiringWithin` / `listWarrantyExpiring`, behind the
 * dashboard and alert-centre lanes), the inventory status chips (`buildStatusFilter`), and the pure
 * classifiers (`expiryStatus` / `warrantyStatus`, behind the badges, the agenda projection and the
 * bridge's counts). Their doc comments claimed the three agreed while the SQL cut-offs were derived
 * from a wall-clock instant and the classifiers from a calendar day, which is how the boundary came
 * to sit in two frames at once.
 *
 * All three now measure the window with `localDayWindowCutoff`, so these seed items on and either
 * side of the boundary and assert the answers are the **same set** — move one derivation off that
 * seam and the others do not follow, so this fails.
 *
 * **What this can and cannot see.** The comparison is only as sharp as the host zone allows. A
 * wall-clock boundary and a calendar-day one pick different rows exactly when `now`'s local time of
 * day pushes the wall-clock cut-off into a different *UTC* day from the stored midnight — so the
 * readings below deliberately include one just after local midnight and one just before it, not
 * only a midday one where the two frames coincide everywhere. In UTC itself they can never
 * separate, because local and UTC midnight are the same instant; that half of the guard is
 * `src/features/lifecycle/expiring-window.test.ts`, which pins real zones in child processes. What
 * survives in every zone is a day-level pin: nudge any one of the three derivations by a day and
 * these go red.
 *
 * `attention-sql.test.ts` pins what each predicate selects on its own; this pins that the
 * pre-filter, the chip and the badge cannot disagree.
 */
describe('expiring / warranty — SQL predicate ↔ pure classifier parity', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  /** Day offsets from today, straddling both 30-day windows and reaching into the past. */
  const OFFSETS = [-10, -1, 0, 1, 29, 30, 31, 60] as const;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  /** Every active item, read the way the card grid and the bridge scan read them. */
  async function allActiveItems() {
    const page = await items.list({ limit: 200 });
    return page.rows;
  }

  const names = (rows: readonly { name: string }[]) => rows.map((r) => r.name).sort();

  /**
   * Three readings of one local day. The two near midnight are the ones that separate a wall-clock
   * boundary from a calendar-day one outside UTC; midday is the control where they coincide.
   */
  const READINGS = [
    { label: 'just after local midnight', h: 0, m: 30 },
    { label: 'midday', h: 12, m: 34 },
    { label: 'late in the local evening', h: 23, m: 30 },
  ] as const;

  describe.each(READINGS)('read $label', ({ h, m }) => {
    const NOW = new Date(new Date().setHours(h, m, 0, 0)).getTime();

    /** The stored midnight-UTC stamp of the day `offset` local calendar days from today. */
    const storedDay = (offset: number) => localDayWindowCutoff(NOW, offset);

    /**
     * One perishable and one asset per offset, plus one of each carrying no date at all — the row
     * all three derivations have to agree to leave out.
     */
    async function seedDatedInventory(): Promise<void> {
      for (const offset of OFFSETS) {
        await items.create({
          name: `Perishable${offset}`,
          trackingMode: 'DISCRETE',
          quantity: 1,
          expiryDate: storedDay(offset),
        });
        await items.create({
          name: `Asset${offset}`,
          trackingMode: 'DISCRETE',
          quantity: 1,
          warrantyExpiresAt: toDateInputValue(storedDay(offset)),
        });
      }
      await items.create({ name: 'Undated', trackingMode: 'DISCRETE', quantity: 1 });
    }

    it('agrees on which perishables need attention — expiring feed vs pure expiryStatus', async () => {
      await seedDatedInventory();

      const fromSql = await items.listExpiringWithin(EXPIRY_SOON_WINDOW_DAYS, NOW, { limit: 200 });
      // The feed's cutoff takes in the already-lapsed too, so the pure side is both attention states.
      const fromPure = (await allActiveItems()).filter((item) => {
        const status = expiryStatus(effectiveExpiryDate(item.expiryDate, item.earliestBatchExpiryDate), NOW);
        return status === 'EXPIRING_SOON' || status === 'EXPIRED';
      });

      expect(names(fromSql.rows)).toEqual(names(fromPure));
      // Guard the guard: two empty sets would satisfy the comparison above, and the boundary day
      // itself is the row a drifting derivation moves first.
      expect(names(fromSql.rows)).toContain(`Perishable${EXPIRY_SOON_WINDOW_DAYS}`);
      expect(names(fromSql.rows)).not.toContain(`Perishable${EXPIRY_SOON_WINDOW_DAYS + 1}`);
    });

    it('agrees on which assets need attention — warranty feed vs pure warrantyStatus', async () => {
      await seedDatedInventory();

      const fromSql = await items.listWarrantyExpiring(WARRANTY_SOON_WINDOW_DAYS, NOW, { limit: 200 });
      const fromPure = (await allActiveItems()).filter((item) => {
        const status = warrantyStatus(item, NOW);
        return status === 'expiring-soon' || status === 'expired';
      });

      expect(names(fromSql.rows)).toEqual(names(fromPure));
      expect(names(fromSql.rows)).toContain(`Asset${WARRANTY_SOON_WINDOW_DAYS}`);
      expect(names(fromSql.rows)).not.toContain(`Asset${WARRANTY_SOON_WINDOW_DAYS + 1}`);
    });

    it('gives the inventory status chips the same sets as the feeds they share a predicate with', async () => {
      await seedDatedInventory();

      // The chips bind their cut-offs in `status-filter.ts` rather than in the feeds, so they are a
      // third derivation of the same boundary and drift independently of both.
      const expiringChip = await items.list({ status: ['expiring'], now: NOW, limit: 200 });
      const warrantyChip = await items.list({ status: ['warranty'], now: NOW, limit: 200 });

      const expiringFeed = await items.listExpiringWithin(EXPIRY_SOON_WINDOW_DAYS, NOW, { limit: 200 });
      const warrantyFeed = await items.listWarrantyExpiring(WARRANTY_SOON_WINDOW_DAYS, NOW, { limit: 200 });

      expect(names(expiringChip.rows)).toEqual(names(expiringFeed.rows));
      expect(names(warrantyChip.rows)).toEqual(names(warrantyFeed.rows));
      expect(names(expiringChip.rows)).toContain(`Perishable${EXPIRY_SOON_WINDOW_DAYS}`);
      expect(names(expiringChip.rows)).not.toContain(`Perishable${EXPIRY_SOON_WINDOW_DAYS + 1}`);
      expect(names(warrantyChip.rows)).toContain(`Asset${WARRANTY_SOON_WINDOW_DAYS}`);
      expect(names(warrantyChip.rows)).not.toContain(`Asset${WARRANTY_SOON_WINDOW_DAYS + 1}`);
    });
  });
});
