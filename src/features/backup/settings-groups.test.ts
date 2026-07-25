import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS_GROUPS,
  LIVE_SYNCABLE_SETTINGS_GROUP_IDS,
  LIVE_SYNCED_STORE_KEYS,
  NON_PORTABLE_PREF_FIELDS,
  PREFERENCES_KEY,
  SETTINGS_GROUPS,
  SETTINGS_GROUP_IDS,
  allSettingsGroups,
  filterSettingsByGroups,
  isLiveSyncableGroup,
  mergePreferencesBlob,
  ownerOfPrefField,
  ownerOfStoreField,
  settingsGroup,
  settingsGroupsPresent,
} from './settings-groups';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { EN_CATALOG } from '@/features/i18n';

const prefsBlob = (state: Record<string, unknown>, version = 3) => JSON.stringify({ state, version });

describe('the group registry', () => {
  it('assigns every persisted preference to exactly one group', () => {
    // The drift guard: a preference added in a later build must be given a group (or listed as
    // deliberately non-portable), or the picker would silently stop offering it — and, worse, it
    // would quietly stop travelling in backups that used to carry it.
    const persisted = Object.entries(usePreferencesStore.getState())
      .filter(([, value]) => typeof value !== 'function')
      .map(([field]) => field);

    const ungrouped = persisted.filter(
      (field) => !ownerOfPrefField(field) && !NON_PORTABLE_PREF_FIELDS.includes(field),
    );
    expect(ungrouped, 'preferences with no settings group').toEqual([]);
  });

  it('never lists the same preference under two groups', () => {
    const seen = new Map<string, string>();
    for (const group of SETTINGS_GROUPS) {
      for (const field of group.prefFields ?? []) {
        expect(seen.get(field), `${field} is already owned by ${seen.get(field)}`).toBeUndefined();
        seen.set(field, group.id);
      }
    }
  });

  it('never groups a non-portable field, and never owns the preferences key wholesale', () => {
    for (const field of NON_PORTABLE_PREF_FIELDS) expect(ownerOfPrefField(field)).toBeUndefined();
    for (const group of SETTINGS_GROUPS) {
      expect(group.storageKeys ?? []).not.toContain(PREFERENCES_KEY);
    }
  });

  it('has a translated label and hint for every group', () => {
    for (const group of SETTINGS_GROUPS) {
      expect(EN_CATALOG[group.labelKey], `${group.id} label`).toBeTypeOf('string');
      expect(EN_CATALOG[group.hintKey], `${group.id} hint`).toBeTypeOf('string');
    }
  });

  it('defaults every group on except the device-specific one', () => {
    expect(DEFAULT_SETTINGS_GROUPS.device).toBe(false);
    const others = SETTINGS_GROUP_IDS.filter((id) => id !== 'device');
    expect(others.every((id) => DEFAULT_SETTINGS_GROUPS[id])).toBe(true);
  });

  it('resolves a group by id and shrugs off an unknown one', () => {
    expect(settingsGroup('appearance')?.id).toBe('appearance');
    expect(settingsGroup('not-a-group')).toBeUndefined();
  });

  it('marks every group except the device-specific one as live-syncable (issue #382)', () => {
    // Backups and live sync ask separate questions, but the answers must stay in step with the
    // partition itself: a *new* group has to make a conscious choice here rather than inherit one.
    expect(settingsGroup('device')?.liveSyncable).toBe(false);
    expect(LIVE_SYNCABLE_SETTINGS_GROUP_IDS).not.toContain('device');
    expect([...LIVE_SYNCABLE_SETTINGS_GROUP_IDS].sort()).toEqual(
      SETTINGS_GROUP_IDS.filter((id) => id !== 'device').sort(),
    );
    expect(isLiveSyncableGroup('not-a-group')).toBe(false);
  });

  it('exposes the preferences blob and every live-syncable whole key as a sync surface', () => {
    expect(LIVE_SYNCED_STORE_KEYS).toContain(PREFERENCES_KEY);
    for (const group of SETTINGS_GROUPS) {
      for (const key of group.storageKeys ?? []) {
        expect(LIVE_SYNCED_STORE_KEYS.includes(key), `${key} (${group.id})`).toBe(group.liveSyncable);
      }
    }
  });

  it('answers field ownership for both kinds of group through one lookup', () => {
    expect(ownerOfStoreField(PREFERENCES_KEY, 'mode')).toBe('appearance');
    // A whole-key store's group owns every field inside it, whatever the field is called.
    expect(ownerOfStoreField('gubbins:layout', 'density')).toBe('dashboard');
    expect(ownerOfStoreField('gubbins:layout', 'anything')).toBe('dashboard');
    expect(ownerOfStoreField(PREFERENCES_KEY, 'bridgeToken')).toBeUndefined();
    expect(ownerOfStoreField('gubbins:lab', 'flags')).toBeUndefined();
  });
});

