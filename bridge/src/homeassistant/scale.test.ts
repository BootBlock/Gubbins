/**
 * Scale projection + unit reconciliation (issue #122).
 *
 * The conversion tests carry the most weight here: an unrecognised unit that silently defaulted
 * to grams would not round a count slightly, it would multiply it by a thousand and write that
 * to the user's stock. So "unknown units are refused, never assumed" is asserted directly.
 */
import { describe, expect, it } from 'vitest';
import {
  haUnitToGrams,
  isScaleEntity,
  isSupportedWeightUnit,
  parseScaleReading,
  projectScaleEntities,
} from './scale.ts';

/** A minimal HA state payload, shaped like `GET /api/states` entries. */
function state(overrides: {
  entityId?: string;
  value?: string;
  unit?: string | null;
  name?: string;
  deviceClass?: string;
  lastUpdated?: string;
}) {
  const attributes: Record<string, unknown> = {};
  if (overrides.unit !== null) attributes.unit_of_measurement = overrides.unit ?? 'g';
  if (overrides.name !== undefined) attributes.friendly_name = overrides.name;
  if (overrides.deviceClass !== undefined) attributes.device_class = overrides.deviceClass;
  return {
    entity_id: overrides.entityId ?? 'sensor.workshop_scale',
    state: overrides.value ?? '250',
    attributes,
    last_updated: overrides.lastUpdated ?? '2026-07-18T10:00:00.000Z',
  };
}

describe('haUnitToGrams', () => {
  it('converts each supported unit using the exact international factors', () => {
    expect(haUnitToGrams(1, 'g')).toBe(1);
    expect(haUnitToGrams(1, 'kg')).toBe(1000);
    expect(haUnitToGrams(1, 'mg')).toBe(0.001);
    expect(haUnitToGrams(1, 'oz')).toBeCloseTo(28.349523125, 9);
    expect(haUnitToGrams(1, 'lb')).toBeCloseTo(453.59237, 9);
    expect(haUnitToGrams(1, 'st')).toBeCloseTo(6350.29318, 9);
  });

  it('tolerates the casing and padding a third-party integration might report', () => {
    expect(haUnitToGrams(2, ' KG ')).toBe(2000);
    expect(haUnitToGrams(2, 'Lb')).toBeCloseTo(907.18474, 9);
  });

  // The safety property: never guess. A unit we don't know must not fall back to grams.
  it('refuses an unrecognised unit rather than assuming grams', () => {
    expect(haUnitToGrams(5, 'stones')).toBeNull();
    expect(haUnitToGrams(5, 'ml')).toBeNull();
    expect(haUnitToGrams(5, '')).toBeNull();
    expect(haUnitToGrams(5, '%')).toBeNull();
  });

  it('refuses a non-finite value', () => {
    expect(haUnitToGrams(Number.NaN, 'g')).toBeNull();
    expect(haUnitToGrams(Number.POSITIVE_INFINITY, 'kg')).toBeNull();
  });
});

describe('isSupportedWeightUnit', () => {
  it('accepts known mass units and rejects everything else', () => {
    expect(isSupportedWeightUnit('kg')).toBe(true);
    expect(isSupportedWeightUnit('°C')).toBe(false);
    expect(isSupportedWeightUnit(null)).toBe(false);
  });
});

describe('isScaleEntity', () => {
  it('accepts a mass-reporting sensor even without a device_class', () => {
    expect(isScaleEntity(state({ unit: 'kg' }))).toBe(true);
  });

  it('rejects a weight-classed sensor whose unit cannot be converted', () => {
    expect(isScaleEntity(state({ unit: 'furlongs', deviceClass: 'weight' }))).toBe(false);
  });

  it('rejects a sensor with no unit at all, and a malformed entry', () => {
    expect(isScaleEntity(state({ unit: null }))).toBe(false);
    expect(isScaleEntity({ state: '1', attributes: { unit_of_measurement: 'g' } })).toBe(false);
  });
});

