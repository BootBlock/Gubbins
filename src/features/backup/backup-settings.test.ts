import { describe, it, expect } from 'vitest';
import {
  EXPORTABLE_SETTING_KEYS,
  applySettings,
  collectSettings,
  sanitiseSettingsRecord,
} from './backup-settings';
import { allSettingsGroups } from './settings-groups';

/** A minimal in-memory Storage stub (avoids touching the real localStorage). */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  } as Storage;
}

const prefsWithSecret = JSON.stringify({
  state: { mode: 'dark', bridgeUrl: 'http://127.0.0.1:8787', bridgeToken: 'xxxx-placeholder' },
  version: 0,
});

describe('sanitiseSettingsRecord', () => {
  it('keeps only allow-listed keys', () => {
    const out = sanitiseSettingsRecord({
      'gubbins:layout': '{"state":{}}',
      'gubbins:auth': '{"state":{"providerId":"google-drive"}}',
      'gubbins:google-drive-token': 'ya29.secret',
      'evil-key': 'nope',
    });
    expect(Object.keys(out)).toEqual(['gubbins:layout']);
    expect(out['gubbins:auth']).toBeUndefined();
    expect(out['gubbins:google-drive-token']).toBeUndefined();
  });

  it('scrubs the bridge token out of the preferences blob but keeps the rest', () => {
    const out = sanitiseSettingsRecord({ 'gubbins:preferences': prefsWithSecret });
    const parsed = JSON.parse(out['gubbins:preferences']!);
    expect(parsed.state.bridgeToken).toBeUndefined();
    expect(parsed.state.bridgeUrl).toBe('http://127.0.0.1:8787');
    expect(parsed.state.mode).toBe('dark');
  });

  it('carries keyboard shortcut bindings into the backup (issue #127)', () => {
    // Bindings are device-local *state*, but they are a preference the user configured by hand
    // and expects to find again after restoring onto a new machine — so unlike the bridge token
    // they must survive the scrub. Locked here because they travel inside the preferences blob:
    // nothing names them explicitly, so a future scrub rule could drop them unnoticed.
    const withBindings = JSON.stringify({
      state: { bridgeToken: 'shh', hotkeyBindings: { 'nav.inventory': 'F1', 'nav.reports': 'G R' } },
    });
    const out = sanitiseSettingsRecord({ 'gubbins:preferences': withBindings });
    const parsed = JSON.parse(out['gubbins:preferences']!);
    expect(parsed.state.bridgeToken).toBeUndefined();
    expect(parsed.state.hotkeyBindings).toEqual({ 'nav.inventory': 'F1', 'nav.reports': 'G R' });
  });

  it('drops an unparseable preferences blob rather than exporting it raw', () => {
    const out = sanitiseSettingsRecord({ 'gubbins:preferences': 'not json' });
    expect(out['gubbins:preferences']).toBeUndefined();
  });

  it('ignores non-string values', () => {
    const out = sanitiseSettingsRecord({ 'gubbins:layout': 123 as unknown as string });
    expect(out['gubbins:layout']).toBeUndefined();
  });
});

