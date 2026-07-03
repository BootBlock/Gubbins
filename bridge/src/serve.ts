/**
 * Bridge entry point (Phase HA-3): wire config → watcher → HTTP server and listen.
 *
 * This is the runnable composition root. It is intentionally thin — the testable logic
 * lives in `config.ts`, `watcher.ts` and `server.ts`, each driven directly in-process by
 * the unit tests. Run it via the `serve.mjs` bootstrap (which registers the `@/` loader
 * and loads `.env`):
 *
 *   node bridge/serve.mjs
 *
 * Read-only throughout: the server only ever calls the HA-2 query core, whose SQL is the
 * parameterised `parseASTtoSQL`. Binds 127.0.0.1 by default; 0.0.0.0 LAN exposure is an
 * explicit, logged choice.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { isLanExposed, loadConfig, type BridgeConfig, type Env } from './config.ts';
import { createBridgeServer } from './server.ts';
import { createRateLimiter } from './rate-limit.ts';
import { createWriteExecutor } from './write.ts';
import { ingestSnapshot } from './push.ts';
import { detectSource, pushEnabledForSource, writesEnabledForSource } from './sqlite-source.ts';
import { createSnapshotWatcher, type SnapshotWatcher } from './watcher.ts';
import packageJson from '../package.json' with { type: 'json' };
import { createMdnsAdvertiser, type MdnsAdvertiser } from './mdns/advertise.ts';
import { pickAdvertisedAddress, resolveMdnsPlan, sanitizeHostLabel } from './mdns/records.ts';
import { createEventPipeline, type EventSink } from './events/pipeline.ts';
import { createSseHub, type SseHub } from './events/sse.ts';
import { createWebhookDeliverer, parseWebhookTargets, type WebhookTarget } from './events/webhook.ts';
import { createMqttPublisher, type MqttPublisher } from './mqtt/publisher.ts';
import { endpointLabel, parseMqttEndpoint, type MqttEndpoint } from './mqtt/client.ts';
import type { Server } from 'node:http';

export interface RunningBridge {
  readonly server: Server;
  readonly watcher: SnapshotWatcher;
  /** The mDNS advertiser, when LAN-exposed and opted in; otherwise `undefined`. */
  readonly mdns?: MdnsAdvertiser;
  /** The MQTT publisher, when `GUBBINS_BRIDGE_MQTT=on`; otherwise `undefined`. */
  readonly mqtt?: MqttPublisher;
}

