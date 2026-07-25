/**
 * Live settings sync — the pure seam (issue #382).
 *
 * The behaviours worth pinning are the ones a bug in would be invisible on screen: publishing a
 * value that has not changed (which re-stamps the row and restarts the #161 timestamp churn),
 * publishing a field the user never agreed to share, and adopting a value shaped wrongly enough to
 * break a screen.
 */
import { describe, it, expect } from 'vitest';
import type { SettingRow } from '@/db/repositories/types/settings';
import { PREFERENCES_KEY, LIVE_SYNCABLE_SETTINGS_GROUP_IDS } from '@/features/backup/settings-groups';
import {
  DEFAULT_LIVE_SETTINGS_SELECTION,
  decodeSettingValue,
  encodeSettingValue,
  isSharedSettingField,
  normaliseLiveSettingsSelection,
  planSettingApplies,
  planSettingPublishes,
  resolveLiveSettingsSelection,
  sameSettingShape,
  settingRowId,
  type SettingsStoreStates,
} from './settings-sync';

const APPEARANCE_ONLY = { appearance: true };
const ALL_ELIGIBLE = resolveLiveSettingsSelection(true, DEFAULT_LIVE_SETTINGS_SELECTION);

/** A `settings` row, with the timestamps a caller of these pure functions never looks at. */
function row(storeKey: string, field: string, value: unknown): SettingRow {
  return {
    id: settingRowId(storeKey, field),
    store_key: storeKey,
    field,
    value: JSON.stringify(value),
    created_at: 1,
    updated_at: 1,
  };
}

function states(overrides: Record<string, Record<string, unknown>> = {}): SettingsStoreStates {
  return {
    [PREFERENCES_KEY]: {
      mode: 'dark',
      accent: 'violet',
      lowStockQtyThreshold: 3,
      bridgeToken: '<YOUR_BRIDGE_TOKEN>',
      bridgeUrl: 'http://127.0.0.1:8787',
      settingsSyncEnabled: true,
      cardFields: { location: true, quantity: false },
      setMode: () => undefined,
      ...overrides[PREFERENCES_KEY],
    },
    'gubbins:layout': { density: 'visual', dashboardLayout: [], ...overrides['gubbins:layout'] },
    'gubbins:saved-searches': { searches: [], ...overrides['gubbins:saved-searches'] },
  };
}

describe('resolveLiveSettingsSelection', () => {
  it('shares nothing at all while the master opt-in is off', () => {
    expect(resolveLiveSettingsSelection(false, DEFAULT_LIVE_SETTINGS_SELECTION)).toEqual({});
  });

  it('keeps only the groups that are both eligible and ticked', () => {
    const resolved = resolveLiveSettingsSelection(true, { appearance: true, reports: false });
    expect(resolved).toEqual({ appearance: true });
  });

  it('refuses the device group even when the persisted selection claims it', () => {
    // The `device` group is where the bridge address and kiosk mode live: continuously overwriting
    // one machine's copy from another would be wrong every time, so it is never eligible.
    const resolved = resolveLiveSettingsSelection(true, { device: true, appearance: true });
    expect(resolved).toEqual({ appearance: true });
  });
});

describe('normaliseLiveSettingsSelection', () => {
  it('falls back to the shipped default for a value that is not an object', () => {
    expect(normaliseLiveSettingsSelection('yes')).toBe(DEFAULT_LIVE_SETTINGS_SELECTION);
    expect(normaliseLiveSettingsSelection(null)).toBe(DEFAULT_LIVE_SETTINGS_SELECTION);
  });

  it('ticks every eligible group by default and leaves the device group off', () => {
    expect(DEFAULT_LIVE_SETTINGS_SELECTION.device).toBe(false);
    for (const id of LIVE_SYNCABLE_SETTINGS_GROUP_IDS) {
      expect(DEFAULT_LIVE_SETTINGS_SELECTION[id]).toBe(true);
    }
  });

  it('forces ineligible groups off and drops unknown ids, keeping every real one present', () => {
    const normalised = normaliseLiveSettingsSelection({ device: true, appearance: true, wat: true });
    expect(normalised.device).toBe(false);
    expect(normalised.appearance).toBe(true);
    expect(normalised.reports).toBe(false); // absent from the input ⇒ not shared
    expect(Object.keys(normalised)).not.toContain('wat');
  });
});

