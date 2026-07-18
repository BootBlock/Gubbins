/**
 * The append-only Activity Log INSERT builder (spec §4, §4.1.3).
 *
 * Every item mutation records an entry in `item_history` within the *same* atomic
 * transaction as the state change, so the immutable ledger can never drift from the
 * item. The concern modules each emit these statements via {@link historyStatement}.
 */
import type { SqlStatement } from '../../rpc/driver';

/**
 * The optional detail columns of a ledger entry. Each accepts `null` as well as `undefined`
 * so a caller can write "explicitly no delta" (`cond ? null : -n`) without a cast — the
 * builder coalesces both to SQL NULL.
 */
export interface HistoryFields {
  readonly quantityDelta?: number | null;
  readonly netValueDelta?: number | null;
  readonly note?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

/**
 * Build an append-only Activity Log INSERT for inclusion in a write transaction.
 *
 * `actorUserId` is deliberately a **required** positional argument (issue #79, plan §2.4):
 * every ledger entry names who caused it, and a caller that forgets must fail to compile
 * rather than quietly recording the System user. Repository methods pass `this.actorId()`;
 * callers with no real user — maintenance, sync reconciliation, the Bridge — pass
 * `SYSTEM_USER_ID` explicitly, so "the app did this" is always a visible decision at the
 * call site rather than a default.
 */
export function historyStatement(
  itemId: string,
  action: string,
  actorUserId: string,
  fields: HistoryFields = {},
): SqlStatement {
  return {
    sql: `INSERT INTO item_history (id, item_id, action, quantity_delta, net_value_delta, note, metadata, actor_user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    params: [
      crypto.randomUUID(),
      itemId,
      action,
      fields.quantityDelta ?? null,
      fields.netValueDelta ?? null,
      fields.note ?? null,
      fields.metadata ? JSON.stringify(fields.metadata) : null,
      actorUserId,
    ],
  };
}
