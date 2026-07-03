/**
 * MQTT topic + payload construction (EI-5) — **pure**, so every topic string and JSON body
 * unit-tests without a broker or a database.
 *
 * Topic layout under the configurable base prefix (default `gubbins`):
 *
 *   gubbins/status                 → "online" / "offline"  (retained; also the LWT topic)
 *   gubbins/summary/state          → { itemsTotal, lowStockItems, … }  (retained JSON)
 *   gubbins/location/<id>/state    → { id, name, itemCount }           (retained JSON, one per location)
 *   gubbins/event/<type>           → the EI-1 BridgeEvent JSON          (not retained — transient)
 *
 * State is **retained** so a subscriber (or Home Assistant) that connects after the bridge sees the
 * last-known value immediately; events are transient (a late subscriber shouldn't replay history).
 */
import type { BridgeEvent } from '../events/model.ts';
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

/** The retained JSON body for one location's state topic. */
export function locationPayload(location: LocationState): string {
  return JSON.stringify({ id: location.id, name: location.name, itemCount: location.itemCount });
}

/** The transient JSON body for an event topic (the EI-1 event verbatim). */
export function eventPayload(event: BridgeEvent): string {
  return JSON.stringify(event);
}
