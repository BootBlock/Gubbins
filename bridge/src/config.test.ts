/**
 * Phase HA-3 config tests — pure env resolution, no I/O. Uses only placeholder/synthetic
 * values (never a real token or path).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST,
  DEFAULT_MAX_PUSH_BYTES,
  DEFAULT_PORT,
  isLanExposed,
  loadConfig,
  loadStaleAfterFailures,
} from './config.ts';
import { DEFAULT_RATE_CAPACITY, DEFAULT_RATE_REFILL_PER_SEC } from './rate-limit.ts';
import { HOSTED_APP_ORIGIN } from './cors.ts';
import { DEFAULT_LOOKUP_DEBOUNCE_MS, MAX_LOOKUP_DEBOUNCE_MS } from './events/lookup.ts';
import { DEFAULT_STALE_AFTER_FAILURES } from './snapshot-health.ts';

const VALID: Record<string, string> = {
  GUBBINS_SNAPSHOT_PATH: '/tmp/synthetic/gubbins-sync.json',
};

describe('loadConfig (HA-3)', () => {
  it('resolves required values and applies host/port defaults', () => {
    expect(loadConfig(VALID)).toEqual({
      snapshotPath: '/tmp/synthetic/gubbins-sync.json',
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      rateLimit: { capacity: DEFAULT_RATE_CAPACITY, refillPerSec: DEFAULT_RATE_REFILL_PER_SEC },
      allowedOrigins: { wildcard: false, origins: new Set([HOSTED_APP_ORIGIN]) },
      mdns: false,
      mdnsInstanceName: undefined,
      bridgeId: undefined,
      bridgeIdFile: undefined,
      allowWrites: false,
      allowPush: false,
      maxPushBytes: DEFAULT_MAX_PUSH_BYTES,
      staleAfterFailures: DEFAULT_STALE_AFTER_FAILURES,
      events: false,
      lookupEvents: false,
      lookupEventsDebounceMs: DEFAULT_LOOKUP_DEBOUNCE_MS,
      webhooks: false,
      webhooksFile: undefined,
      webhooksInline: undefined,
      webhooksSecretsInline: undefined,
      webhooksAllowPrivate: false,
      mqtt: false,
      mqttUrl: undefined,
      mqttUsername: undefined,
      mqttPassword: undefined,
      mqttPrefix: 'gubbins',
      mqttClientId: 'gubbins-bridge',
      mqttDiscovery: false,
      mqttDiscoveryPrefix: 'homeassistant',
      mqttStateFile: undefined,
      homeAssistant: false,
      homeAssistantUrl: undefined,
      homeAssistantToken: undefined,
      homeAssistantDiscovery: false,
    });
  });

  it('keeps Home Assistant reads off by default and opts in with a URL + token', () => {
    expect(loadConfig(VALID).homeAssistant).toBe(false);
    const config = loadConfig({
      ...VALID,
      GUBBINS_BRIDGE_HA: 'on',
      GUBBINS_BRIDGE_HA_URL: 'http://ha.test:8123/',
      GUBBINS_BRIDGE_HA_TOKEN: '<placeholder-ha-token>',
    });
    expect(config.homeAssistant).toBe(true);
    expect(config.homeAssistantUrl).toBe('http://ha.test:8123/');
    expect(config.homeAssistantToken).toBe('<placeholder-ha-token>');
  });

  it('refuses to start with Home Assistant on but its URL or token missing', () => {
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_HA: 'on' })).toThrow(/GUBBINS_BRIDGE_HA_URL/);
    expect(() =>
      loadConfig({ ...VALID, GUBBINS_BRIDGE_HA: 'on', GUBBINS_BRIDGE_HA_URL: 'http://ha.test:8123' }),
    ).toThrow(/GUBBINS_BRIDGE_HA_TOKEN/);
  });

  it('allows the Home Assistant URL to be unset when discovery is opted into', () => {
    expect(loadConfig(VALID).homeAssistantDiscovery).toBe(false);
    const config = loadConfig({
      ...VALID,
      GUBBINS_BRIDGE_HA: 'on',
      GUBBINS_BRIDGE_HA_DISCOVERY: 'on',
      GUBBINS_BRIDGE_HA_TOKEN: '<placeholder-ha-token>',
    });
    expect(config.homeAssistantDiscovery).toBe(true);
    expect(config.homeAssistantUrl).toBeUndefined();
    // The token is never discoverable — it stays required.
    expect(() =>
      loadConfig({ ...VALID, GUBBINS_BRIDGE_HA: 'on', GUBBINS_BRIDGE_HA_DISCOVERY: 'on' }),
    ).toThrow(/GUBBINS_BRIDGE_HA_TOKEN/);
  });

  it('rejects a Home Assistant URL that is not http(s)', () => {
    expect(() =>
      loadConfig({
        ...VALID,
        GUBBINS_BRIDGE_HA: 'on',
        GUBBINS_BRIDGE_HA_URL: 'ha.test:8123',
        GUBBINS_BRIDGE_HA_TOKEN: '<placeholder-ha-token>',
      }),
    ).toThrow(/http:\/\/ or https:\/\//);
  });

  it('keeps events + webhooks off by default and opts in explicitly', () => {
    expect(loadConfig(VALID).events).toBe(false);
    expect(loadConfig(VALID).webhooks).toBe(false);
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_EVENTS: 'on' }).events).toBe(true);
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_WEBHOOKS: 'on' }).webhooks).toBe(true);
  });

  it('enabling webhooks implies the event stream (shared pipeline)', () => {
    const config = loadConfig({ ...VALID, GUBBINS_BRIDGE_WEBHOOKS: 'on' });
    expect(config.webhooks).toBe(true);
    expect(config.events).toBe(true);
  });

  it('keeps MQTT off by default and opts in with a URL', () => {
    expect(loadConfig(VALID).mqtt).toBe(false);
    const config = loadConfig({
      ...VALID,
      GUBBINS_BRIDGE_MQTT: 'on',
      GUBBINS_BRIDGE_MQTT_URL: 'mqtt://broker.test:1883',
      GUBBINS_BRIDGE_MQTT_USERNAME: 'user',
      GUBBINS_BRIDGE_MQTT_PASSWORD: 'placeholder-mqtt-pass',
      GUBBINS_BRIDGE_MQTT_DISCOVERY: 'on',
      GUBBINS_BRIDGE_MQTT_PREFIX: 'home/gubbins',
    });
    expect(config.mqtt).toBe(true);
    expect(config.mqttUrl).toBe('mqtt://broker.test:1883');
    expect(config.mqttUsername).toBe('user');
    expect(config.mqttPassword).toBe('placeholder-mqtt-pass');
    expect(config.mqttDiscovery).toBe(true);
    expect(config.mqttPrefix).toBe('home/gubbins');
  });

  it('takes the retained-topic state file from the environment, defaulting to unset', () => {
    expect(loadConfig(VALID).mqttStateFile).toBeUndefined();
    const config = loadConfig({
      ...VALID,
      GUBBINS_BRIDGE_MQTT: 'on',
      GUBBINS_BRIDGE_MQTT_URL: 'mqtt://broker.test:1883',
      GUBBINS_BRIDGE_MQTT_STATE_FILE: '  /var/lib/gubbins/mqtt-retained.json  ',
    });
    expect(config.mqttStateFile).toBe('/var/lib/gubbins/mqtt-retained.json');
  });

  it('does NOT expose the SSE HTTP endpoint just because MQTT is on', () => {
    // MQTT publishes events out to the broker but must not implicitly open GET /api/v1/events.
    const config = loadConfig({
      ...VALID,
      GUBBINS_BRIDGE_MQTT: 'on',
      GUBBINS_BRIDGE_MQTT_URL: 'mqtt://broker.test:1883',
    });
    expect(config.mqtt).toBe(true);
    expect(config.events).toBe(false);
  });

  it('throws when MQTT is on but no broker URL is set', () => {
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_MQTT: 'on' })).toThrow(/GUBBINS_BRIDGE_MQTT_URL/);
  });

  it('carries the webhook target sources without inlining a secret into config shape', () => {
    const config = loadConfig({
      ...VALID,
      GUBBINS_BRIDGE_WEBHOOKS: 'on',
      GUBBINS_BRIDGE_WEBHOOKS_FILE: '/tmp/synthetic/webhooks.json',
    });
    expect(config.webhooksFile).toBe('/tmp/synthetic/webhooks.json');
    expect(config.webhooksInline).toBeUndefined();
  });

  it('rejects a non-boolean events flag', () => {
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_EVENTS: 'perhaps' })).toThrow(/GUBBINS_BRIDGE_EVENTS/);
  });

  it('keeps writes off by default and opts in only when explicitly enabled', () => {
    expect(loadConfig(VALID).allowWrites).toBe(false);
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_ALLOW_WRITES: 'on' }).allowWrites).toBe(true);
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_ALLOW_WRITES: 'off' }).allowWrites).toBe(false);
  });

  it('rejects a non-boolean writes flag', () => {
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_ALLOW_WRITES: 'sometimes' })).toThrow(
      /GUBBINS_BRIDGE_ALLOW_WRITES/,
    );
  });

  it('keeps push off by default and opts in only when explicitly enabled (independent of writes)', () => {
    expect(loadConfig(VALID).allowPush).toBe(false);
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_ALLOW_PUSH: 'on' }).allowPush).toBe(true);
    // Independent: enabling push does not enable writes and vice versa.
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_ALLOW_PUSH: 'on' }).allowWrites).toBe(false);
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_ALLOW_WRITES: 'on' }).allowPush).toBe(false);
  });

  it('rejects a non-boolean push flag', () => {
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_ALLOW_PUSH: 'maybe' })).toThrow(
      /GUBBINS_BRIDGE_ALLOW_PUSH/,
    );
  });

  it('defaults the push size cap and accepts a positive override', () => {
    expect(loadConfig(VALID).maxPushBytes).toBe(DEFAULT_MAX_PUSH_BYTES);
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_MAX_PUSH_BYTES: '1048576' }).maxPushBytes).toBe(1048576);
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_MAX_PUSH_BYTES: '0' })).toThrow(
      /GUBBINS_BRIDGE_MAX_PUSH_BYTES/,
    );
  });

  it('defaults the stale-reload threshold, allows an override, and allows opting out with 0', () => {
    expect(loadConfig(VALID).staleAfterFailures).toBe(DEFAULT_STALE_AFTER_FAILURES);
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_STALE_AFTER_FAILURES: '10' }).staleAfterFailures).toBe(10);
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_STALE_AFTER_FAILURES: '0' }).staleAfterFailures).toBe(0);
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_STALE_AFTER_FAILURES: 'lots' })).toThrow(
      /GUBBINS_BRIDGE_STALE_AFTER_FAILURES/,
    );
  });

  it('resolves the stale threshold standalone for the MCP server (same parsing as loadConfig)', () => {
    // The MCP stdio server has no HTTP config to resolve, so it reads this one value on its own —
    // and it must trip staleness at the same point `/health` does (issue #394).
    expect(loadStaleAfterFailures({})).toBe(DEFAULT_STALE_AFTER_FAILURES);
    expect(loadStaleAfterFailures({ GUBBINS_BRIDGE_STALE_AFTER_FAILURES: '7' })).toBe(7);
    expect(loadStaleAfterFailures({ GUBBINS_BRIDGE_STALE_AFTER_FAILURES: '0' })).toBe(0);
    expect(() => loadStaleAfterFailures({ GUBBINS_BRIDGE_STALE_AFTER_FAILURES: 'nope' })).toThrow(
      /GUBBINS_BRIDGE_STALE_AFTER_FAILURES/,
    );
  });

  it('opts into mDNS only when explicitly enabled, and parses an instance name', () => {
    expect(loadConfig(VALID).mdns).toBe(false);
    const on = loadConfig({
      ...VALID,
      GUBBINS_BRIDGE_MDNS: 'on',
      GUBBINS_BRIDGE_MDNS_NAME: 'Workshop Gubbins',
    });
    expect(on.mdns).toBe(true);
    expect(on.mdnsInstanceName).toBe('Workshop Gubbins');
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_MDNS: 'off' }).mdns).toBe(false);
  });

  it('rejects a non-boolean mDNS flag', () => {
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_MDNS: 'maybe' })).toThrow(/GUBBINS_BRIDGE_MDNS/);
  });

  // Issue #672: the bridge normally mints and remembers its own identity, so both of these stay
  // unset. An operator pins one when it has to survive a move to different hardware.
  it('accepts a pinned bridge id and id-file path', () => {
    const config = loadConfig({
      ...VALID,
      GUBBINS_BRIDGE_ID: '  workshop-nas-8787 ',
      GUBBINS_BRIDGE_ID_FILE: '/var/lib/gubbins/bridge-id',
    });
    expect(config.bridgeId).toBe('workshop-nas-8787');
    expect(config.bridgeIdFile).toBe('/var/lib/gubbins/bridge-id');
  });

  // A pinned id that cannot be used must fail startup: silently substituting a different one would
  // present the bridge to its consumers as a *different* bridge, which is the confusion it prevents.
  it('refuses a pinned bridge id that could not travel in an advertisement', () => {
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_ID: 'two words' })).toThrow(/GUBBINS_BRIDGE_ID/);
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_ID: 'x'.repeat(65) })).toThrow(/GUBBINS_BRIDGE_ID/);
    // Blank is "not pinned", not an error.
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_ID: '   ' }).bridgeId).toBeUndefined();
  });

  it('honours an explicit host and port', () => {
    const config = loadConfig({
      ...VALID,
      GUBBINS_BRIDGE_HOST: '0.0.0.0',
      GUBBINS_BRIDGE_PORT: '9999',
    });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(9999);
  });

  // There is no inbound bearer token in the environment any more (issue #79, plan §1.3): callers
  // present per-user tokens minted in the app, which arrive in the snapshot. A config that names
  // one is simply ignored rather than being honoured as a back door.
  it('needs no inbound token, and ignores a leftover one', () => {
    const config = loadConfig({ ...VALID, GUBBINS_BRIDGE_TOKEN: 'placeholder-token-for-tests' });
    expect(config).not.toHaveProperty('token');
  });

  it('throws when the snapshot path is missing', () => {
    expect(() => loadConfig({})).toThrow(/GUBBINS_SNAPSHOT_PATH/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_PORT: '70000' })).toThrow(/GUBBINS_BRIDGE_PORT/);
  });

  it('honours explicit rate-limit values', () => {
    const config = loadConfig({
      ...VALID,
      GUBBINS_BRIDGE_RATE_CAPACITY: '10',
      GUBBINS_BRIDGE_RATE_REFILL: '2',
    });
    expect(config.rateLimit).toEqual({ capacity: 10, refillPerSec: 2 });
  });

  it('disables the rate limiter when capacity is 0', () => {
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_RATE_CAPACITY: '0' }).rateLimit).toBeNull();
  });

  it('rejects a non-numeric rate capacity', () => {
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_RATE_CAPACITY: 'lots' })).toThrow(
      /GUBBINS_BRIDGE_RATE_CAPACITY/,
    );
  });

  it('defaults the CORS allow-list to the hosted app origin and honours an override', () => {
    expect(loadConfig(VALID).allowedOrigins).toEqual({
      wildcard: false,
      origins: new Set([HOSTED_APP_ORIGIN]),
    });
    expect(
      loadConfig({ ...VALID, GUBBINS_BRIDGE_ALLOWED_ORIGINS: 'https://app.example.com' }).allowedOrigins,
    ).toEqual({ wildcard: false, origins: new Set(['https://app.example.com']) });
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_ALLOWED_ORIGINS: '*' }).allowedOrigins).toEqual({
      wildcard: true,
    });
  });

  it('rejects a malformed CORS origin so a typo fails loudly at startup', () => {
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_ALLOWED_ORIGINS: 'not-a-url' })).toThrow(
      /GUBBINS_BRIDGE_ALLOWED_ORIGINS/,
    );
  });

  it('flags LAN exposure only for non-loopback hosts', () => {
    expect(isLanExposed(DEFAULT_HOST)).toBe(false);
    expect(isLanExposed('localhost')).toBe(false);
    expect(isLanExposed('0.0.0.0')).toBe(true);
  });

  // --- A2: the read-triggered lookup event (its own opt-in) --------------------------
  it('keeps lookup events off by default', () => {
    expect(loadConfig(VALID).lookupEvents).toBe(false);
  });

  it('does NOT enable lookup events via GUBBINS_BRIDGE_EVENTS', () => {
    // Deliberate: a lookup event publishes what someone SEARCHED FOR, which is a privacy step
    // beyond publishing inventory state — so it is never implied by the event stream, nor by
    // webhooks or MQTT (both of which do imply the stream).
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_EVENTS: 'on' }).lookupEvents).toBe(false);
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_WEBHOOKS: 'on' }).lookupEvents).toBe(false);
    expect(
      loadConfig({ ...VALID, GUBBINS_BRIDGE_MQTT: 'on', GUBBINS_BRIDGE_MQTT_URL: 'mqtt://broker.test:1883' })
        .lookupEvents,
    ).toBe(false);
  });

  it('enables lookup events only when its own flag is set', () => {
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_LOOKUP_EVENTS: 'on' }).lookupEvents).toBe(true);
  });

  it('does not enable the event stream just because lookup events are on', () => {
    expect(loadConfig({ ...VALID, GUBBINS_BRIDGE_LOOKUP_EVENTS: 'on' }).events).toBe(false);
  });

  it('defaults, honours and clamps the lookup debounce window', () => {
    expect(loadConfig(VALID).lookupEventsDebounceMs).toBe(DEFAULT_LOOKUP_DEBOUNCE_MS);
    expect(
      loadConfig({ ...VALID, GUBBINS_BRIDGE_LOOKUP_EVENTS_DEBOUNCE_MS: '500' }).lookupEventsDebounceMs,
    ).toBe(500);
    expect(
      loadConfig({ ...VALID, GUBBINS_BRIDGE_LOOKUP_EVENTS_DEBOUNCE_MS: '0' }).lookupEventsDebounceMs,
    ).toBe(0);
    expect(
      loadConfig({ ...VALID, GUBBINS_BRIDGE_LOOKUP_EVENTS_DEBOUNCE_MS: '99999999' }).lookupEventsDebounceMs,
    ).toBe(MAX_LOOKUP_DEBOUNCE_MS);
  });

  it('rejects a non-boolean lookup-events flag and a negative debounce', () => {
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_LOOKUP_EVENTS: 'maybe' })).toThrow(
      /GUBBINS_BRIDGE_LOOKUP_EVENTS/,
    );
    expect(() => loadConfig({ ...VALID, GUBBINS_BRIDGE_LOOKUP_EVENTS_DEBOUNCE_MS: '-1' })).toThrow(
      /GUBBINS_BRIDGE_LOOKUP_EVENTS_DEBOUNCE_MS/,
    );
  });
});
