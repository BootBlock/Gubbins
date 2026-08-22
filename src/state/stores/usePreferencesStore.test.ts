import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTACHMENT_MODE,
  DEFAULT_SCRAPE_NOTIFICATIONS,
  normaliseAttachmentMode,
  normaliseScrapeNotifications,
  resetPreferenceFields,
  usePreferencesStore,
} from './usePreferencesStore';
import { DEFAULT_ITEMS_PER_PAGE, PAGE_SIZE_BOUNDS } from '@/features/settings/settings';
import { DEFAULT_SCANNER_SYMBOLOGY } from '@/features/scanner/scanner-formats';
import { DEFAULT_WEIGHT_UNIT } from '@/lib/weight';
import { DEFAULT_ANIMATION_LEVEL } from '@/features/settings/theme-registry';
import { DEFAULT_CURRENCY, DEFAULT_LOCALE } from '@/lib/format';
import { normaliseLiveSettingsSelection } from '@/features/settings/settings-sync';

/**
 * The store as it is *before* anything is rehydrated — the shipped defaults, captured once at
 * module load (localStorage is empty then), so every assertion below compares against the same
 * source of truth the store itself declares.
 */
const DEFAULTS = { ...usePreferencesStore.getInitialState() };

/** Just the persisted half — the data fields, without the setters. */
function dataFields(state: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).filter(([, v]) => typeof v !== 'function'));
}

const state = () => usePreferencesStore.getState();

/**
 * Seed `localStorage` with a persisted payload and replay zustand's rehydration, which is where
 * an untyped `JSON.parse` result would otherwise reach the store verbatim. `version` defaults to
 * the store's current one so `migrate` stays out of the way unless a test wants it.
 */
function rehydrateFrom(persisted: unknown, version = 3): void {
  localStorage.setItem('gubbins:preferences', JSON.stringify({ state: persisted, version }));
  void usePreferencesStore.persist.rehydrate();
}

beforeEach(() => {
  localStorage.clear();
  usePreferencesStore.setState(DEFAULTS, true);
});

describe('normaliseAttachmentMode / normaliseScrapeNotifications', () => {
  it('keeps a live union member', () => {
    expect(normaliseAttachmentMode('HYBRID')).toBe('HYBRID');
    expect(normaliseScrapeNotifications('SILENT')).toBe('SILENT');
  });

  it.each([['hybrid'], [''], [undefined], [null], [0], [{}], [['HYBRID']]])(
    'falls back to the default for %p',
    (value) => {
      expect(normaliseAttachmentMode(value)).toBe(DEFAULT_ATTACHMENT_MODE);
      expect(normaliseScrapeNotifications(value)).toBe(DEFAULT_SCRAPE_NOTIFICATIONS);
    },
  );
});

