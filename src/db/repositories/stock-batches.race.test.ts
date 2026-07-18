import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { isQuantityFloorViolation, runStockDraw, STOCK_DRAW_RACE_MESSAGE } from './stock-batches';

/**
 * A drawdown plans its per-batch decrements from a read taken *before* its transaction, so two
 * overlapping decrements can both plan against the same on-hand and the loser trips the ledger's
 * `CHECK (quantity >= 0)` (issue #302). The constraint is the right backstop — these cover that
 * it reaches the caller as validation rather than as a raw SQLite constraint message.
 */
describe('the stock drawdown backstop (#302)', () => {
  describe('isQuantityFloorViolation', () => {
    // The three drivers disagree on the code for this identical failure, so the predicate must
    // key on the message alone or it misses in the browser — see its doc comment.
    it.each(['SQLITE_CONSTRAINT', 'TRANSACTION_FAILED', 'UNKNOWN'] as const)(
      'recognises the quantity floor CHECK reported under %s',
      (code) => {
        expect(isQuantityFloorViolation(new DbError(code, 'CHECK constraint failed: quantity >= 0'))).toBe(
          true,
        );
      },
    );

    it('leaves every other failure alone', () => {
      expect(
        isQuantityFloorViolation(
          new DbError('SQLITE_CONSTRAINT', "CHECK constraint failed: tracking_mode <> 'SERIALISED'"),
        ),
      ).toBe(false);
      expect(
        isQuantityFloorViolation(
          new DbError('SQLITE_CONSTRAINT_FOREIGNKEY', 'FOREIGN KEY constraint failed'),
        ),
      ).toBe(false);
      // A different quantity CHECK (the gauge net-value floor) must not be mistaken for it.
      expect(
        isQuantityFloorViolation(new DbError('SQLITE_CONSTRAINT', 'CHECK constraint failed: net_value >= 0')),
      ).toBe(false);
      expect(isQuantityFloorViolation(new Error('CHECK constraint failed: quantity >= 0'))).toBe(false);
      expect(isQuantityFloorViolation(undefined)).toBe(false);
    });
  });

  describe('against the real ledger', () => {
    let driver: MemoryDriver;
    let items: ItemRepository;
    let locations: LocationRepository;

    beforeEach(async () => {
      driver = createMemoryDriver();
      await runMigrations(driver, migrations);
      items = new ItemRepository(driver);
      locations = new LocationRepository(driver);
    });

    afterEach(async () => {
      await driver.close();
    });

    it('rejects a lost decrement race with validation, not a raw constraint message', async () => {
      const drawer = await locations.create({ name: 'Drawer A' });
      const item = await items.create({ name: 'Fuse', quantity: 1, locationId: drawer.id });

      // Both decrements plan against the same on-hand of 1 — the stale read the issue describes.
      const first = items.adjustQuantity(item.id, -1);
      const second = items.adjustQuantity(item.id, -1);

      await first;
      await expect(second).rejects.toMatchObject({
        name: 'DbError',
        code: 'SQLITE_CONSTRAINT',
        message: STOCK_DRAW_RACE_MESSAGE,
      });
      // The winner still landed, and the ledger is untouched by the loser.
      expect((await items.getById(item.id))!.quantity).toBe(0);
    });

    it('leaves the ledger consistent after the rejection', async () => {
      const drawer = await locations.create({ name: 'Drawer A' });
      const item = await items.create({ name: 'Fuse', quantity: 1, locationId: drawer.id });

      const first = items.adjustQuantity(item.id, -1);
      const second = items.adjustQuantity(item.id, -1);
      await first;
      await expect(second).rejects.toThrow();

      // The rejected transaction rolled back whole — no half-applied history entry.
      const history = await items.getHistory(item.id);
      expect(history.rows.filter((h) => h.action === 'QUANTITY_CHANGE')).toHaveLength(1);
    });
  });

  describe('runStockDraw', () => {
    it('passes non-floor failures through untouched', async () => {
      const boom = new DbError('SQLITE_BUSY', 'database is locked');
      const driver = {
        transaction: () => Promise.reject(boom),
      } as unknown as MemoryDriver;
      await expect(runStockDraw(driver, [])).rejects.toBe(boom);
    });

    it('carries a caller-supplied message', async () => {
      const driver = {
        transaction: () =>
          Promise.reject(new DbError('SQLITE_CONSTRAINT', 'CHECK constraint failed: quantity >= 0')),
      } as unknown as MemoryDriver;
      await expect(runStockDraw(driver, [], 'Not enough left.')).rejects.toMatchObject({
        message: 'Not enough left.',
      });
    });
  });
});
