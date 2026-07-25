/**
 * Live settings sync — the runtime half (issue #382).
 *
 * Driven against the real stores and a fake database port, because the behaviours that matter are
 * exactly the interactions between the two: that nothing is written while sharing is off, that a
 * single change publishes only itself, that switching sharing on publishes what this device has, and
 * that adopting a peer's value goes through the store's own reconciliation rather than around it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SettingRow, SettingUpsert } from '@/db/repositories/types/settings';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import { PREFERENCES_KEY, LIVE_SYNCED_STORE_KEYS } from '@/features/backup/settings-groups';
import { DEFAULT_LIVE_SETTINGS_SELECTION, settingRowId } from './settings-sync';
import {
  SHARED_SETTINGS_STORES,
  applySharedSettings,
  flushSettingsSync,
  publishSharedSettings,
  setSettingsSyncPort,
  startSettingsSync,
} from './settings-sync-runtime';

/** An in-memory stand-in for the `settings` table, recording what the runtime asked it to write. */
class FakePort {
  readonly rows = new Map<string, SettingRow>();
  readonly publishes: SettingUpsert[][] = [];

  list = (): Promise<readonly SettingRow[]> => Promise.resolve([...this.rows.values()]);

  publish = (upserts: readonly SettingUpsert[]): Promise<void> => {
    this.publishes.push([...upserts]);
    for (const { storeKey, field, value } of upserts) {
      const id = settingRowId(storeKey, field);
      // Mirrors the real table: the value changes, the timestamp moves on.
      this.rows.set(id, {
        id,
        store_key: storeKey,
        field,
        value,
        created_at: 1,
        updated_at: (this.rows.get(id)?.updated_at ?? 0) + 1,
      });
    }
    return Promise.resolve();
  };

  /** Stand in for a peer's newer value arriving through a merge. */
  seed(storeKey: string, field: string, value: unknown): void {
    const id = settingRowId(storeKey, field);
    this.rows.set(id, {
      id,
      store_key: storeKey,
      field,
      value: JSON.stringify(value),
      created_at: 1,
      updated_at: 99,
    });
  }

  /** Every field this port has ever been asked to write, flattened. */
  publishedFields(): string[] {
    return this.publishes.flat().map((u) => u.field);
  }
}

let port: FakePort;
let stop: (() => void) | undefined;

/** Reset every participating store to its shipped defaults, and its stored blob with it. */
function resetStores(): void {
  for (const store of Object.values(SHARED_SETTINGS_STORES)) {
    // `setState` rather than a replace: the actions must survive, and persist writes the blob.
    store.setState({});
  }
  usePreferencesStore.setState({
    ...usePreferencesStore.getInitialState(),
    settingsSyncEnabled: false,
    settingsSyncGroups: DEFAULT_LIVE_SETTINGS_SELECTION,
  });
  useLayoutStore.setState(useLayoutStore.getInitialState());
}

/** Let every queued publish settle, so an assertion sees the finished state. */
async function settle(): Promise<void> {
  await flushSettingsSync();
}

beforeEach(() => {
  port = new FakePort();
  setSettingsSyncPort(port);
  resetStores();
  stop = startSettingsSync();
});

afterEach(async () => {
  await settle();
  stop?.();
  stop = undefined;
  setSettingsSyncPort(null);
  vi.restoreAllMocks();
});

describe('the store map', () => {
  it('covers exactly the stores the settings-group registry marks live-syncable', () => {
    // The drift guard: marking a group live-syncable without teaching the runtime about its store
    // would publish nothing at all, silently.
    expect(Object.keys(SHARED_SETTINGS_STORES).sort()).toEqual([...LIVE_SYNCED_STORE_KEYS].sort());
  });
});

describe('while settings sync is off', () => {
  it('writes nothing when the user changes a preference', async () => {
    usePreferencesStore.getState().setMode('light');
    await settle();
    expect(port.publishes).toEqual([]);
  });

  it('does not even read the table', async () => {
    const list = vi.spyOn(port, 'list');
    usePreferencesStore.getState().setMode('light');
    await settle();
    expect(list).not.toHaveBeenCalled();
  });
});

