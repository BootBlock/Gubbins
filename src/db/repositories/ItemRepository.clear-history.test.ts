import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '../errors';
import { ItemRepository } from './ItemRepository';
import { ADMIN_USER_ID } from './constants';

/**
 * Clearing one item's Activity Log (issue #620) — `ItemRepository.clearHistory`. A real
 * `:memory:` SQL test, because the interesting behaviour is in the statements: the ledger is
 * append-only and guarded by an immutability trigger, and the marker's own count has to see
 * the ledger as it stood *before* the delete that follows it in the same transaction.
 */
describe('ItemRepository.clearHistory (issue #620)', () => {
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

  it('replaces the whole log with one entry naming who cleared it and how much went', async () => {
    const item = await items.create({ name: 'Filament', quantity: 10 });
    await items.update(item.id, { name: 'PLA Filament' });
    await items.adjustQuantity(item.id, 5);
    expect((await items.getHistory(item.id)).rows).toHaveLength(3);

    await items.clearHistory(item.id, 'Ada');

    const after = await items.getHistory(item.id);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.action).toBe('HISTORY_CLEARED');
    expect(after.rows[0]?.note).toBe('Activity log cleared by Ada. 3 earlier entries were removed.');
    // The authoritative attribution is the actor column, not the note's label.
    const [row] = await driver.query<{ actor_user_id: string }>(
      'SELECT actor_user_id FROM item_history WHERE item_id = ?;',
      [item.id],
    );
    expect(row?.actor_user_id).toBe(ADMIN_USER_ID);
  });

  it('says "entry" rather than "entries" when exactly one is removed', async () => {
    const item = await items.create({ name: 'Solo' });

    await items.clearHistory(item.id, 'Ada');

    const after = await items.getHistory(item.id);
    expect(after.rows[0]?.note).toBe('Activity log cleared by Ada. 1 earlier entry was removed.');
  });

  it('leaves an already-cleared log with a fresh marker reporting the one it replaced', async () => {
    const item = await items.create({ name: 'Twice' });
    await items.clearHistory(item.id, 'Ada');
    await items.clearHistory(item.id, 'Grace');

    const after = await items.getHistory(item.id);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.note).toBe('Activity log cleared by Grace. 1 earlier entry was removed.');
  });

  it('leaves every other item’s log alone', async () => {
    const cleared = await items.create({ name: 'Cleared' });
    const kept = await items.create({ name: 'Kept' });
    await items.update(kept.id, { name: 'Kept v2' });

    await items.clearHistory(cleared.id, 'Ada');

    expect((await items.getHistory(kept.id)).rows).toHaveLength(2);
    expect((await items.getHistory(kept.id)).rows.map((r) => r.action)).not.toContain('HISTORY_CLEARED');
  });

  it('leaves the item and its stock untouched — only the record of them goes', async () => {
    const item = await items.create({ name: 'Bolts', quantity: 7 });

    await items.clearHistory(item.id, 'Ada');

    const after = await items.getById(item.id);
    expect(after?.name).toBe('Bolts');
    expect(after?.quantity).toBe(7);
  });

  it('refuses a clear for an item that does not exist rather than writing an orphan marker', async () => {
    await expect(items.clearHistory('no-such-item', 'Ada')).rejects.toBeInstanceOf(DbError);
    const rows = await driver.query('SELECT id FROM item_history;');
    expect(rows).toHaveLength(0);
  });

  it('requires audit:delete — the permission that guards destroying an audit trail', async () => {
    const item = await items.create({ name: 'Guarded' });
    const restricted = new ItemRepository(driver, {
      // Everything an item write needs, but not the audit-deletion grant.
      resolveAuthority: () => ({ mode: 'granted', grants: new Set(['items:*', 'stock:*']) }),
    });

    await expect(restricted.clearHistory(item.id, 'Ada')).rejects.toBeInstanceOf(DbError);
    expect((await items.getHistory(item.id)).rows).toHaveLength(1);
  });
});
