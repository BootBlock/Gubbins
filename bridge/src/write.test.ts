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
import { ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE, SYNC_TABLES } from '@/db/repositories';
import { ADMIN_USER_ID, SYSTEM_USER_ID } from '@/db/repositories/constants';
import { UserRepository } from '@/db/repositories/UserRepository.ts';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { CheckoutRepository } from '@/db/repositories/CheckoutRepository.ts';
import { reconcile } from '@/features/sync/reconcile';
import { applyPlan, buildLocalSnapshot, buildSchemaDictionary } from '@/features/sync/snapshot';
import { snapshotToBackupJson } from '@/features/sync/backup';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { createNodeDriver } from './node-driver.ts';
import { hydrateFromJson, type HydrateResult } from './hydrate.ts';
import {
  applyOperation,
  createWriteExecutor,
  executeWrite,
  MAX_BORROWER_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  WriteError,
} from './write.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);
const DICTIONARY_TABLES = [...SYNC_TABLES, ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE];
/**
 * The actor every write in this file is attributed to. Since issue #79 the bridge writes as the
 * owner of the token that authorised the request; these tests drive the layer below that, so they
 * name an actor explicitly — which is exactly the point of making it a required argument.
 */
const ACTOR = ADMIN_USER_ID;

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
    const { item } = await applyOperation(
      hydrated.driver,
      {
        kind: 'adjust-quantity',
        itemId: 'item-m3-bolt',
        delta: 5,
      },
      ACTOR,
    );
    expect(item.quantity).toBe(47);
    const history = await hydrated.driver.query<{ action: string; quantity_delta: number }>(
      "SELECT action, quantity_delta FROM item_history WHERE item_id = 'item-m3-bolt' ORDER BY created_at DESC LIMIT 1;",
    );
    expect(history[0]?.action).toBe('QUANTITY_CHANGE');
    expect(Number(history[0]?.quantity_delta)).toBe(5);
  });

  // Issue #79: the bridge used to attribute every write to System because a shared token named
  // nobody. It now writes as the owner of the presented token, which is the whole point of the
  // per-user credential — the ledger has to say who, not merely what.
  it('attributes the ledger entry to the actor it was given, not to System', async () => {
    const actor = await new UserRepository(hydrated.driver).create({
      username: 'kit',
      displayName: 'Kit Alvarez',
    });
    await applyOperation(
      hydrated.driver,
      { kind: 'adjust-quantity', itemId: 'item-m3-bolt', delta: 1 },
      actor.id,
    );
    const history = await hydrated.driver.query<{ actor_user_id: string }>(
      "SELECT actor_user_id FROM item_history WHERE item_id = 'item-m3-bolt' ORDER BY created_at DESC LIMIT 1;",
    );
    expect(history[0]?.actor_user_id).toBe(actor.id);
    expect(history[0]?.actor_user_id).not.toBe(SYSTEM_USER_ID);
  });

  it('adjusts a DISCRETE quantity down', async () => {
    const { item } = await applyOperation(
      hydrated.driver,
      {
        kind: 'adjust-quantity',
        itemId: 'item-m3-bolt',
        delta: -2,
      },
      ACTOR,
    );
    expect(item.quantity).toBe(40);
  });

  it('rejects an unknown item with a 404 WriteError', async () => {
    await expect(
      applyOperation(hydrated.driver, { kind: 'adjust-quantity', itemId: 'nope', delta: 1 }, ACTOR),
    ).rejects.toMatchObject({ name: 'WriteError', status: 404, code: 'not_found' });
  });

  it('rejects a below-zero adjustment with a 422 and the app’s own message', async () => {
    const err = await applyOperation(
      hydrated.driver,
      {
        kind: 'adjust-quantity',
        itemId: 'item-esp32', // total 7
        delta: -10,
      },
      ACTOR,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(WriteError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('unprocessable');
    expect(err.message).toMatch(/below zero/i);
  });

  it('rejects a non-integer delta with a 422', async () => {
    await expect(
      applyOperation(hydrated.driver, { kind: 'adjust-quantity', itemId: 'item-m3-bolt', delta: 1.5 }, ACTOR),
    ).rejects.toMatchObject({ status: 422, code: 'unprocessable' });
  });

  it('rejects a note longer than the documented bound with a 422', async () => {
    // The bound lives here, in the shared core, so BOTH write surfaces (HTTP and the MCP tools)
    // honour it — an unbounded string must never reach the history ledger.
    const err = await applyOperation(
      hydrated.driver,
      {
        kind: 'adjust-quantity',
        itemId: 'item-m3-bolt',
        delta: 1,
        note: 'x'.repeat(MAX_NOTE_LENGTH + 1),
      },
      ACTOR,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(WriteError);
    expect(err.status).toBe(422);
  });

  it('accepts a note exactly at the bound', async () => {
    const { item } = await applyOperation(
      hydrated.driver,
      {
        kind: 'adjust-quantity',
        itemId: 'item-m3-bolt',
        delta: 1,
        note: 'x'.repeat(MAX_NOTE_LENGTH),
      },
      ACTOR,
    );
    expect(item.id).toBe('item-m3-bolt');
  });

  // --- loans (issue #142) ---------------------------------------------------------

  it('checks an item out to a new contact, drawing the units down', async () => {
    const { item, checkout } = await applyOperation(
      hydrated.driver,
      { kind: 'check-out', itemId: 'item-m3-bolt', contactName: 'Sam Okafor', quantity: 2 },
      ACTOR,
    );
    expect(item.quantity).toBe(40); // 42 - 2, out with the borrower
    expect(checkout).not.toBeNull();
    expect(checkout!.itemId).toBe('item-m3-bolt');
    expect(checkout!.borrowerType).toBe('contact');
    expect(checkout!.returnedAt).toBeNull();
    const history = await hydrated.driver.query<{ action: string }>(
      "SELECT action FROM item_history WHERE item_id = 'item-m3-bolt' ORDER BY created_at DESC LIMIT 1;",
    );
    expect(history[0]?.action).toBe('CHECKED_OUT');
  });

  it('rejects an over-long borrower name with a 422', async () => {
    // `contactName` CREATES a row and lands in the ledger note, so it is bounded for the same
    // reason a note is — the MCP transport has no body cap to fall back on.
    await expect(
      applyOperation(
        hydrated.driver,
        {
          kind: 'check-out',
          itemId: 'item-m3-bolt',
          contactName: 'x'.repeat(MAX_BORROWER_NAME_LENGTH + 1),
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 422, code: 'unprocessable' });
  });

  it('anchors a yyyy-MM-dd due date at local end-of-day, as the app does', async () => {
    const { checkout } = await applyOperation(
      hydrated.driver,
      { kind: 'check-out', itemId: 'item-m3-bolt', contactName: 'Sam Okafor', dueDate: '2026-08-14' },
      ACTOR,
    );
    // Not midnight UTC: a deadline belongs to the borrower's own day (issue #318), so the
    // instant read back as a *local* calendar day must still be the 14th.
    expect(checkout!.dueDate).toBe(new Date('2026-08-14T23:59:59').getTime());
  });

  it('rejects a due date that is not a plain calendar day with a 422', async () => {
    // The last two are the ones a shape check alone would miss: `Date` rolls a non-existent day
    // forward, so 31 February would silently become 3 March.
    for (const dueDate of [
      '14 August 2026',
      '2026-08-14T12:00:00Z',
      'tomorrow',
      '2026-02-31',
      '2026-13-01',
    ]) {
      await expect(
        applyOperation(
          hydrated.driver,
          { kind: 'check-out', itemId: 'item-m3-bolt', contactName: 'Sam Okafor', dueDate },
          ACTOR,
        ),
      ).rejects.toMatchObject({ status: 422, code: 'unprocessable' });
    }
  });

  it('rejects a check-out with no borrower, in the app’s own words', async () => {
    const err = await applyOperation(
      hydrated.driver,
      { kind: 'check-out', itemId: 'item-m3-bolt' },
      ACTOR,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(WriteError);
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/borrower/i);
  });

  it('rejects a check-out of more than is on hand with a 422', async () => {
    await expect(
      applyOperation(
        hydrated.driver,
        { kind: 'check-out', itemId: 'item-esp32', contactName: 'Sam Okafor', quantity: 99 },
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 422, code: 'unprocessable' });
  });

  it('checks the item’s single open loan back in without being told which', async () => {
    await applyOperation(
      hydrated.driver,
      { kind: 'check-out', itemId: 'item-m3-bolt', contactName: 'Sam Okafor', quantity: 2 },
      ACTOR,
    );
    const { item, checkout } = await applyOperation(
      hydrated.driver,
      { kind: 'check-in', itemId: 'item-m3-bolt', note: 'All back' },
      ACTOR,
    );
    expect(item.quantity).toBe(42); // restored
    expect(checkout!.returnedAt).not.toBeNull(); // RETURNED is derived from this
    expect(checkout!.returnNote).toBe('All back');
  });

  it('refuses to guess when the item has more than one open loan', async () => {
    for (const contactName of ['Sam Okafor', 'Ada Quinn']) {
      await applyOperation(
        hydrated.driver,
        { kind: 'check-out', itemId: 'item-m3-bolt', contactName, quantity: 1 },
        ACTOR,
      );
    }
    const err = await applyOperation(
      hydrated.driver,
      { kind: 'check-in', itemId: 'item-m3-bolt' },
      ACTOR,
    ).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/checkoutId/);
  });

  it('closes the named loan when there are several', async () => {
    const first = await applyOperation(
      hydrated.driver,
      { kind: 'check-out', itemId: 'item-m3-bolt', contactName: 'Sam Okafor', quantity: 1 },
      ACTOR,
    );
    await applyOperation(
      hydrated.driver,
      { kind: 'check-out', itemId: 'item-m3-bolt', contactName: 'Ada Quinn', quantity: 3 },
      ACTOR,
    );
    const { item, checkout } = await applyOperation(
      hydrated.driver,
      { kind: 'check-in', itemId: 'item-m3-bolt', checkoutId: first.checkout!.id },
      ACTOR,
    );
    expect(checkout!.id).toBe(first.checkout!.id);
    expect(item.quantity).toBe(39); // 42 - 1 - 3, then the 1 comes back
  });

  it('rejects a check-in for an item that is not on loan with a 422', async () => {
    await expect(
      applyOperation(hydrated.driver, { kind: 'check-in', itemId: 'item-m3-bolt' }, ACTOR),
    ).rejects.toMatchObject({ status: 422, code: 'unprocessable' });
  });

  it('rejects a checkoutId belonging to a different item with a 404', async () => {
    const other = await applyOperation(
      hydrated.driver,
      { kind: 'check-out', itemId: 'item-esp32', contactName: 'Sam Okafor', quantity: 1 },
      ACTOR,
    );
    // Naming another item's loan under /items/item-m3-bolt/check-in is a mistake, not a licence
    // to return that other item.
    await expect(
      applyOperation(
        hydrated.driver,
        { kind: 'check-in', itemId: 'item-m3-bolt', checkoutId: other.checkout!.id },
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect((await new ItemRepository(hydrated.driver).getById('item-esp32'))!.quantity).toBe(6);
  });

  it('rejects re-returning an already-returned loan with a 422', async () => {
    const lent = await applyOperation(
      hydrated.driver,
      { kind: 'check-out', itemId: 'item-m3-bolt', contactName: 'Sam Okafor', quantity: 1 },
      ACTOR,
    );
    await applyOperation(
      hydrated.driver,
      { kind: 'check-in', itemId: 'item-m3-bolt', checkoutId: lent.checkout!.id },
      ACTOR,
    );
    await expect(
      applyOperation(
        hydrated.driver,
        { kind: 'check-in', itemId: 'item-m3-bolt', checkoutId: lent.checkout!.id },
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 422, code: 'unprocessable' });
  });

  // --- moving stock between locations (issue #142) ---------------------------------

  it('moves stock between placements, leaving the total alone', async () => {
    // item-esp32 is split 5 at Shelf 2 (its home) and 2 at Bin 4.
    const { item } = await applyOperation(
      hydrated.driver,
      {
        kind: 'transfer-stock',
        itemId: 'item-esp32',
        fromLocationId: 'loc-shelf-2',
        toLocationId: 'loc-bin-4',
        quantity: 3,
      },
      ACTOR,
    );
    expect(item.quantity).toBe(7); // a move, not a change in how much there is
    const placements = await new ItemRepository(hydrated.driver).listStock('item-esp32');
    const at = (id: string) => placements.find((p) => p.locationId === id)?.quantity ?? 0;
    expect(at('loc-shelf-2')).toBe(2);
    expect(at('loc-bin-4')).toBe(5);
  });

  it('refuses a transfer larger than the source holds rather than moving part of it', async () => {
    // The repository clamps for the UI's benefit; over the API a partial move would be a silent
    // wrong answer, so the shortfall is a 422 and NOTHING moves.
    const err = await applyOperation(
      hydrated.driver,
      {
        kind: 'transfer-stock',
        itemId: 'item-esp32',
        fromLocationId: 'loc-bin-4',
        toLocationId: 'loc-shelf-2',
        quantity: 10,
      },
      ACTOR,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(WriteError);
    expect(err.status).toBe(422);
    const placements = await new ItemRepository(hydrated.driver).listStock('item-esp32');
    expect(placements.find((p) => p.locationId === 'loc-bin-4')?.quantity).toBe(2); // untouched
  });

  it('rejects a fractional or non-positive transfer quantity with a 422', async () => {
    for (const quantity of [0, -1, 1.5]) {
      await expect(
        applyOperation(
          hydrated.driver,
          {
            kind: 'transfer-stock',
            itemId: 'item-esp32',
            fromLocationId: 'loc-shelf-2',
            toLocationId: 'loc-bin-4',
            quantity,
          },
          ACTOR,
        ),
      ).rejects.toMatchObject({ status: 422, code: 'unprocessable' });
    }
  });

  it('rejects a gauge adjustment on a DISCRETE item with a 422', async () => {
    const err = await applyOperation(
      hydrated.driver,
      {
        kind: 'adjust-gauge',
        itemId: 'item-m3-bolt',
        delta: -10,
      },
      ACTOR,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(WriteError);
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/CONSUMABLE_GAUGE/);
  });
});

// --- the executeWrite orchestrator (injected in-memory file) ----------------------

describe('executeWrite', () => {
  it('applies the mutation and writes the merged snapshot back atomically', async () => {
    let stored = await fixtureJson();
    const result = await executeWrite({
      actorUserId: ACTOR,
      snapshotPath: '/virtual/gubbins-sync.json',
      op: { kind: 'adjust-quantity', itemId: 'item-m3-bolt', delta: 5, note: 'restock' },
      io: {
        readSnapshot: async () => stored,
        writeSnapshotAtomic: async (_p, text) => {
          stored = text;
        },
      },
    });
    expect(result.item.id).toBe('item-m3-bolt');
    expect(result.item.quantity).toBe(47);
    expect(result.checkout).toBeNull(); // a stock adjustment opens no loan

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
        actorUserId: ACTOR,
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
      execute({ kind: 'adjust-quantity', itemId: 'item-m3-bolt', delta: 1 }, ACTOR),
      execute({ kind: 'adjust-quantity', itemId: 'item-m3-bolt', delta: 1 }, ACTOR),
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
      actorUserId: ACTOR,
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

  it('carries a loan and its return to the PWA, idempotently (issue #142)', async () => {
    const pwa = await hydrateFromJson(await fixtureJson());
    const dictionary = await buildSchemaDictionary(pwa.driver, DICTIONARY_TABLES);
    const onDisk = snapshotToBackupJson(await buildLocalSnapshot(pwa.driver));

    // The bridge lends 2 out. A loan is not one row: it inserts a `checkouts` row (and a
    // `contacts` row for the new borrower) as well as drawing the stock down, so this is the
    // check that the whole set travels, not just the quantity.
    const { json: lentJson, bridge } = await bridgeWriteBack(onDisk, {
      kind: 'check-out',
      itemId: 'item-m3-bolt',
      contactName: 'Sam Okafor',
      quantity: 2,
    });
    expect(await quantityOf(bridge.driver, 'item-m3-bolt')).toBe(40);

    const lentRemote = JSON.parse(lentJson);
    const lentPlan = reconcile(await buildLocalSnapshot(pwa.driver), lentRemote, { offset: 0, dictionary });
    await applyPlan(pwa.driver, lentPlan, dictionary);
    expect(await quantityOf(pwa.driver, 'item-m3-bolt')).toBe(40);
    const open = await new CheckoutRepository(pwa.driver).listOpen();
    expect(
      open.rows.map((r) => ({ itemId: r.itemId, borrowerName: r.borrowerName, quantity: r.quantity })),
    ).toEqual([{ itemId: 'item-m3-bolt', borrowerName: 'Sam Okafor', quantity: 2 }]);

    // Re-running the same sync changes nothing (equal clocks resolve REMOTE without a write).
    const replay = reconcile(await buildLocalSnapshot(pwa.driver), lentRemote, { offset: 0, dictionary });
    await applyPlan(pwa.driver, replay, dictionary);
    expect((await new CheckoutRepository(pwa.driver).listOpen()).rows).toHaveLength(1);

    // ...and the return travels the same way, closing that very loan on the PWA side.
    const { json: backJson, bridge: bridgeBack } = await bridgeWriteBack(lentJson, {
      kind: 'check-in',
      itemId: 'item-m3-bolt',
    });
    const backPlan = reconcile(await buildLocalSnapshot(pwa.driver), JSON.parse(backJson), {
      offset: 0,
      dictionary,
    });
    await applyPlan(pwa.driver, backPlan, dictionary);
    expect(await quantityOf(pwa.driver, 'item-m3-bolt')).toBe(42);
    expect((await new CheckoutRepository(pwa.driver).listOpen()).rows).toHaveLength(0);

    await pwa.driver.close();
    await bridge.driver.close();
    await bridgeBack.driver.close();
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
