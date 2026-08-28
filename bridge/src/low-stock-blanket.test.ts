/**
 * The blanket low-stock threshold reaching every bridge surface at once (issue #483).
 *
 * The bug this pins was not that any one projection counted wrongly — each was faithful to the
 * thresholds it was given — but that the thresholds themselves were this build's constants rather
 * than the user's. Raising the blanket in Settings moved the app's own Low Stock feed and left the
 * Home Assistant sensor, the MQTT `gubbins/summary` counts, the Prometheus gauge and
 * `/api/v1/status` reporting on per-item reorder points alone.
 *
 * So the assertion is deliberately made across all of them together, over one synthetic vault: the
 * same fixture the other feed tests use, whose "Hook-up Wire 22AWG" carries 250 on hand and no
 * reorder point of its own — invisible to low-stock until a blanket says otherwise.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsRepository } from '@/db/repositories/SettingsRepository.ts';
import { PREFERENCES_KEY } from '@/features/backup/settings-groups';
import { LOW_STOCK_QTY_FIELD } from '@/features/settings/shared-low-stock.ts';
import { projectItemStatuses } from './feeds/item-status.ts';
import { projectMetrics } from './feeds/metrics.ts';
import { hydrateFromJson, type HydrateResult } from './hydrate.ts';
import { projectInventoryState } from './mqtt/state.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-feeds-snapshot.json', import.meta.url);

let hydrated: HydrateResult | undefined;

/** A fresh hydration of the shared fixture, so a published blanket cannot leak between tests. */
async function vault(): Promise<HydrateResult> {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  return hydrated;
}

afterEach(async () => {
  await hydrated?.driver.close();
  hydrated = undefined;
});

/** Every low-stock figure the bridge publishes, from the four surfaces that publish one. */
async function lowStockEverywhere(result: HydrateResult): Promise<readonly number[]> {
  const { driver } = result;
  return [
    (await projectItemStatuses(driver))['low-stock'],
    (await projectMetrics(driver)).lowStockItems,
    (await projectInventoryState(driver, { generatedAt: null })).lowStockItems,
  ];
}

describe('the blanket low-stock threshold', () => {
  it('leaves every surface on the shipped defaults when the user has shared nothing', async () => {
    // Two items carry their own reorder point and sit at or below it; the 250-on-hand item does
    // not, so with the opt-in defaults it is not low.
    expect(await lowStockEverywhere(await vault())).toEqual([2, 2, 2]);
  });

  it('is honoured by every surface once the app has shared it', async () => {
    const result = await vault();
    await new SettingsRepository(result.driver).publish([
      { storeKey: PREFERENCES_KEY, field: LOW_STOCK_QTY_FIELD, value: '300' },
    ]);

    // The 250-on-hand item is now below the blanket, and the soft-deleted one still counts for
    // nothing — on all three surfaces, which is the point.
    expect(await lowStockEverywhere(result)).toEqual([3, 3, 3]);
  });

  it('does not move the out-of-stock counts, which are not threshold-driven', async () => {
    const result = await vault();
    await new SettingsRepository(result.driver).publish([
      { storeKey: PREFERENCES_KEY, field: LOW_STOCK_QTY_FIELD, value: '300' },
    ]);

    expect((await projectMetrics(result.driver)).outOfStockItems).toBe(1);
    expect((await projectItemStatuses(result.driver))['out-of-stock']).toBe(1);
  });
});
