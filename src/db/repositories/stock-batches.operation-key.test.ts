import { describe, it, expect } from 'vitest';
import { createMemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { withOperationKey } from './stock-batches';

/**
 * The capture seam a one-shot terminal operation brackets its stock writes with (issue #696), so
 * both devices that run it offline derive the same `stock_deltas` ids and the merge reads one
 * movement rather than two.
 *
 * The key's shape is a real constraint, not a formality: the derivation joins it to the placement
 * with `|` and counts the operation's existing rows by a `LIKE` prefix, so a key carrying `|`, `%`
 * or `_` would mint ids that collide or miscount — silently, and in the ledger. It is rejected here
 * as well as by the column's own CHECK.
 */
describe('withOperationKey (issue #696)', () => {
  const key = '1e3a5c7d-0000-5000-8000-abcdefabcdef';
  const write = { sql: 'UPDATE stock_batches SET quantity = 1 WHERE id = ?;', params: ['x'] };

  it('brackets the writes with the key, and clears it afterwards', () => {
    const statements = withOperationKey(key, [write]);
    expect(statements).toHaveLength(3);
    expect(statements[0]!.params).toEqual([key]);
    expect(statements[1]).toBe(write);
    expect(statements[2]!.sql).toContain('operation_key = NULL');
  });

  it('leaves an empty batch unbracketed — there is nothing to capture', () => {
    expect(withOperationKey(key, [])).toEqual([]);
  });

  it.each([
    'not-a-uuid',
    '1E3A5C7D-0000-5000-8000-ABCDEFABCDEF', // upper case: the ids are minted lower-case
    '1e3a5c7d|0000-5000-8000-abcdefabcdef', // the derivation's own separator
    '1e3a5c7d-0000-5000-8000-abcdefabcde%', // a LIKE wildcard the ordinal would count by
    '1e3a5c7d-0000-5000-8000-abcdefabcde_',
  ])('refuses a key that is not a canonical lower-case UUID (%s)', (bad) => {
    expect(() => withOperationKey(bad, [write])).toThrow(DbError);
  });

  it('is refused by the column itself, so no path can set a key of the wrong shape', async () => {
    const driver = createMemoryDriver();
    try {
      await runMigrations(driver, migrations);
      await expect(
        driver.execute("UPDATE stock_delta_capture SET operation_key = 'a|b' WHERE id = 1;"),
      ).rejects.toThrow();
      await driver.execute('UPDATE stock_delta_capture SET operation_key = ? WHERE id = 1;', [key]);
    } finally {
      await driver.close();
    }
  });
});
