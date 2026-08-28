/**
 * The blanket low-stock thresholds, read back out of the shared-settings noticeboard (issue #483).
 *
 * The app's own screens read `lowStockQtyThreshold` / `lowStockGaugePercent` straight off the
 * preferences store, because that is where they live. The **bridge** has no store: it hydrates the
 * synced database and nothing else, so the only blanket it could ever see is the one live settings
 * sync publishes into the `settings` table (issue #382). Without this seam the bridge fell back to
 * the shipped defaults — both `0`, i.e. off — so raising the blanket in Settings moved the app's
 * Low Stock feed and left the Home Assistant sensor, the MQTT `gubbins/summary` counts, the
 * Prometheus gauge and the derived `item.low_stock` events reporting on per-item reorder points
 * alone.
 *
 * Pure, and deliberately built out of the seams that already exist rather than beside them:
 * {@link settingRowId} derives the same row id the publisher wrote, {@link decodeSettingValue}
 * reads the same encoding it wrote, and the same {@link clampLowStockQty} /
 * {@link clampLowStockGaugePercent} the store applies decides the range. A row from another device
 * is untrusted in exactly the way an adopted preference is, and the clamps are what make
 * "untrusted" safe: anything that is not a finite number in range falls back to the shipped
 * default rather than reaching a predicate.
 *
 * **A missing row means "the user has not shared this"**, not "the blanket is zero" — but the two
 * land on the same answer, because the shipped default *is* zero. That keeps the bridge's
 * behaviour unchanged for everyone who has not turned live settings sync on.
 *
 * Two drift tests hold the halves together, so a rename on either side fails rather than silently
 * reverting the bridge to the defaults. `shared-low-stock.test.ts` beside this file changes the
 * thresholds on the real preferences store and lets the real sync runtime plan the publish, then
 * reads the rows back through here; `bridge/src/low-stock-thresholds.test.ts` makes the same round
 * trip through the real `SettingsRepository` over a migrated database.
 */
import type { SettingRow } from '@/db/repositories/types/settings';
import { PREFERENCES_KEY } from '@/features/backup/settings-groups';
import type { ReorderDefaults } from '@/features/inventory/reorder-policy';
import { clampLowStockGaugePercent, clampLowStockQty } from './settings';
import { decodeSettingValue, settingRowId } from './settings-sync';

/** The preferences field holding the blanket DISCRETE quantity floor. */
export const LOW_STOCK_QTY_FIELD = 'lowStockQtyThreshold';
/** The preferences field holding the blanket CONSUMABLE_GAUGE percentage floor. */
export const LOW_STOCK_GAUGE_FIELD = 'lowStockGaugePercent';

/** The `settings` row id the publisher writes the blanket quantity floor to. */
export const LOW_STOCK_QTY_SETTING_ID = settingRowId(PREFERENCES_KEY, LOW_STOCK_QTY_FIELD);
/** The `settings` row id the publisher writes the blanket gauge floor to. */
export const LOW_STOCK_GAUGE_SETTING_ID = settingRowId(PREFERENCES_KEY, LOW_STOCK_GAUGE_FIELD);

/**
 * Read one numeric preference out of the noticeboard, clamped.
 *
 * An absent row, an unreadable one and an out-of-range value all resolve through the store's own
 * clamp, which answers the shipped default for anything that is not a finite number — so the three
 * failure modes need no separate handling and cannot produce a threshold the app itself would
 * refuse to hold.
 */
function readClamped(rows: readonly SettingRow[], id: string, clamp: (value: unknown) => number): number {
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) return clamp(undefined);
  const decoded = decodeSettingValue(row.value);
  return clamp(decoded.ok ? decoded.value : undefined);
}

/**
 * The blanket low-stock thresholds carried by a set of `settings` rows, falling back field by field
 * to the shipped defaults. Pass the whole table — `SettingsRepository.list()` returns it in one go.
 */
export function resolveSharedLowStockThresholds(rows: readonly SettingRow[]): ReorderDefaults {
  return {
    qtyThreshold: readClamped(rows, LOW_STOCK_QTY_SETTING_ID, clampLowStockQty),
    gaugePercent: readClamped(rows, LOW_STOCK_GAUGE_SETTING_ID, clampLowStockGaugePercent),
  };
}
