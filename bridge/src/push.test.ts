/**
 * Snapshot-ingest ("push to bridge") tests over the SYNTHETIC fixture (no real or personal data).
 *
 * Two layers:
 *   - {@link validateSnapshotText} — the pure version-guard mapping (valid / malformed / newer).
 *   - {@link ingestSnapshot} — the streaming temp-file → validate → merge/publish flow, including
 *     the size cap, the cleanup-on-failure guarantees, the first-push/corrupt verbatim fallbacks,
 *     and the core issue #154 guarantee: a push is MERGED into the served snapshot (via the app's
 *     §7.3 reconcile) so a bridge write it never saw is not silently destroyed.
 * Plus an end-to-end check that a push is what the unchanged {@link createSnapshotWatcher watcher}
 * then serves — proving the merged bytes flow through the normal re-hydrate path.
 */
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { ADMIN_USER_ID } from '@/db/repositories/constants';
import { buildLocalSnapshot } from '@/features/sync/snapshot';
import { snapshotToBackupJson } from '@/features/sync/backup';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { hydrateFromJson } from './hydrate.ts';
import { ingestSnapshot, PushError, validateSnapshotText } from './push.ts';
import { createWriteExecutor } from './write.ts';
import { createSnapshotMutex } from './snapshot-io.ts';
import { createSnapshotWatcher } from './watcher.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);

let fixtureText: string;
let dir: string;
let snapshotPath: string;