describe('switching sharing on', () => {
  it('publishes this device’s current settings', async () => {
    usePreferencesStore.getState().setSettingsSyncEnabled(true);
    await settle();
    expect(port.publishedFields()).toContain('mode');
    expect(port.publishedFields()).toContain('accent');
  });

  it('never publishes the bridge token, a device preference, or the opt-in itself', async () => {
    usePreferencesStore.getState().setSettingsSyncEnabled(true);
    await settle();
    const fields = port.publishedFields();
    expect(fields).not.toContain('bridgeToken');
    expect(fields).not.toContain('bridgeUrl');
    expect(fields).not.toContain('settingsSyncEnabled');
    expect(fields).not.toContain('settingsSyncGroups');
  });

  it('publishes only the groups that are ticked', async () => {
    usePreferencesStore.getState().setSettingsSyncGroups({
      ...DEFAULT_LIVE_SETTINGS_SELECTION,
      appearance: true,
      alerts: false,
      dashboard: false,
    });
    usePreferencesStore.getState().setSettingsSyncEnabled(true);
    await settle();
    const fields = port.publishedFields();
    expect(fields).toContain('mode');
    expect(fields).not.toContain('lowStockQtyThreshold');
    expect(fields).not.toContain('density');
  });
});

describe('while sharing is on', () => {
  beforeEach(async () => {
    usePreferencesStore.getState().setSettingsSyncEnabled(true);
    await settle();
    port.publishes.length = 0;
  });

  it('publishes a changed preference, and only that one', async () => {
    usePreferencesStore.getState().setMode('light');
    await settle();
    expect(port.publishes).toEqual([[{ storeKey: PREFERENCES_KEY, field: 'mode', value: '"light"' }]]);
  });

  it('publishes a change made in a whole-key store too', async () => {
    useLayoutStore.getState().setDensity('data');
    await settle();
    expect(port.publishes.flat()).toContainEqual({
      storeKey: 'gubbins:layout',
      field: 'density',
      value: '"data"',
    });
  });

  it('writes nothing when a setter is called with the value already held', async () => {
    // The `updated_at` trigger stamps any UPDATE, so a no-op write would make this device look like
    // the more recent editor and start the two pushing the row back and forth (issue #161).
    usePreferencesStore.getState().setMode(usePreferencesStore.getState().mode);
    await settle();
    expect(port.publishes).toEqual([]);
  });

  it('writes nothing when a device-only preference changes', async () => {
    usePreferencesStore.getState().setBridgeUrl('http://127.0.0.1:9999');
    await settle();
    expect(port.publishes).toEqual([]);
  });

  it('does not republish a field a peer has since moved on, when publishing one change', async () => {
    // The narrowing that stops an unrelated local value overwriting a peer's newer one.
    port.seed(PREFERENCES_KEY, 'accent', 'amber');
    usePreferencesStore.getState().setMode('light');
    await settle();
    expect(port.publishedFields()).toEqual(['mode']);
    expect(port.rows.get(settingRowId(PREFERENCES_KEY, 'accent'))?.value).toBe('"amber"');
  });
});

