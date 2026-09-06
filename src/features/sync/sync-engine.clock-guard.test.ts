/**
 * Issue #872 driven through a real pass: a device handed a wrong server time must not publish.
 *
 * The reported damage is not that the offending device mis-dates its own work. It is that the
 * inflated stamps *win* every Last-Write-Wins comparison, and winning records no conflict — so a
 * peer's genuinely newer edits are overwritten with nothing left to review, and the inflation
 * persists because #393's rebase trigger only fires on a later edit that nobody makes.
 *
 * So what these assert is that the shared copy is exactly as it was. `clock-offset-guard.test.ts`
 * covers which readings are refused; this covers what a refusal costs.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import type { CloudProvider } from './provider';
import { runSync } from './sync-engine';
import { SyncClockUntrustedError } from './sync-errors';

const NO_QUOTA = { skipQuotaCheck: true } as const;
const LOCAL_NOW = 1_788_172_254_093;
const DAY_MS = 24 * 60 * 60 * 1_000;

async function makeDevice() {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  return { driver, items: new ItemRepository(driver) };
}

/**
 * Wrap a provider so it has no clock of its own — like the File System folder adapter — and the
 * pass reads the injected `serverTime` instead. Delegating rather than spreading: the methods live
 * on `MemoryCloudProvider`'s prototype, so a spread would drop every one of them.
 */
function clockless(provider: MemoryCloudProvider): CloudProvider {
  return {
    id: provider.id,
    label: provider.label,
    getServerTime: async () => null,
    fetchSnapshot: () => provider.fetchSnapshot(),
    pushSnapshot: (snapshot) => provider.pushSnapshot(snapshot),
  };
}

describe('a wrong server-time reading cannot become the publishing frame (#872)', () => {
  it('leaves the peer’s newer edit standing when the Date header is 400 days ahead', async () => {
    const provider = new MemoryCloudProvider();
    const a = await makeDevice();
    const b = await makeDevice();
    try {
      // A publishes; B pulls it, edits it, and publishes that edit. B is the newest in real time.
      const item = await a.items.create({ name: 'Original', locationId: UNASSIGNED_LOCATION_ID });
      await runSync(a.driver, provider, NO_QUOTA);
      await runSync(b.driver, provider, NO_QUOTA);
      await b.items.update(item.id, { name: 'B edit (newest in real time)' });
      await runSync(b.driver, provider, NO_QUOTA);

      // A now edits the same row on an honest clock, but its network hands it a `Date` header
      // 400 days in the future. Unchecked, every row it pushes outranks B's edit for good.
      await a.items.update(item.id, { name: 'A edit (older in real time)' });
      const before = await provider.fetchSnapshot();
      await expect(
        runSync(a.driver, clockless(provider), {
          ...NO_QUOTA,
          now: () => LOCAL_NOW,
          serverTime: async () => LOCAL_NOW + 400 * DAY_MS,
        }),
      ).rejects.toThrow(SyncClockUntrustedError);

      // Nothing was read, merged or pushed: the guard runs before the first fetch.
      expect(await provider.fetchSnapshot()).toEqual(before);
      await runSync(b.driver, provider, NO_QUOTA);
      expect((await b.items.getById(item.id))?.name).toBe('B edit (newest in real time)');
    } finally {
      await a.driver.close();
      await b.driver.close();
    }
  });

  it('refuses a four-hour reading the 365-day bound alone would have let through', async () => {
    const provider = new MemoryCloudProvider();
    const a = await makeDevice();
    try {
      await a.items.create({ name: 'Original', locationId: UNASSIGNED_LOCATION_ID });
      await expect(
        runSync(a.driver, clockless(provider), {
          ...NO_QUOTA,
          now: () => LOCAL_NOW,
          serverTime: async () => LOCAL_NOW + 4 * 60 * 60 * 1_000,
          // This device measured its own clock a minute ago and found it correct, so the reading
          // and the measurement cannot both be right — and nothing here can say which is.
          clockSkew: () => ({ skewMs: 0, measuredAt: LOCAL_NOW - 60_000 }),
        }),
      ).rejects.toThrow(SyncClockUntrustedError);
      expect(await provider.fetchSnapshot()).toBeNull();
    } finally {
      await a.driver.close();
    }
  });

  it('publishes normally when the reading and the device’s own measurement agree', async () => {
    const provider = new MemoryCloudProvider();
    const a = await makeDevice();
    try {
      await a.items.create({ name: 'Original', locationId: UNASSIGNED_LOCATION_ID });
      // A genuinely eleven-month-slow clock: refusing it, or zeroing the offset, would have this
      // device publish every row eleven months in the past and lose every comparison it should win.
      const elevenMonths = 330 * DAY_MS;
      const outcome = await runSync(a.driver, clockless(provider), {
        ...NO_QUOTA,
        now: () => LOCAL_NOW,
        serverTime: async () => LOCAL_NOW + elevenMonths,
        clockSkew: () => ({ skewMs: elevenMonths, measuredAt: LOCAL_NOW - 60_000 }),
      });
      expect(outcome.status).toBe('PUBLISHED');
      expect(outcome.clockOffset).toBe(elevenMonths);
    } finally {
      await a.driver.close();
    }
  });
});
