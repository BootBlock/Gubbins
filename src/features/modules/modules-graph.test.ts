import { describe, expect, it } from 'vitest';
import {
  ALL_FEATURE_IDS,
  FEATURE_GROUP_ORDER,
  FEATURE_REGISTRY,
  OPTIONAL_FEATURE_IDS,
  getFeature,
  type FeatureDef,
  type FeatureId,
} from './feature-registry';
import {
  closureToDisable,
  closureToEnable,
  dependenciesOf,
  dependentsOf,
  findDependencyCycle,
  isFeatureEnabled,
  resolveEnabled,
  type FeatureIntent,
} from './modules-graph';
import { PRESETS } from './presets';
import { NAV_DESTINATIONS } from '@/components/nav/nav-destinations';
import { PackageIcon } from '@/components/icons';

/**
 * A small synthetic registry for exercising the pure graph maths in isolation, so the
 * resolution/closure assertions don't drift when the real registry gains features:
 *
 *   core (alwaysOn)
 *   a  →  (no deps)
 *   b  →  a
 *   c  →  b          (transitive: c depends on b depends on a)
 *   d  →  a          (a second dependent of a)
 */
const F = (id: string, dependsOn?: string[], alwaysOn?: boolean): FeatureDef => ({
  id: id as FeatureId,
  kind: 'capability',
  label: id,
  description: id,
  Icon: PackageIcon,
  group: 'capabilities',
  ...(dependsOn ? { dependsOn: dependsOn as FeatureId[] } : {}),
  ...(alwaysOn ? { alwaysOn: true } : {}),
});

const TEST_REGISTRY: readonly FeatureDef[] = [
  F('core', undefined, true),
  F('a'),
  F('b', ['a']),
  F('c', ['b']),
  F('d', ['a']),
];

const ids = (set: ReadonlySet<FeatureId>) => [...set].sort();

describe('resolveEnabled — effective resolution', () => {
  it('treats a missing intent key as on (default everything-on)', () => {
    const enabled = resolveEnabled({}, TEST_REGISTRY);
    expect(ids(enabled)).toEqual(['a', 'b', 'c', 'core', 'd']);
  });

  it('keeps core (alwaysOn) enabled even when intent explicitly turns it off', () => {
    const enabled = resolveEnabled({ core: false }, TEST_REGISTRY);
    expect(enabled.has('core' as FeatureId)).toBe(true);
  });

  it('turning a feature off does not touch its independent siblings', () => {
    const enabled = resolveEnabled({ d: false }, TEST_REGISTRY);
    expect(ids(enabled)).toEqual(['a', 'b', 'c', 'core']);
  });

  it('cascades: a child whose dependency is off resolves off without a stored key', () => {
    // `a` off ⇒ b (needs a) and c (needs b) both fall, but d also needs a so it falls too.
    const enabled = resolveEnabled({ a: false }, TEST_REGISTRY);
    expect(ids(enabled)).toEqual(['core']);
  });

  it('restores a child to its own intent when the parent comes back on', () => {
    // b explicitly off, but a on: b stays off (own intent) while c (needs b) also falls.
    const enabled = resolveEnabled({ b: false }, TEST_REGISTRY);
    expect(ids(enabled)).toEqual(['a', 'core', 'd']);
    // Flip b's parent-chain back to default and b returns; its intent was never mutated.
    const restored = resolveEnabled({}, TEST_REGISTRY);
    expect(restored.has('b' as FeatureId)).toBe(true);
  });

  it('isFeatureEnabled matches membership of the resolved set', () => {
    const intent: FeatureIntent = { a: false };
    expect(isFeatureEnabled('c', intent, TEST_REGISTRY)).toBe(false);
    expect(isFeatureEnabled('core', intent, TEST_REGISTRY)).toBe(true);
  });
});

