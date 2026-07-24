/**
 * Home Assistant scale readings — the pure projection behind "read the weight off a scale
 * entity instead of typing it in" (issue #122).
 *
 * Counting by weight (issue #101) turns a gross weight into a quantity using the item's
 * recorded per-unit mass. That arithmetic lives in the PWA (`features/inventory/weigh-count`)
 * and is unchanged here; this module only answers the question *what does the scale say, in
 * grams?* so the reading arrives in the same canonical unit a hand-typed one does.
 *
 * **Unit reconciliation is the whole point of this module, and it fails closed.** A scale
 * entity reports whatever unit its integration chose — `g`, `kg`, `oz`, `lb`, `st`, `mg` — and
 * Gubbins stores mass canonically in grams. Guessing at an unrecognised unit would not produce
 * a slightly-wrong number: it would silently multiply the resulting *stock count* by a factor
 * of a thousand. So an entity whose unit we do not recognise is rejected outright rather than
 * assumed to be grams, and the caller surfaces that as a plain "this sensor's unit isn't
 * supported" rather than a count.
 *
 * Side-effect-free (no `node:http`, no fetch, no config) so the parsing and every conversion
 * are unit-tested in isolation — see `scale.test.ts`.
 */

/**
 * Grams per one of each mass unit Home Assistant may report. The imperial factors are the
 * exact international definitions, matching `src/lib/weight.ts`'s table so a reading pulled
 * from a scale and one typed by hand convert identically.
 *
 * Deliberately *not* shared with `src/lib/weight.ts`: that table is the set of units a user may
 * **enter and read** weights in (`g`/`kg`/`oz`/`lb`), which is a UI choice. This one is the set
 * a third-party sensor may **report**, which is a wider, integration-driven set we don't
 * control. Conflating them would force a new display unit into the app's settings every time
 * some integration reports stones.
 */
const GRAMS_PER_HA_UNIT: Readonly<Record<string, number>> = {
  mg: 0.001,
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
  st: 6350.29318,
};

/**
 * The Home Assistant `device_class` that marks a sensor as reporting a mass. Present on
 * well-behaved integrations; its absence is not disqualifying (see {@link isScaleEntity}).
 */
export const WEIGHT_DEVICE_CLASS = 'weight';

/** The raw shape of one entity in Home Assistant's `GET /api/states` response. */
export interface HaState {
  readonly entity_id?: unknown;
  readonly state?: unknown;
  readonly attributes?: unknown;
  readonly last_updated?: unknown;
}

/** A weight sensor the user may pick as "the scale", as served to the PWA's entity picker. */
export interface ScaleEntityDto {
  /** Home Assistant entity id, e.g. `sensor.workshop_scale`. The stable key the PWA stores. */
  readonly entityId: string;
  /** Friendly name for the picker, falling back to the entity id when unnamed. */
  readonly name: string;
  /** The unit the sensor reports (already known-supported), e.g. `kg`. */
  readonly unit: string;
}

/** A single reading, reconciled to canonical grams. */
export interface ScaleReadingDto {
  readonly entityId: string;
  /** The reading in canonical **grams** — what the weigh-count arithmetic consumes. */
  readonly grams: number;
  /** The raw numeric value as the sensor reported it, for an "as read: 1.25 kg" hint. */
  readonly value: number;
  /** The unit that raw value was in. */
  readonly unit: string;
  /** ISO-8601 timestamp of the sensor's last update, or null when absent/unparseable. */
  readonly lastUpdated: string | null;
}

/**
 * Why a state could not be turned into a reading — distinguished so the caller can explain it.
 *
 * `not-a-scale` is the **security-relevant** one: the requested entity is not a weight sensor the
 * picker would ever have offered (a light, a thermostat, a presence sensor — or an entity that
 * doesn't exist). It is deliberately *not* given a distinct user-facing outcome; the client maps
 * it onto the very same `404` a missing entity produces, so a token holder cannot use this
 * endpoint to probe the rest of the user's home (issue #179). The other two describe a genuine
 * scale that simply can't be read right now.
 */
export type ScaleReadingIssue = 'not-a-number' | 'unavailable' | 'not-a-scale';

/** A parse attempt: the reading, or the specific reason there isn't one. */
export type ScaleReadingOutcome =
  | { readonly ok: true; readonly reading: ScaleReadingDto }
  | { readonly ok: false; readonly issue: ScaleReadingIssue };

/**
 * The two state strings Home Assistant uses for "this entity has no value right now" — a scale
 * that is off, asleep, or whose integration has lost its connection. Distinguished from a
 * garbage reading so the UI can say "the scale is unavailable" rather than blaming the unit.
 */
const UNAVAILABLE_STATES = new Set(['unavailable', 'unknown']);

