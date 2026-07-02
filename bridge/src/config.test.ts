/**
 * Phase HA-3 config tests — pure env resolution, no I/O. Uses only placeholder/synthetic
 * values (never a real token or path).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST, DEFAULT_MAX_PUSH_BYTES, DEFAULT_PORT, isLanExposed, loadConfig } from './config.ts';
import { DEFAULT_RATE_CAPACITY, DEFAULT_RATE_REFILL_PER_SEC } from './rate-limit.ts';

const VALID: Record<string, string> = {
  GUBBINS_BRIDGE_TOKEN: 'placeholder-token-for-tests',
  GUBBINS_SNAPSHOT_PATH: '/tmp/synthetic/gubbins-sync.json',
};

describe('loadConfig (HA-3)', () => {
  it('resolves required values and applies host/port defaults', () => {
    expect(loadConfig(VALID)).toEqual({
      token: 'placeholder-token-for-tests',
      snapshotPath: '/tmp/synthetic/gubbins-sync.json',
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      rateLimit: { capacity: DEFAULT_RATE_CAPACITY, refillPerSec: DEFAULT_RATE_REFILL_PER_SEC },
      mdns: false,
      mdnsInstanceName: undefined,
      allowWrites: false,
      allowPush: false,
      maxPushBytes: DEFAULT_MAX_PUSH_BYTES,
    });
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

  it('honours an explicit host and port', () => {
    const config = loadConfig({
      ...VALID,
      GUBBINS_BRIDGE_HOST: '0.0.0.0',
      GUBBINS_BRIDGE_PORT: '9999',
    });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(9999);
  });

  it('throws when the token is missing', () => {
    expect(() => loadConfig({ GUBBINS_SNAPSHOT_PATH: VALID.GUBBINS_SNAPSHOT_PATH })).toThrow(
      /GUBBINS_BRIDGE_TOKEN/,
    );
  });

  it('throws when the snapshot path is missing', () => {
    expect(() => loadConfig({ GUBBINS_BRIDGE_TOKEN: VALID.GUBBINS_BRIDGE_TOKEN })).toThrow(
      /GUBBINS_SNAPSHOT_PATH/,
    );
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

  it('flags LAN exposure only for non-loopback hosts', () => {
    expect(isLanExposed(DEFAULT_HOST)).toBe(false);
    expect(isLanExposed('localhost')).toBe(false);
    expect(isLanExposed('0.0.0.0')).toBe(true);
  });
});