describe('usePreferencesStore — rehydration', () => {
  it('keeps a persisted state that is entirely valid', () => {
    rehydrateFrom({
      weightUnit: 'kg',
      defaultPageSize: 25,
      scannerSymbology: 'ean_13',
      mode: 'light',
      accent: 'amber',
      baseCurrency: 'EUR',
      locale: 'de-DE',
      kioskMode: true,
      brandTagline: 'Workshop stores',
      lastArchivedAt: 1_700_000_000_000,
    });
    expect(state().weightUnit).toBe('kg');
    expect(state().defaultPageSize).toBe(25);
    expect(state().scannerSymbology).toBe('ean_13');
    expect(state().mode).toBe('light');
    expect(state().accent).toBe('amber');
    expect(state().baseCurrency).toBe('EUR');
    expect(state().locale).toBe('de-DE');
    expect(state().kioskMode).toBe(true);
    expect(state().brandTagline).toBe('Workshop stores');
    expect(state().lastArchivedAt).toBe(1_700_000_000_000);
  });

  it('rejects the hand-edited payload the defaults are supposed to be safe against', () => {
    // A unit outside the union, a page size below the floor, and a symbology that isn't a
    // string at all — each typed as its narrow union by the store's declaration alone.
    rehydrateFrom({ weightUnit: 'stones', defaultPageSize: -5, scannerSymbology: 42 });
    expect(state().weightUnit).toBe(DEFAULT_WEIGHT_UNIT);
    // A number that is merely out of range is clamped into it, not thrown away.
    expect(state().defaultPageSize).toBe(PAGE_SIZE_BOUNDS.min);
    expect(state().scannerSymbology).toBe(DEFAULT_SCANNER_SYMBOLOGY);
  });

  it('falls back to the default page size when the stored value is not a number', () => {
    rehydrateFrom({ defaultPageSize: 'lots' });
    expect(state().defaultPageSize).toBe(DEFAULT_ITEMS_PER_PAGE);
  });

  it('replaces a locale and currency Intl would throw on', () => {
    // `makeFormatters` builds its Intl.*Format objects eagerly and without a guard, so a bad
    // value here is a crash on the first render that formats anything — not a cosmetic slip.
    rehydrateFrom({ locale: 42, baseCurrency: 'not-a-code' });
    expect(state().locale).toBe(DEFAULT_LOCALE);
    // Back to the first-run guess this install started on, not blindly to GBP.
    expect(state().baseCurrency).toBe(DEFAULTS.baseCurrency);
    expect(
      () => new Intl.NumberFormat(state().locale, { style: 'currency', currency: state().baseCurrency }),
    ).not.toThrow();
  });

  it('does not take a non-boolean as a toggle state', () => {
    rehydrateFrom({ kioskMode: 'true', scannerBeep: 0, catalogueRunningHeader: null });
    expect(state().kioskMode).toBe(false);
    expect(state().scannerBeep).toBe(true);
    expect(state().catalogueRunningHeader).toBe(true);
  });

  it('replaces a non-array card-field config and a non-object map', () => {
    rehydrateFrom({ cardFields: { location: true }, navCountMetrics: 'active', reminderKinds: [] });
    expect(state().cardFields).toEqual(DEFAULTS.cardFields);
    expect(state().navCountMetrics).toEqual(DEFAULTS.navCountMetrics);
    expect(state().reminderKinds).toEqual(DEFAULTS.reminderKinds);
  });

  it('reads a corrupt timestamp as "never recorded" rather than a nonsense date', () => {
    rehydrateFrom({ lastArchivedAt: 'yesterday', archiveNudgeSnoozedUntil: Number.NaN });
    expect(state().lastArchivedAt).toBeNull();
    expect(state().archiveNudgeSnoozedUntil).toBeNull();
  });

  it('survives a payload that is not an object at all', () => {
    rehydrateFrom('corrupt');
    expect(dataFields(state())).toEqual(dataFields(DEFAULTS));
  });

  it('leaves the store actions intact after rehydrating', () => {
    rehydrateFrom({ weightUnit: 'stones' });
    state().setWeightUnit('lb');
    expect(state().weightUnit).toBe('lb');
  });

  it('lands on the shipped defaults when every field is garbage', () => {
    const garbage = Object.fromEntries(
      Object.keys(dataFields(DEFAULTS)).map((key) => [key, { notAValidValueForAnyField: true }]),
    );
    rehydrateFrom(garbage);
    const reconciled = dataFields(state());
    // `settingsSyncGroups` is the one field a garbage *object* doesn't restore to its default,
    // and deliberately: an unrecognised group id is dropped rather than trusted, so a payload
    // naming none of the real groups shares nothing. Asserted explicitly instead of exempted.
    expect(reconciled.settingsSyncGroups).toEqual(normaliseLiveSettingsSelection({}));
    delete reconciled.settingsSyncGroups;
    const defaults = dataFields(DEFAULTS);
    delete defaults.settingsSyncGroups;
    expect(reconciled).toEqual(defaults);
  });

  /**
   * The drift guard. `merge` spreads `current` and then names each field explicitly, so a field
   * it *omits* is not passed through — it silently keeps the default and the user's stored value
   * is dropped on every reload. A garbage payload cannot see that (the omitted field lands on the
   * default either way), so this seeds every field with its own valid value over a store whose
   * fields all hold a sentinel: anything still holding the sentinel afterwards was never
   * reconciled, and is named in the failure.
   */
  it('reconciles every persisted field — a field missing from the merge is caught here', () => {
    const persistedDefaults = dataFields(DEFAULTS);
    const SENTINEL = '__never-reconciled__';
    usePreferencesStore.setState(
      Object.fromEntries(Object.keys(persistedDefaults).map((key) => [key, SENTINEL])) as never,
    );

    rehydrateFrom(persistedDefaults);

    const unreconciled = Object.entries(dataFields(state()))
      .filter(([, value]) => value === SENTINEL)
      .map(([key]) => key);
    expect(unreconciled).toEqual([]);
    // …and a valid stored value survives the round trip rather than being reset.
    expect(dataFields(state())).toEqual(persistedDefaults);
  });
});

