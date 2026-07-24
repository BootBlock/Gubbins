/**
 * The append-only Activity Log INSERT builder (spec §4, §4.1.3).
 *
 * Every item mutation records an entry in `item_history` within the *same* atomic
 * transaction as the state change, so the immutable ledger can never drift from the
 * item. The concern modules each emit these statements via {@link historyStatement}.
 */
import type { SqlStatement, SqlValue } from '../../rpc/driver';

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
  /**
   * The row's id. Defaults to a fresh `crypto.randomUUID()` — correct for an ordinary event,
   * which is genuinely new. Pass a **deterministic** id only for the ledger entry of a one-shot
   * terminal operation two devices can each run offline (assembly finalisation, issue #195): the
   * ledger reconciles by union-of-id, so a random id would leave one duplicate entry per device,
   * whereas the same derived id collapses them to one. See `derived-uuid.ts`.
   */
  readonly id?: string;
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
      fields.id ?? crypto.randomUUID(),
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

/**
 * A gauge's net value *after* a write, as a SQL expression over the item's live row
 * (issue #297) — never a number computed in JavaScript from an earlier read.
 *
 * A gauge's value and the sum of its `GAUGE_UPDATE` deltas are not merely expected to
 * agree: §7.3 reconciliation *reconstructs* the value as `grossCapacity + Σ deltas`
 * (`replayGaugeValue`), so any drift between them is permanent and propagates to every
 * device. Computing the next value from a base read before the transaction breaks that
 * the moment two writes overlap — both read the same base, and the second silently
 * discards the first while the ledger still records both.
 *
 * Pairing the expression with its parameters keeps the two halves of a gauge write —
 * {@link gaugeValueUpdate}'s `SET` and {@link gaugeDeltaHistoryStatement}'s recorded
 * delta — provably in step: both are generated from *this* value, so neither can drift
 * from the other.
 */
export interface GaugeNextValue {
  /** SQL evaluating to the post-write net value, over the pre-write `items` row. */
  readonly sql: string;
  /** Bindings for the expression's placeholders, in order. */
  readonly params: readonly SqlValue[];
}

/**
 * The gauge value after adding a relative `delta`, clamped to `[0, gross_capacity]`
 * (§4.1.1) — the SQL twin of `clampNetValue(current + delta, grossCapacity)`.
 *
 * `gross_capacity > 0` is a table CHECK for every `CONSUMABLE_GAUGE` row, so unlike the
 * JavaScript helper this needs no non-positive-capacity guard.
 */
export function gaugeAfterDelta(delta: number): GaugeNextValue {
  return { sql: 'MAX(0, MIN(gross_capacity, current_net_value + ?))', params: [delta] };
}

/**
 * The gauge value after re-clamping into a **new** capacity, moving no material of its
 * own (issue #69's spill). Reads `current_net_value` live rather than writing back a
 * figure read earlier, so a reconfiguration that only relabels a gauge cannot silently
 * revert an adjustment that landed while the dialog was open.
 */
export function gaugeAfterRecapacity(grossCapacity: number): GaugeNextValue {
  return { sql: 'MAX(0, MIN(?, current_net_value))', params: [grossCapacity] };
}

/** `UPDATE` setting a gauge to `next`, evaluated against the row it is replacing. */
export function gaugeValueUpdate(itemId: string, next: GaugeNextValue): SqlStatement {
  return {
    sql: `UPDATE items SET current_net_value = ${next.sql} WHERE id = ?;`,
    params: [...next.params, itemId],
  };
}

/**
 * Build a `GAUGE_UPDATE` ledger entry whose `net_value_delta` is what `next` actually
 * moves, computed **by SQLite** from the item's live row (issue #297) — see
 * {@link GaugeNextValue} for why the delta may not come from JavaScript.
 *
 * Emit this **before** the matching update in the transaction, so the `SELECT` still
 * sees the pre-write row.
 *
 * Only the *delta* is a subquery — the row itself is a plain `VALUES` insert, so this
 * still writes unconditionally. An `INSERT … SELECT FROM items` would read better but
 * would insert nothing at all for an item deleted mid-flight, turning a failed write into
 * a transaction that commits having quietly done nothing; keeping `item_id` a bound
 * parameter leaves `item_history`'s foreign key free to reject it exactly as the plain
 * {@link historyStatement} this replaces did.
 */
export function gaugeDeltaHistoryStatement(
  itemId: string,
  actorUserId: string,
  next: GaugeNextValue,
  fields: Pick<HistoryFields, 'note' | 'metadata'> = {},
): SqlStatement {
  return {
    sql: `INSERT INTO item_history (id, item_id, action, quantity_delta, net_value_delta, note, metadata, actor_user_id)
          VALUES (?, ?, 'GAUGE_UPDATE', NULL,
                  (SELECT ${next.sql} - current_net_value FROM items WHERE id = ?),
                  ?, ?, ?);`,
    params: [
      crypto.randomUUID(),
      itemId,
      ...next.params,
      itemId,
      fields.note ?? null,
      fields.metadata ? JSON.stringify(fields.metadata) : null,
      actorUserId,
    ],
  };
}
