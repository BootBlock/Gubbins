import { beforeEach, describe, expect, it } from 'vitest';
import { useModulesStore } from './useModulesStore';
import { FEATURE_REGISTRY, OPTIONAL_FEATURE_IDS, type FeatureId } from '@/features/modules/feature-registry';
import { PRESETS, getPreset } from '@/features/modules/presets';
import { resolveEnabled } from '@/features/modules/modules-graph';

/** Read the store's current snapshot outside React. */
const state = () => useModulesStore.getState();

beforeEach(() => {
  // Reset to the pristine default so persisted state can't leak between cases.
  useModulesStore.setState({ intent: {}, firstRunComplete: false });
});

describe('useModulesStore — defaults', () => {
  it('starts with no intent overrides and first-run incomplete', () => {
    expect(state().intent).toEqual({});
    expect(state().firstRunComplete).toBe(false);
  });

  it('resolves everything on when no intent is stored (missing key ⇒ on)', () => {
    const enabled = resolveEnabled(state().intent, FEATURE_REGISTRY);
    // Every feature bar the opt-in ones, which read as *off* until deliberately chosen — see
    // `FeatureDef.defaultOff`. Asserted against the registry rather than a hard-coded count so
    // adding a feature of either kind keeps this honest.
    const expected = FEATURE_REGISTRY.filter((f) => !f.defaultOff);
    expect([...enabled].sort()).toEqual(expected.map((f) => f.id).sort());
  });

  it('leaves an opt-in feature off until it is explicitly turned on', () => {
    const optIn = FEATURE_REGISTRY.filter((f) => f.defaultOff);
    expect(optIn.length).toBeGreaterThan(0);
    for (const feature of optIn) {
      expect(resolveEnabled({}, FEATURE_REGISTRY).has(feature.id)).toBe(false);
      expect(resolveEnabled({ [feature.id]: true }, FEATURE_REGISTRY).has(feature.id)).toBe(true);
    }
  });
});

describe('setFeatureIntent', () => {
  it('records a single choice without touching other keys', () => {
    state().setFeatureIntent('projects', false);
    expect(state().intent).toEqual({ projects: false });
    state().setFeatureIntent('reports', false);
    expect(state().intent).toEqual({ projects: false, reports: false });
  });

  it('turning a feature back on flips only its own key', () => {
    state().setFeatureIntent('projects', false);
    state().setFeatureIntent('projects', true);
    expect(state().intent.projects).toBe(true);
  });

  it('does not cascade — dependents fall only at resolution time', () => {
    // Turning contacts off leaves purchase-orders' own intent untouched in storage…
    state().setFeatureIntent('contacts', false);
    expect(state().intent).toEqual({ contacts: false });
    // …but resolution hides its dependents.
    const enabled = resolveEnabled(state().intent, FEATURE_REGISTRY);
    expect(enabled.has('contacts' as FeatureId)).toBe(false);
    expect(enabled.has('purchase-orders' as FeatureId)).toBe(false);
    expect(enabled.has('bookings' as FeatureId)).toBe(false);
  });
});

describe('applyPreset', () => {
  it('sets listed optional features on and every other optional feature off', () => {
    state().applyPreset('minimal');
    const intent = state().intent;
    // Every optional feature has an explicit entry, all false.
    expect(Object.keys(intent).sort()).toEqual([...OPTIONAL_FEATURE_IDS].sort());
    expect(Object.values(intent).every((v) => v === false)).toBe(true);
  });

  it.each(PRESETS.map((p) => p.id))(
    'applying "%s" enables exactly its declared features (plus dependencies)',
    (presetId) => {
      state().applyPreset(presetId);
      const preset = getPreset(presetId)!;
      const enabled = resolveEnabled(state().intent, FEATURE_REGISTRY);
      for (const id of preset.featureIds) {
        expect(enabled.has(id), `${id} should be enabled`).toBe(true);
      }
    },
  );

  it('home-hobby leaves an unlisted optional feature off', () => {
    state().applyPreset('home-hobby');
    const enabled = resolveEnabled(state().intent, FEATURE_REGISTRY);
    expect(enabled.has('projects' as FeatureId)).toBe(false);
  });

  it('always keeps core features on regardless of preset', () => {
    state().applyPreset('minimal');
    const enabled = resolveEnabled(state().intent, FEATURE_REGISTRY);
    for (const id of ['dashboard', 'inventory', 'settings', 'about'] as FeatureId[]) {
      expect(enabled.has(id), id).toBe(true);
    }
  });

  it('ignores an unknown preset id, leaving intent untouched', () => {
    state().setFeatureIntent('projects', false);
    // @ts-expect-error — deliberately passing an unregistered preset id.
    state().applyPreset('does-not-exist');
    expect(state().intent).toEqual({ projects: false });
  });
});

describe('resetToEverything', () => {
  it('clears every override back to default-on', () => {
    state().applyPreset('minimal');
    state().resetToEverything();
    expect(state().intent).toEqual({});
    const enabled = resolveEnabled(state().intent, FEATURE_REGISTRY);
    // "Reset" returns to the *default*, which for an opt-in feature is off — resetting must not
    // quietly switch sign-in on.
    expect([...enabled].sort()).toEqual(
      FEATURE_REGISTRY.filter((f) => !f.defaultOff)
        .map((f) => f.id)
        .sort(),
    );
  });
});

describe('completeFirstRun', () => {
  it('flips the first-run flag and leaves intent alone', () => {
    state().setFeatureIntent('projects', false);
    state().completeFirstRun();
    expect(state().firstRunComplete).toBe(true);
    expect(state().intent).toEqual({ projects: false });
  });
});
