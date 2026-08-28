/**
 * The bridge's blanket low-stock thresholds (issue #483), over a real migrated database.
 *
 * The point of the round-trip is that both halves are real: the rows are written through the app's
 * own `SettingsRepository.publish` (the same call live settings sync makes) and read back through
 * the projection seam the metrics, MQTT, `/api/v1/status` and event surfaces all share. A change to
 * the row id, the encoding or the table on either side fails here rather than silently returning the
 * shipped defaults, which is indistinguishable from "the user shared nothing".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrations } from '@/db/migrations';
import { runMigrations } from '@/db/migrations/engine';
import { SettingsRepository } from '@/db/repositories/SettingsRepository.ts';
import { PREFERENCES_KEY } from '@/features/backup/settings-groups';
import { LOW_STOCK_GAUGE_FIELD, LOW_STOCK_QTY_FIELD } from '@/features/settings/shared-low-stock.ts';
import { DEFAULT_LOW_STOCK } from './events/model.ts';
import { readLowStockThresholds } from './low-stock-thresholds.ts';
import { createNodeDriver, type NodeDriver } from './node-driver.ts';

let driver: NodeDriver;

beforeEach(async () => {
  driver = createNodeDriver();
  await runMigrations(driver, migrations);
});

afterEach(async () => {
  await driver.close();
});

describe('readLowStockThresholds', () => {
  it('answers the shipped defaults when the user has not shared their settings', async () => {
    // Live settings sync is off until asked for, so an empty `settings` table is the common case.
    expect(await readLowStockThresholds(driver)).toEqual(DEFAULT_LOW_STOCK);
  });

  it('reads the blanket the app published, through the real repository', async () => {
    await new SettingsRepository(driver).publish([
      { storeKey: PREFERENCES_KEY, field: LOW_STOCK_QTY_FIELD, value: '6' },
      { storeKey: PREFERENCES_KEY, field: LOW_STOCK_GAUGE_FIELD, value: '30' },
    ]);

    expect(await readLowStockThresholds(driver)).toEqual({ qtyThreshold: 6, gaugePercent: 30 });
  });

  it('is not confused by the other preferences sharing the table', async () => {
    await new SettingsRepository(driver).publish([
      { storeKey: PREFERENCES_KEY, field: 'mode', value: '"dark"' },
      { storeKey: PREFERENCES_KEY, field: LOW_STOCK_QTY_FIELD, value: '3' },
      { storeKey: PREFERENCES_KEY, field: 'baseCurrency', value: '"GBP"' },
    ]);

    expect(await readLowStockThresholds(driver)).toEqual({ qtyThreshold: 3, gaugePercent: 0 });
  });
});