describe('isSharedSettingField', () => {
  it('shares a preference whose group is ticked', () => {
    expect(isSharedSettingField(PREFERENCES_KEY, 'mode', APPEARANCE_ONLY)).toBe(true);
  });

  it('does not share a preference whose group is unticked', () => {
    expect(isSharedSettingField(PREFERENCES_KEY, 'lowStockQtyThreshold', APPEARANCE_ONLY)).toBe(false);
  });

  it('never shares the bridge access token, however wide the selection', () => {
    expect(isSharedSettingField(PREFERENCES_KEY, 'bridgeToken', ALL_ELIGIBLE)).toBe(false);
  });

  it('never shares a device-specific preference, however wide the selection', () => {
    expect(isSharedSettingField(PREFERENCES_KEY, 'bridgeUrl', ALL_ELIGIBLE)).toBe(false);
    expect(isSharedSettingField(PREFERENCES_KEY, 'kioskMode', ALL_ELIGIBLE)).toBe(false);
  });

  it('does not share a field no group claims (a preference from a newer build)', () => {
    expect(isSharedSettingField(PREFERENCES_KEY, 'somethingNewer', ALL_ELIGIBLE)).toBe(false);
  });

  it('shares a whole-key store through the group that owns the key', () => {
    expect(isSharedSettingField('gubbins:layout', 'density', { dashboard: true })).toBe(true);
    expect(isSharedSettingField('gubbins:layout', 'density', APPEARANCE_ONLY)).toBe(false);
  });

  it('ignores a store the registry does not describe', () => {
    expect(isSharedSettingField('gubbins:lab', 'anything', ALL_ELIGIBLE)).toBe(false);
  });
});