describe('filterSettingsByGroups', () => {
  const record = {
    [PREFERENCES_KEY]: prefsBlob({ mode: 'dark', baseCurrency: 'USD', hotkeysEnabled: true }),
    'gubbins:layout': '{"state":{"dashboardLayout":[]}}',
    'gubbins:saved-searches': '{"state":{"searches":[]}}',
  };

  it('keeps only the chosen groups’ preference fields', () => {
    const out = filterSettingsByGroups(record, { ...allSettingsGroups(false), regional: true });
    expect(Object.keys(out)).toEqual([PREFERENCES_KEY]);
    expect(JSON.parse(out[PREFERENCES_KEY]!).state).toEqual({ baseCurrency: 'USD' });
  });

  it('keeps a whole-key group’s key only when that group is chosen', () => {
    const withLayout = filterSettingsByGroups(record, { ...allSettingsGroups(false), dashboard: true });
    expect(Object.keys(withLayout)).toEqual(['gubbins:layout']);
    const without = filterSettingsByGroups(record, { ...allSettingsGroups(false), savedSearches: true });
    expect(Object.keys(without)).toEqual(['gubbins:saved-searches']);
  });

  it('preserves the persist envelope (so the store’s migrations still run)', () => {
    const out = filterSettingsByGroups(record, allSettingsGroups(true));
    expect(JSON.parse(out[PREFERENCES_KEY]!).version).toBe(3);
  });

  it('drops the preferences key entirely when no chosen group owns a field in it', () => {
    const out = filterSettingsByGroups(
      { [PREFERENCES_KEY]: prefsBlob({ mode: 'dark' }) },
      { ...allSettingsGroups(false), regional: true },
    );
    expect(out).toEqual({});
  });

  it('drops a field no group owns, so an unknown preference can never travel unasked', () => {
    const out = filterSettingsByGroups(
      { [PREFERENCES_KEY]: prefsBlob({ mode: 'dark', somethingFromANewerBuild: 42 }) },
      allSettingsGroups(true),
    );
    expect(JSON.parse(out[PREFERENCES_KEY]!).state).toEqual({ mode: 'dark' });
  });

  it('shrugs off an unparseable blob', () => {
    expect(filterSettingsByGroups({ [PREFERENCES_KEY]: 'not json' }, allSettingsGroups(true))).toEqual({});
  });
});

describe('settingsGroupsPresent', () => {
  it('reports the groups a record actually carries, in picker order', () => {
    const present = settingsGroupsPresent({
      [PREFERENCES_KEY]: prefsBlob({ baseCurrency: 'USD', mode: 'dark' }),
      'gubbins:saved-searches': '{"state":{"searches":[]}}',
    });
    expect(present).toEqual(['appearance', 'regional', 'savedSearches']);
  });

  it('ignores fields no group owns', () => {
    expect(settingsGroupsPresent({ [PREFERENCES_KEY]: prefsBlob({ bridgeToken: 'shh' }) })).toEqual([]);
  });

  it('is empty for an empty record', () => {
    expect(settingsGroupsPresent({})).toEqual([]);
  });
});

describe('mergePreferencesBlob', () => {
  it('merges the incoming state over the live one, incoming winning per field', () => {
    const merged = mergePreferencesBlob(
      prefsBlob({ mode: 'dark' }),
      prefsBlob({ mode: 'light', baseCurrency: 'GBP' }),
    );
    expect(JSON.parse(merged).state).toEqual({ mode: 'dark', baseCurrency: 'GBP' });
  });

  it('takes the incoming envelope, so the store migrates from the backup’s version', () => {
    const merged = mergePreferencesBlob(prefsBlob({ mode: 'dark' }, 2), prefsBlob({ mode: 'light' }, 3));
    expect(JSON.parse(merged).version).toBe(2);
  });

  it('falls back to the incoming blob when there is nothing (readable) to merge into', () => {
    const incoming = prefsBlob({ mode: 'dark' });
    expect(mergePreferencesBlob(incoming, null)).toBe(incoming);
    expect(mergePreferencesBlob(incoming, 'not json')).toBe(incoming);
  });
});
