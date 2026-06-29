/**
 * Snapshot-ingest ("push to bridge") tests over the SYNTHETIC fixture (no real or personal data).
 *
 * Two layers:
 *   - {@link validateSnapshotText} — the pure version-guard mapping (valid / malformed / newer).
 *   - {@link ingestSnapshot} — the streaming temp-file → validate → atomic-rename publish, including
 *     the size cap and the cleanup-on-failure guarantees, exercised against real temp files.
 * Plus an end-to-end check that a push is what the unchanged {@link createSnapshotWatcher watcher}
 * then serves — proving the pushed bytes flow through the normal re-hydrate path.
 */
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { ingestSnapshot, PushError, validateSnapshotText } from './push.ts';
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
  it('writes a valid pushed snapshot byte-identically and returns its summary', async () => {
    await writeFile(snapshotPath, 'ORIGINAL (not yet a snapshot)', 'utf8');
    const summary = await ingestSnapshot({ snapshotPath, body: bodyOf(fixtureText, 3), maxBytes: 1_000_000 });
    expect(summary).toEqual({ formatVersion: 1, generatedAt: 1751000000000 });
    expect(await readFile(snapshotPath, 'utf8')).toBe(fixtureText);
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
});

describe('the watcher serves a pushed snapshot', () => {
  it('re-hydrates the pushed bytes through the unchanged watch path', async () => {
    await writeFile(snapshotPath, fixtureText, 'utf8');
    const watcher = createSnapshotWatcher({ snapshotPath, debounceMs: 10 });
    await watcher.start();

    const before = watcher.getState();
    expect(before).not.toBeNull();
    const item = await new ItemRepository(before!.driver).getById('item-m3-bolt');
    expect(item?.name).toBe('M3 x 10 Hex Bolt');

    // Push a modified snapshot: rename the item and bump the snapshot timestamp.
    const modified = JSON.parse(fixtureText);
    modified.generatedAt = 1751999999000;
    modified.tables.items[0].name = 'M3 Pushed Bolt';
    await ingestSnapshot({ snapshotPath, body: bodyOf(JSON.stringify(modified)), maxBytes: 1_000_000 });

    await watcher.reload();
    const after = watcher.getState();
    expect(after!.snapshotGeneratedAt).toBe(new Date(1751999999000).toISOString());
    const pushed = await new ItemRepository(after!.driver).getById('item-m3-bolt');
    expect(pushed?.name).toBe('M3 Pushed Bolt');

    await watcher.stop();
  });
});
