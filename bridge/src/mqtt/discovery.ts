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

/** The software that produced these discovery payloads — recommended by HA, required device-based. */
export const ORIGIN_NAME = 'Gubbins Bridge';

/** Where a user goes for help with the discovered entities (public, carries no secret). */
export const ORIGIN_SUPPORT_URL = 'https://github.com/BootBlock/Gubbins';

/** One discovery message: the retained config topic and its JSON payload. */
export interface DiscoveryConfig {
  readonly topic: string;
  readonly payload: string;
}

/** Options for {@link buildDiscoveryConfigs}. */
export interface DiscoveryOptions {
  /**
   * The state-topic prefix the entities read from (must match the publisher's prefix). HA learns
   * where to read an entity solely from the topics in these payloads, so a mismatch yields
   * entities that sit at `unknown` for ever with nothing logged. `publisher.test.ts` asserts every
   * topic a discovery payload names is one the publisher actually publishes (issue #254).
   */
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
 * The HA `origin` block naming the software behind these payloads. Recommended for single-component
 * discovery and mandatory for device-based discovery, which HA is moving towards.
 */
function originBlock(version: string): Record<string, unknown> {
  return {
    name: ORIGIN_NAME,
    sw_version: version,
    support_url: ORIGIN_SUPPORT_URL,
  };
}

/**
 * Build every discovery config for the current state: the four aggregate count sensors, a
 * low-stock binary sensor, a snapshot-stale binary sensor (issue #394), and one item-count sensor
 * per location. A caller republishes these (retained) on every (re)connect and whenever the
 * location set changes.
 *
 * Entity `name`s are **device-relative**: an MQTT entity with a `device` gets
 * `has_entity_name = True`, so HA already prefixes the device name ("Gubbins"). Repeating it here
 * would read as "Gubbins Gubbins items total". The primary sensor uses `name: null`, which names it
 * after the device alone.
 */
export function buildDiscoveryConfigs(state: InventoryState, options: DiscoveryOptions): DiscoveryConfig[] {
  const topics = topicsFor(options.prefix);
  const device = deviceBlock(options.version);
  const origin = originBlock(options.version);
  const availability = {
    availability_topic: topics.status,
    payload_available: AVAILABILITY_ONLINE,
    payload_not_available: AVAILABILITY_OFFLINE,
  };
  const configTopic = (component: string, objectId: string): string =>
    discoveryConfigTopic(options.discoveryPrefix, component, objectId);

  /**
   * A numeric summary sensor reading one field of the retained summary JSON. `name` is
   * device-relative; `null` names the entity after the device alone (the primary feature).
   */
  const summarySensor = (
    objectId: string,
    name: string | null,
    field: string,
    icon: string,
  ): DiscoveryConfig => ({
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
      origin,
    }),
  });

  const configs: DiscoveryConfig[] = [
    // The total is this device's primary feature, so it takes the device's own name.
    summarySensor('items_total', null, 'itemsTotal', 'mdi:package-variant-closed'),
    summarySensor('low_stock_items', 'Low stock items', 'lowStockItems', 'mdi:alert'),
    summarySensor(
      'out_of_stock_items',
      'Out of stock items',
      'outOfStockItems',
      'mdi:package-variant-remove',
    ),
    summarySensor('locations_total', 'Locations total', 'locationsTotal', 'mdi:map-marker'),
    {
      topic: configTopic('binary_sensor', 'low_stock'),
      payload: JSON.stringify({
        name: 'Low stock',
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
        origin,
      }),
    },
    {
      // Snapshot-staleness sensor (issue #394): ON when the bridge is knowingly serving out-of-date
      // data. It reads the dedicated `snapshot/state` topic rather than `summary/state`, because
      // that topic is the only one published from the reload *failure* path — the summary/location
      // topics ride the success hook and freeze at their last good values exactly when staleness
      // begins. Availability stays the shared `status` topic, so this entity reports `unavailable`
      // (bridge down) and `on` (bridge up, data stale) as the two distinct conditions they are. The
      // reload counters travel as attributes so an operator can see how stale without a second topic.
      topic: configTopic('binary_sensor', 'snapshot_stale'),
      payload: JSON.stringify({
        name: 'Snapshot stale',
        unique_id: 'gubbins_snapshot_stale',
        object_id: 'gubbins_snapshot_stale',
        device_class: 'problem',
        state_topic: topics.snapshotState,
        value_template: "{{ 'ON' if value_json.stale else 'OFF' }}",
        payload_on: 'ON',
        payload_off: 'OFF',
        json_attributes_topic: topics.snapshotState,
        json_attributes_template:
          '{{ {"reloadFailures": value_json.reloadFailures, "lastReloadAt": value_json.lastReloadAt, ' +
          '"lastReloadError": value_json.lastReloadError, "lastReloadErrorAt": value_json.lastReloadErrorAt} | tojson }}',
        icon: 'mdi:database-clock',
        ...availability,
        device,
        origin,
      }),
    },
  ];

  for (const location of state.locations) {
    // Via the shared helper — the publisher retracts removed locations through the same one, so a
    // change to the scheme can't leave a retained config behind under a stale topic.
    const objectId = locationSensorObjectId(location.id);
    configs.push({
      topic: configTopic('sensor', objectId),
      payload: JSON.stringify({
        name: `Location ${location.name}`,
        unique_id: `gubbins_${objectId}`,
        object_id: `gubbins_${objectId}`,
        state_topic: topics.locationState(location.id),
        value_template: '{{ value_json.itemCount }}',
        // The location's custom-field values ride along as entity attributes, read from the very
        // same (retained) state topic — the idiomatic HA way to attach metadata to an MQTT sensor.
        // An automation then reads e.g. `state_attr('sensor.gubbins_location_<id>', 'ha_entity')`
        // instead of the user maintaining a parallel mapping table in YAML. Because the attributes
        // travel on the state topic, a *value* changing needs no new discovery config.
        json_attributes_topic: topics.locationState(location.id),
        json_attributes_template: '{{ value_json.attributes | tojson }}',
        state_class: 'measurement',
        icon: 'mdi:map-marker',
        ...availability,
        device,
        origin,
      }),
    });
  }

  return configs;
}