/** Read a string attribute off an entity's `attributes` bag, or null when absent/not a string. */
function readAttribute(state: HaState, key: string): string | null {
  const attributes = state.attributes;
  if (typeof attributes !== 'object' || attributes === null) return null;
  const value = (attributes as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The entity id, or null when the payload is malformed. */
function readEntityId(state: HaState): string | null {
  return typeof state.entity_id === 'string' && state.entity_id.length > 0 ? state.entity_id : null;
}

/**
 * Convert a value in a Home-Assistant-reported unit to canonical grams, or `null` when the unit
 * is not one we recognise. **Never falls back to a default unit** — see the module note.
 * Matching is case-insensitive and whitespace-tolerant (`" KG"` → kilograms) because the unit is
 * free text set by whichever integration owns the sensor.
 */
export function haUnitToGrams(value: number, unit: string): number | null {
  if (!Number.isFinite(value)) return null;
  const factor = GRAMS_PER_HA_UNIT[unit.trim().toLowerCase()];
  return factor === undefined ? null : value * factor;
}

/** Whether a unit string is one we can reconcile to grams. */
export function isSupportedWeightUnit(unit: string | null): boolean {
  return unit !== null && Object.hasOwn(GRAMS_PER_HA_UNIT, unit.trim().toLowerCase());
}

/**
 * Whether an entity is plausibly a scale — i.e. worth offering in the picker.
 *
 * The test is the **unit**, not the `device_class`: a sensor reporting grams is usable whether
 * or not its integration bothered to declare `device_class: weight`, and a `weight`-classed
 * sensor reporting something we can't convert is *not* usable. Requiring the device class would
 * hide perfectly good scales from the picker; requiring only the device class would offer ones
 * that can't be read. So the unit is necessary, and the device class is merely corroborating.
 */
export function isScaleEntity(state: HaState): boolean {
  if (readEntityId(state) === null) return false;
  return isSupportedWeightUnit(readAttribute(state, 'unit_of_measurement'));
}

/**
 * Project Home Assistant's full `GET /api/states` payload down to the weight sensors the user
 * may pick as their scale, sorted by display name so the picker is stable between calls (HA
 * does not promise an order). A non-array payload yields an empty list rather than throwing —
 * the bridge should report "no scales found", not a 500, if HA answers something unexpected.
 *
 * Note this deliberately discards every other entity: the bridge asks Home Assistant for all
 * states because that is the only endpoint HA offers, but nothing about the user's lights,
 * locks or presence sensors is retained or forwarded to the PWA.
 */
export function projectScaleEntities(payload: unknown): ScaleEntityDto[] {
  if (!Array.isArray(payload)) return [];
  const entities: ScaleEntityDto[] = [];
  for (const raw of payload as HaState[]) {
    if (typeof raw !== 'object' || raw === null || !isScaleEntity(raw)) continue;
    const entityId = readEntityId(raw)!;
    entities.push({
      entityId,
      name: readAttribute(raw, 'friendly_name') ?? entityId,
      unit: readAttribute(raw, 'unit_of_measurement')!.trim().toLowerCase(),
    });
  }
  return entities.sort((a, b) => a.name.localeCompare(b.name) || a.entityId.localeCompare(b.entityId));
}

/**
 * Turn one entity's state into a grams reading, or say precisely why it can't be.
 *
 * **The read is gated on {@link isScaleEntity} first**, exactly the test the picker applies: an
 * entity that isn't a convertible-mass sensor (or doesn't exist) yields `not-a-scale` and is never
 * inspected further — its state, unit and `last_updated` are not surfaced, and the caller answers
 * it as a plain `404`. That is what keeps this endpoint from being a read oracle over the user's
 * other Home Assistant entities (issue #179); it also means an unrecognised unit can no longer
 * reach a distinct, unit-echoing response, because such an entity simply isn't a scale.
 *
 * Beyond the gate the two remaining failure modes describe a genuine scale that can't be read
 * right now, kept apart because they need different words: an unavailable scale is a
 * hardware/integration problem, a non-numeric state is a "that sensor isn't reporting a weight"
 * problem.
 */
export function parseScaleReading(payload: unknown): ScaleReadingOutcome {
  const state = (typeof payload === 'object' && payload !== null ? payload : {}) as HaState;

  // Only an entity the picker itself would offer may be read at all; everything else — a non-scale
  // sensor, an unconvertible unit, a malformed payload — is indistinguishable from "no such entity".
  if (!isScaleEntity(state)) return { ok: false, issue: 'not-a-scale' };

  // Guaranteed non-null by the gate above (a scale entity has an id and a supported unit).
  const entityId = readEntityId(state)!;
  const unit = readAttribute(state, 'unit_of_measurement')!;

  const rawState = typeof state.state === 'string' ? state.state.trim() : '';
  if (UNAVAILABLE_STATES.has(rawState.toLowerCase()) || rawState === '') {
    return { ok: false, issue: 'unavailable' };
  }

  // `Number` (not `parseFloat`) so a trailing-garbage state like "12kg" is rejected rather than
  // silently read as 12 — the unit must come from the attribute, never from the state string.
  const value = Number(rawState);
  if (!Number.isFinite(value)) return { ok: false, issue: 'not-a-number' };

  // The unit is known-supported and the value is finite, so this cannot be null — but treat a
  // broken invariant as "not a scale" rather than risk a wrong grams figure.
  const grams = haUnitToGrams(value, unit);
  if (grams === null) return { ok: false, issue: 'not-a-scale' };

  return {
    ok: true,
    reading: {
      entityId,
      grams,
      value,
      unit: unit.trim().toLowerCase(),
      lastUpdated: typeof state.last_updated === 'string' ? state.last_updated : null,
    },
  };
}
