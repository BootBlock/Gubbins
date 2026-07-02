import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { parseBackupJson } from './backup';
import {
  buildPushRequest,
  buildPushSnapshotJson,
  mapPushResponse,
  pushSnapshotToBridge,
  resolveBridgeIngestUrl,
  SNAPSHOT_INGEST_PATH,
  type FetchLike,
} from './push-to-bridge';

describe('resolveBridgeIngestUrl', () => {
  it('appends the ingest path to a base URL and tolerates trailing slashes', () => {
    expect(resolveBridgeIngestUrl('http://127.0.0.1:8787')).toBe(
      `http://127.0.0.1:8787${SNAPSHOT_INGEST_PATH}`,
    );
    expect(resolveBridgeIngestUrl('http://127.0.0.1:8787/')).toBe(
      `http://127.0.0.1:8787${SNAPSHOT_INGEST_PATH}`,
    );
  });

  it('respects a URL that already ends in the ingest path', () => {
    const full = `http://localhost:8787${SNAPSHOT_INGEST_PATH}`;
    expect(resolveBridgeIngestUrl(full)).toBe(full);
  });

  it('rejects a blank or non-HTTP URL with a friendly message', () => {
    expect(() => resolveBridgeIngestUrl('   ')).toThrow(/Enter the bridge URL/);
    expect(() => resolveBridgeIngestUrl('ftp://nope')).toThrow(/http/);
  });
});

describe('buildPushRequest', () => {
  it('shapes a POST with a bearer token and JSON content type', () => {
    const req = buildPushRequest('http://127.0.0.1:8787', '  s3cret  ', '{"formatVersion":1}');
    expect(req).toEqual({
      url: `http://127.0.0.1:8787${SNAPSHOT_INGEST_PATH}`,
      method: 'POST',
      headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
      body: '{"formatVersion":1}',
    });
  });

  it('rejects a blank token before any network call', () => {
    expect(() => buildPushRequest('http://127.0.0.1:8787', '   ', '{}')).toThrow(/access token/);
  });
});

describe('mapPushResponse', () => {
  it('reports success and echoes the accepted format version', () => {
    const result = mapPushResponse(200, { ok: true, formatVersion: 3 }, 'http://x/api/v1/snapshot');
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/format 3/);
  });

  it('maps 401/404/413/422/429 to distinct, token-free guidance', () => {
    expect(mapPushResponse(401, undefined, 'u').message).toMatch(/token/i);
    expect(mapPushResponse(404, undefined, 'u').message).toMatch(/GUBBINS_BRIDGE_ALLOW_PUSH/);
    expect(
      mapPushResponse(413, { error: { code: 'payload_too_large', message: 'too big' } }, 'u').message,
    ).toBe('too big');
    expect(
      mapPushResponse(422, { error: { code: 'unprocessable', message: 'newer build' } }, 'u').message,
    ).toBe('newer build');
    expect(mapPushResponse(429, undefined, 'u').message).toMatch(/rate-limit/i);
  });

  it('falls back to a generic message for an unexpected status', () => {
    expect(mapPushResponse(500, undefined, 'http://x').message).toMatch(/HTTP 500/);
  });
});

describe('pushSnapshotToBridge', () => {
  it('POSTs the JSON with the right shape and reports success', async () => {
    const seen: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] =
      [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, init });
      return { status: 200, json: async () => ({ ok: true, formatVersion: 2 }) };
    };
    const result = await pushSnapshotToBridge({
      baseUrl: 'http://127.0.0.1:8787',
      token: 'tok',
      json: '{"formatVersion":2}',
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`http://127.0.0.1:8787${SNAPSHOT_INGEST_PATH}`);
    expect(seen[0]!.init.headers.authorization).toBe('Bearer tok');
    expect(seen[0]!.init.body).toBe('{"formatVersion":2}');
  });

  it('returns a friendly failure (no throw) when the bridge is unreachable', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:8787');
    };
    const result = await pushSnapshotToBridge({
      baseUrl: 'http://127.0.0.1:8787',
      token: 'tok',
      json: '{}',
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not reach the bridge/);
    // The raw error / token never leaks into the message.
    expect(result.message).not.toMatch(/ECONNREFUSED|tok/);
  });

  it('validates settings before the network (blank token never fetches)', async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return { status: 200, json: async () => ({}) };
    };
    const result = await pushSnapshotToBridge({ baseUrl: 'http://x', token: '', json: '{}', fetchImpl });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('buildPushSnapshotJson', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('produces the same versioned-JSON the bridge ingests (parseBackupJson round-trips it)', async () => {
    const items = new ItemRepository(driver);
    await items.create({ name: 'Pushable Widget', locationId: UNASSIGNED_LOCATION_ID });

    const json = await buildPushSnapshotJson(driver, 1751999999000);
    const snapshot = parseBackupJson(json); // the exact guard the bridge applies on ingest
    expect(snapshot.generatedAt).toBe(1751999999000);
    expect(snapshot.tables.items?.some((row) => row.name === 'Pushable Widget')).toBe(true);
  });
});
