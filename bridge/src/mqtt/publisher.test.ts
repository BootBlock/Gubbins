/**
 * MQTT publisher orchestration tests (EI-5) — the publisher driven with a FAKE client that records
 * every publish, over the hydrated synthetic state fixture. Asserts the retained state topics, the
 * event topics, the availability lifecycle, and the discovery re-emit rules — no broker, no wire.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { createMqttPublisher, type MqttPublisherOptions } from './publisher.ts';
import type { MqttClient, MqttClientOptions } from './client.ts';
import type { BridgeEvent } from '../events/model.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-mqtt-snapshot.json', import.meta.url);
const GENERATED_AT = '2025-06-27T07:33:20.000Z';

interface Published {
  topic: string;
  payload: string;
  retain: boolean;
}

/** A fake MQTT client that records publishes and exposes the captured onConnect hook. */
function fakeClientFactory() {
  const published: Published[] = [];
  let onConnect: (() => void) | undefined;
  let stopped = false;
  const create = (options: MqttClientOptions): MqttClient => {
    onConnect = options.onConnect;
    return {
      start: () => {},
      publish: (topic, payload, retain = false) => {
        published.push({ topic, payload: String(payload), retain });
        return true;
      },
      isConnected: () => true,
      stop: () => {
        stopped = true;
      },
    };
  };
  return {
    create,
    published,
    triggerConnect: () => onConnect?.(),
    wasStopped: () => stopped,
  };
}

function makePublisher(overrides: Partial<MqttPublisherOptions> = {}) {
  const fake = fakeClientFactory();
  const publisher = createMqttPublisher({
    endpoint: { host: 'broker.test', port: 1883, tls: false },
    clientId: 'gubbins-bridge',
    prefix: 'gubbins',
    discovery: false,
    discoveryPrefix: 'homeassistant',
    version: '9.9.9',
    createClient: fake.create,
    ...overrides,
  });
  return { publisher, fake };
}

let hydrated: HydrateResult;
beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
});
afterAll(async () => {
  await hydrated.driver.close();
});

const byTopic = (published: Published[], topic: string): Published | undefined =>
  published.find((p) => p.topic === topic);

describe('publishState', () => {
  it('publishes the retained summary + per-location state topics', async () => {
    const { publisher, fake } = makePublisher();
    await publisher.publishState(hydrated.driver, GENERATED_AT);

    const summary = byTopic(fake.published, 'gubbins/summary/state')!;
    expect(summary.retain).toBe(true);
    expect(JSON.parse(summary.payload)).toEqual({
      itemsTotal: 3,
      lowStockItems: 2,
      outOfStockItems: 1,
      locationsTotal: 2,
      generatedAt: GENERATED_AT,
    });

    const store = byTopic(fake.published, 'gubbins/location/loc-store/state')!;
    expect(store.retain).toBe(true);
    expect(JSON.parse(store.payload)).toEqual({ id: 'loc-store', name: 'Store Room', itemCount: 2 });
    expect(byTopic(fake.published, 'gubbins/location/loc-bench/state')).toBeDefined();
  });

  it('does NOT publish discovery configs when discovery is off', async () => {
    const { publisher, fake } = makePublisher({ discovery: false });
    await publisher.publishState(hydrated.driver, GENERATED_AT);
    expect(fake.published.some((p) => p.topic.startsWith('homeassistant/'))).toBe(false);
  });

  it('publishes retained HA discovery configs when discovery is on', async () => {
    const { publisher, fake } = makePublisher({ discovery: true });
    await publisher.publishState(hydrated.driver, GENERATED_AT);
    const config = byTopic(fake.published, 'homeassistant/sensor/gubbins/items_total/config')!;
    expect(config.retain).toBe(true);
    expect(JSON.parse(config.payload).state_topic).toBe('gubbins/summary/state');
  });

  it('re-emits discovery only when the location layout changes (idempotent on repeat)', async () => {
    const { publisher, fake } = makePublisher({ discovery: true });
    await publisher.publishState(hydrated.driver, GENERATED_AT);
    const afterFirst = fake.published.filter((p) => p.topic.startsWith('homeassistant/')).length;
    await publisher.publishState(hydrated.driver, GENERATED_AT); // same layout
    const afterSecond = fake.published.filter((p) => p.topic.startsWith('homeassistant/')).length;
    expect(afterSecond).toBe(afterFirst); // no new discovery configs
  });

  it('clears the retained state + HA entity of a location that disappears', async () => {
    const { publisher, fake } = makePublisher({ discovery: true });
    // First generation: both user locations present.
    await publisher.publishState(hydrated.driver, GENERATED_AT);
    fake.published.length = 0;

    // Second generation: a snapshot whose only user location is loc-store (loc-bench removed).
    const trimmed = await hydrateFromJson(JSON.stringify(await trimmedSnapshot()));
    try {
      await publisher.publishState(trimmed.driver, GENERATED_AT);
    } finally {
      await trimmed.driver.close();
    }

    // A zero-length retained publish clears the ghost location's state topic and HA entity.
    const benchState = byTopic(fake.published, 'gubbins/location/loc-bench/state')!;
    expect(benchState.payload).toBe('');
    expect(benchState.retain).toBe(true);
    const benchConfig = byTopic(fake.published, 'homeassistant/sensor/gubbins/location_loc-bench/config')!;
    expect(benchConfig.payload).toBe('');
    expect(benchConfig.retain).toBe(true);
    // The surviving location is still published normally.
    expect(byTopic(fake.published, 'gubbins/location/loc-store/state')!.payload).not.toBe('');
  });
});