describe('dependentsOf / dependenciesOf — transitive edges', () => {
  it('lists every transitive dependent of a feature', () => {
    // a is depended on by b, d directly and c transitively (c → b → a).
    expect(ids(dependentsOf('a', TEST_REGISTRY))).toEqual(['b', 'c', 'd']);
    expect(ids(dependentsOf('b', TEST_REGISTRY))).toEqual(['c']);
    expect(ids(dependentsOf('c', TEST_REGISTRY))).toEqual([]);
  });

  it('lists every transitive dependency of a feature', () => {
    expect(ids(dependenciesOf('c', TEST_REGISTRY))).toEqual(['a', 'b']);
    expect(ids(dependenciesOf('a', TEST_REGISTRY))).toEqual([]);
  });

  it('reflects the real registry edges (purchase-orders/bookings → contacts)', () => {
    expect(dependenciesOf('purchase-orders', FEATURE_REGISTRY).has('contacts')).toBe(true);
    expect(dependenciesOf('bookings', FEATURE_REGISTRY).has('contacts')).toBe(true);
    expect(ids(dependentsOf('contacts', FEATURE_REGISTRY))).toEqual(['bookings', 'purchase-orders']);
  });
});

describe('closureToDisable / closureToEnable — confirmation copy', () => {
  it('disable closure = the feature plus its currently-effective dependents', () => {
    // Everything on: turning a off would also hide b, c, d.
    expect(ids(closureToDisable('a', {}, TEST_REGISTRY))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('disable closure omits dependents that are already off', () => {
    // c already off (own intent): turning b off only additionally hides b itself.
    expect(ids(closureToDisable('b', { c: false }, TEST_REGISTRY))).toEqual(['b']);
  });

  it('enable closure = the feature plus its currently-off dependencies', () => {
    // a and b are off; enabling c must also switch a and b on.
    const intent: FeatureIntent = { a: false, b: false, c: false };
    expect(ids(closureToEnable('c', intent, TEST_REGISTRY))).toEqual(['a', 'b', 'c']);
  });

  it('enable closure omits dependencies that are already on', () => {
    // Only b is off; enabling c needs just b (a is already on).
    const intent: FeatureIntent = { b: false, c: false };
    expect(ids(closureToEnable('c', intent, TEST_REGISTRY))).toEqual(['b', 'c']);
  });

  it('reflects the real registry (disabling contacts also hides its dependents)', () => {
    expect(ids(closureToDisable('contacts', {}, FEATURE_REGISTRY))).toEqual([
      'bookings',
      'contacts',
      'purchase-orders',
    ]);
    // Enabling purchase-orders while contacts is off also pulls contacts on.
    expect(ids(closureToEnable('purchase-orders', { contacts: false }, FEATURE_REGISTRY))).toEqual([
      'contacts',
      'purchase-orders',
    ]);
  });
});

describe('findDependencyCycle', () => {
  it('returns null for an acyclic graph', () => {
    expect(findDependencyCycle(TEST_REGISTRY)).toBeNull();
  });

  it('detects a cycle when one is present', () => {
    const cyclic: FeatureDef[] = [F('x', ['y']), F('y', ['x'])];
    expect(findDependencyCycle(cyclic)).not.toBeNull();
  });
});

describe('registry integrity', () => {
  it('has a unique id for every feature (full FeatureId coverage is a compile-time guarantee)', () => {
    // FEATURE_DEFS is typed `Record<FeatureId, FeatureDef>`, so tsc already forces every
    // declared FeatureId to have exactly one definition — a missing/typo'd id won't compile.
    // This runtime check guards the remaining property: no duplicate ids leak into the array.
    const seen = new Set(FEATURE_REGISTRY.map((f) => f.id));
    expect(seen.size).toBe(FEATURE_REGISTRY.length);
    expect([...seen].sort()).toEqual([...ALL_FEATURE_IDS].sort());
  });

  it('is acyclic', () => {
    expect(findDependencyCycle(FEATURE_REGISTRY)).toBeNull();
  });

  it('references only registered ids in every dependsOn edge', () => {
    for (const feature of FEATURE_REGISTRY) {
      for (const dep of feature.dependsOn ?? []) {
        expect(getFeature(dep), `${feature.id} depends on unknown ${dep}`).toBeDefined();
      }
    }
  });

  it('never lists a dependency on a core (alwaysOn) feature (pointless — always on)', () => {
    for (const feature of FEATURE_REGISTRY) {
      for (const dep of feature.dependsOn ?? []) {
        expect(getFeature(dep)?.alwaysOn ?? false).toBe(false);
      }
    }
  });

  it('gives every page feature a route and every capability none', () => {
    for (const feature of FEATURE_REGISTRY) {
      if (feature.kind === 'page') expect(feature.route, feature.id).toBeDefined();
      else expect(feature.route, feature.id).toBeUndefined();
    }
  });

  it('uses only a valid AppRoutePath for every page route', () => {
    const validRoutes = new Set(NAV_DESTINATIONS.map((d) => d.to));
    for (const feature of FEATURE_REGISTRY) {
      if (feature.route) expect(validRoutes.has(feature.route), feature.route).toBe(true);
    }
  });

  it('maps every NAV_DESTINATIONS entry to exactly one registered feature by route', () => {
    for (const dest of NAV_DESTINATIONS) {
      const matches = FEATURE_REGISTRY.filter((f) => f.route === dest.to);
      expect(matches.length, `nav route ${dest.to}`).toBe(1);
    }
  });

  it('annotates every NAV_DESTINATIONS entry with the feature whose route it maps to', () => {
    // Phase 2 gates the nav surfaces by `dest.feature`; this keeps that annotation from
    // drifting from the registry (which stays the SSOT for the route↔feature pairing).
    for (const dest of NAV_DESTINATIONS) {
      const feature = getFeature(dest.feature);
      expect(feature, `nav entry ${dest.to} references unknown feature ${dest.feature}`).toBeDefined();
      expect(feature?.route, `nav entry ${dest.to} / feature ${dest.feature}`).toBe(dest.to);
    }
  });

  it('assigns every feature a group in FEATURE_GROUP_ORDER', () => {
    const validGroups = new Set(FEATURE_GROUP_ORDER);
    for (const feature of FEATURE_REGISTRY) {
      expect(validGroups.has(feature.group), feature.id).toBe(true);
    }
  });

  it('marks exactly the four core features alwaysOn', () => {
    const core = FEATURE_REGISTRY.filter((f) => f.alwaysOn)
      .map((f) => f.id)
      .sort();
    expect(core).toEqual(['about', 'dashboard', 'inventory', 'settings']);
  });

  it('derives OPTIONAL_FEATURE_IDS as every non-core id', () => {
    expect([...OPTIONAL_FEATURE_IDS].sort()).toEqual(
      FEATURE_REGISTRY.filter((f) => !f.alwaysOn)
        .map((f) => f.id)
        .sort(),
    );
  });
});

describe('preset integrity', () => {
  it('references only optional (never core) feature ids', () => {
    const optional = new Set(OPTIONAL_FEATURE_IDS);
    for (const preset of PRESETS) {
      for (const id of preset.featureIds) {
        expect(optional.has(id), `${preset.id} lists ${id}`).toBe(true);
      }
    }
  });

  it('has a unique id per preset', () => {
    const ids2 = PRESETS.map((p) => p.id);
    expect(new Set(ids2).size).toBe(ids2.length);
  });

  it('everything = all optional features, minimal = none', () => {
    const everything = PRESETS.find((p) => p.id === 'everything')!;
    const minimal = PRESETS.find((p) => p.id === 'minimal')!;
    expect([...everything.featureIds].sort()).toEqual([...OPTIONAL_FEATURE_IDS].sort());
    expect(minimal.featureIds).toEqual([]);
  });

  it('resolves each preset to a self-consistent set (listed features stay enabled)', () => {
    const intentFrom = (enabled: readonly FeatureId[]) => {
      const on = new Set(enabled);
      return Object.fromEntries(OPTIONAL_FEATURE_IDS.map((id) => [id, on.has(id)]));
    };
    for (const preset of PRESETS) {
      const enabled = resolveEnabled(intentFrom(preset.featureIds), FEATURE_REGISTRY);
      // Every explicitly-listed feature must survive resolution — i.e. presets never list a
      // feature while omitting one of its dependencies.
      for (const id of preset.featureIds) {
        expect(enabled.has(id), `${preset.id}: ${id} dropped by resolution`).toBe(true);
      }
    }
  });
});