/**
 * The device-level entities {@link buildDiscoveryConfigs} always emits, as `[component, objectId]`
 * pairs — the fixed half of the discovery tree, independent of any location.
 *
 * It exists so a *retraction* can name every config topic a previous run published without having
 * that run's {@link InventoryState} to hand (issue #565): the ids are the only part of a config a
 * blanking publish needs. `discovery.test.ts` drives both sides and fails if the two ever diverge —
 * see `names exactly the topics buildDiscoveryConfigs emits, in the same order`.
 */
const DEVICE_ENTITY_IDS: readonly (readonly [component: string, objectId: string])[] = [
  ['sensor', 'items_total'],
  ['sensor', 'low_stock_items'],
  ['sensor', 'out_of_stock_items'],
  ['sensor', 'locations_total'],
  ['binary_sensor', 'low_stock'],
  ['binary_sensor', 'snapshot_stale'],
];

/**
 * Every retained discovery config topic a run with these locations publishes, in emission order
 * (device entities first, then one sensor per location). Used both to describe the current tree
 * and to blank an abandoned one.
 */
export function discoveryConfigTopics(discoveryPrefix: string, locationIds: readonly string[]): string[] {
  return [
    ...DEVICE_ENTITY_IDS.map(([component, objectId]) =>
      discoveryConfigTopic(discoveryPrefix, component, objectId),
    ),
    ...locationIds.map((id) => discoveryConfigTopic(discoveryPrefix, 'sensor', locationSensorObjectId(id))),
  ];
}
