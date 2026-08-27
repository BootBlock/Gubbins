import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations, SQL_NOW_MS } from '@/db/migrations';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { restoreConflictVersion } from './conflict-restore';
import { buildConflict } from './conflict-detect';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';
import { ADMIN_USER_ID } from '@/db/repositories/constants';

async function makeDriver(): Promise<MemoryDriver> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  return driver;
}

/**
 * Read the clock the auto-stamp trigger itself uses, via the very expression the trigger
 * interpolates.
 *
 * Bracketing the restore with two reads of *this* clock — rather than with `Date.now()` —
 * is what makes the re-stamp assertion deterministic. The two are separate clock sources
 * (V8 interpolates a high-resolution timer; SQLite reads the coarser system clock), so under
 * load a `Date.now()` sampled first can legitimately read a millisecond *ahead* of the stamp
 * the trigger goes on to write, failing a comparison that is really only checking "the
 * trigger stamped now".
 */
async function dbNow(driver: MemoryDriver): Promise<number> {
  const row = await driver.queryOne<{ now: number }>(`SELECT ${SQL_NOW_MS} AS now;`);
  return Number(row?.now);
}

describe('restoreConflictVersion (#72)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = await makeDriver();
  });

  afterEach(async () => {
    await driver.close();
  });

  it('re-applies the discarded version and re-stamps updated_at so it wins next sync', async () => {
    // A contact currently holding the "winning" (remote) name, with an old updated_at.
    await driver.execute("INSERT INTO contacts (id, name, updated_at) VALUES ('c1', 'Theirs', 1000);");
    const before = await dbNow(driver);

    const conflict = buildConflict(
      'contacts',
      { id: 'c1', name: 'Mine', updated_at: 500 },
      { id: 'c1', name: 'Theirs', updated_at: 1000 },
      999,
    );
    await restoreConflictVersion(driver, conflict);
    const after = await dbNow(driver);

    const row = await driver.queryOne<{ name: string; updated_at: number }>(
      "SELECT name, updated_at FROM contacts WHERE id = 'c1';",
    );
    expect(row?.name).toBe('Mine'); // the user's version is back
    // The auto-stamp trigger re-stamped updated_at to now (not the stored 500), so a
    // subsequent sync sees it as the newest and propagates it. Bracketed by the trigger's own
    // clock, so the window is exact rather than a lower bound borrowed from another clock.
    const stamped = Number(row?.updated_at);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
    // …and strictly past the remote version it lost to, which is what makes it win next sync.
    expect(stamped).toBeGreaterThan(1000);
  });

  it('resurrects a deleted row and clears its tombstone (DELETE conflict)', async () => {
    // The row was deleted locally by a winning remote tombstone.
    await driver.transaction([
      {
        sql: "INSERT OR REPLACE INTO tombstones (table_name, id, deleted_at) VALUES ('contacts', 'c2', 2000);",
      },
    ]);

    const conflict = buildConflict('contacts', { id: 'c2', name: 'Recovered', updated_at: 500 }, null, 999);
    await restoreConflictVersion(driver, conflict);

    const row = await driver.queryOne<{ name: string }>("SELECT name FROM contacts WHERE id = 'c2';");
    expect(row?.name).toBe('Recovered');
    const tomb = await driver.queryOne(
      "SELECT 1 FROM tombstones WHERE table_name = 'contacts' AND id = 'c2';",
    );
    expect(tomb).toBeUndefined(); // tombstone cleared so the deletion isn't re-propagated
  });

  it('restores an item name without clobbering the CRDT gauge value (non-LWW column)', async () => {
    // The live row holds the delta-CRDT-merged net value (35) and its name "Theirs".
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, unit_of_measure, gross_capacity, tare_weight, current_net_value, quantity, updated_at)
       VALUES ('g1', 'Theirs', ?, 'CONSUMABLE_GAUGE', 'g', 100, 0, 35, 0, 1000);`,
      [UNASSIGNED_LOCATION_ID],
    );
    // The user's discarded version carried a stale pre-merge net value (40) — restoring the
    // name must NOT drag that stale value back over the CRDT-merged 35.
    const gauge = (name: string, netValue: number, updatedAt: number) => ({
      id: 'g1',
      name,
      location_id: UNASSIGNED_LOCATION_ID,
      tracking_mode: 'CONSUMABLE_GAUGE',
      unit_of_measure: 'g',
      gross_capacity: 100,
      tare_weight: 0,
      current_net_value: netValue,
      quantity: 0,
      updated_at: updatedAt,
    });
    const conflict = buildConflict('items', gauge('Mine', 40, 500), gauge('Theirs', 35, 1000), 999);
    await restoreConflictVersion(driver, conflict);

    const row = await driver.queryOne<{ name: string; current_net_value: number }>(
      "SELECT name, current_net_value FROM items WHERE id = 'g1';",
    );
    expect(row?.name).toBe('Mine'); // the user's name is back
    expect(Number(row?.current_net_value)).toBe(35); // CRDT value preserved, not clobbered to 40
  });

  it('restores an item edit against the live schema', async () => {
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, quantity, updated_at)
       VALUES ('i1', 'Theirs', ?, 'DISCRETE', 1, 1000);`,
      [UNASSIGNED_LOCATION_ID],
    );
    const conflict = buildConflict(
      'items',
      {
        id: 'i1',
        name: 'Mine',
        location_id: UNASSIGNED_LOCATION_ID,
        tracking_mode: 'DISCRETE',
        quantity: 1,
        updated_at: 500,
      },
      {
        id: 'i1',
        name: 'Theirs',
        location_id: UNASSIGNED_LOCATION_ID,
        tracking_mode: 'DISCRETE',
        quantity: 1,
        updated_at: 1000,
      },
      999,
    );
    await restoreConflictVersion(driver, conflict);
    const row = await driver.queryOne<{ name: string }>("SELECT name FROM items WHERE id = 'i1';");
    expect(row?.name).toBe('Mine');
  });
});

describe('restoreConflictVersion is inside the permission boundary (issue #429)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = await makeDriver();
    await driver.execute("INSERT INTO contacts (id, name, updated_at) VALUES ('c1', 'Theirs', 1000);");
  });

  afterEach(async () => {
    useSessionStore.getState().setResolved(UNRESTRICTED_AUTHORITY, ADMIN_USER_ID);
    await driver.close();
  });

  const conflict = () =>
    buildConflict(
      'contacts',
      { id: 'c1', name: 'Mine', updated_at: 500 },
      { id: 'c1', name: 'Theirs', updated_at: 1000 },
      999,
    );

  it('refuses a session without `sync:write`, leaving the merged row alone', async () => {
    // Reading the conflict list is one thing; overturning what every device agreed on — and
    // pushing that decision to all of them — is `sync:write`.
    useSessionStore.getState().setResolved({ mode: 'granted', grants: new Set(['sync:read']) }, 'user-1');

    await expect(restoreConflictVersion(driver, conflict())).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    const row = await driver.queryOne<{ name: string }>("SELECT name FROM contacts WHERE id = 'c1';");
    expect(row?.name).toBe('Theirs');
  });

  it('allows a role that holds `sync:write`', async () => {
    useSessionStore.getState().setResolved({ mode: 'granted', grants: new Set(['sync:write']) }, 'user-1');

    await expect(restoreConflictVersion(driver, conflict())).resolves.toBeUndefined();
    const row = await driver.queryOne<{ name: string }>("SELECT name FROM contacts WHERE id = 'c1';");
    expect(row?.name).toBe('Mine');
  });
});
