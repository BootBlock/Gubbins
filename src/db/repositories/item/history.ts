/**
 * The append-only Activity Log INSERT builder (spec §4, §4.1.3).
 *
 * Every item mutation records an entry in `item_history` within the *same* atomic
 * transaction as the state change, so the immutable ledger can never drift from the
 * item. The concern modules each emit these statements via {@link historyStatement}.
 */
import type { SqlStatement } from '../../rpc/driver';

export interface HistoryFields {
  readonly quantityDelta?: number;
  readonly netValueDelta?: number;
  readonly note?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Build an append-only Activity Log INSERT for inclusion in a write transaction. */
export function historyStatement(itemId: string, action: string, fields: HistoryFields = {}): SqlStatement {
  return {
    sql: `INSERT INTO item_history (id, item_id, action, quantity_delta, net_value_delta, note, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?);`,
    params: [
      crypto.randomUUID(),
      itemId,
      action,
      fields.quantityDelta ?? null,
      fields.netValueDelta ?? null,
      fields.note ?? null,
      fields.metadata ? JSON.stringify(fields.metadata) : null,
    ],
  };
}
