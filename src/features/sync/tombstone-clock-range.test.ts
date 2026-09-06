/**
 * Regression cover for issue #876 — a tombstone's `deletedAt` is a clock, not just a number.
 *
 * The tombstone check at the {@link parseBackupJson} trust boundary tested `deletedAt` for being
 * finite, but not for being a *plausible* instant, while the snapshot's own clock and a gauge
 * delta's `createdAt` in the same module were both range-checked. A marker stamped far beyond any
 * real date — the year 318857, say — was therefore accepted and stored, and then:
 *
 *   - never expired, because the 180-day TTL prune compares against it and it is always ahead;
 *   - won every Last-Write-Wins comparison against the row it deletes, so that id could not be
 *     re-created on any device the snapshot reached;
 *   - was republished to every peer on each pass, so it spread.
 *
 * On a bridge host it also stopped sync and backup outright: `tombstones.deleted_at` is a STRICT
 * INTEGER column and Node's SQLite driver refuses to hand back an integer above
 * `Number.MAX_SAFE_INTEGER`, so building a snapshot threw — before the prune that might have
 * cleared it ever ran.
 *
 * Two limbs, each with a control:
 *   1. the parser now applies the same range check the other two clocks get;
 *   2. `buildLocalSnapshot` bounds its read, so a device poisoned by a build predating limb 1
 *      recovers instead of being stranded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { MAX_TIMESTAMP } from '@/lib/timestamp';
import { parseBackupJson, restoreFromBackupJson } from './backup';
import { buildLocalSnapshot } from './snapshot';

/** The value from the issue: finite, an integer, and beyond anything a clock produces. */
const ABSURD = 1e16;

function snapshotWith(deletedAt: unknown, id = 'i-1'): string {
  return JSON.stringify({
    formatVersion: 1,
    tables: {},
    tombstones: [{ tableName: 'items', id, deletedAt }],
  });
}

describe('issue #876 — the deletion clock takes the same range check as the other two', () => {
  it.each([
    ['the value that breaks the bridge driver', ABSURD],
    ['a value beyond the representable Date range', 1e308],
    ['the same magnitude in the past', -ABSURD],
  ])('refuses a snapshot carrying %s', (_label, deletedAt) => {
    expect(() => parseBackupJson(snapshotWith(deletedAt))).toThrow(/not part of Gubbins/i);
  });

  // The controls: the bound must not have been tightened onto ordinary data. An honest deletion
  // instant, and the widest instant `Date` can represent, both still parse.
  it('still accepts an ordinary deletion instant', () => {
    const snapshot = parseBackupJson(snapshotWith(1_751_000_000_000));
    expect(snapshot.tombstones[0]?.deletedAt).toBe(1_751_000_000_000);
  });

  it('still accepts the widest instant the range allows', () => {
    expect(parseBackupJson(snapshotWith(MAX_TIMESTAMP)).tombstones[0]?.deletedAt).toBe(MAX_TIMESTAMP);
  });
});

describe('issue #876 — a crafted marker cannot reach the database', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('refuses the whole restore and leaves the row it names intact', async () => {
    const item = await items.create({ name: 'Still here', locationId: UNASSIGNED_LOCATION_ID });

    await expect(restoreFromBackupJson(driver, snapshotWith(ABSURD, item.id))).rejects.toThrow(
      /not part of Gubbins/i,
    );

    expect((await items.getById(item.id))?.name).toBe('Still here');
    const held = await driver.query('SELECT id FROM tombstones WHERE table_name = ?;', ['items']);
    expect(held).toEqual([]);
  });

  // The control for the limb above: an honest marker in the same shape *is* adopted, so the
  // rejection above is the range check doing its job rather than tombstones being ignored.
  // (A marker is adopted only for a row this device does not hold — issue #202 — hence an id
  // that was never created here.)
  it('still adopts an honest marker in the same snapshot shape', async () => {
    const deletedAt = Date.now();

    await restoreFromBackupJson(driver, snapshotWith(deletedAt, 'never-existed-here'));

    const held = await driver.query<{ id: string; deleted_at: number }>(
      'SELECT id, deleted_at FROM tombstones WHERE table_name = ?;',
      ['items'],
    );
    expect(held).toEqual([{ id: 'never-existed-here', deleted_at: deletedAt }]);
  });
});

describe('issue #876 — a device poisoned by an earlier build recovers', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    // The row a build predating the parser check would have persisted, alongside an honest one.
    await driver.execute('INSERT INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?), (?, ?, ?);', [
      'items',
      'poisoned',
      ABSURD,
      'items',
      'honest',
      1_751_000_000_000,
    ]);
  });

  afterEach(async () => {
    await driver.close();
  });

  // This is the control *and* the reason the bound is applied in SQL rather than after the read:
  // the driver refuses to marshal the value at all, so no amount of filtering in JavaScript could
  // have saved a read that asks for it. Remove the `BETWEEN` from `buildLocalSnapshot` and the
  // test below fails with exactly this error.
  it('cannot read the poisoned marker back at all', async () => {
    await expect(driver.query('SELECT deleted_at FROM tombstones;')).rejects.toThrow(
      /too large to be represented/i,
    );
  });

  it('builds a snapshot that omits the poisoned marker and keeps the honest one', async () => {
    const snapshot = await buildLocalSnapshot(driver);

    const ids = snapshot.tombstones.filter((t) => t.tableName === 'items').map((t) => t.id);
    expect(ids).toContain('honest');
    expect(ids).not.toContain('poisoned');
  });
});
