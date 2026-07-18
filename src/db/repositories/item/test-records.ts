/**
 * ItemRepository test / calibration / service records concern (feature-gap G7).
 *
 * A structured pass/fail + reading log per **serialised** unit — the QA audit trail
 * (InvenTree "test result" parity) that free-form maintenance history can't express. This
 * mirrors the `revaluations` shape: an append-only child log of the item, written through the
 * pure `@/features/inventory/test-records` seam so all vocabulary/validation lives in one tested
 * place and this mixin stays thin SQL glue.
 *
 * `test_records` participates in synchronisation (§7.1): it is an LWW leaf carrying its own
 * `updated_at`, so recording is a plain INSERT and removing a mistaken record is a DELETE +
 * tombstone in the same transaction (so the deletion propagates instead of being resurrected from
 * a peer, §7.2). Recording also appends a `TESTED` Activity-Log entry in the same transaction, so
 * the item's timeline reflects the QA event (mirrors `recordRevaluation`'s `REVALUED`).
 */
import { DbError } from '../../errors';
import { rowToTestRecord } from '../mappers';
import { historyStatement } from './history';
import { tombstoneStatement } from '../tombstone';
import {
  planTestRecord,
  TEST_RECORD_KIND_LABELS,
  TEST_RESULT_LABELS,
  type TestRecordPlanError,
} from '@/features/inventory/test-records';
import type { SqlStatement } from '../../rpc/driver';
import type { PageParams, RecordTestResultInput, TestRecord, TestRecordRow } from '../types';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

/** User-facing message for each reason `planTestRecord` can reject a proposed record. */
const REJECTION_MESSAGE: Record<TestRecordPlanError, string> = {
  EMPTY_NAME: 'A test name is required.',
  INVALID_READING: 'The reading must be a number.',
};

export function withTestRecords<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemTestRecordRepository extends Base {
    /**
     * Record a test / calibration / service result against an item (feature-gap G7): append a
     * `test_records` row and a `TESTED` Activity-Log entry in one atomic transaction. The content
     * is validated + normalised by the pure `planTestRecord` seam (a blank name or non-finite
     * reading is rejected; kind/result soften to their defaults); the item must exist. `performedAt`
     * defaults to now. Write-gated (it grows storage).
     */
    async recordTestResult(itemId: string, input: RecordTestResultInput): Promise<TestRecord> {
      this.assertWritable();
      await this.require(itemId); // shared precondition: a record against a missing item throws

      const plan = planTestRecord(input);
      if (!plan.ok) {
        throw new DbError('SQLITE_CONSTRAINT', REJECTION_MESSAGE[plan.reason]);
      }
      const { kind, name, result, reading, unit, note } = plan.record;
      const performedAt =
        input.performedAt != null && Number.isFinite(input.performedAt)
          ? Math.trunc(input.performedAt)
          : Date.now();
      const id = crypto.randomUUID();

      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO test_records (id, item_id, kind, name, result, reading, unit, note, performed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          params: [id, itemId, kind, name, result, reading, unit, note, performedAt],
        },
        historyStatement(itemId, 'TESTED', this.actorId(), {
          note: `${TEST_RECORD_KIND_LABELS[kind]} — ${name}: ${TEST_RESULT_LABELS[result]}.`,
          metadata: { kind, result, reading, unit, performedAt },
        }),
      ];
      await this.driver.transaction(statements);

      return (await this.getTestRecord(id))!;
    }

    /**
     * An item's recorded test / calibration / service records, newest first (feature-gap G7). Tiny
     * per item, but strictly bounded per the §2.1 pagination mandate; the pure `sortTestRecords`
     * seam re-derives the same order for display, so SQL and UI agree.
     */
    async listTestRecords(itemId: string, params: PageParams = {}): Promise<TestRecord[]> {
      const { limit, offset } = this.resolvePage(params);
      const rows = await this.driver.query<TestRecordRow>(
        `SELECT * FROM test_records WHERE item_id = ?
         ORDER BY performed_at DESC, created_at DESC, id ASC
         LIMIT ? OFFSET ?;`,
        [itemId, limit, offset],
      );
      return rows.map(rowToTestRecord);
    }

    /**
     * Remove a test record by id — DELETE + tombstone in the same transaction so the removal
     * propagates on the next sync (§7.2). Always permitted (a delete frees storage). A genuine
     * no-op when the id doesn't exist: no tombstone is recorded (tombstoning an id this device
     * never held would wrongly instruct peers to delete it), mirroring `removeRelation`.
     */
    async removeTestRecord(recordId: string): Promise<void> {
      if (!(await this.getTestRecord(recordId))) return;
      const statements: SqlStatement[] = [
        { sql: 'DELETE FROM test_records WHERE id = ?;', params: [recordId] },
        tombstoneStatement('test_records', recordId),
      ];
      await this.driver.transaction(statements);
    }

    /** Fetch a single test record by id, or undefined when absent (internal helper). */
    private async getTestRecord(recordId: string): Promise<TestRecord | undefined> {
      const row = await this.driver.queryOne<TestRecordRow>('SELECT * FROM test_records WHERE id = ?;', [
        recordId,
      ]);
      return row ? rowToTestRecord(row) : undefined;
    }
  };
}