describe('collectSettings', () => {
  it('reads, allow-lists and scrubs from storage', () => {
    const storage = memoryStorage({
      'gubbins:preferences': prefsWithSecret,
      'gubbins:layout': '{"state":{"dashboardLayout":[]}}',
      'gubbins:auth': '{"state":{"providerId":"x"}}', // excluded
    });
    const out = collectSettings(allSettingsGroups(true), storage);
    expect(Object.keys(out).sort()).toEqual(['gubbins:layout', 'gubbins:preferences']);
    expect(JSON.parse(out['gubbins:preferences']!).state.bridgeToken).toBeUndefined();
  });

  it('carries only the chosen groups (issue #175)', () => {
    const storage = memoryStorage({
      'gubbins:preferences': JSON.stringify({ state: { mode: 'dark', baseCurrency: 'USD' }, version: 3 }),
      'gubbins:layout': '{"state":{"dashboardLayout":[]}}',
      'gubbins:saved-searches': '{"state":{"searches":[]}}',
    });
    const out = collectSettings({ ...allSettingsGroups(false), appearance: true }, storage);
    expect(Object.keys(out)).toEqual(['gubbins:preferences']);
    const state = JSON.parse(out['gubbins:preferences']!).state;
    expect(state).toEqual({ mode: 'dark' }); // baseCurrency belongs to the unchosen `regional` group
  });

  it('leaves the bridge address behind by default (device-specific)', () => {
    const storage = memoryStorage({ 'gubbins:preferences': prefsWithSecret });
    const state = JSON.parse(collectSettings(undefined, storage)['gubbins:preferences']!).state;
    expect(state.mode).toBe('dark');
    expect(state.bridgeUrl).toBeUndefined();
  });

  it('returns nothing at all when no group is chosen', () => {
    const storage = memoryStorage({
      'gubbins:preferences': prefsWithSecret,
      'gubbins:layout': '{"state":{}}',
    });
    expect(collectSettings(allSettingsGroups(false), storage)).toEqual({});
  });
});

describe('applySettings', () => {
  it('writes only allow-listed keys back to storage and counts them', () => {
    const storage = memoryStorage();
    const written = applySettings(
      {
        'gubbins:layout': '{"state":{}}',
        'gubbins:saved-searches': '{"state":{"searches":[]}}',
        'gubbins:auth': '{"state":{"providerId":"x"}}', // must be ignored
      },
      allSettingsGroups(true),
      storage,
    );
    expect(written).toBe(2);
    expect(storage.getItem('gubbins:layout')).toBe('{"state":{}}');
    expect(storage.getItem('gubbins:auth')).toBeNull();
  });

  it('applies only the groups the user chose to restore (issue #175)', () => {
    const storage = memoryStorage();
    const written = applySettings(
      {
        'gubbins:preferences': JSON.stringify({ state: { mode: 'dark', baseCurrency: 'USD' }, version: 3 }),
        'gubbins:layout': '{"state":{"dashboardLayout":[]}}',
      },
      { ...allSettingsGroups(false), regional: true },
      storage,
    );
    expect(written).toBe(1);
    expect(storage.getItem('gubbins:layout')).toBeNull();
    expect(JSON.parse(storage.getItem('gubbins:preferences')!).state).toEqual({ baseCurrency: 'USD' });
  });

  it('merges a restored group over the live preferences instead of resetting the rest', () => {
    // Restoring one group must not blank the others: a wholesale write of a group-filtered blob
    // would leave every unchosen field absent, and the store would re-hydrate them to defaults.
    const storage = memoryStorage({
      'gubbins:preferences': JSON.stringify({ state: { mode: 'light', baseCurrency: 'GBP' }, version: 3 }),
    });
    applySettings(
      { 'gubbins:preferences': JSON.stringify({ state: { mode: 'dark' }, version: 3 }) },
      { ...allSettingsGroups(false), appearance: true },
      storage,
    );
    const state = JSON.parse(storage.getItem('gubbins:preferences')!).state;
    expect(state).toEqual({ mode: 'dark', baseCurrency: 'GBP' });
  });

  it('round-trips collect → apply for every allow-listed key', () => {
    const seed: Record<string, string> = {};
    // The preferences blob needs a field from some group to survive the split; the whole-key
    // groups (layout, saved searches) travel on their own.
    for (const key of EXPORTABLE_SETTING_KEYS) seed[key] = '{"state":{},"version":0}';
    seed['gubbins:preferences'] = JSON.stringify({ state: { mode: 'dark' }, version: 3 });
    const groups = allSettingsGroups(true);
    const written = applySettings(collectSettings(groups, memoryStorage(seed)), groups, memoryStorage());
    expect(written).toBe(EXPORTABLE_SETTING_KEYS.length);
  });
});