describe('encodeSettingValue', () => {
  it('skips a store action rather than encoding it', () => {
    expect(encodeSettingValue(() => undefined)).toBeNull();
  });

  it('skips undefined and a non-finite number', () => {
    // `JSON.stringify(NaN)` is `"null"`, which would land on the far side as a *type* change
    // rather than a lost value — so it never travels.
    expect(encodeSettingValue(undefined)).toBeNull();
    expect(encodeSettingValue(Number.NaN)).toBeNull();
    expect(encodeSettingValue(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('encodes the ordinary value kinds, and round-trips them', () => {
    for (const value of ['dark', 7, true, false, null, [1, 2], { a: 1 }]) {
      const encoded = encodeSettingValue(value);
      expect(encoded).not.toBeNull();
      expect(decodeSettingValue(encoded!)).toEqual({ ok: true, value });
    }
  });

  it('skips a cyclic value instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(encodeSettingValue(cyclic)).toBeNull();
  });
});

describe('decodeSettingValue', () => {
  it('reports a damaged row rather than throwing', () => {
    expect(decodeSettingValue('{not json')).toEqual({ ok: false });
  });
});

describe('sameSettingShape', () => {
  it('accepts a value of the same primitive type', () => {
    expect(sameSettingShape('light', 'dark')).toBe(true);
    expect(sameSettingShape(9, 3)).toBe(true);
    expect(sameSettingShape(false, true)).toBe(true);
  });

  it('rejects a type change, which is what a corrupt or hostile row looks like', () => {
    expect(sameSettingShape('3', 3)).toBe(false);
    expect(sameSettingShape(1, true)).toBe(false);
    expect(sameSettingShape({ a: 1 }, 'dark')).toBe(false);
    expect(sameSettingShape(['a'], { a: 1 })).toBe(false);
    expect(sameSettingShape(null, 'dark')).toBe(false);
  });

  it('accepts anything readable when the store currently holds null (nothing to compare)', () => {
    expect(sameSettingShape('anything', null)).toBe(true);
    expect(sameSettingShape(42, null)).toBe(true);
  });

  it('checks array elements against the reference element, and accepts any array when empty', () => {
    expect(sameSettingShape([{ id: 'a' }], [{ id: 'b' }])).toBe(true);
    expect(sameSettingShape(['a'], [{ id: 'b' }])).toBe(false);
    expect(sameSettingShape([{ anything: true }], [])).toBe(true);
  });

  it('checks only the keys the reference describes, so builds can differ either way', () => {
    // A key the reference lacks may be a preference from a newer build (keep it); a key it has but
    // the candidate lacks is filled from the store's own defaults.
    expect(sameSettingShape({ location: false, newer: 'x' }, { location: true, quantity: true })).toBe(true);
    expect(sameSettingShape({ location: 'yes' }, { location: true })).toBe(false);
  });

  it('rejects a non-finite number arriving inside an object', () => {
    expect(sameSettingShape({ hue: Number.NaN }, { hue: 277 })).toBe(false);
  });
});

describe('planSettingPublishes', () => {
  it('publishes an eligible preference that has no row yet', () => {
    expect(planSettingPublishes(states(), APPEARANCE_ONLY, [])).toEqual([
      { storeKey: PREFERENCES_KEY, field: 'mode', value: '"dark"' },
      { storeKey: PREFERENCES_KEY, field: 'accent', value: '"violet"' },
    ]);
  });

  it('publishes nothing when the row already holds the same value', () => {
    // Load-bearing, not an optimisation: the `updated_at` trigger stamps any UPDATE, so re-writing
    // an unchanged value would make this device look like the more recent editor and set the two
    // devices pushing the row back and forth (issue #161, reached from the write side).
    const existing = [row(PREFERENCES_KEY, 'mode', 'dark'), row(PREFERENCES_KEY, 'accent', 'violet')];
    expect(planSettingPublishes(states(), APPEARANCE_ONLY, existing)).toEqual([]);
  });

  it('publishes a changed value over its existing row', () => {
    const existing = [row(PREFERENCES_KEY, 'mode', 'light')];
    expect(planSettingPublishes(states(), { appearance: true }, existing)).toContainEqual({
      storeKey: PREFERENCES_KEY,
      field: 'mode',
      value: '"dark"',
    });
  });

  it('never publishes the token, a device preference, or the opt-in itself', () => {
    const published = planSettingPublishes(states(), ALL_ELIGIBLE, []).map((u) => u.field);
    expect(published).not.toContain('bridgeToken');
    expect(published).not.toContain('bridgeUrl');
    expect(published).not.toContain('settingsSyncEnabled');
  });

  it('never publishes a store action', () => {
    expect(planSettingPublishes(states(), ALL_ELIGIBLE, []).map((u) => u.field)).not.toContain('setMode');
  });

  it('publishes only the named rows when limited to them', () => {
    // The narrowing is what stops a single change republishing a *different* field whose row a peer
    // has already moved on — which would overwrite a newer value with an older one.
    const plan = planSettingPublishes(states(), ALL_ELIGIBLE, [], [settingRowId(PREFERENCES_KEY, 'mode')]);
    expect(plan).toEqual([{ storeKey: PREFERENCES_KEY, field: 'mode', value: '"dark"' }]);
  });

  it('publishes fields of the whole-key stores too', () => {
    const plan = planSettingPublishes(states(), { dashboard: true, savedSearches: true }, []);
    expect(plan).toContainEqual({ storeKey: 'gubbins:layout', field: 'density', value: '"visual"' });
    expect(plan).toContainEqual({
      storeKey: 'gubbins:saved-searches',
      field: 'searches',
      value: '[]',
    });
  });
});

describe('planSettingApplies', () => {
  it('adopts a peer value for a shared group', () => {
    const plan = planSettingApplies([row(PREFERENCES_KEY, 'mode', 'light')], states(), APPEARANCE_ONLY);
    expect(plan.patches).toEqual({ [PREFERENCES_KEY]: { mode: 'light' } });
    expect(plan.rejected).toEqual([]);
  });

  it('ignores a row whose group this device does not share', () => {
    const rows = [row(PREFERENCES_KEY, 'lowStockQtyThreshold', 9)];
    expect(planSettingApplies(rows, states(), APPEARANCE_ONLY).patches).toEqual({});
  });

  it('ignores a row that already matches, so nothing is written for nothing', () => {
    expect(
      planSettingApplies([row(PREFERENCES_KEY, 'mode', 'dark')], states(), APPEARANCE_ONLY).patches,
    ).toEqual({});
  });

  it('rejects a row whose value is shaped wrongly, and reports which', () => {
    const rows = [row(PREFERENCES_KEY, 'mode', { deeply: 'wrong' })];
    const plan = planSettingApplies(rows, states(), APPEARANCE_ONLY);
    expect(plan.patches).toEqual({});
    expect(plan.rejected).toEqual([settingRowId(PREFERENCES_KEY, 'mode')]);
  });

  it('rejects a damaged row rather than applying rubbish', () => {
    const damaged: SettingRow = { ...row(PREFERENCES_KEY, 'mode', 'light'), value: '{{{' };
    const plan = planSettingApplies([damaged], states(), APPEARANCE_ONLY);
    expect(plan.patches).toEqual({});
    expect(plan.rejected).toEqual([damaged.id]);
  });

  it('groups patches by store, so each store is written once', () => {
    const rows = [
      row(PREFERENCES_KEY, 'mode', 'light'),
      row(PREFERENCES_KEY, 'accent', 'amber'),
      row('gubbins:layout', 'density', 'data'),
    ];
    const plan = planSettingApplies(rows, states(), { appearance: true, dashboard: true });
    expect(plan.patches).toEqual({
      [PREFERENCES_KEY]: { mode: 'light', accent: 'amber' },
      'gubbins:layout': { density: 'data' },
    });
  });

  it('ignores a row naming a store this build does not know', () => {
    const rows = [row('gubbins:layout', 'density', 'data')];
    const withoutLayout = { [PREFERENCES_KEY]: states()[PREFERENCES_KEY]! };
    expect(planSettingApplies(rows, withoutLayout, { dashboard: true }).patches).toEqual({});
  });

  it('adopts an object-valued preference by deep value, not by reference', () => {
    const identical = [row(PREFERENCES_KEY, 'cardFields', { location: true, quantity: false })];
    expect(planSettingApplies(identical, states(), { cards: true }).patches).toEqual({});

    const changed = [row(PREFERENCES_KEY, 'cardFields', { location: false, quantity: false })];
    expect(planSettingApplies(changed, states(), { cards: true }).patches).toEqual({
      [PREFERENCES_KEY]: { cardFields: { location: false, quantity: false } },
    });
  });
});
