import { describe, expect, it } from 'vitest';
import { FEATURE_REGISTRY, type FeatureId } from '@/features/modules/feature-registry';
import {
  HIDEABLE_CAPABILITIES,
  HIDEABLE_CAPABILITY_IDS,
  hidesAnyCapability,
  isCapabilityVisible,
  toggleHiddenCapability,
  toHiddenCapabilitySet,
} from './category-capabilities';

const setOf = (...ids: FeatureId[]): ReadonlySet<FeatureId> => new Set(ids);
/** Every capability enabled — the default device, where nothing is switched off. */
const ALL_ENABLED: ReadonlySet<FeatureId> = new Set(FEATURE_REGISTRY.map((f) => f.id));

describe('HIDEABLE_CAPABILITY_IDS', () => {
  it('only names ids that are real, optional capabilities in the registry', () => {
    for (const id of HIDEABLE_CAPABILITY_IDS) {
      const def = FEATURE_REGISTRY.find((f) => f.id === id);
      expect(def, `${id} is not registered`).toBeDefined();
      expect(def!.kind, `${id} is not a capability`).toBe('capability');
      expect(def!.alwaysOn, `${id} is always-on and could never be hidden`).toBeFalsy();
    }
  });

  it('excludes the workflow/device capabilities a category has no business hiding', () => {
    // Hiding these would either be meaningless (a Movie is no less scannable than a drill) or
    // would imply a behavioural promise this presentation-only feature does not make.
    for (const id of ['scanner', 'nfc', 'labels', 'scraping', 'cycle-counts', 'sales'] as const) {
      expect(HIDEABLE_CAPABILITY_IDS).not.toContain(id);
    }
  });

  it('resolves every id to a registry definition for the picker', () => {
    expect(HIDEABLE_CAPABILITIES).toHaveLength(HIDEABLE_CAPABILITY_IDS.length);
    for (const def of HIDEABLE_CAPABILITIES) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });
});

describe('toHiddenCapabilitySet', () => {
  it('reads null, undefined and empty as nothing hidden', () => {
    expect(toHiddenCapabilitySet(null).size).toBe(0);
    expect(toHiddenCapabilitySet(undefined).size).toBe(0);
    expect(toHiddenCapabilitySet([]).size).toBe(0);
  });

  it('keeps ids this build recognises as hideable', () => {
    expect([...toHiddenCapabilitySet(['maintenance', 'warranty'])].sort()).toEqual([
      'maintenance',
      'warranty',
    ]);
  });

  it('ignores ids this build does not recognise, rather than throwing', () => {
    // A peer on a newer version may hide a capability that does not exist here yet. Storage
    // keeps it verbatim; this boundary simply gives it no effect on what we render.
    expect([...toHiddenCapabilitySet(['maintenance', 'time-travel'])]).toEqual(['maintenance']);
  });

  it('ignores real features that are not hideable, so the allow-list is enforced here too', () => {
    // `projects` is a page and `scanner` a deliberately-excluded capability. Neither may take
    // effect just because something managed to write it into the column.
    expect(toHiddenCapabilitySet(['projects', 'scanner']).size).toBe(0);
  });
});

describe('isCapabilityVisible', () => {
  it('always shows an ungated section', () => {
    expect(isCapabilityVisible(undefined, new Set(), setOf('maintenance'), false)).toBe('visible');
  });

  it('shows a gated section the category does not hide', () => {
    expect(isCapabilityVisible('maintenance', ALL_ENABLED, new Set(), false)).toBe('visible');
  });

  it('hides a section whose category hides it and which holds no data', () => {
    expect(isCapabilityVisible('maintenance', ALL_ENABLED, setOf('maintenance'), false)).toBe('hidden');
  });

  it('shows a hidden section that holds data, flagged so the UI can explain why', () => {
    expect(isCapabilityVisible('maintenance', ALL_ENABLED, setOf('maintenance'), true)).toBe(
      'shown-despite-hidden',
    );
  });

  it('lets the device module win even when the section holds data', () => {
    // Modular UI stays the last word on what this device shows; the data is untouched and
    // returns the moment the module is switched back on.
    expect(isCapabilityVisible('maintenance', new Set(), setOf('maintenance'), true)).toBe('hidden');
    expect(isCapabilityVisible('maintenance', new Set(), new Set(), true)).toBe('hidden');
  });

  it('never lets a category re-enable what the device has switched off', () => {
    // The narrowing invariant: there is no combination of category state that turns a
    // device-disabled capability back on.
    for (const hidden of [new Set<FeatureId>(), setOf('maintenance')]) {
      for (const hasData of [false, true]) {
        expect(isCapabilityVisible('maintenance', new Set(), hidden, hasData)).toBe('hidden');
      }
    }
  });
});

describe('hidesAnyCapability', () => {
  it('is false for nothing hidden, and for ids that have no effect here', () => {
    expect(hidesAnyCapability(null)).toBe(false);
    expect(hidesAnyCapability([])).toBe(false);
    expect(hidesAnyCapability(['time-travel', 'scanner'])).toBe(false);
  });

  it('is true as soon as one recognised capability is hidden', () => {
    expect(hidesAnyCapability(['maintenance'])).toBe(true);
  });
});

describe('toggleHiddenCapability', () => {
  it('adds and removes an id', () => {
    expect(toggleHiddenCapability([], 'maintenance', true)).toEqual(['maintenance']);
    expect(toggleHiddenCapability(['maintenance'], 'maintenance', false)).toEqual([]);
  });

  it('is idempotent, so a repeated toggle cannot duplicate an id', () => {
    expect(toggleHiddenCapability(['maintenance'], 'maintenance', true)).toEqual(['maintenance']);
  });

  it('round-trips to the identical array, so a no-op edit cannot churn the synced row', () => {
    const start = ['kits', 'maintenance', 'warranty'];
    const off = toggleHiddenCapability(start, 'maintenance', false);
    expect(toggleHiddenCapability(off, 'maintenance', true)).toEqual(start);
  });

  it('preserves ids it does not recognise, so a newer peer keeps its choice', () => {
    expect(toggleHiddenCapability(['time-travel'], 'kits', true)).toEqual(['kits', 'time-travel']);
  });
});
