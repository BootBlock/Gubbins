/**
 * Home Assistant MQTT-discovery config construction (EI-5) — **pure**.
 *
 * When the discovery sub-flag is on, the bridge publishes a retained
 * `<discovery_prefix>/<component>/gubbins/<object_id>/config` message for each entity, so Home
 * Assistant auto-creates the sensors with **no `custom_components/gubbins` at all**. This is an
 * *alternative* to the custom component (see `homeassistant/README.md`): a user picks one path.
 *
 * The entities all attach to a single HA **device** ("Gubbins") and read the retained state topics
 * this bridge publishes (see `topics.ts`). Everything here is a pure function of the topic set and
 * the current {@link InventoryState}, so each discovery payload unit-tests directly.
 *
 * HA MQTT discovery reference: https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery
 */
import { AVAILABILITY_OFFLINE, AVAILABILITY_ONLINE, sanitizeTopicLevel, topicsFor } from './topics.ts';
import type { InventoryState } from './state.ts';

/** The default HA discovery prefix (HA's own default). */
export const DEFAULT_DISCOVERY_PREFIX = 'homeassistant';

/** The stable HA device identifier every Gubbins entity attaches to. */
export const DEVICE_ID = 'gubbins_bridge';

/** One discovery message: the retained config topic and its JSON payload. */
export interface DiscoveryConfig {
  readonly topic: string;
  readonly payload: string;
}

/** Options for {@link buildDiscoveryConfigs}. */
export interface DiscoveryOptions {
  /** The state-topic prefix the entities read from (must match the publisher's prefix). */
  readonly prefix: string;
  /** The HA discovery prefix (default {@link DEFAULT_DISCOVERY_PREFIX}). */
  readonly discoveryPrefix: string;
  /** The bridge version, surfaced as the device's software version (carries no secret). */
  readonly version: string;
}

/** The HA discovery config topic for one entity: `<prefix>/<component>/gubbins/<objectId>/config`. */
export function discoveryConfigTopic(discoveryPrefix: string, component: string, objectId: string): string {
  return `${discoveryPrefix}/${component}/gubbins/${sanitizeTopicLevel(objectId)}/config`;
}

/** The discovery `object_id` for a per-location sensor (also its `unique_id` stem). */
export function locationSensorObjectId(locationId: string): string {
  return `location_${sanitizeTopicLevel(locationId)}`;
}

/** The HA device block shared by every entity, so they group under one "Gubbins" device. */
function deviceBlock(version: string): Record<string, unknown> {
  return {
    identifiers: [DEVICE_ID],
    name: 'Gubbins',
    manufacturer: 'Gubbins',
    model: 'Gubbins Bridge',
    sw_version: version,
  };
}

/**
 * Build every discovery config for the current state: the four aggregate count sensors, a
 * low-stock binary sensor, and one item-count sensor per location. A caller republishes these
 * (retained) on every (re)connect and whenever the location set changes.
 */
export function buildDiscoveryConfigs(state: InventoryState, options: DiscoveryOptions): DiscoveryConfig[] {
  const topics = topicsFor(options.prefix);
  const device = deviceBlock(options.version);
  const availability = {
    availability_topic: topics.status,
    payload_available: AVAILABILITY_ONLINE,
    payload_not_available: AVAILABILITY_OFFLINE,
  };
  const configTopic = (component: string, objectId: string): string =>
    discoveryConfigTopic(options.discoveryPrefix, component, objectId);

  /** A numeric summary sensor reading one field of the retained summary JSON. */
  const summarySensor = (objectId: string, name: string, field: string, icon: string): DiscoveryConfig => ({
    topic: configTopic('sensor', objectId),
    payload: JSON.stringify({
      name,
      unique_id: `gubbins_${objectId}`,
      object_id: `gubbins_${objectId}`,
      state_topic: topics.summaryState,
      value_template: `{{ value_json.${field} }}`,
      state_class: 'measurement',
      icon,
      ...availability,
      device,
    }),
  });

  const configs: DiscoveryConfig[] = [
    summarySensor('items_total', 'Gubbins items total', 'itemsTotal', 'mdi:package-variant-closed'),
    summarySensor('low_stock_items', 'Gubbins low stock items', 'lowStockItems', 'mdi:alert'),
    summarySensor(
      'out_of_stock_items',
      'Gubbins out of stock items',
      'outOfStockItems',
      'mdi:package-variant-remove',
    ),
    summarySensor('locations_total', 'Gubbins locations total', 'locationsTotal', 'mdi:map-marker'),
    {
      topic: configTopic('binary_sensor', 'low_stock'),
      payload: JSON.stringify({
        name: 'Gubbins low stock',
        unique_id: 'gubbins_low_stock',
        object_id: 'gubbins_low_stock',
        device_class: 'problem',
        state_topic: topics.summaryState,
        // ON when any item is low; OFF otherwise — a plain template over the retained summary JSON.
        value_template: "{{ 'ON' if (value_json.lowStockItems | int) > 0 else 'OFF' }}",
        payload_on: 'ON',
        payload_off: 'OFF',
        icon: 'mdi:alert',
        ...availability,
        device,
      }),
    },
  ];

  for (const location of state.locations) {
    const objectId = `location_${sanitizeTopicLevel(location.id)}`;
    configs.push({
      topic: configTopic('sensor', objectId),
      payload: JSON.stringify({
        name: `Gubbins location ${location.name}`,
        unique_id: `gubbins_${objectId}`,
        object_id: `gubbins_${objectId}`,
        state_topic: topics.locationState(location.id),
        value_template: '{{ value_json.itemCount }}',
        state_class: 'measurement',
        icon: 'mdi:map-marker',
        ...availability,
        device,
      }),
    });
  }

  return configs;
}
