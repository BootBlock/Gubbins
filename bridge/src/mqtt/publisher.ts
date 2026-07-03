/**
 * MQTT publisher (EI-5) — the orchestrator that turns bridge state + EI-1 events into broker
 * publishes. It ties together the pure pieces (`topics.ts`, `discovery.ts`, `state.ts`) and the
 * connection shell (`client.ts`), and is the single object `serve.ts` wires up.
 *
 * Two inputs drive it:
 *   - **Per generation** (`publishState`): the watcher's post-swap hook projects the just-swapped
 *     driver into the aggregate {@link InventoryState} and publishes it to the **retained** state
 *     topics, so a late subscriber (or Home Assistant) sees the last-known values immediately.
 *   - **Per event** (the {@link EventSink} `deliver`): each EI-1 event is published to
 *     `.../event/<type>` (not retained -- a late subscriber shouldn't replay history), reusing the
 *     event model verbatim (no fork).
 *
 * Availability is a retained `.../status` topic: `online` published on each (re)connect, and
 * `offline` as the connection's Last-Will (so an ungraceful death flips it automatically) and on a
 * graceful stop. On every reconnect the last-known state -- and, when enabled, the HA discovery
 * configs -- are re-announced, so a broker that restarted without persistence re-learns everything.
 */
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { BridgeEvent } from '../events/model.ts';
import type { EventSink } from '../events/pipeline.ts';
import {
  createMqttClient,
  type MqttClient,
  type MqttClientOptions,
  type MqttEndpoint,
  type MqttLogger,
  type SocketFactory,
} from './client.ts';
import { buildDiscoveryConfigs, discoveryConfigTopic, locationSensorObjectId } from './discovery.ts';
import { projectInventoryState, type InventoryState } from './state.ts';
import {
  AVAILABILITY_OFFLINE,
  AVAILABILITY_ONLINE,
  eventPayload,
  locationPayload,
  summaryPayload,
  topicsFor,
} from './topics.ts';

export interface MqttPublisherOptions {
  readonly endpoint: MqttEndpoint;
  readonly clientId: string;
  readonly username?: string;
  readonly password?: string;
  /** The topic prefix (default `gubbins`, via `topicsFor`). */
  readonly prefix: string;
  /** Emit HA MQTT-discovery configs so HA auto-creates entities (the discovery sub-flag). */
  readonly discovery: boolean;
  /** The HA discovery prefix (default `homeassistant`). */
  readonly discoveryPrefix: string;
  /** Bridge version, surfaced as the HA device software version (carries no secret). */
  readonly version: string;
  /** Injectable client factory (defaults to the real {@link createMqttClient}). */
  readonly createClient?: (options: MqttClientOptions) => MqttClient;
  /** Injectable socket factory forwarded to the default client (tests inject a fake socket). */
  readonly socketFactory?: SocketFactory;
  readonly keepAliveSeconds?: number;
  readonly logger?: MqttLogger;
}

export interface MqttPublisher extends EventSink {
  /** Begin connecting to the broker (and reconnecting until {@link stop}). */
  start(): void;
  /** Project the driver and publish the retained state (+ discovery when the layout changed). */
  publishState(driver: IDatabaseDriver, generatedAt: string | null): Promise<void>;
  /** Publish `offline` and disconnect gracefully. */
  stop(): void;
}

/** Create the MQTT publisher. It owns the client; call {@link MqttPublisher.start}. */
export function createMqttPublisher(options: MqttPublisherOptions): MqttPublisher {
  const topics = topicsFor(options.prefix);
  const createClient = options.createClient ?? createMqttClient;

  let lastState: InventoryState | null = null;
  // Signature of the location set last published as discovery configs -- so we only re-emit the
  // discovery layout when a location is added/removed/renamed, not on every state refresh.
  let discoverySignature: string | null = null;
  // The location ids we currently have RETAINED topics for, so a removed location's retained state
  // (and its HA discovery entity) can be cleared rather than lingering on the broker as a ghost.
  let publishedLocationIds: readonly string[] = [];

  const client = createClient({
    endpoint: options.endpoint,
    clientId: options.clientId,
    ...(options.username !== undefined ? { username: options.username } : {}),
    ...(options.password !== undefined ? { password: options.password } : {}),
    // The Last-Will flips availability to `offline` (retained) if the bridge dies ungracefully.
    will: { topic: topics.status, payload: AVAILABILITY_OFFLINE, retain: true },
    ...(options.keepAliveSeconds !== undefined ? { keepAliveSeconds: options.keepAliveSeconds } : {}),
    ...(options.socketFactory !== undefined ? { socketFactory: options.socketFactory } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    onConnect: handleConnect,
  });

  /** On each (re)connect: announce online and re-publish the last-known retained state. */
  function handleConnect(): void {
    client.publish(topics.status, AVAILABILITY_ONLINE, true);
    if (lastState !== null) {
      // Force discovery re-emission on a fresh connection (the broker may have lost retained state).
      discoverySignature = null;
      publishSnapshot(lastState);
    }
  }

  /** Publish the retained state topics for a projected state, plus discovery when the layout changed. */
  function publishSnapshot(state: InventoryState): void {
    client.publish(topics.summaryState, summaryPayload(state), true);
    for (const location of state.locations) {
      client.publish(topics.locationState(location.id), locationPayload(location), true);
    }
    clearRemovedLocations(state);
    if (options.discovery) publishDiscoveryIfChanged(state);
  }

  /**
   * Clear the retained state (and HA discovery entity) of any location that was published before but
   * is gone from `state` (deleted, archived, or renamed to a new id), so it doesn't linger on the
   * broker as a ghost sensor. A zero-length retained publish is the MQTT idiom for "forget this
   * topic" / "remove this discovered entity".
   */
  function clearRemovedLocations(state: InventoryState): void {
    const currentIds = new Set(state.locations.map((l) => l.id));
    for (const id of publishedLocationIds) {
      if (currentIds.has(id)) continue;
      client.publish(topics.locationState(id), '', true);
      if (options.discovery) {
        client.publish(
          discoveryConfigTopic(options.discoveryPrefix, 'sensor', locationSensorObjectId(id)),
          '',
          true,
        );
      }
    }
    publishedLocationIds = state.locations.map((l) => l.id);
  }

  /** Re-publish the HA discovery configs only when the location layout has changed since last time. */
  function publishDiscoveryIfChanged(state: InventoryState): void {
    const signature = JSON.stringify(state.locations.map((l) => [l.id, l.name]));
    if (signature === discoverySignature) return;
    discoverySignature = signature;
    const configs = buildDiscoveryConfigs(state, {
      prefix: options.prefix,
      discoveryPrefix: options.discoveryPrefix,
      version: options.version,
    });
    for (const config of configs) client.publish(config.topic, config.payload, true);
  }

  return {
    start(): void {
      client.start();
    },

    async publishState(driver: IDatabaseDriver, generatedAt: string | null): Promise<void> {
      const state = await projectInventoryState(driver, { generatedAt });
      lastState = state;
      publishSnapshot(state);
    },

    deliver(events: readonly BridgeEvent[]): void {
      for (const event of events) {
        client.publish(topics.event(event.type), eventPayload(event), false);
      }
    },

    stop(): void {
      // Announce a clean offline before the graceful DISCONNECT (which suppresses the will).
      client.publish(topics.status, AVAILABILITY_OFFLINE, true);
      client.stop();
    },
  };
}
