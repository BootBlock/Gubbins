/**
 * The blanket low-stock thresholds, read back out of the shared-settings noticeboard (issue #483).
 *
 * The bridge's low-stock counts are only as good as this seam's ability to find the two rows live
 * settings sync wrote. Nothing in the type system holds "the field the store persists" and "the row
 * id the bridge looks up" together, so the parity is driven rather than asserted from source text:
 * the first test changes the thresholds on the **real** preferences store, lets the **real** sync
 * runtime publish them, and reads the resulting rows back through
 * {@link resolveSharedLowStockThresholds}. Rename either field, change the encoding, or move the
 * pair out of a live-syncable group, and it fails — rather than the bridge quietly reverting to the
 * shipped defaults, which is the failure this whole module exists to end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SettingRow, SettingUpsert } from '@/db/repositories/types/settings';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { isLiveSyncableGroup, ownerOfStoreField, PREFERENCES_KEY } from '@/features/backup/settings-groups';
import { DEFAULT_LIVE_SETTINGS_SELECTION, settingRowId } from './settings-sync';
import { flushSettingsSync, setSettingsSyncPort, startSettingsSync } from './settings-sync-runtime';
import {
  LOW_STOCK_GAUGE_FIELD,
  LOW_STOCK_GAUGE_SETTING_ID,
  LOW_STOCK_QTY_FIELD,
  LOW_STOCK_QTY_SETTING_ID,
  resolveSharedLowStockThresholds,
} from './shared-low-stock';

/** An in-memory stand-in for the `settings` table — enough of it for the runtime to publish into. */
class FakePort {
  readonly rows = new Map<string, SettingRow>();

  list = (): Promise<readonly SettingRow[]> => Promise.resolve([...this.rows.values()]);

  publish = (upserts: readonly SettingUpsert[]): Promise<void> => {
    for (const { storeKey, field, value } of upserts) {
      const id = settingRowId(storeKey, field);
      this.rows.set(id, { id, store_key: storeKey, field, value, created_at: 1, updated_at: 1 });
    }
    return Promise.resolve();
  };
}

/** One `settings` row holding an already-encoded value, as a peer's device would have written it. */
function row(id: string, value: string): SettingRow {
  const [store_key = '', field = ''] = id.split('#');
  return { id, store_key, field, value, created_at: 1, updated_at: 1 };
}

let port: FakePort;
let stop: (() => void) | undefined;

beforeEach(() => {
  port = new FakePort();
  setSettingsSyncPort(port);
  usePreferencesStore.setState({
    ...usePreferencesStore.getInitialState(),
    settingsSyncEnabled: false,
    settingsSyncGroups: DEFAULT_LIVE_SETTINGS_SELECTION,
  });
  stop = startSettingsSync();
});

afterEach(async () => {
  await flushSettingsSync();
  stop?.();
  stop = undefined;
  setSettingsSyncPort(null);
});

describe('the fields the bridge reads', () => {
  it('are ones the preferences store actually persists', () => {
    // A rename that the settings-group registry's own drift guard forced through would otherwise
    // leave this module looking up a row id nothing ever writes.
    expect(usePreferencesStore.getInitialState()).toHaveProperty(LOW_STOCK_QTY_FIELD);
    expect(usePreferencesStore.getInitialState()).toHaveProperty(LOW_STOCK_GAUGE_FIELD);
  });

  it('belong to a group that may travel live between devices', () => {
    // If the pair were moved to a group that cannot travel live, no row would ever be published and
    // the bridge would be back to counting per-item reorder points alone.
    for (const field of [LOW_STOCK_QTY_FIELD, LOW_STOCK_GAUGE_FIELD]) {
      const owner = ownerOfStoreField(PREFERENCES_KEY, field);
      expect(owner).toBeDefined();
      expect(isLiveSyncableGroup(owner!)).toBe(true);
    }
  });
});

describe('resolveSharedLowStockThresholds', () => {
  it('reads back what the real sync runtime published for the real store', async () => {
    const prefs = usePreferencesStore.getState();
    prefs.setSettingsSyncEnabled(true);
    prefs.setLowStockQtyThreshold(7);
    prefs.setLowStockGaugePercent(25);
    await flushSettingsSync();

    expect(resolveSharedLowStockThresholds([...port.rows.values()])).toEqual({
      qtyThreshold: 7,
      gaugePercent: 25,
    });
  });

  it('falls back to the shipped defaults when nothing has been shared', () => {
    // Live settings sync is off until asked for, so an empty table is the common case — and the
    // shipped defaults are both 0, i.e. low-stock alerts stay opt-in.
    expect(resolveSharedLowStockThresholds([])).toEqual({ qtyThreshold: 0, gaugePercent: 0 });
  });

  it('falls back field by field, so one shared threshold does not force the other', () => {
    expect(resolveSharedLowStockThresholds([row(LOW_STOCK_QTY_SETTING_ID, '4')])).toEqual({
      qtyThreshold: 4,
      gaugePercent: 0,
    });
  });

  it('clamps a hostile or damaged row to something the app itself would hold', () => {
    const rows = [row(LOW_STOCK_QTY_SETTING_ID, '999999'), row(LOW_STOCK_GAUGE_SETTING_ID, '"most of it"')];
    // 1000 is the quantity ceiling; a non-numeric gauge value is refused for the default.
    expect(resolveSharedLowStockThresholds(rows)).toEqual({ qtyThreshold: 1000, gaugePercent: 0 });
  });

  it('ignores a row whose value is not readable JSON', () => {
    expect(resolveSharedLowStockThresholds([row(LOW_STOCK_QTY_SETTING_ID, 'not json')])).toEqual({
      qtyThreshold: 0,
      gaugePercent: 0,
    });
  });
});
