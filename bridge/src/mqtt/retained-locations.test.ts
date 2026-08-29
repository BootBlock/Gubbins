/**
 * Persisted retained-topic bookkeeping tests (issue #565) — pure. Assert what a record from a
 * previous run means for the run that reads it: the diff baseline it restores, the abandoned topics
 * it hands over to be blanked, and the ways a file is rejected rather than half-trusted.
 */
import { describe, expect, it } from 'vitest';
import {
  parseRetainedLocations,
  planRetainedRestore,
  RETAINED_LOCATIONS_VERSION,
  serialiseRetainedLocations,
  type RetainedLocationsRecord,
} from './retained-locations.ts';

const SCOPE = { prefix: 'gubbins', discoveryPrefix: 'homeassistant', discovery: true };

const record = (overrides: Partial<RetainedLocationsRecord> = {}): RetainedLocationsRecord => ({
  version: RETAINED_LOCATIONS_VERSION,
  prefix: 'gubbins',
  discoveryPrefix: 'homeassistant',
  locationIds: ['loc-store', 'loc-bench'],
  discoveryPublished: true,
  ...overrides,
});

describe('serialise / parse', () => {
  it('round-trips a record', () => {
    const original = record();
    expect(parseRetainedLocations(serialiseRetainedLocations(original))).toEqual(original);
  });

  it.each([
    ['absent', undefined],
    ['blank', '   '],
    ['not JSON', '{ nope'],
    ['a JSON array', '[]'],
    ['a JSON scalar', '"gubbins"'],
    ['a newer format version', JSON.stringify({ ...record(), version: 99 })],
    ['a missing prefix', JSON.stringify({ ...record(), prefix: '' })],
    ['a missing discovery prefix', JSON.stringify({ ...record(), discoveryPrefix: '' })],
    ['a non-boolean discoveryPublished', JSON.stringify({ ...record(), discoveryPublished: 'yes' })],
    ['a non-array locationIds', JSON.stringify({ ...record(), locationIds: 'loc-store' })],
    ['a non-string id', JSON.stringify({ ...record(), locationIds: ['loc-store', 7] })],
  ])('rejects %s', (_label, raw) => {
    expect(parseRetainedLocations(raw as string | undefined)).toBeUndefined();
  });
});

describe('planRetainedRestore', () => {
  it('restores nothing on a first ever start', () => {
    expect(planRetainedRestore(undefined, SCOPE)).toEqual({
      seedLocationIds: [],
      staleTopics: [],
      discoveryPublished: false,
    });
  });

  it('restores the recorded ids as the diff baseline when both prefixes are unchanged', () => {
    const plan = planRetainedRestore(record(), SCOPE);
    expect(plan.seedLocationIds).toEqual(['loc-store', 'loc-bench']);
    expect(plan.staleTopics).toEqual([]);
    expect(plan.discoveryPublished).toBe(true);
  });

  it('reports no discovery configs when the previous run never published any', () => {
    expect(planRetainedRestore(record({ discoveryPublished: false }), SCOPE).discoveryPublished).toBe(false);
  });

  it('blanks the abandoned state tree, and the location configs, when the topic prefix changes', () => {
    const plan = planRetainedRestore(record(), { ...SCOPE, prefix: 'shed' });
    expect(plan.seedLocationIds).toEqual([]);
    // The configs are still under the discovery prefix this run publishes to.
    expect(plan.discoveryPublished).toBe(true);
    expect(plan.staleTopics).toEqual([
      'homeassistant/sensor/gubbins/location_loc-store/config',
      'homeassistant/sensor/gubbins/location_loc-bench/config',
      'gubbins/location/loc-store/state',
      'gubbins/location/loc-bench/state',
      'gubbins/summary/state',
      'gubbins/snapshot/state',
      'gubbins/status',
    ]);
  });

  // The device-level entities sit at fixed object ids under the discovery prefix alone, so they are
  // the topics a second bridge on the same broker publishes to as well. Blanking them because THIS
  // bridge changed its topic prefix would take that bridge's live entities down; the first
  // publishState rewrites ours moments later anyway.
  it('leaves the shared device configs alone when only the topic prefix changes', () => {
    const plan = planRetainedRestore(record(), { ...SCOPE, prefix: 'shed' });
    expect(plan.staleTopics).not.toContain('homeassistant/sensor/gubbins/items_total/config');
    expect(plan.staleTopics).not.toContain('homeassistant/binary_sensor/gubbins/snapshot_stale/config');
  });

  it('blanks every config before the state topic its entity reads attributes from', () => {
    const plan = planRetainedRestore(record(), { ...SCOPE, prefix: 'shed' });
    const lastConfig = plan.staleTopics.findLastIndex((t) => t.startsWith('homeassistant/'));
    const firstState = plan.staleTopics.findIndex((t) => t.startsWith('gubbins/'));
    expect(lastConfig).toBeLessThan(firstState);
  });

  it('keeps the state baseline but blanks the configs when only the discovery prefix changes', () => {
    const plan = planRetainedRestore(record(), { ...SCOPE, discoveryPrefix: 'ha' });
    expect(plan.seedLocationIds).toEqual(['loc-store', 'loc-bench']);
    expect(plan.discoveryPublished).toBe(false);
    expect(plan.staleTopics).toEqual([
      'homeassistant/sensor/gubbins/items_total/config',
      'homeassistant/sensor/gubbins/low_stock_items/config',
      'homeassistant/sensor/gubbins/out_of_stock_items/config',
      'homeassistant/sensor/gubbins/locations_total/config',
      'homeassistant/binary_sensor/gubbins/low_stock/config',
      'homeassistant/binary_sensor/gubbins/snapshot_stale/config',
      'homeassistant/sensor/gubbins/location_loc-store/config',
      'homeassistant/sensor/gubbins/location_loc-bench/config',
    ]);
  });

  // Nothing re-emits the device entities when this run publishes no discovery configs, so leaving
  // them would strand a half-removed device reading state topics this same sweep blanks.
  it('blanks the device configs too when the topic prefix moves with discovery now off', () => {
    const plan = planRetainedRestore(record(), { ...SCOPE, prefix: 'shed', discovery: false });
    expect(plan.staleTopics).toContain('homeassistant/sensor/gubbins/items_total/config');
    expect(plan.staleTopics).toContain('homeassistant/sensor/gubbins/location_loc-bench/config');
    expect(plan.discoveryPublished).toBe(false);
  });

  it('blanks no config topic when the previous run had discovery off', () => {
    const plan = planRetainedRestore(record({ discoveryPublished: false }), {
      ...SCOPE,
      prefix: 'shed',
    });
    expect(plan.staleTopics.some((t) => t.startsWith('homeassistant/'))).toBe(false);
    expect(plan.staleTopics).toContain('gubbins/status');
  });
});
