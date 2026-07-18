/**
 * MQTT topic + payload construction (EI-5) — **pure**, so every topic string and JSON body
 * unit-tests without a broker or a database.
 *
 * Topic layout under the configurable base prefix (default `gubbins`):
 *
 *   gubbins/status                 → "online" / "offline"  (retained; also the LWT topic)
 *   gubbins/summary/state          → { itemsTotal, lowStockItems, … }  (retained JSON)
 *   gubbins/location/<id>/state    → { id, name, itemCount, attributes }(retained JSON, one per location)
 *   gubbins/event/<type>           → the EI-1 BridgeEvent JSON          (not retained — transient)
 *   gubbins/locate                 → the resolved "where is X?" answer  (not retained — transient)
 *
 * State is **retained** so a subscriber (or Home Assistant) that connects after the bridge sees the
 * last-known value immediately; events are transient (a late subscriber shouldn't replay history).
 * The locate topic is emphatically in the second group: it answers a question somebody asked *now*,
 * so re-delivering it to a late subscriber would light a bin over yesterday's lookup.
 */
import type { BridgeEvent } from '../events/model.ts';
import type { LookupEvent } from '../events/lookup.ts';
import type { InventoryState, LocationState } from './state.ts';

/** The default topic prefix; every bridge topic hangs under it. */
export const DEFAULT_TOPIC_PREFIX = 'gubbins';

/** The two availability payloads (also used as the LWT message). */
export const AVAILABILITY_ONLINE = 'online';
export const AVAILABILITY_OFFLINE = 'offline';

/** The characters an MQTT topic level must not contain: the separator and the two wildcards. */
const UNSAFE_TOPIC_CHARS = /[/+#]/g;

/**
 * Sanitise one topic *level* so a record id can never inject a level separator or an MQTT
 * wildcard. App ids are already `[A-Za-z0-9_-]`, but this is defensive belt-and-braces: the level
 * separator `/` and the wildcards `+` / `#` become `_`.
 */
export function sanitizeTopicLevel(value: string): string {
  const cleaned = value.replace(UNSAFE_TOPIC_CHARS, '_');
  return cleaned.length > 0 ? cleaned : '_';
}

/** The set of fixed + templated topics for a given prefix. */
export function topicsFor(prefix: string) {
  const base = prefix.length > 0 ? prefix : DEFAULT_TOPIC_PREFIX;
  return {
    base,
    status: `${base}/status`,
    summaryState: `${base}/summary/state`,
    locationState: (id: string): string => `${base}/location/${sanitizeTopicLevel(id)}/state`,
    event: (type: string): string => `${base}/event/${sanitizeTopicLevel(type)}`,
    locate: `${base}/locate`,
  };
}

/** The retained JSON body for the aggregate summary topic. */
export function summaryPayload(state: InventoryState): string {
  return JSON.stringify({
    itemsTotal: state.itemsTotal,
    lowStockItems: state.lowStockItems,
    outOfStockItems: state.outOfStockItems,
    locationsTotal: state.locations.length,
    generatedAt: state.generatedAt,
  });
}

/**
 * Turn a custom field's dictionary name into an attribute key that reads naturally in a Home
 * Assistant template: lower-cased, non-alphanumerics collapsed to a single `_`, ends trimmed. So
 * `HA Entity` → `ha_entity`, readable as `state_attr('sensor.gubbins_location_bin_42', 'ha_entity')`.
 *
 * A name that normalises to nothing (punctuation only) or that starts with a digit would make an
 * awkward template key, so it is prefixed to stay a usable identifier.
 */
export function attributeKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (slug.length === 0) return 'field';
  return /^[0-9]/.test(slug) ? `field_${slug}` : slug;
}

/**
 * Flatten a location's custom-field values into the `{ key: value }` attribute map published on its
 * state topic. Values are already text (the app stores them that way) and empty ones were dropped
 * upstream. Two fields whose names normalise to the same key would collide, so the **first** wins —
 * the values arrive ordered by field name, making that deterministic rather than order-of-read luck.
 */
export function locationAttributes(location: LocationState): Record<string, string> {
  // A null-prototype accumulator, so the collision check below tests only keys we actually set. A
  // plain `{}` inherits `Object.prototype`, where `'constructor' in attributes` is already true —
  // which would silently drop a field a user happened to name "Constructor".
  const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const field of location.fieldValues) {
    const key = attributeKey(field.name);
    if (key in attributes) continue;
    attributes[key] = field.value;
  }
  // Back to a plain object for serialisation: JSON.stringify handles either, but callers (and
  // tests) reasonably expect an ordinary object out of a pure payload helper.
  return { ...attributes };
}

/**
 * The retained JSON body for one location's state topic. `attributes` is **always present** (an
 * empty object when the location holds no custom fields), so an HA `json_attributes_template`
 * reading it never has to guard against a missing key.
 */
export function locationPayload(location: LocationState): string {
  return JSON.stringify({
    id: location.id,
    name: location.name,
    itemCount: location.itemCount,
    attributes: locationAttributes(location),
  });
}

/** The transient JSON body for an event topic (the EI-1 event verbatim). */
export function eventPayload(event: BridgeEvent): string {
  return JSON.stringify(event);
}

/**
 * The transient JSON body for the dedicated locate topic: the lookup event's envelope with its
 * `data` **flattened to the top level**.
 *
 * That flattening is the whole reason this topic exists beside `<prefix>/event/lookup.resolved`.
 * A Node-RED flow or an HA MQTT trigger acting on the answer wants `value_json.locationIds[0]`,
 * not `value_json.data.locationIds[0]`, and wants one fixed topic to subscribe to rather than a
 * per-type one. The event topic keeps carrying the untouched event for anything consuming the
 * event stream generically.
 */
export function locatePayload(event: LookupEvent): string {
  return JSON.stringify({
    id: event.id,
    occurredAt: event.occurredAt,
    query: event.data.query,
    itemIds: event.data.itemIds,
    locationIds: event.data.locationIds,
    matches: event.data.matches,
  });
}
