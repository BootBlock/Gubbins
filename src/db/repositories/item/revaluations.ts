/**
 * ItemRepository revaluation concern (feature-gap G9 — manual current / market value).
 *
 * An appreciating asset (collectible, tool, property) needs a manual value that can move up
 * or down independently of the straight-line depreciation curve, plus an append-only log of
 * the points that set it — so the value history is charted rather than overwritten and lost,
 * and an insurance schedule (G1) can be struck at today's worth.
 *
 * This mirrors the shipped supplier-cost + `supplier_part_price_history` shape: the live
 * value is a column on the parent (`items.current_value`), and each recorded change appends a
 * row to the `revaluations` log. {@link recordRevaluation} does both in the *same* atomic
 * transaction so the column can never drift from the newest log point.
 */
import { toStoredMoney } from '@/lib/money';
import { DbError } from '../../errors';
import { rowToRevaluation } from '../mappers';
import { historyStatement } from './history';
import type { SqlStatement } from '../../rpc/driver';
import type { PageParams, RecordRevaluationInput, Revaluation, RevaluationRow } from '../types';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

export function withRevaluations<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemRevaluationRepository extends Base {
    /**
     * Record a manual revaluation of an item (feature-gap G9): append a `revaluations` log
     * point and set the item's live `current_value` to it, in one atomic transaction. Also
     * records a `REVALUED` Activity-Log entry so the change shows on the item's timeline.
     * The `value` must be finite and ≥ 0; `revaluedAt` defaults to now. Write-gated (it grows
     * storage).
     */
    async recordRevaluation(itemId: string, input: RecordRevaluationInput): Promise<Revaluation> {
      this.assertPermission('items:write');
      this.assertWritable();
      await this.require(itemId); // shared precondition: a revaluation of a missing item throws

      const value = input.value;
      if (!Number.isFinite(value) || value < 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A revaluation must be a non-negative number.');
      }
      const revaluedAt =
        input.revaluedAt != null && Number.isFinite(input.revaluedAt)
          ? Math.trunc(input.revaluedAt)
          : Date.now();
      const note = input.note?.trim() ? input.note.trim() : null;
      const id = crypto.randomUUID();
      // `revaluations.value` and the mirrored `items.current_value` are stored in integer
      // micro-units (issue #286); the Activity-Log metadata keeps the major-unit figure for display.
      const storedValue = toStoredMoney(value);

      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO revaluations (id, item_id, value, revalued_at, note)
                VALUES (?, ?, ?, ?, ?);`,
          params: [id, itemId, storedValue, revaluedAt, note],
        },
        { sql: 'UPDATE items SET current_value = ? WHERE id = ?;', params: [storedValue, itemId] },
        historyStatement(itemId, 'REVALUED', this.actorId(), {
          note: note ? `Recorded a manual revaluation. ${note}` : 'Recorded a manual revaluation.',
          metadata: { value, revaluedAt },
        }),
      ];
      await this.driver.transaction(statements);

      const row = await this.driver.queryOne<RevaluationRow>('SELECT * FROM revaluations WHERE id = ?;', [
        id,
      ]);
      return rowToRevaluation(row!);
    }

    /**
     * An item's recorded revaluation points, newest first (feature-gap G9). Tiny per item, but
     * strictly bounded per the §2.1 pagination mandate; the pure `buildRevaluationSeries` seam
     * sorts ascending for the trend/sparkline regardless of this order.
     */
    async listRevaluations(itemId: string, params: PageParams = {}): Promise<Revaluation[]> {
      const { limit, offset } = this.resolvePage(params);
      const rows = await this.driver.query<RevaluationRow>(
        `SELECT * FROM revaluations WHERE item_id = ?
         ORDER BY revalued_at DESC, rowid DESC
         LIMIT ? OFFSET ?;`,
        [itemId, limit, offset],
      );
      return rows.map(rowToRevaluation);
    }
  };
}
