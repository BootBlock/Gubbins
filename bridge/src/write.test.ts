/**
 * Opt-in write tests over the SYNTHETIC fixture (made-up parts, no real or personal data).
 *
 * Two layers:
 *   1. The pure-ish mutation core ({@link applyOperation}) — success, not-found, and the
 *      domain rejections (wrong tracking mode, below-zero, non-integer) mapped to typed
 *      {@link WriteError}s.
 *   2. The **gold round-trip**: a bridge write must reach the PWA with NO drift. We simulate a
 *      device (the fixture), have the bridge apply a write through {@link executeWrite}, then run
 *      the app's REAL §7.3 `reconcile` + `applyPlan` against the bridge's written snapshot and
 *      assert the change converges — LWW for a discrete quantity, Delta-CRDT replay for a gauge —
 *      and is idempotent. This proves the "bridge as a peer device" design end-to-end through the
 *      same merge code the app uses, never a fork.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ITEM_HISTORY_TABLE, SYNC_TABLES } from '@/db/repositories';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { reconcile } from '@/features/sync/reconcile';
import { applyPlan, buildLocalSnapshot, buildSchemaDictionary } from '@/features/sync/snapshot';
import { snapshotToBackupJson } from '@/features/sync/backup';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { createNodeDriver } from './node-driver.ts';
import { hydrateFromJson, type HydrateResult } from './hydrate.ts';
import { applyOperation, createWriteExecutor, executeWrite, WriteError } from './write.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);
const DICTIONARY_TABLES = [...SYNC_TABLES, ITEM_HISTORY_TABLE];

async function fixtureJson(): Promise<string> {
  return readFile(fileURLToPath(FIXTURE_URL), 'utf8');
}

async function quantityOf(driver: IDatabaseDriver, id: string): Promise<number> {
  const item = await new ItemRepository(driver).getById(id);
  return item!.quantity;
}

// --- the pure mutation core -------------------------------------------------------

describe('applyOperation', () => {
  let hydrated: HydrateResult;
  beforeEach(async () => {
    hydrated = await hydrateFromJson(await fixtureJson());
  });
  afterEach(async () => {
    await hydrated.driver.close();
  });

  it('adjusts a DISCRETE quantity up and logs it', async () => {
    const item = await applyOperation(hydrated.driver, {
      kind: 'adjust-quantity',
      itemId: 'item-m3-bolt',
      delta: 5,
    });
    expect(item.quantity).toBe(47);
    const history = await hydrated.driver.query<{ action: string; quantity_delta: number }>(
      "SELECT action, quantity_delta FROM item_history WHERE item_id = 'item-m3-bolt' ORDER BY created_at DESC LIMIT 1;",
    );
    expect(history[0]?.action).toBe('QUANTITY_CHANGE');
    expect(Number(history[0]?.quantity_delta)).toBe(5);
  });

  it('adjusts a DISCRETE quantity down', async () => {
    const item = await applyOperation(hydrated.driver, {
      kind: 'adjust-quantity',
      itemId: 'item-m3-bolt',
      delta: -2,
    });
    expect(item.quantity).toBe(40);
  });

  it('rejects an unknown item with a 404 WriteError', async () => {
    await expect(
      applyOperation(hydrated.driver, { kind: 'adjust-quantity', itemId: 'nope', delta: 1 }),
    ).rejects.toMatchObject({ name: 'WriteError', status: 404, code: 'not_found' });
  });

  it('rejects a below-zero adjustment with a 422 and the app’s own message', async () => {
    const err = await applyOperation(hydrated.driver, {
      kind: 'adjust-quantity',
      itemId: 'item-esp32', // total 7
      delta: -10,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(WriteError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('unprocessable');
    expect(err.message).toMatch(/below zero/i);
  });

  it('rejects a non-integer delta with a 422', async () => {
    await expect(
      applyOperation(hydrated.driver, { kind: 'adjust-quantity', itemId: 'item-m3-bolt', delta: 1.5 }),
    ).rejects.toMatchObject({ status: 422, code: 'unprocessable' });
  });

  it('rejects a gauge adjustment on a DISCRETE item with a 422', async () => {
    const err = await applyOperation(hydrated.driver, {
      kind: 'adjust-gauge',
      itemId: 'item-m3-bolt',
      delta: -10,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(WriteError);
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/CONSUMABLE_GAUGE/);
  });
});

// --- the executeWrite orchestrator (injected in-memory file) ----------------------

describe('executeWrite', () => {
  it('applies the mutation and writes the merged snapshot back atomically', async () => {
    let stored = await fixtureJson();
    const detail = await executeWrite({
      snapshotPath: '/virtual/gubbins-sync.json',
      op: { kind: 'adjust-quantity', itemId: 'item-m3-bolt', delta: 5, note: 'restock' },
      io: {
        readSnapshot: async () => stored,
        writeSnapshotAtomic: async (_p, text) => {
          stored = text;
        },
      },
    });
    expect(detail.id).toBe('item-m3-bolt');
    expect(detail.quantity).toBe(47);

    // The written-back snapshot, re-hydrated, must carry the new quantity AND the ledger entry.
    const after = await hydrateFromJson(stored);
    expect(await quantityOf(after.driver, 'item-m3-bolt')).toBe(47);
    const log = await after.driver.query(
      "SELECT 1 FROM item_history WHERE item_id = 'item-m3-bolt' AND action = 'QUANTITY_CHANGE';",
    );
    expect(log.length).toBe(1);
    await after.driver.close();
  });

  it('surfaces a read failure as a 503 (snapshot briefly unavailable)', async () => {
    await expect(
      executeWrite({
        snapshotPath: '/virtual/missing.json',
        op: { kind: 'adjust-quantity', itemId: 'item-m3-bolt', delta: 1 },
        io: {
          readSnapshot: async () => {
            throw new Error('ENOENT');
          },
        },
      }),
    ).rejects.toMatchObject({ status: 503, code: 'snapshot_unavailable' });
  });

  it('serialises concurrent writes so neither is lost', async () => {
    let stored = await fixtureJson();
    const execute = createWriteExecutor('/virtual/gubbins-sync.json', {
      readSnapshot: async () => stored,
      writeSnapshotAtomic: async (_p, text) => {
        stored = text;
      },
    });
    // Fire two +1 writes without awaiting between them; serialisation must apply both.
    await Promise.all([
      execute({ kind: 'adjust-quantity', itemId: 'item-m3-bolt', delta: 1 }),
      execute({ kind: 'adjust-quantity', itemId: 'item-m3-bolt', delta: 1 }),
    ]);
    const after = await hydrateFromJson(stored);
    expect(await quantityOf(after.driver, 'item-m3-bolt')).toBe(44); // 42 + 1 + 1, none lost
    await after.driver.close();
  });
});

// --- the gold round-trip: no drift through the real sync merge --------------------

describe('round-trip through the app’s §7.3 reconcile (no drift)', () => {
  /** Simulate a bridge write: hydrate the on-disk snapshot, apply, and return the snapshot it
   * writes back (what the PWA will later fetch as its "remote"). */
  async function bridgeWriteBack(
    onDiskJson: string,
    op: Parameters<typeof executeWrite>[0]['op'],
  ): Promise<{ json: string; bridge: HydrateResult }> {
    let written = onDiskJson;
    await executeWrite({
      snapshotPath: '/virtual/gubbins-sync.json',
      op,
      io: { readSnapshot: async () => onDiskJson, writeSnapshotAtomic: async (_p, t) => void (written = t) },
    });
    return { json: written, bridge: await hydrateFromJson(written) };
  }

  it('carries a discrete check-out to the PWA via LWW, idempotently', async () => {
    // The PWA's own database (a device), and the snapshot currently on the shared folder.
    const pwa = await hydrateFromJson(await fixtureJson());
    const dictionary = await buildSchemaDictionary(pwa.driver, DICTIONARY_TABLES);
    const onDisk = snapshotToBackupJson(await buildLocalSnapshot(pwa.driver));

    // The bridge checks out 2 (delta -2) and writes the merged snapshot back.
    const { json: bridgeJson, bridge } = await bridgeWriteBack(onDisk, {
      kind: 'adjust-quantity',
      itemId: 'item-m3-bolt',
      delta: -2,
    });
    expect(await quantityOf(bridge.driver, 'item-m3-bolt')).toBe(40);

    // The PWA syncs: fetch the bridge's snapshot, reconcile against local, apply. This is the
    // app's real merge path — the bridge never touches it.
    const remote = JSON.parse(bridgeJson);
    const local = await buildLocalSnapshot(pwa.driver);
    const plan = reconcile(local, remote, { offset: 0, dictionary });
    await applyPlan(pwa.driver, plan, dictionary);
    expect(await quantityOf(pwa.driver, 'item-m3-bolt')).toBe(40); // REMOTE_WINS, no drift

    // Re-running the same sync is a no-op (idempotent — equal clocks resolve REMOTE without change).
    const plan2 = reconcile(await buildLocalSnapshot(pwa.driver), remote, { offset: 0, dictionary });
    await applyPlan(pwa.driver, plan2, dictionary);
    expect(await quantityOf(pwa.driver, 'item-m3-bolt')).toBe(40);

    await pwa.driver.close();
    await bridge.driver.close();
  });

  it('does NOT bulldoze a newer local edit (correct LWW direction)', async () => {
    const pwa = await hydrateFromJson(await fixtureJson());
    const dictionary = await buildSchemaDictionary(pwa.driver, DICTIONARY_TABLES);
    const onDisk = snapshotToBackupJson(await buildLocalSnapshot(pwa.driver));

    // The bridge writes back a -2 from the (now stale) on-disk state...
    const { json: bridgeJson, bridge } = await bridgeWriteBack(onDisk, {
      kind: 'adjust-quantity',
      itemId: 'item-m3-bolt',
      delta: -2,
    });

    // ...but the PWA meanwhile made a LATER local edit (+10), so its updated_at is newest.
    await new ItemRepository(pwa.driver).adjustQuantity('item-m3-bolt', 10);
    const localQtyAfterEdit = await quantityOf(pwa.driver, 'item-m3-bolt'); // 52

    const remote = JSON.parse(bridgeJson);
    const plan = reconcile(await buildLocalSnapshot(pwa.driver), remote, { offset: 0, dictionary });
    await applyPlan(pwa.driver, plan, dictionary);
    // The newer local edit wins LWW on the item_stock row, so the bridge's older -2 is not applied.
    expect(await quantityOf(pwa.driver, 'item-m3-bolt')).toBe(localQtyAfterEdit);

    await pwa.driver.close();
    await bridge.driver.close();
  });

  it('carries a gauge change to the PWA via the §7.3 Delta-CRDT replay', async () => {
    // Build a synthetic gauge item via the app's own create (so the schema/ledger invariant the
    // Delta-CRDT depends on is established the same way the app establishes it). The shared
    // fixture is all-DISCRETE and must stay so (its item count is asserted elsewhere). A gauge's
    // value is reached *via* adjustGauge — which logs the net-value deltas the §7.3 replay
    // reconstructs from — so we create it full (net = gross) then consume 400 to reach 600.
    const seed = createNodeDriver();
    await runMigrations(seed, migrations);
    const seedRepo = new ItemRepository(seed);
    const created = await seedRepo.create({
      name: 'Synthetic Solder Spool',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000 },
    });
    const gauge = await seedRepo.adjustGauge(created.id, { delta: -400 }); // net 1000 → 600
    expect(gauge.gauge!.currentNetValue).toBe(600);
    const onDisk = snapshotToBackupJson(await buildLocalSnapshot(seed));
    await seed.close();

    // The PWA holds the same starting state.
    const pwa = await hydrateFromJson(onDisk);
    const dictionary = await buildSchemaDictionary(pwa.driver, DICTIONARY_TABLES);

    // The bridge consumes 150 (delta -150) → net 450.
    const { json: bridgeJson, bridge } = await bridgeWriteBack(onDisk, {
      kind: 'adjust-gauge',
      itemId: gauge.id,
      delta: -150,
    });
    const bridgeNet = (await new ItemRepository(bridge.driver).getById(gauge.id))!.gauge!.currentNetValue;
    expect(bridgeNet).toBe(450);

    // The PWA syncs: the gauge is present on both sides, so reconcile replays the merged
    // net-value deltas (incl. the bridge's) rather than LWW-ing the field — converging on 450.
    const remote = JSON.parse(bridgeJson);
    const plan = reconcile(await buildLocalSnapshot(pwa.driver), remote, { offset: 0, dictionary });
    expect(plan.gaugeResolutions.some((r) => r.itemId === gauge.id)).toBe(true);
    await applyPlan(pwa.driver, plan, dictionary);
    const pwaNet = (await new ItemRepository(pwa.driver).getById(gauge.id))!.gauge!.currentNetValue;
    expect(pwaNet).toBe(bridgeNet); // converged, no drift

    await pwa.driver.close();
    await bridge.driver.close();
  });
});