describe('projectScaleEntities', () => {
  it('keeps only weight sensors and sorts them by display name', () => {
    const entities = projectScaleEntities([
      state({ entityId: 'sensor.zulu_scale', unit: 'g', name: 'Zulu scale' }),
      state({ entityId: 'light.kitchen', unit: null, name: 'Kitchen light' }),
      state({ entityId: 'sensor.alpha_scale', unit: 'kg', name: 'Alpha scale' }),
      state({ entityId: 'sensor.thermostat', unit: '°C', name: 'Thermostat' }),
    ]);

    expect(entities).toEqual([
      { entityId: 'sensor.alpha_scale', name: 'Alpha scale', unit: 'kg' },
      { entityId: 'sensor.zulu_scale', name: 'Zulu scale', unit: 'g' },
    ]);
  });

  it('falls back to the entity id when a sensor has no friendly name', () => {
    const [entity] = projectScaleEntities([state({ entityId: 'sensor.bare', unit: 'g' })]);
    expect(entity).toEqual({ entityId: 'sensor.bare', name: 'sensor.bare', unit: 'g' });
  });

  it('returns an empty list for a payload that is not an array', () => {
    expect(projectScaleEntities({ error: 'nope' })).toEqual([]);
    expect(projectScaleEntities(null)).toEqual([]);
  });
});

describe('parseScaleReading', () => {
  it('reconciles a reading to canonical grams', () => {
    const outcome = parseScaleReading(state({ value: '1.25', unit: 'kg' }));
    expect(outcome).toEqual({
      ok: true,
      reading: {
        entityId: 'sensor.workshop_scale',
        grams: 1250,
        value: 1.25,
        unit: 'kg',
        lastUpdated: '2026-07-18T10:00:00.000Z',
      },
    });
  });

  it('reports an unavailable scale (one with a supported unit but no value)', () => {
    // The unit defaults to 'g' in the helper, so these are genuine scales that are simply off.
    expect(parseScaleReading(state({ value: 'unavailable' }))).toEqual({ ok: false, issue: 'unavailable' });
    expect(parseScaleReading(state({ value: 'unknown' }))).toEqual({ ok: false, issue: 'unavailable' });
    expect(parseScaleReading(state({ value: '' }))).toEqual({ ok: false, issue: 'unavailable' });
  });

  // An unconvertible unit means the entity isn't a scale at all — so it is reported exactly like a
  // non-scale entity, never as its own outcome that would echo the offending unit back (issue #179).
  it('reports an unconvertible unit as not-a-scale, echoing nothing about the entity', () => {
    expect(parseScaleReading(state({ value: '3', unit: 'ml' }))).toEqual({ ok: false, issue: 'not-a-scale' });
  });

  it('reports a non-numeric state on a genuine scale rather than coercing it', () => {
    expect(parseScaleReading(state({ value: 'on' }))).toEqual({ ok: false, issue: 'not-a-number' });
  });

  // The unit must come from the attribute; reading it out of the state string would let a
  // sensor reporting "12kg" be silently taken as 12 grams.
  it('refuses a state with a unit glued onto the number', () => {
    expect(parseScaleReading(state({ value: '12kg', unit: 'g' }))).toEqual({
      ok: false,
      issue: 'not-a-number',
    });
  });

  it('accepts a zero reading (an empty scale is a valid answer)', () => {
    expect(parseScaleReading(state({ value: '0', unit: 'g' }))).toMatchObject({
      ok: true,
      reading: { grams: 0 },
    });
  });

  // The security gate (issue #179): anything that isn't a scale — a non-weight sensor, an entity
  // with no unit, or a malformed payload — collapses to the single `not-a-scale` outcome, whatever
  // its state, so the endpoint cannot be used to tell one non-scale entity from another, or from
  // one that doesn't exist. No state, unit or last_updated ever comes back.
  it('collapses every non-scale entity to not-a-scale, whatever its state', () => {
    expect(parseScaleReading(state({ entityId: 'light.hall', value: 'on', unit: null }))).toEqual({
      ok: false,
      issue: 'not-a-scale',
    });
    expect(parseScaleReading(state({ entityId: 'sensor.lounge', value: '21.5', unit: '°C' }))).toEqual({
      ok: false,
      issue: 'not-a-scale',
    });
    // Even "unavailable" must not distinguish a non-scale entity from a missing one.
    expect(parseScaleReading(state({ entityId: 'lock.front', value: 'unavailable', unit: null }))).toEqual({
      ok: false,
      issue: 'not-a-scale',
    });
  });

  it('treats a malformed payload as not-a-scale rather than throwing', () => {
    expect(parseScaleReading(null)).toEqual({ ok: false, issue: 'not-a-scale' });
    expect(parseScaleReading({})).toEqual({ ok: false, issue: 'not-a-scale' });
  });
});
