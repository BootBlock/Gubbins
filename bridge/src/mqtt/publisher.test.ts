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
import { createLookupObserver, LOOKUP_RESOLVED_TYPE, type LookupObserver } from '../events/lookup.ts';
import type { WhereIsResult } from '../query.ts';
import { HEALTHY_RELOAD, summarizeSnapshotHealth } from '../snapshot-health.ts';
import {
  RETAINED_LOCATIONS_VERSION,
  type RetainedLocationsRecord,
  type RetainedLocationsStore,
} from './retained-locations.ts';

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
    expect(JSON.parse(store.payload)).toEqual({
      id: 'loc-store',
      name: 'Store Room',
      itemCount: 2,
      attributes: {},
    });
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

    // The discovery config is retracted BEFORE the state topic is blanked: the sensor reads its
    // attributes from that state topic, so the other order hands HA an empty payload to run
    // `json_attributes_template` over for an entity that is about to vanish.
    const configAt = fake.published.findIndex(
      (p) => p.topic === 'homeassistant/sensor/gubbins/location_loc-bench/config',
    );
    const stateAt = fake.published.findIndex(
      (p) => p.topic === 'gubbins/location/loc-bench/state' && p.payload === '',
    );
    expect(configAt).toBeGreaterThanOrEqual(0);
    expect(configAt).toBeLessThan(stateAt);
  });
});

/**
 * A {@link RetainedLocationsStore} held in memory, standing in for the file `serve.ts` writes.
 * `saved` is the record the publisher last remembered.
 */
function fakeStore(initial?: RetainedLocationsRecord): RetainedLocationsStore & {
  saved: RetainedLocationsRecord | undefined;
} {
  const store = {
    saved: undefined as RetainedLocationsRecord | undefined,
    load: () => initial,
    save: (record: RetainedLocationsRecord) => {
      store.saved = record;
    },
  };
  return store;
}

const RECORD = (overrides: Partial<RetainedLocationsRecord> = {}): RetainedLocationsRecord => ({
  version: RETAINED_LOCATIONS_VERSION,
  prefix: 'gubbins',
  discoveryPrefix: 'homeassistant',
  locationIds: ['loc-store', 'loc-bench'],
  discoveryPublished: true,
  ...overrides,
});

