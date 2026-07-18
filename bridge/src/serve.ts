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
import { discoverHomeAssistant } from './mdns/discover.ts';
import { resolveHaDiscoveryPlan } from './mdns/discovery.ts';
import { createHaClient, HaError, type HaClient } from './homeassistant/client.ts';
import { createEventPipeline, type EventSink } from './events/pipeline.ts';
import { createLookupObserver } from './events/lookup.ts';
import type { LookupObserver } from './query.ts';
import { createSseHub, type SseHub } from './events/sse.ts';
import { createWebhookDeliverer, parseWebhookTargets, type WebhookTarget } from './events/webhook.ts';
import {
  loadDatabaseWebhookTargets,
  parseWebhookSecrets,
  type WebhookSecrets,
} from './events/webhook-targets.ts';
import { createWebhookDeliveryLog, type WebhookDeliveryLog } from './events/webhook-log.ts';
import { createWebhookTestFirer } from './events/webhook-test.ts';
import type { WebhookTestCapability } from './server.ts';
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
  // Webhooks (issue #87 `W5`). Targets come from two merged sources: the operator's git-ignored
  // file/env config (EI-1, still supported) and the app's `webhooks` table, read out of the DB the
  // bridge already hydrates — so a subscription created in the PWA becomes live on the next sync
  // with no new config endpoint, token or auth surface. The deliverer is wired whenever webhooks
  // are on, even with no file targets, because the DB may supply them later.
  const webhookConfig = config.webhooks ? loadWebhookConfig(config) : { targets: [], secrets: {} };
  const webhookDeliveryLog: WebhookDeliveryLog | undefined = config.webhooks
    ? createWebhookDeliveryLog()
    : undefined;
  if (config.webhooks) {
    // Warnings are per-subscription and re-derived every generation, so they are de-duplicated —
    // otherwise one missing `secret_ref` would print on every hydration for as long as the bridge runs.
    const reported = new Set<string>();
    sinks.push(
      createWebhookDeliverer({
        targets: webhookConfig.targets,
        resolveTargets: async (driver) => {
          if (driver === undefined) return [];
          const { targets, warnings } = await loadDatabaseWebhookTargets(driver, webhookConfig.secrets);
          for (const warning of warnings) {
            if (reported.has(warning)) continue;
            reported.add(warning);
            console.warn(warning);
          }
          return targets;
        },
        ssrfPolicy: { allowPrivate: config.webhooksAllowPrivate },
        deliveryLog: webhookDeliveryLog,
      }),
    );
  }
  // "Send test event" (`W7`, §5.5). It gets its own short-lived deliverer per fire rather than
  // borrowing the pipeline's: the shared one fans an event out to *every* matching subscription,
  // and a test must reach exactly the one the user asked about. Everything that decides an outcome
  // — the matcher, the template engine, the SSRF guard, the delivery log — is the real thing.
  const webhookTest: WebhookTestCapability | undefined =
    config.webhooks && webhookDeliveryLog !== undefined
      ? {
          secrets: webhookConfig.secrets,
          deliver: createWebhookTestFirer({
            deliveryLog: webhookDeliveryLog,
            ssrfPolicy: { allowPrivate: config.webhooksAllowPrivate },
          }),
        }
      : undefined;
  // EI-5 outbound MQTT (opt-in). The publisher is another event sink (events → `…/event/<type>`)
  // AND publishes retained state per generation; enabling it turns the event pipeline on WITHOUT
  // exposing the SSE HTTP endpoint (that stays gated by `config.events`) — per-capability opt-in.
  // The URL is parsed to an endpoint ONCE here (a single validation/throw site), reused for the log.
  const mqttEndpoint = config.mqtt ? parseMqttEndpoint(config.mqttUrl!) : undefined;
  const mqtt = mqttEndpoint ? createMqttPublisherFromConfig(config, mqttEndpoint) : undefined;
  if (mqtt) sinks.push(mqtt);
  const pipeline = config.events || config.mqtt ? createEventPipeline({ sinks }) : undefined;
  // A2: the READ-triggered `lookup.resolved` event. Its own opt-in, never implied by
  // `GUBBINS_BRIDGE_EVENTS` — it publishes what someone searched for, not an inventory change.
  // It rides the same sinks, so a lookup reaches SSE / webhooks / MQTT exactly like any other
  // event; with no sink configured there is nowhere to publish, so it stays off.
  const lookup: LookupObserver | undefined =
    config.lookupEvents && sinks.length > 0
      ? createLookupObserver({
          deliver: (event) => {
            for (const sink of sinks) {
              try {
                sink.deliver([event]);
              } catch (err) {
                console.error(
                  `Lookup event delivery failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          },
          debounceMs: config.lookupEventsDebounceMs,
        })
      : undefined;

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
  // Home Assistant reads (issue #122) — an independent, outbound-only opt-in: the bridge calls
  // HA, so this opens no port and is unrelated to the data source. Present only when configured;
  // otherwise `/api/v1/scale/*` is a 404. The HA token stays here and is never sent to the PWA.
  // Kept as one object so the URL travels with the client it belongs to — the startup probe below
  // logs that URL, and reaching for the resolved URL there would need an assertion that this
  // narrowing has already done properly.
  const haBaseUrl = await resolveHomeAssistantBaseUrl(config);
  const ha =
    config.homeAssistant && haBaseUrl && config.homeAssistantToken
      ? {
          baseUrl: haBaseUrl,
          client: createHaClient({ baseUrl: haBaseUrl, token: config.homeAssistantToken }),
        }
      : undefined;
  const scale = ha ? { client: ha.client } : undefined;

  const server = createBridgeServer({
    token: config.token,
    getState: () => watcher.getState(),
    rateLimiter,
    write,
    push,
    // Present only when events are enabled → `GET /api/v1/events` streams; otherwise a 404.
    events: sseHub,
    scale,
    lookup,
    webhookDeliveries: webhookDeliveryLog,
    webhookTest,
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
      `Webhooks ENABLED (GUBBINS_BRIDGE_WEBHOOKS=on): ${webhookConfig.targets.length} target(s) from ` +
        'bridge config, plus any subscriptions configured in the app (read from the hydrated ' +
        'snapshot on each generation, so a new one goes live on the next sync). A signed delivery ' +
        'carries an HMAC-SHA256 X-Gubbins-Signature; a GET delivery carries none (there is no body ' +
        'to sign).',
    );
    console.log(
      'Webhook delivery log available at GET /api/v1/webhooks/deliveries (same bearer token). ' +
        'It lives in memory and does not survive a restart.',
    );
    console.log(
      'Webhook test fire available at POST /api/v1/webhooks/test (same bearer token). It sends a ' +
        'synthetic event to one subscription through the real matcher, filter and SSRF guard, and ' +
        'records the result in the delivery log.',
    );
    if (config.webhooksAllowPrivate) {
      console.warn(
        'Webhook SSRF guard DISABLED (GUBBINS_BRIDGE_WEBHOOKS_ALLOW_PRIVATE=on): deliveries to ' +
          'loopback, link-local, private and cloud-metadata addresses are permitted. Only do this ' +
          'if you trust every webhook URL configured in the app — they arrive over sync.',
      );
    } else {
      console.log(
        'Webhook SSRF guard active: deliveries to loopback/link-local/private/metadata addresses ' +
          'are refused. Set GUBBINS_BRIDGE_WEBHOOKS_ALLOW_PRIVATE=on to allow them (e.g. to reach ' +
          'Home Assistant on your LAN).',
      );
    }
  }
  if (config.lookupEvents && lookup) {
    console.warn(
      'Lookup events ENABLED (GUBBINS_BRIDGE_LOOKUP_EVENTS=on): each resolved "where is X?" lookup ' +
        `publishes a read-triggered lookup.resolved event (including the search text) to your ` +
        `configured sinks, debounced to one per ${config.lookupEventsDebounceMs}ms.`,
    );
  } else if (config.lookupEvents) {
    console.warn(
      'Lookup events are on but there is no sink to publish them to — enable the SSE stream, ' +
        'webhooks or MQTT, or nothing will be sent.',
    );
  } else {
    console.log(
      'Lookup events: disabled. Set GUBBINS_BRIDGE_LOOKUP_EVENTS=on to publish a lookup.resolved ' +
        'event when a "where is X?" lookup resolves.',
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
  if (ha) {
    // The HA base URL is safe to log (it is a host the operator typed); the TOKEN never is.
    console.log(
      `Home Assistant reads ENABLED (GUBBINS_BRIDGE_HA=on): "count by weight" can read a scale ` +
        `entity from ${ha.baseUrl}. Outbound-only and read-only — the bridge cannot ` +
        'call a Home Assistant service.',
    );
    void probeHomeAssistant(ha.client, ha.baseUrl);
  } else if (config.homeAssistant) {
    // Opted in, but there is no address to call — discovery was on and found nothing (it already
    // said so), or discovery is off and the URL was never set.
    console.warn(
      'Home Assistant reads are on but no address is configured: set GUBBINS_BRIDGE_HA_URL in ' +
        '.env. "count by weight" cannot read a scale entity until it is.',
    );
  } else {
    console.log('Home Assistant reads: disabled. Set GUBBINS_BRIDGE_HA=on to enable a scale reading.');
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

/**
 * Resolve the Home Assistant base URL to call: the operator's explicit `GUBBINS_BRIDGE_HA_URL`
 * whenever it is set, otherwise — and only when discovery is opted into — the first instance that
 * answers on the LAN (issue #126).
 *
 * Discovery is a convenience, not a trust decision: it supplies an *address*, never a credential.
 * The operator's own long-lived access token is still required, and the bridge's Home Assistant
 * access stays read-only however the address was found. Finding nothing is not fatal — the bridge
 * starts with the scale endpoints unavailable, exactly as it would with no URL configured.
 */
async function resolveHomeAssistantBaseUrl(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<string | undefined> {
  const plan = resolveHaDiscoveryPlan({
    homeAssistant: config.homeAssistant,
    enabled: config.homeAssistantDiscovery,
    configuredUrl: config.homeAssistantUrl,
  });
  if (!plan.discover) {
    if (plan.reason === 'configured') {
      console.log('Home Assistant discovery: skipped — GUBBINS_BRIDGE_HA_URL is set and always wins.');
    }
    return config.homeAssistantUrl;
  }

  console.log('Home Assistant discovery: looking for an instance on the LAN over mDNS…');
  const found = await discoverHomeAssistant();
  if (found === null) {
    console.warn(
      'Home Assistant discovery: nothing answered on the LAN. Set GUBBINS_BRIDGE_HA_URL in .env ' +
        'to point at it directly.',
    );
    return undefined;
  }
  // The discovered address is safe to log (it is a LAN host advertising itself); no secret is
  // involved — the access token is still the one the operator configured.
  console.log(`Home Assistant discovered on the LAN: "${found.name}" at ${found.url}.`);
  return found.url;
}

/**
 * Check the configured Home Assistant actually answers, and accepts the token — otherwise a wrong
 * URL or a revoked token stays silent until a user opens the weigh dialog and gets an error there.
 *
 * Deliberately **not awaited**: it is diagnostics, not a precondition. Home Assistant may well be
 * still booting alongside the bridge, and a bridge whose *other* capabilities are fine must not
 * wait on it — nor fail to start because of it. So this is fired after `listen`, and every outcome
 * is a log line. The base URL is safe to log; the token never appears here (or in `HaError`).
 */
async function probeHomeAssistant(client: HaClient, baseUrl: string): Promise<void> {
  try {
    await client.probe();
    console.log(`Home Assistant reachable at ${baseUrl} and the access token was accepted.`);
  } catch (err) {
    const code = err instanceof HaError ? err.code : undefined;
    if (code === 'home_assistant_unauthorised') {
      console.warn(
        `Home Assistant at ${baseUrl} REJECTED the access token — check GUBBINS_BRIDGE_HA_TOKEN ` +
          '(Profile → Security → Long-lived access tokens). Reading a scale will fail until it is fixed.',
      );
    } else if (code === 'home_assistant_unreachable') {
      console.warn(
        `Home Assistant at ${baseUrl} could not be reached — check GUBBINS_BRIDGE_HA_URL and that ` +
          'Home Assistant is running. Reading a scale will fail until it is reachable.',
      );
    } else {
      console.warn(`Home Assistant at ${baseUrl} did not answer as expected. Reading a scale may fail.`);
    }
  }
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

/** The operator-supplied half of the webhook configuration: file/env targets plus named secrets. */
interface WebhookFileConfig {
  readonly targets: readonly WebhookTarget[];
  readonly secrets: WebhookSecrets;
}

/**
 * Load the operator's webhook config from the inline env JSON (`GUBBINS_BRIDGE_WEBHOOKS_TARGETS`,
 * which wins for targets) and/or the git-ignored file (`GUBBINS_BRIDGE_WEBHOOKS_FILE`, default
 * `webhooks.json`).
 *
 * Two things come out of it. The **targets** are the EI-1 operator-configured destinations, still
 * fully supported alongside the app's synced subscriptions. The **secrets** are the named values a
 * subscription's `secret_ref` resolves against — the recommended way to sign an app-configured
 * webhook (plan §6.1), because the value stays here and never enters the database, and therefore
 * never reaches the sync artefact or a backup.
 *
 * Secrets merge across both sources (env over file) rather than the env replacing the file
 * wholesale: an operator keeping most secrets in `webhooks.json` while overriding one from the
 * environment is a reasonable thing to do, and silently dropping the rest would break signing in a
 * way that is very hard to see.
 *
 * A missing file is **not** an error — the app's subscriptions may be the only source of targets,
 * which is the expected setup for a user who never touches bridge config. Best-effort throughout: a
 * malformed list logs a **secret-free** message and yields nothing rather than aborting startup.
 * The file's contents are never logged (they carry secrets).
 */
function loadWebhookConfig(config: BridgeConfig): WebhookFileConfig {
  let targets: readonly WebhookTarget[] = [];
  let secrets: WebhookSecrets = {};

  // Default to `webhooks.json` in the bridge package (resolved from this module, not the cwd),
  // so it always lands in the git-ignored `bridge/webhooks.json` — never somewhere committable —
  // regardless of the directory the bridge is launched from. An explicit file path is honoured as-is.
  const file =
    config.webhooksFile !== undefined
      ? path.resolve(config.webhooksFile)
      : fileURLToPath(new URL('../webhooks.json', import.meta.url));

  let fileValue: unknown;
  try {
    fileValue = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fileValue = undefined; // absent or unreadable — fine; the app's subscriptions may be the source
  }

  if (fileValue !== undefined) {
    // Only when the env value is absent: with it set, the file's targets are overridden below, and
    // complaining about a stale file whose targets were never going to be used sends the operator
    // to debug a problem that does not exist. The file's *secrets* are still read either way.
    if (config.webhooksInline === undefined) {
      try {
        targets = parseWebhookTargets(fileValue);
      } catch (err) {
        console.error(
          `Failed to load webhook targets from ${file}: ${errorMessage(err)}. ` +
            'Its targets will not be used.',
        );
      }
    }
    try {
      const block =
        typeof fileValue === 'object' && fileValue !== null && !Array.isArray(fileValue)
          ? (fileValue as Record<string, unknown>).secrets
          : undefined;
      secrets = parseWebhookSecrets(block);
    } catch (err) {
      console.error(`Failed to load webhook secrets from ${file}: ${errorMessage(err)}.`);
    }
  }

  if (config.webhooksInline !== undefined) {
    try {
      targets = parseWebhookTargets(JSON.parse(config.webhooksInline));
    } catch (err) {
      console.error(
        `Failed to parse GUBBINS_BRIDGE_WEBHOOKS_TARGETS: ${errorMessage(err)}. Its targets will not be used.`,
      );
    }
  }

  if (config.webhooksSecretsInline !== undefined) {
    try {
      secrets = { ...secrets, ...parseWebhookSecrets(JSON.parse(config.webhooksSecretsInline)) };
    } catch (err) {
      console.error(`Failed to parse GUBBINS_BRIDGE_WEBHOOKS_SECRETS: ${errorMessage(err)}.`);
    }
  }

  return { targets, secrets };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

startBridge().catch((error: unknown) => {
  console.error(`Bridge failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
