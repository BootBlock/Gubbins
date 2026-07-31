import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { LocationRepository } from './LocationRepository';
import { locationHistoryStatement } from './location-history';
import { ADMIN_USER_ID } from './constants';

/**
 * The guarded activity INSERT (issue #691).
 *
 * `LocationRepository.update` folds the same atomic cycle guard the `UPDATE` carries into every
 * activity entry it emits, so a move a concurrent re-parent has made illegal records nothing.
 * That race cannot be staged through the repository — its pre-check rejects the easy case first —
 * so the guard is exercised here against the statement builder directly, which is the only place
 * the "insert nothing" behaviour can actually be observed.
 */
describe('locationHistoryStatement guard (#691)', () => {
  let driver: MemoryDriver;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  const countFor = async (id: string) =>
    (await driver.queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM location_history WHERE location_id = ?;',
      [id],
    ))!.n;

  it('writes the entry when the guard holds', async () => {
    const shelf = await locations.create({ name: 'Shelf' });
    const before = await countFor(shelf.id);

    const stmt = locationHistoryStatement(shelf.id, 'Shelf', 'RENAMED', ADMIN_USER_ID, {
      note: 'Renamed.',
      guard: { sql: '1 = 1', params: [] },
    });
    await driver.execute(stmt.sql, stmt.params ?? []);

    expect(await countFor(shelf.id)).toBe(before + 1);
  });

  it('writes nothing at all when the guard does not hold', async () => {
    const shelf = await locations.create({ name: 'Shelf' });
    const before = await countFor(shelf.id);

    const stmt = locationHistoryStatement(shelf.id, 'Shelf', 'RE_PARENTED', ADMIN_USER_ID, {
      note: 'Moved.',
      guard: { sql: '1 = 0', params: [] },
    });
    await driver.execute(stmt.sql, stmt.params ?? []);

    expect(await countFor(shelf.id)).toBe(before);
  });

  it('binds the guard’s parameters after the row’s, in order', async () => {
    const shelf = await locations.create({ name: 'Shelf' });

    const stmt = locationHistoryStatement(shelf.id, 'Shelf', 'ARCHIVED', ADMIN_USER_ID, {
      // A guard whose truth depends on its own bindings, so a mis-ordered params array would
      // either bind the wrong value or fail arity rather than quietly passing.
      guard: { sql: '? = ?', params: ['same', 'same'] },
    });
    await driver.execute(stmt.sql, stmt.params ?? []);

    expect(await countFor(shelf.id)).toBe(2); // CREATED plus this one
  });
});