describe('retained topics remembered across restarts (issue #565)', () => {
  it('clears a location that disappeared while this bridge was NOT running', async () => {
    // The previous run published both locations; only loc-store is in the snapshot this run reads,
    // so loc-bench was deleted while the bridge was stopped and is in no in-memory diff.
    const { publisher, fake } = makePublisher({ discovery: true, retainedStore: fakeStore(RECORD()) });
    const trimmed = await hydrateFromJson(JSON.stringify(await trimmedSnapshot()));
    try {
      await publisher.publishState(trimmed.driver, GENERATED_AT);
    } finally {
      await trimmed.driver.close();
    }

    expect(byTopic(fake.published, 'gubbins/location/loc-bench/state')!.payload).toBe('');
    const config = byTopic(fake.published, 'homeassistant/sensor/gubbins/location_loc-bench/config')!;
    expect(config.payload).toBe('');
    expect(config.retain).toBe(true);
    expect(byTopic(fake.published, 'gubbins/location/loc-store/state')!.payload).not.toBe('');
  });

  it('retracts a removed location HA entity discovery published before the flag was turned off', async () => {
    const { publisher, fake } = makePublisher({
      discovery: false,
      retainedStore: fakeStore(RECORD({ discoveryPublished: true })),
    });
    const trimmed = await hydrateFromJson(JSON.stringify(await trimmedSnapshot()));
    try {
      await publisher.publishState(trimmed.driver, GENERATED_AT);
    } finally {
      await trimmed.driver.close();
    }

    // The config is out there whatever the flag now says, so the ghost still has to be cleared —
    // and nothing else is written under the discovery prefix.
    expect(fake.published.filter((p) => p.topic.startsWith('homeassistant/')).map((p) => p.topic)).toEqual([
      'homeassistant/sensor/gubbins/location_loc-bench/config',
    ]);
  });

  it('remembers the current location set, and that discovery configs are out there', async () => {
    const store = fakeStore();
    const { publisher } = makePublisher({ discovery: true, retainedStore: store });
    await publisher.publishState(hydrated.driver, GENERATED_AT);

    expect(store.saved).toEqual({
      version: RETAINED_LOCATIONS_VERSION,
      prefix: 'gubbins',
      discoveryPrefix: 'homeassistant',
      locationIds: ['loc-store', 'loc-bench'],
      discoveryPublished: true,
    });
  });

  it('records discoveryPublished false while the discovery flag is off', async () => {
    const store = fakeStore();
    const { publisher } = makePublisher({ discovery: false, retainedStore: store });
    await publisher.publishState(hydrated.driver, GENERATED_AT);
    expect(store.saved!.discoveryPublished).toBe(false);
  });

  it('blanks the tree abandoned by a prefix change, once, at start', () => {
    const store = fakeStore(RECORD({ prefix: 'old-prefix' }));
    const { publisher, fake } = makePublisher({ discovery: true, retainedStore: store });
    publisher.start();

    const blanked = fake.published.filter((p) => p.payload === '' && p.retain);
    expect(blanked.map((p) => p.topic)).toContain('old-prefix/location/loc-bench/state');
    expect(blanked.map((p) => p.topic)).toContain('old-prefix/status');
    expect(blanked.map((p) => p.topic)).toContain('homeassistant/sensor/gubbins/location_loc-store/config');
    // Nothing is published under the CURRENT prefix by the sweep itself.
    expect(fake.published.some((p) => p.topic.startsWith('gubbins/'))).toBe(false);
    // The record is rewritten immediately, so a crash before the first state publish cannot make
    // the next start blank the same topics all over again.
    expect(store.saved).toEqual({
      version: RETAINED_LOCATIONS_VERSION,
      prefix: 'gubbins',
      discoveryPrefix: 'homeassistant',
      locationIds: [],
      discoveryPublished: false,
    });
  });

  it('blanks nothing at start when the prefixes are unchanged', () => {
    const { publisher, fake } = makePublisher({ discovery: true, retainedStore: fakeStore(RECORD()) });
    publisher.start();
    expect(fake.published).toEqual([]);
  });

  it('keeps the in-memory behaviour when no store is supplied', async () => {
    const { publisher, fake } = makePublisher({ discovery: true });
    const trimmed = await hydrateFromJson(JSON.stringify(await trimmedSnapshot()));
    try {
      await publisher.publishState(trimmed.driver, GENERATED_AT);
    } finally {
      await trimmed.driver.close();
    }
    // Nothing was published before, so there is nothing to retract — only the live set goes out.
    expect(byTopic(fake.published, 'gubbins/location/loc-bench/state')).toBeUndefined();
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

  it('does NOT publish the locate topic for an ordinary change event', () => {
    const { publisher, fake } = makePublisher();
    publisher.deliver([
      { id: 'e1', type: 'item.low_stock', occurredAt: GENERATED_AT, data: {} } as unknown as BridgeEvent,
    ]);
    expect(byTopic(fake.published, 'gubbins/locate')).toBeUndefined();
  });

  it('also publishes a resolved lookup to the dedicated locate topic, NOT retained', () => {
    const { publisher, fake } = makePublisher();
    publisher.deliver([lookupEvent()]);

    // Still on the generic event topic…
    expect(byTopic(fake.published, 'gubbins/event/lookup.resolved')).toBeDefined();

    // …and on the dedicated one, flattened and — the whole point — transient, so a late
    // subscriber can never re-light a bin over yesterday's lookup.
    const locate = byTopic(fake.published, 'gubbins/locate')!;
    expect(locate.retain).toBe(false);
    expect(JSON.parse(locate.payload)).toEqual({
      id: 'lookup:abc0123456789def:1751000000000',
      occurredAt: GENERATED_AT,
      query: 'solder',
      itemIds: ['item-solder'],
      locationIds: ['loc-store'],
      matches: [
        {
          itemId: 'item-solder',
          itemName: 'Solder 0.7mm',
          placements: [{ locationId: 'loc-store', locationName: 'Store Room', quantity: 3 }],
        },
      ],
    });
  });

  it('stays silent on the locate topic while lookup events are disabled', () => {
    // The locate topic inherits A2's flag rather than adding one of its own: with
    // `GUBBINS_BRIDGE_LOOKUP_EVENTS` unset, `serve.ts` wires **no observer at all**, so a resolved
    // lookup never reaches a sink — and nothing can be published. Both postures are modelled here
    // exactly as `serve.ts` builds them, so the flag is the only difference between them.
    const answer = {
      query: 'solder',
      matches: [
        {
          id: 'item-solder',
          name: 'Solder 0.7mm',
          placements: [{ locationId: 'loc-store', locationName: 'Store Room', quantity: 3 }],
        },
      ],
    } as unknown as WhereIsResult;

    /** Exactly `serve.ts`'s wiring: the observer exists only when the flag is on. */
    const wire = (lookupEventsEnabled: boolean) => {
      const { publisher, fake } = makePublisher();
      const observer: LookupObserver | undefined = lookupEventsEnabled
        ? createLookupObserver({ deliver: (event) => publisher.deliver([event]) })
        : undefined;
      observer?.onLookupResolved(answer);
      return fake.published;
    };

    expect(byTopic(wire(false), 'gubbins/locate')).toBeUndefined();
    expect(byTopic(wire(true), 'gubbins/locate')).toBeDefined();
  });
});

/** A synthetic `lookup.resolved` event with a fixed id, so the payload assertion is exact. */
function lookupEvent(): BridgeEvent {
  return {
    id: 'lookup:abc0123456789def:1751000000000',
    type: LOOKUP_RESOLVED_TYPE,
    occurredAt: GENERATED_AT,
    data: {
      query: 'solder',
      itemIds: ['item-solder'],
      locationIds: ['loc-store'],
      matches: [
        {
          itemId: 'item-solder',
          itemName: 'Solder 0.7mm',
          placements: [{ locationId: 'loc-store', locationName: 'Store Room', quantity: 3 }],
        },
      ],
    },
  };
}

describe('publishSnapshotHealth (issue #394)', () => {
  it('publishes the retained staleness verdict to the dedicated snapshot topic', () => {
    const { publisher, fake } = makePublisher();
    publisher.publishSnapshotHealth(
      summarizeSnapshotHealth({
        ...HEALTHY_RELOAD,
        consecutiveFailures: 4,
        lastError: 'boom',
        lastErrorAt: '2025-06-27T07:40:00.000Z',
        lastSuccessAt: GENERATED_AT,
      }),
    );
    const health = byTopic(fake.published, 'gubbins/snapshot/state')!;
    expect(health.retain).toBe(true);
    expect(JSON.parse(health.payload)).toMatchObject({ stale: true, reloadFailures: 4 });
  });

  it('re-announces the last staleness verdict on reconnect', async () => {
    const { publisher, fake } = makePublisher();
    await publisher.publishState(hydrated.driver, GENERATED_AT);
    publisher.publishSnapshotHealth(
      summarizeSnapshotHealth({ ...HEALTHY_RELOAD, consecutiveFailures: 5, lastSuccessAt: GENERATED_AT }),
    );
    fake.published.length = 0; // clear
    fake.triggerConnect();
    // A broker that dropped retained topics re-learns the current staleness verdict, not just state.
    const health = byTopic(fake.published, 'gubbins/snapshot/state')!;
    expect(health.retain).toBe(true);
    expect(JSON.parse(health.payload).stale).toBe(true);
  });

  it('does not publish a snapshot health topic before any verdict is known', () => {
    const { fake } = makePublisher();
    fake.triggerConnect();
    expect(byTopic(fake.published, 'gubbins/snapshot/state')).toBeUndefined();
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

/**
 * Drift guard (issue #254). `DiscoveryOptions.prefix` is documented as "must match the
 * publisher's prefix" — a comment standing in for the only thing that makes discovery work at
 * all. Home Assistant learns where to read an entity's state solely from the topics inside the
 * discovery payload, so a discovery config naming a topic the publisher never writes produces
 * entities that appear correctly and then sit at `unknown` forever, with nothing logged.
 *
 * Asserted end-to-end rather than by comparing the two prefixes: every topic named by every
 * discovery payload has to be one this publisher actually published. A deliberately non-default
 * prefix is used, so a hard-coded `gubbins/` on either side fails here instead of passing by
 * coincidence.
 */
describe('discovery topics ↔ published topics parity (issue #254)', () => {
  /** The payload keys HA reads a topic out of. */
  const TOPIC_KEYS = ['state_topic', 'availability_topic', 'json_attributes_topic'] as const;

  it('never names a state topic the publisher does not write', async () => {
    const { publisher, fake } = makePublisher({ discovery: true, prefix: 'warehouse/gubbins' });
    // The availability topic is announced on connect; the staleness topic only from the health
    // hook. Both have to have been published for the parity check to mean anything.
    fake.triggerConnect();
    await publisher.publishState(hydrated.driver, GENERATED_AT);
    publisher.publishSnapshotHealth(summarizeSnapshotHealth({ ...HEALTHY_RELOAD }));

    const configs = fake.published.filter((p) => p.topic.startsWith('homeassistant/'));
    expect(configs.length).toBeGreaterThan(0);

    const publishedTopics = new Set(
      fake.published.filter((p) => !p.topic.startsWith('homeassistant/')).map((p) => p.topic),
    );

    let checked = 0;
    for (const config of configs) {
      const payload = JSON.parse(config.payload) as Record<string, unknown>;
      for (const key of TOPIC_KEYS) {
        const topic = payload[key];
        if (typeof topic !== 'string') continue;
        expect(topic.startsWith('warehouse/gubbins/'), `${key} ignored the configured prefix`).toBe(true);
        expect(publishedTopics.has(topic), `${key} names an unpublished topic: ${topic}`).toBe(true);
        checked += 1;
      }
    }
    // Every entity carries at least a state topic and an availability topic.
    expect(checked).toBeGreaterThanOrEqual(configs.length * 2);
  });

  it('publishes each discovery config under the configured HA discovery prefix', async () => {
    const { publisher, fake } = makePublisher({
      discovery: true,
      prefix: 'warehouse/gubbins',
      discoveryPrefix: 'ha-test',
    });
    await publisher.publishState(hydrated.driver, GENERATED_AT);
    const configs = fake.published.filter((p) => p.topic.endsWith('/config'));
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) expect(config.topic.startsWith('ha-test/')).toBe(true);
  });
});