/** Load config, hydrate the first snapshot, and start listening. Resolves once bound. */
export async function startBridge(env: Env = process.env): Promise<RunningBridge> {
  const config = loadConfig(env);

  // EI-1 events / webhooks / SSE (opt-in). The stream + webhooks share one event pipeline: the
  // SSE hub and the webhook deliverer are just sinks. When neither is enabled, nothing is wired
  // and `GET /api/v1/events` is a 404 (the feature is invisible).
  const sinks: EventSink[] = [];
  const sseHub: SseHub | undefined = config.events ? createSseHub() : undefined;
  if (sseHub) sinks.push(sseHub);
  const webhookTargets = config.webhooks ? loadWebhookTargets(config) : [];
  if (webhookTargets.length > 0) sinks.push(createWebhookDeliverer({ targets: webhookTargets }));
  // EI-5 outbound MQTT (opt-in). The publisher is another event sink (events → `…/event/<type>`)
  // AND publishes retained state per generation; enabling it turns the event pipeline on WITHOUT
  // exposing the SSE HTTP endpoint (that stays gated by `config.events`) — per-capability opt-in.
  // The URL is parsed to an endpoint ONCE here (a single validation/throw site), reused for the log.
  const mqttEndpoint = config.mqtt ? parseMqttEndpoint(config.mqttUrl!) : undefined;
  const mqtt = mqttEndpoint ? createMqttPublisherFromConfig(config, mqttEndpoint) : undefined;
  if (mqtt) sinks.push(mqtt);
  const pipeline = config.events || config.mqtt ? createEventPipeline({ sinks }) : undefined;

  const watcher = createSnapshotWatcher({
    snapshotPath: config.snapshotPath,
    onReload: async (state) => {
      console.log(`Snapshot loaded (generated ${state.snapshotGeneratedAt ?? 'unknown'}).`);
      // The pipeline reads the just-swapped driver (guaranteed live because the watcher awaits
      // this hook) and fans any new events to the sinks. It never throws.
      if (pipeline) await pipeline.onGeneration(state.driver);
      // Publish the retained inventory-state topics for this generation (best-effort; the client
      // buffers while offline). Guarded so an MQTT hiccup never disturbs the data-serving job.
      if (mqtt) {
        try {
          await mqtt.publishState(state.driver, state.snapshotGeneratedAt);
        } catch (err) {
          console.error(`MQTT state publish failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    onError: (error) => console.error(`Snapshot reload failed: ${error.message}`),
  });
  mqtt?.start();
  await watcher.start();

  const rateLimiter = config.rateLimit ? createRateLimiter(config.rateLimit) : undefined;
  // Writes are off unless explicitly opted in; the executor serialises writes and round-trips
  // each through the §7.3 sync merge (the PWA picks them up on its next sync). See write.ts.
  // They are additionally refused for a raw `.sqlite` source, which has no sync channel to
  // round-trip through (the PWA never reads the exported `.sqlite` back) — see sqlite-source.ts.
  const source = await detectSource(config.snapshotPath);
  const writesEnabled = writesEnabledForSource(config.allowWrites, source);
  const write = writesEnabled ? { execute: createWriteExecutor(config.snapshotPath) } : undefined;
  // Push ("push to bridge") is an independent opt-in: it replaces the whole served snapshot, and
  // is likewise refused for a raw `.sqlite` source (no JSON sync channel). See push.ts.
  const pushEnabled = pushEnabledForSource(config.allowPush, source);
  const push = pushEnabled
    ? {
        ingest: (body: AsyncIterable<Uint8Array>) =>
          ingestSnapshot({ snapshotPath: config.snapshotPath, body, maxBytes: config.maxPushBytes }),
      }
    : undefined;
  const server = createBridgeServer({
    token: config.token,
    getState: () => watcher.getState(),
    rateLimiter,
    write,
    push,
    // Present only when events are enabled → `GET /api/v1/events` streams; otherwise a 404.
    events: sseHub,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  if (isLanExposed(config.host)) {
    console.warn(`Bridge bound to ${config.host} — reachable from the LAN (a deliberate exposure choice).`);
  }
  console.log(`Gubbins bridge listening on http://${config.host}:${config.port}`);
  console.log(
    config.rateLimit
      ? `Rate limit: ${config.rateLimit.capacity} burst, ${config.rateLimit.refillPerSec}/s sustained per client.`
      : 'Rate limit: disabled (deferring to the LAN/firewall).',
  );
  console.log(`Data source: ${source === 'sqlite' ? 'raw .sqlite export' : 'JSON sync snapshot'}.`);
  if (writesEnabled) {
    console.warn(
      'Writes ENABLED (GUBBINS_BRIDGE_ALLOW_WRITES=on): POST /api/v1/items/{id}/adjust-quantity|adjust-gauge ' +
        'can mutate the snapshot. Each write round-trips through the sync merge.',
    );
  } else if (config.allowWrites && source === 'sqlite') {
    console.warn(
      'Writes requested but REFUSED: a raw .sqlite source has no sync channel to round-trip ' +
        'through, so writes would drift. Use a JSON sync snapshot to enable writes. (Read-only.)',
    );
  } else {
    console.log('Writes: disabled (read-only). Set GUBBINS_BRIDGE_ALLOW_WRITES=on to enable.');
  }
  if (pushEnabled) {
    console.warn(
      'Snapshot push ENABLED (GUBBINS_BRIDGE_ALLOW_PUSH=on): POST /api/v1/snapshot can REPLACE the ' +
        `served snapshot (max ${config.maxPushBytes} bytes). The watcher re-hydrates each push.`,
    );
  } else if (config.allowPush && source === 'sqlite') {
    console.warn(
      'Snapshot push requested but REFUSED: a raw .sqlite source is not the PWA sync channel, so a ' +
        'push there would not flow into the app. Use a JSON sync snapshot to enable push. (Read-only.)',
    );
  } else {
    console.log('Snapshot push: disabled. Set GUBBINS_BRIDGE_ALLOW_PUSH=on to enable.');
  }
  if (config.webhooks) {
    console.warn(
      `Webhooks ENABLED (GUBBINS_BRIDGE_WEBHOOKS=on): ${webhookTargets.length} target(s). Each event is ` +
        'POSTed with an HMAC-SHA256 X-Gubbins-Signature.' +
        (webhookTargets.length === 0
          ? ' No targets configured — set GUBBINS_BRIDGE_WEBHOOKS_FILE or _TARGETS (nothing will be sent).'
          : ''),
    );
  }
  if (config.events) {
    console.log('Event stream available at GET /api/v1/events (SSE, read-only, same bearer token).');
  } else if (!config.mqtt) {
    console.log(
      'Events/webhooks: disabled. Set GUBBINS_BRIDGE_EVENTS=on for the SSE stream, or ' +
        'GUBBINS_BRIDGE_WEBHOOKS=on for outbound webhooks.',
    );
  }
  if (mqttEndpoint) {
    // The endpoint label is safe to log (host/port only); the username/password are NEVER logged.
    console.warn(
      `MQTT ENABLED (GUBBINS_BRIDGE_MQTT=on): publishing state + events to ` +
        `${endpointLabel(mqttEndpoint)} under "${config.mqttPrefix}/". ` +
        (config.mqttDiscovery
          ? `Home Assistant discovery ON (prefix "${config.mqttDiscoveryPrefix}") — HA will auto-create entities.`
          : 'Home Assistant discovery off (set GUBBINS_BRIDGE_MQTT_DISCOVERY=on to auto-create HA entities).'),
    );
  } else {
    console.log('MQTT publishing: disabled. Set GUBBINS_BRIDGE_MQTT=on to publish to a broker.');
  }

  const mdns = await maybeStartMdns(config);

  const shutdown = (): void => {
    void mdns?.stop();
    mqtt?.stop();
    sseHub?.close();
    void watcher.stop();
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { server, watcher, mdns, mqtt };
}

/** Build the MQTT publisher from config + the already-parsed broker endpoint. */
function createMqttPublisherFromConfig(config: BridgeConfig, endpoint: MqttEndpoint): MqttPublisher {
  return createMqttPublisher({
    endpoint,
    clientId: config.mqttClientId,
    ...(config.mqttUsername !== undefined ? { username: config.mqttUsername } : {}),
    ...(config.mqttPassword !== undefined ? { password: config.mqttPassword } : {}),
    prefix: config.mqttPrefix,
    discovery: config.mqttDiscovery,
    discoveryPrefix: config.mqttDiscoveryPrefix,
    version: packageJson.version,
  });
}

/**
 * Start the mDNS advertiser when the operator opted in *and* the bridge is actually
 * LAN-exposed (advertising a loopback bind is pointless). Best-effort and read-only — the
 * advertisement carries no secret, and a failure here never affects the HTTP server.
 */
async function maybeStartMdns(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<MdnsAdvertiser | undefined> {
  const plan = resolveMdnsPlan({ enabled: config.mdns, host: config.host });
  if (!plan.advertise) {
    if (config.mdns && plan.reason === 'loopback') {
      console.log('mDNS: requested but skipped (bridge is loopback-only — nothing to discover).');
    }
    return undefined;
  }

  const address = pickAdvertisedAddress(os.networkInterfaces(), config.host);
  if (address === null) {
    console.warn('mDNS: no routable IPv4 address found to advertise — skipping.');
    return undefined;
  }

  const advertiser = createMdnsAdvertiser({
    instanceName: config.mdnsInstanceName,
    hostLabel: sanitizeHostLabel(os.hostname()),
    port: config.port,
    address,
    txt: { serverVersion: packageJson.version },
  });
  await advertiser.start();
  return advertiser;
}

/**
 * Load the webhook targets from the inline env JSON (`GUBBINS_BRIDGE_WEBHOOKS_TARGETS`, which
 * wins) or the git-ignored file (`GUBBINS_BRIDGE_WEBHOOKS_FILE`, default `webhooks.json`).
 * Best-effort: a missing file or a malformed list logs a **secret-free** warning and yields no
 * targets rather than aborting startup. Never logs the file's contents (they carry secrets).
 */
function loadWebhookTargets(config: BridgeConfig): WebhookTarget[] {
  try {
    if (config.webhooksInline !== undefined) {
      return parseWebhookTargets(JSON.parse(config.webhooksInline));
    }
    // Default to `webhooks.json` in the bridge package (resolved from this module, not the cwd),
    // so it always lands in the git-ignored `bridge/webhooks.json` — never somewhere committable —
    // regardless of the directory the bridge is launched from. An explicit file path is honoured as-is.
    const file =
      config.webhooksFile !== undefined
        ? path.resolve(config.webhooksFile)
        : fileURLToPath(new URL('../webhooks.json', import.meta.url));
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      console.warn(
        `Webhooks enabled but no target file found at ${file} (and no GUBBINS_BRIDGE_WEBHOOKS_TARGETS). ` +
          'No webhooks will be sent until you add one.',
      );
      return [];
    }
    return parseWebhookTargets(JSON.parse(text));
  } catch (err) {
    // The parse errors are secret-free by construction; still, we only surface the message.
    console.error(
      `Failed to load webhook targets: ${err instanceof Error ? err.message : String(err)}. ` +
        'No webhooks will be sent.',
    );
    return [];
  }
}

startBridge().catch((error: unknown) => {
  console.error(`Bridge failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
