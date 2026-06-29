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
import { isLanExposed, loadConfig, type Env } from './config.ts';
import { createBridgeServer } from './server.ts';
import { createRateLimiter } from './rate-limit.ts';
import { createWriteExecutor } from './write.ts';
import { ingestSnapshot } from './push.ts';
import { detectSource, pushEnabledForSource, writesEnabledForSource } from './sqlite-source.ts';
import { createSnapshotWatcher, type SnapshotWatcher } from './watcher.ts';
import packageJson from '../package.json' with { type: 'json' };
import { createMdnsAdvertiser, type MdnsAdvertiser } from './mdns/advertise.ts';
import { pickAdvertisedAddress, resolveMdnsPlan, sanitizeHostLabel } from './mdns/records.ts';
import type { Server } from 'node:http';

export interface RunningBridge {
  readonly server: Server;
  readonly watcher: SnapshotWatcher;
  /** The mDNS advertiser, when LAN-exposed and opted in; otherwise `undefined`. */
  readonly mdns?: MdnsAdvertiser;
}

/** Load config, hydrate the first snapshot, and start listening. Resolves once bound. */
export async function startBridge(env: Env = process.env): Promise<RunningBridge> {
  const config = loadConfig(env);

  const watcher = createSnapshotWatcher({
    snapshotPath: config.snapshotPath,
    onReload: (state) =>
      console.log(`Snapshot loaded (generated ${state.snapshotGeneratedAt ?? 'unknown'}).`),
    onError: (error) => console.error(`Snapshot reload failed: ${error.message}`),
  });
  await watcher.start();

  const rateLimiter = config.rateLimit ? createRateLimiter(config.rateLimit) : undefined;
  // Writes are off unless explicitly opted in; the executor serialises writes and round-trips
  // each through the §7.3 sync merge (the PWA picks them up on its next sync). See write.ts.
  // They are additionally refused for a raw `.sqlite` source, which has no sync channel to
  // round-trip through (the PWA never reads the exported `.sqlite` back) — see sqlite-source.ts.
  const source = await detectSource(config.snapshotPath);
  const writesEnabled = writesEnabledForSource(config.allowWrites, source);
  const write = writesEnabled
    ? { execute: createWriteExecutor(config.snapshotPath) }
    : undefined;
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
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  if (isLanExposed(config.host)) {
    console.warn(
      `Bridge bound to ${config.host} — reachable from the LAN (a deliberate exposure choice).`,
    );
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

  const mdns = await maybeStartMdns(config);

  const shutdown = (): void => {
    void mdns?.stop();
    void watcher.stop();
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { server, watcher, mdns };
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

startBridge().catch((error: unknown) => {
  console.error(`Bridge failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