/** The fixture snapshot with the Workbench location (and its items) removed, for the removal test. */
async function trimmedSnapshot(): Promise<Record<string, unknown>> {
  type Row = { id?: string; location_id?: string };
  interface Snapshot {
    tables: { locations: Row[]; items: Row[]; item_stock: Row[]; stock_batches: Row[] };
  }
  const raw = JSON.parse(await readFile(fileURLToPath(FIXTURE_URL), 'utf8')) as Snapshot;
  const t = raw.tables;
  t.locations = t.locations.filter((l) => l.id !== 'loc-bench');
  t.items = t.items.filter((i) => i.location_id !== 'loc-bench');
  t.item_stock = t.item_stock.filter((s) => s.location_id !== 'loc-bench');
  t.stock_batches = t.stock_batches.filter((s) => s.location_id !== 'loc-bench');
  return raw as unknown as Record<string, unknown>;
}

describe('event delivery (EventSink)', () => {
  it('publishes each event to its topic, not retained', () => {
    const { publisher, fake } = makePublisher();
    const event = {
      id: 'e1',
      type: 'item.low_stock',
      occurredAt: GENERATED_AT,
      data: { itemId: 'i1' },
    } as unknown as BridgeEvent;
    publisher.deliver([event]);
    const published = byTopic(fake.published, 'gubbins/event/item.low_stock')!;
    expect(published.retain).toBe(false);
    expect(JSON.parse(published.payload)).toMatchObject({ id: 'e1', type: 'item.low_stock' });
  });
});

describe('availability lifecycle', () => {
  it('announces online + re-publishes last state on (re)connect', async () => {
    const { publisher, fake } = makePublisher();
    await publisher.publishState(hydrated.driver, GENERATED_AT);
    fake.published.length = 0; // clear
    fake.triggerConnect();
    const status = byTopic(fake.published, 'gubbins/status')!;
    expect(status.payload).toBe('online');
    expect(status.retain).toBe(true);
    // The last-known summary is re-announced so a freshly-(re)connected broker re-learns it.
    expect(byTopic(fake.published, 'gubbins/summary/state')).toBeDefined();
  });

  it('publishes retained offline and stops the client on stop()', () => {
    const { publisher, fake } = makePublisher();
    publisher.stop();
    const status = byTopic(fake.published, 'gubbins/status')!;
    expect(status.payload).toBe('offline');
    expect(status.retain).toBe(true);
    expect(fake.wasStopped()).toBe(true);
  });
});
