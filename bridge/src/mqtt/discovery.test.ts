/**
 * Home Assistant MQTT-discovery config tests (EI-5) — pure. Assert the config topics + payloads HA
 * needs to auto-create the Gubbins entities with no custom component.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISCOVERY_PREFIX,
  DEVICE_ID,
  ORIGIN_NAME,
  ORIGIN_SUPPORT_URL,
  buildDiscoveryConfigs,
} from './discovery.ts';
import type { InventoryState } from './state.ts';

const STATE: InventoryState = {
  itemsTotal: 3,
  lowStockItems: 2,
  outOfStockItems: 1,
  locations: [
    { id: 'loc-store', name: 'Store Room', itemCount: 2, fieldValues: [] },
    { id: 'loc-bench', name: 'Workbench', itemCount: 1, fieldValues: [] },
  ],
  generatedAt: '2025-06-27T07:33:20.000Z',
};

const OPTIONS = { prefix: 'gubbins', discoveryPrefix: DEFAULT_DISCOVERY_PREFIX, version: '9.9.9' };

function byTopic(configs: ReturnType<typeof buildDiscoveryConfigs>, topic: string) {
  const found = configs.find((c) => c.topic === topic);
  if (!found) throw new Error(`no discovery config for ${topic}`);
  return JSON.parse(found.payload) as Record<string, unknown>;
}

describe('buildDiscoveryConfigs', () => {
  const configs = buildDiscoveryConfigs(STATE, OPTIONS);

  it('emits the four summary sensors + low-stock and snapshot-stale binary sensors + one per location', () => {
    // 4 summary sensors + 2 binary sensors (low_stock, snapshot_stale) + 2 locations = 8.
    expect(configs).toHaveLength(8);
    expect(configs.every((c) => c.topic.startsWith('homeassistant/'))).toBe(true);
    expect(configs.every((c) => c.topic.endsWith('/config'))).toBe(true);
  });

  it('wires the items-total sensor to the summary state topic via a value template', () => {
    const sensor = byTopic(configs, 'homeassistant/sensor/gubbins/items_total/config');
    expect(sensor.state_topic).toBe('gubbins/summary/state');
    expect(sensor.value_template).toBe('{{ value_json.itemsTotal }}');
    expect(sensor.unique_id).toBe('gubbins_items_total');
    // The primary feature takes the device's own name rather than repeating it.
    expect(sensor.name).toBeNull();
    expect(sensor.availability_topic).toBe('gubbins/status');
    expect((sensor.device as Record<string, unknown>).identifiers).toEqual([DEVICE_ID]);
    expect((sensor.device as Record<string, unknown>).sw_version).toBe('9.9.9');
  });

  it('drives the low-stock binary sensor ON/OFF from the summary count', () => {
    const bin = byTopic(configs, 'homeassistant/binary_sensor/gubbins/low_stock/config');
    expect(bin.state_topic).toBe('gubbins/summary/state');
    expect(bin.payload_on).toBe('ON');
    expect(bin.payload_off).toBe('OFF');
    expect(bin.device_class).toBe('problem');
    expect(String(bin.value_template)).toContain('lowStockItems');
  });

  it('drives the snapshot-stale binary sensor from the dedicated snapshot topic (issue #394)', () => {
    const bin = byTopic(configs, 'homeassistant/binary_sensor/gubbins/snapshot_stale/config');
    // It reads snapshot/state, NOT summary/state — that is the only topic published from the reload
    // failure path, so it still updates when the summary/location topics have frozen.
    expect(bin.state_topic).toBe('gubbins/snapshot/state');
    expect(bin.device_class).toBe('problem');
    expect(bin.payload_on).toBe('ON');
    expect(bin.payload_off).toBe('OFF');
    expect(String(bin.value_template)).toContain('value_json.stale');
    // Availability still rides the shared status topic, so "bridge down" (unavailable) and "data
    // stale" (on) stay distinct conditions.
    expect(bin.availability_topic).toBe('gubbins/status');
    // The reload counters ride along as attributes off the same topic.
    expect(bin.json_attributes_topic).toBe('gubbins/snapshot/state');
    expect(String(bin.json_attributes_template)).toContain('reloadFailures');
  });

  it('creates a per-location sensor pointed at that location state topic', () => {
    const sensor = byTopic(configs, 'homeassistant/sensor/gubbins/location_loc-store/config');
    expect(sensor.name).toBe('Location Store Room');
    expect(sensor.state_topic).toBe('gubbins/location/loc-store/state');
    expect(sensor.value_template).toBe('{{ value_json.itemCount }}');
  });

  it('surfaces the location custom fields as attributes off the same state topic', () => {
    const sensor = byTopic(configs, 'homeassistant/sensor/gubbins/location_loc-store/config');
    // Attributes ride the state topic, so a changed field VALUE needs no new discovery config.
    expect(sensor.json_attributes_topic).toBe('gubbins/location/loc-store/state');
    expect(sensor.json_attributes_template).toBe('{{ value_json.attributes | tojson }}');
  });

  it('shares one HA device across every entity', () => {
    const ids = configs.map((c) => (JSON.parse(c.payload).device as Record<string, unknown>).identifiers);
    expect(ids.every((i) => JSON.stringify(i) === JSON.stringify([DEVICE_ID]))).toBe(true);
  });

  it('carries the origin block on every entity', () => {
    for (const config of configs) {
      const origin = JSON.parse(config.payload).origin as Record<string, unknown>;
      expect(origin.name).toBe(ORIGIN_NAME);
      expect(origin.sw_version).toBe('9.9.9');
      expect(origin.support_url).toBe(ORIGIN_SUPPORT_URL);
    }
  });

  it('never repeats the device name in an entity name', () => {
    // MQTT entities with a device get `has_entity_name`, so HA prefixes "Gubbins" itself.
    const names = configs.map((c) => JSON.parse(c.payload).name as string | null);
    expect(names.some((n) => n === null)).toBe(true);
    expect(names.every((n) => n === null || !n.startsWith('Gubbins'))).toBe(true);
  });

  it('honours a custom discovery prefix', () => {
    const custom = buildDiscoveryConfigs(STATE, { ...OPTIONS, discoveryPrefix: 'ha' });
    expect(custom.every((c) => c.topic.startsWith('ha/'))).toBe(true);
  });
});