beforeEach(async () => {
  fixtureText = await readFile(fileURLToPath(FIXTURE_URL), 'utf8');
  dir = await mkdtemp(path.join(tmpdir(), 'gubbins-push-test-'));
  snapshotPath = path.join(dir, 'gubbins-sync.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Yield a string as the request body would arrive (optionally in a couple of chunks). */
async function* bodyOf(text: string, chunks = 1): AsyncGenerator<Uint8Array> {
  const buf = Buffer.from(text, 'utf8');
  if (chunks <= 1) {
    yield buf;
    return;
  }
  const size = Math.ceil(buf.length / chunks);
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

/** The quantity of one item in a JSON snapshot, via a throwaway hydration. */
async function quantityIn(json: string, itemId: string): Promise<number> {
  const { driver } = await hydrateFromJson(json);
  try {
    return (await new ItemRepository(driver).getById(itemId))!.quantity;
  } finally {
    await driver.close();
  }
}

/** Serialise a driver's state to the versioned JSON the bridge stores. */
async function snapshotOf(driver: IDatabaseDriver): Promise<string> {
  return snapshotToBackupJson(await buildLocalSnapshot(driver));
}

describe('validateSnapshotText', () => {
  it('accepts a valid snapshot and reports its envelope', () => {
    const summary = validateSnapshotText(fixtureText);
    expect(summary.formatVersion).toBe(1);
    expect(summary.generatedAt).toBe(1751000000000);
  });

  it('rejects non-JSON with a 400 bad_request', () => {
    try {
      validateSnapshotText('{ not json');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PushError);
      expect((err as PushError).status).toBe(400);
      expect((err as PushError).code).toBe('bad_request');
    }
  });

  it('rejects a snapshot missing its format version with a 400', () => {
    expect(() => validateSnapshotText(JSON.stringify({ tables: {} }))).toThrow(PushError);
    try {
      validateSnapshotText(JSON.stringify({ tables: {} }));
    } catch (err) {
      expect((err as PushError).status).toBe(400);
    }
  });

  it('rejects a snapshot from a newer Gubbins build with a 422 unprocessable (the version guard)', () => {
    const future = JSON.stringify({ formatVersion: 9999, generatedAt: 1, tables: {} });
    try {
      validateSnapshotText(future);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PushError);
      expect((err as PushError).status).toBe(422);
      expect((err as PushError).code).toBe('unprocessable');
    }
  });
});

describe('ingestSnapshot', () => {
  it('publishes the first push verbatim when there is no snapshot on disk yet', async () => {
    // No file at snapshotPath — nothing to merge, so the pushed bytes are placed as-is.
    const summary = await ingestSnapshot({
      snapshotPath,
      body: bodyOf(fixtureText, 3),
      maxBytes: 1_000_000,
    });
    expect(summary).toEqual({ formatVersion: 1, generatedAt: 1751000000000 });
    expect(await readFile(snapshotPath, 'utf8')).toBe(fixtureText);
    expect(await readdir(dir)).toEqual(['gubbins-sync.json']);
  });

  // The heart of issue #154: a push must not bulldoze a change the bridge made that the pushing
  // device never saw. The served snapshot carries a bridge-only stock change; the push carries a
  // DIFFERENT device-only change and a stale copy of the first item. After the merge BOTH survive.
  it('merges a push into the served snapshot, keeping a bridge-only change the push never saw', async () => {
    // 1. The served snapshot, with a bridge write applied (item-m3-bolt: 42 → 47).
    const served = await hydrateFromJson(fixtureText);
    await new ItemRepository(served.driver).adjustQuantity('item-m3-bolt', 5);
    await writeFile(snapshotPath, await snapshotOf(served.driver), 'utf8');
    await served.driver.close();

    // 2. The pushing device: same fixture starting point, but it edited a DIFFERENT item
    //    (item-esp32: 7 → 10) and has NO knowledge of the bridge's m3-bolt change.
    const device = await hydrateFromJson(fixtureText);
    await new ItemRepository(device.driver).adjustQuantity('item-esp32', 3);
    const deviceJson = await snapshotOf(device.driver);
    await device.driver.close();

    const summary = await ingestSnapshot({
      snapshotPath,
      body: bodyOf(deviceJson),
      maxBytes: 1_000_000,
      now: () => 1752000000000,
    });
    // The served snapshot's generatedAt is now the MERGE instant, not either input's.
    expect(summary.generatedAt).toBe(1752000000000);
    expect(summary.formatVersion).toBe(1);

    const merged = await readFile(snapshotPath, 'utf8');
    expect(await quantityIn(merged, 'item-m3-bolt')).toBe(47); // bridge change preserved
    expect(await quantityIn(merged, 'item-esp32')).toBe(10); // device change applied
  });

  // The issue's exact example: a consumable gauge decremented on the bridge (a Home Assistant
  // automation) must survive a stale push. The gauge path is a distinct §7.3 Delta-CRDT replay —
  // not the discrete-stock LWW above — so it is covered directly.
  it('keeps a bridge gauge consumption the push never saw (Delta-CRDT replay)', async () => {
    // A shared starting point: a gauge item consumed to net 600 (of a 1000 g spool). The fixture is
    // all-discrete, so the gauge is created via the app's own create/adjust (the same way its
    // net-value deltas are established) and both sides begin from it.
    const seed = await hydrateFromJson(fixtureText);
    const created = await new ItemRepository(seed.driver).create({
      name: 'Synthetic Solder Spool',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000 },
    });
    await new ItemRepository(seed.driver).adjustGauge(created.id, { delta: -400 }); // net 1000 → 600
    const baseJson = await snapshotOf(seed.driver);
    await seed.driver.close();

    // The served snapshot: the bridge consumed a further 150 g → net 450.
    const served = await hydrateFromJson(baseJson);
    await new ItemRepository(served.driver).adjustGauge(created.id, { delta: -150 });
    await writeFile(snapshotPath, await snapshotOf(served.driver), 'utf8');
    await served.driver.close();

    // The device pushes the STALE base (net 600), with no knowledge of the bridge's -150.
    await ingestSnapshot({
      snapshotPath,
      body: bodyOf(baseJson),
      maxBytes: 1_000_000,
      now: () => 1752000000000,
    });

    const { driver } = await hydrateFromJson(await readFile(snapshotPath, 'utf8'));
    try {
      // The merged deltas replay to 450 — the bridge's consumption is not destroyed.
      expect((await new ItemRepository(driver).getById(created.id))!.gauge!.currentNetValue).toBe(450);
    } finally {
      await driver.close();
    }
  });

  it('replaces an unreadable on-disk snapshot rather than failing the push', async () => {
    // A corrupt served file has nothing mergeable to preserve, so the push is placed verbatim.
    await writeFile(snapshotPath, 'ORIGINAL (not a valid snapshot)', 'utf8');
    const summary = await ingestSnapshot({ snapshotPath, body: bodyOf(fixtureText), maxBytes: 1_000_000 });
    expect(summary).toEqual({ formatVersion: 1, generatedAt: 1751000000000 });
    expect(await readFile(snapshotPath, 'utf8')).toBe(fixtureText);
    expect(await readdir(dir)).toEqual(['gubbins-sync.json']);
  });

  it('rejects an over-large body with a 413 and leaves the target untouched', async () => {
    await writeFile(snapshotPath, 'ORIGINAL', 'utf8');
    await expect(
      ingestSnapshot({ snapshotPath, body: bodyOf(fixtureText), maxBytes: 16 }),
    ).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });
    expect(await readFile(snapshotPath, 'utf8')).toBe('ORIGINAL');
    // The temp file was cleaned up — no orphan left in the directory.
    expect(await readdir(dir)).toEqual(['gubbins-sync.json']);
  });

  it('rejects a malformed body with a 400 and leaves the target untouched, no temp left', async () => {
    await writeFile(snapshotPath, 'ORIGINAL', 'utf8');
    await expect(
      ingestSnapshot({ snapshotPath, body: bodyOf('{ not json'), maxBytes: 1_000_000 }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    expect(await readFile(snapshotPath, 'utf8')).toBe('ORIGINAL');
    expect(await readdir(dir)).toEqual(['gubbins-sync.json']);
  });

  // A push and a §7.3 write both read-modify-write the same file; sharing one single-flight makes
  // whichever runs second read the other's result, so neither change is lost (issue #154). Without
  // it the two would each read the pre-change fixture and the last writer would clobber the other.
  it('serialises a concurrent write and push against the same snapshot (no lost update)', async () => {
    await writeFile(snapshotPath, fixtureText, 'utf8');
    const mutex = createSnapshotMutex();

    // The pushing device edited a different item (item-esp32: 7 → 10).
    const device = await hydrateFromJson(fixtureText);
    await new ItemRepository(device.driver).adjustQuantity('item-esp32', 3);
    const deviceJson = await snapshotOf(device.driver);
    await device.driver.close();

    const execute = createWriteExecutor(snapshotPath, undefined, mutex);
    // Fire a bridge write (item-m3-bolt +5) and the push concurrently, sharing the lock.
    await Promise.all([
      execute({ kind: 'adjust-quantity', itemId: 'item-m3-bolt', delta: 5 }, ADMIN_USER_ID),
      ingestSnapshot({ snapshotPath, body: bodyOf(deviceJson), maxBytes: 1_000_000, mutex }),
    ]);

    const final = await readFile(snapshotPath, 'utf8');
    expect(await quantityIn(final, 'item-m3-bolt')).toBe(47); // the write survived the push
    expect(await quantityIn(final, 'item-esp32')).toBe(10); // the push survived the write
  });
});

describe('the watcher serves a merged pushed snapshot', () => {
  it('re-hydrates the merged bytes through the unchanged watch path', async () => {
    await writeFile(snapshotPath, fixtureText, 'utf8');
    const watcher = createSnapshotWatcher({ snapshotPath, debounceMs: 10 });
    await watcher.start();

    const before = watcher.getState();
    expect(before).not.toBeNull();
    const item = await new ItemRepository(before!.driver).getById('item-m3-bolt');
    expect(item?.name).toBe('M3 x 10 Hex Bolt');

    // Push a modified snapshot: rename the item. (Its updated_at is unchanged, so the tie resolves
    // to the incoming row — its content differs, so the rename applies rather than a no-op.)
    const modified = JSON.parse(fixtureText);
    modified.tables.items[0].name = 'M3 Pushed Bolt';
    await ingestSnapshot({
      snapshotPath,
      body: bodyOf(JSON.stringify(modified)),
      maxBytes: 1_000_000,
      now: () => 1752000000000,
    });

    await watcher.reload();
    const after = watcher.getState();
    // The served snapshot's generatedAt is the merge instant.
    expect(after!.snapshotGeneratedAt).toBe(new Date(1752000000000).toISOString());
    const pushed = await new ItemRepository(after!.driver).getById('item-m3-bolt');
    expect(pushed?.name).toBe('M3 Pushed Bolt');

    await watcher.stop();
  });
});