describe('usePreferencesStore — migration still runs before the merge', () => {
  it('derives the animation level for a pre-v2 install', () => {
    rehydrateFrom({ reduceEffects: true }, 0);
    expect(state().animationLevel).toBe('calm');
  });

  it('remaps a v2 install onto the final scale', () => {
    rehydrateFrom({ animationLevel: 'full' }, 2);
    expect(state().animationLevel).toBe('headache');
  });

  it('still reconciles a migrated field the migration could not fix', () => {
    // v2 remaps only the ids it knows; anything else has to be caught by the merge.
    rehydrateFrom({ animationLevel: 'sparkly' }, 2);
    expect(state().animationLevel).toBe(DEFAULT_ANIMATION_LEVEL);
  });
});

describe('usePreferencesStore — setters', () => {
  it('rejects an out-of-union value handed in at runtime', () => {
    state().setAttachmentMode('LOCAL_ONLY' as never);
    expect(state().attachmentMode).toBe(DEFAULT_ATTACHMENT_MODE);
    state().setScrapeNotifications('SHOUT' as never);
    expect(state().scrapeNotifications).toBe(DEFAULT_SCRAPE_NOTIFICATIONS);
  });

  it('normalises a currency code the formatter could not build', () => {
    state().setBaseCurrency('eur');
    expect(state().baseCurrency).toBe('EUR');
    state().setBaseCurrency('nonsense');
    expect(state().baseCurrency).toBe(DEFAULT_CURRENCY);
  });
});

describe('resetPreferenceFields (issue #521)', () => {
  it('returns just the named fields to their defaults, leaving the rest untouched', () => {
    state().setBridgeToken('example-bridge-token');
    state().setBridgeUrl('http://127.0.0.1:8787');
    state().setKioskMode(true);

    resetPreferenceFields(['bridgeToken']);

    expect(state().bridgeToken).toBe(DEFAULTS.bridgeToken);
    // The address is not a secret and the next person needs it, so it must survive.
    expect(state().bridgeUrl).toBe('http://127.0.0.1:8787');
    expect(state().kioskMode).toBe(true);
  });

  it('ignores a field name the store does not have, rather than blanking anything', () => {
    state().setBridgeToken('example-bridge-token');

    resetPreferenceFields(['fieldFromAnOlderBuild']);

    expect(state().bridgeToken).toBe('example-bridge-token');
    expect('fieldFromAnOlderBuild' in state()).toBe(false);
  });

  it('does not touch the store at all when no named field is a resettable one', () => {
    // Not merely "the action survives" — assigning an action its own value would leave that
    // assertion green. What must not happen is a write: it would re-persist the whole blob, and
    // the Danger Zone relies on a field reset provoking exactly one, controllable write.
    const writes: unknown[] = [];
    const unsubscribe = usePreferencesStore.subscribe((next) => writes.push(next));
    try {
      resetPreferenceFields(['setBridgeToken', 'fieldFromAnOlderBuild']);
    } finally {
      unsubscribe();
    }

    expect(writes).toEqual([]);
  });
});