describe('adopting shared settings after a merge', () => {
  beforeEach(async () => {
    usePreferencesStore.getState().setSettingsSyncEnabled(true);
    await settle();
    port.publishes.length = 0;
  });

  it('applies a peer’s value and reports how many changed', async () => {
    port.seed(PREFERENCES_KEY, 'mode', 'light');
    expect(await applySharedSettings()).toBe(1);
    expect(usePreferencesStore.getState().mode).toBe('light');
  });

  it('leaves a preference alone when the shared value already matches', async () => {
    port.seed(PREFERENCES_KEY, 'mode', usePreferencesStore.getState().mode);
    expect(await applySharedSettings()).toBe(0);
  });

  it('does not publish anything back — the adopted value already equals its row', async () => {
    port.seed(PREFERENCES_KEY, 'mode', 'light');
    await applySharedSettings();
    await settle();
    expect(port.publishes).toEqual([]);
  });

  it('normalises a value this build has no arm for, instead of storing it', async () => {
    // The reason adopting goes through the store's own re-hydration: a peer on a newer build can
    // send a layout density this one does not know, and the store's `merge` already rejects exactly
    // that. Storing it verbatim would leave an unrenderable value in a live screen.
    port.seed('gubbins:layout', 'density', 'holograph');
    await applySharedSettings();
    expect(useLayoutStore.getState().density).toBe('visual');
  });

  it('ignores a row whose group this device does not share', async () => {
    usePreferencesStore
      .getState()
      .setSettingsSyncGroups({ ...DEFAULT_LIVE_SETTINGS_SELECTION, appearance: false });
    await settle();
    port.seed(PREFERENCES_KEY, 'mode', 'light');
    expect(await applySharedSettings()).toBe(0);
    expect(usePreferencesStore.getState().mode).not.toBe('light');
  });

  it('drops a wrongly-shaped row, warns with its name only, and leaves the rest applied', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    port.seed(PREFERENCES_KEY, 'mode', { not: 'a mode' });
    port.seed(PREFERENCES_KEY, 'accent', 'amber');

    expect(await applySharedSettings()).toBe(1);
    expect(usePreferencesStore.getState().accent).toBe('amber');
    expect(usePreferencesStore.getState().mode).toBe('dark');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not match'), expect.any(String));
    // Never the value: a preference can hold the user's own letterhead text.
    expect(warn.mock.calls[0]?.[1]).toBe(settingRowId(PREFERENCES_KEY, 'mode'));
  });

  it('does nothing while sharing is off', async () => {
    usePreferencesStore.getState().setSettingsSyncEnabled(false);
    await settle();
    port.seed(PREFERENCES_KEY, 'mode', 'light');
    expect(await applySharedSettings()).toBe(0);
    expect(usePreferencesStore.getState().mode).toBe('dark');
  });
});

describe('flushSettingsSync', () => {
  it('waits for a publish queued a moment earlier to reach the database', async () => {
    usePreferencesStore.getState().setSettingsSyncEnabled(true);
    await settle();
    port.publishes.length = 0;

    usePreferencesStore.getState().setMode('light');
    // Not awaited by the caller anywhere — this is precisely what the sync screen must wait for, or
    // the change sits out the sync it was made just before.
    await flushSettingsSync();
    expect(port.rows.get(settingRowId(PREFERENCES_KEY, 'mode'))?.value).toBe('"light"');
  });

  it('keeps serving later work after a publish fails', async () => {
    usePreferencesStore.getState().setSettingsSyncEnabled(true);
    await settle();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const publish = vi.spyOn(port, 'publish').mockRejectedValueOnce(new Error('storage full'));

    usePreferencesStore.getState().setMode('light');
    await settle();
    publish.mockRestore();

    usePreferencesStore.getState().setMode('system');
    await settle();
    expect(port.rows.get(settingRowId(PREFERENCES_KEY, 'mode'))?.value).toBe('"system"');
  });

  it('reports a failed publish without throwing at the user', async () => {
    usePreferencesStore.getState().setSettingsSyncEnabled(true);
    await settle();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(port, 'publish').mockRejectedValueOnce(new Error('storage full'));

    usePreferencesStore.getState().setMode('light');
    await settle();
    expect(error).toHaveBeenCalledWith('[gubbins] could not publish a shared setting', expect.any(Error));
  });
});

describe('publishSharedSettings', () => {
  it('returns how many rows it wrote, and nothing on a second run', async () => {
    // Unsubscribed first, so this call is the only publisher and the count is its own.
    stop?.();
    stop = undefined;
    usePreferencesStore.setState({ settingsSyncEnabled: true });

    expect(await publishSharedSettings()).toBeGreaterThan(0);
    expect(await publishSharedSettings()).toBe(0); // nothing left differing
  });
});
