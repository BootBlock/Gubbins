import { describe, it, expect } from 'vitest';
import {
  EXPORTABLE_SETTING_KEYS,
  applySettings,
  collectSettings,
  sanitiseSettingsRecord,
} from './backup-settings';

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
  state: { theme: 'dark', bridgeUrl: 'http://127.0.0.1:8787', bridgeToken: 'super-secret' },
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
    expect(parsed.state.theme).toBe('dark');
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
    const out = collectSettings(storage);
    expect(Object.keys(out).sort()).toEqual(['gubbins:layout', 'gubbins:preferences']);
    expect(JSON.parse(out['gubbins:preferences']!).state.bridgeToken).toBeUndefined();
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
      storage,
    );
    expect(written).toBe(2);
    expect(storage.getItem('gubbins:layout')).toBe('{"state":{}}');
    expect(storage.getItem('gubbins:auth')).toBeNull();
  });

  it('round-trips collect → apply for every allow-listed key', () => {
    const seed: Record<string, string> = {};
    for (const key of EXPORTABLE_SETTING_KEYS) seed[key] = '{"state":{},"version":0}';
    const written = applySettings(collectSettings(memoryStorage(seed)), memoryStorage());
    expect(written).toBe(EXPORTABLE_SETTING_KEYS.length);
  });
});
