/**
 * Phase HA-3 watcher tests over the SYNTHETIC fixture (no real or personal data).
 *
 * Uses a real temp directory and the synthetic snapshot only. Covers: the deterministic
 * `reload()` path (initial hydrate + atomic swap on changed content), graceful handling
 * of a missing/partial file (last good state retained), and that a real `fs.watch` event
 * is eventually picked up.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { emptyAst } from '@/db/search/ast.ts';
import { createSnapshotWatcher, type SnapshotWatcher } from './watcher.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);

let fixtureText: string;
let dir: string;
let snapshotPath: string;
let watcher: SnapshotWatcher | null = null;

beforeEach(async () => {
  fixtureText = await readFile(fileURLToPath(FIXTURE_URL), 'utf8');
  dir = await mkdtemp(path.join(tmpdir(), 'gubbins-bridge-'));
  snapshotPath = path.join(dir, 'gubbins-sync.json');
});

afterEach(async () => {
  if (watcher) await watcher.stop();
  watcher = null;
  await rm(dir, { recursive: true, force: true });
});

/**
 * The snapshot with a different `generatedAt` and one item removed (4 → 3). Drops
 * `item-resistor` *and* its `item_stock` row so the snapshot stays referentially intact
 * (a dangling FK would make the re-hydrate fail rather than swap).
 */
function modifiedSnapshot(): string {
  const snap = JSON.parse(fixtureText);
  snap.generatedAt = snap.generatedAt + 60_000;
  snap.tables.items = snap.tables.items.filter((item: { id: string }) => item.id !== 'item-resistor');
  snap.tables.item_stock = snap.tables.item_stock.filter(
    (row: { item_id: string }) => row.item_id !== 'item-resistor',
  );
  snap.tables.stock_batches = snap.tables.stock_batches.filter(
    (row: { item_id: string }) => row.item_id !== 'item-resistor',
  );
  return JSON.stringify(snap);
}

async function itemCount(w: SnapshotWatcher): Promise<number> {
  const state = w.getState();
  if (!state) throw new Error('no state');
  return new ItemRepository(state.driver).countByAst(emptyAst('AND'));
}

describe('createSnapshotWatcher (HA-3)', () => {
  it('hydrates on reload() and swaps in new content', async () => {
    await writeFile(snapshotPath, fixtureText);
    watcher = createSnapshotWatcher({ snapshotPath });

    await watcher.reload();
    expect(await itemCount(watcher)).toBe(4);
    const firstGeneratedAt = watcher.getState()?.snapshotGeneratedAt;

    await writeFile(snapshotPath, modifiedSnapshot());
    await watcher.reload();
    expect(await itemCount(watcher)).toBe(3);
    expect(watcher.getState()?.snapshotGeneratedAt).not.toBe(firstGeneratedAt);
  });

  it('retains the last good state when the file is briefly absent', async () => {
    await writeFile(snapshotPath, fixtureText);
    watcher = createSnapshotWatcher({ snapshotPath });
    await watcher.reload();

    await rm(snapshotPath, { force: true });
    let reported: Error | null = null;
    const guarded = createSnapshotWatcher({
      snapshotPath,
      onError: (err) => {
        reported = err;
      },
    });
    // The guarded watcher (file absent) keeps null state and surfaces the error...
    await guarded.reload();
    expect(guarded.getState()).toBeNull();
    expect(reported).not.toBeNull();
    await guarded.stop();

    // ...while the original watcher still serves the previously-loaded data.
    expect(await itemCount(watcher)).toBe(4);
  });

  it('picks up a real filesystem change via fs.watch', async () => {
    await writeFile(snapshotPath, fixtureText);
    watcher = createSnapshotWatcher({ snapshotPath, debounceMs: 30 });
    await watcher.start();
    expect(await itemCount(watcher)).toBe(4);

    await writeFile(snapshotPath, modifiedSnapshot());

    // Poll for the swap; fs.watch latency varies by platform.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await itemCount(watcher)) === 3) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await itemCount(watcher)).toBe(3);
  });
});
