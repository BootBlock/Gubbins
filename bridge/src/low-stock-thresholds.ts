/**
 * The blanket low-stock thresholds this hydration generation should judge "low" against
 * (issue #483) — the DB-facing half of `@/features/settings/shared-low-stock`.
 *
 * Every bridge surface that reports low stock — the `/api/v1/status` counts, the Prometheus
 * `gubbins_low_stock_items` gauge, the MQTT `gubbins/summary` counts and the derived
 * `item.low_stock` events — reads its thresholds through here, so no two of them can apply a
 * different idea of "low". They used to take the shipped app defaults (`DEFAULT_LOW_STOCK`) instead, which
 * meant a user who raised the blanket in Settings saw the app's own Low Stock feed move while the
 * bridge kept counting per-item reorder points alone.
 *
 * One small read of the `settings` table (a few dozen rows, no paging) per projection. Read-only,
 * like everything else the bridge does with a hydrated driver.
 *
 * **The blanket only reaches the bridge when the user shares it.** Live settings sync is off until
 * asked for, and the thresholds travel with its *Alerts & thresholds* group; until then the table
 * holds no such row and this answers the shipped defaults, which is exactly the behaviour that
 * shipped before.
 */
import { SettingsRepository } from '@/db/repositories/SettingsRepository.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { ReorderDefaults } from '@/features/inventory/reorder-policy.ts';
import { resolveSharedLowStockThresholds } from '@/features/settings/shared-low-stock.ts';

/**
 * The blanket thresholds carried by the hydrated snapshot, or the shipped defaults when the user
 * has not shared them. Never throws on a damaged row: the app's own clamps answer the default.
 */
export async function readLowStockThresholds(driver: IDatabaseDriver): Promise<ReorderDefaults> {
  return resolveSharedLowStockThresholds(await new SettingsRepository(driver).list());
}
