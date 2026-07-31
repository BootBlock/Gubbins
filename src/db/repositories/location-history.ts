/**
 * The append-only location activity-record INSERT builder (issue #691).
 *
 * The direct counterpart of `item/history.ts` for `location_history`: every location change that
 * reshapes the hierarchy records an entry in the *same* atomic transaction as the state change, so
 * the record can never claim something the write did not do.
 *
 * That "never claim" is not rhetorical here. A parent move rides an atomic cycle guard in the
 * `UPDATE`'s WHERE clause (`PARENT_MOVE_CYCLE_GUARD`), so the write can legitimately match zero
 * rows when a concurrent re-parent has made the move illegal. An unconditional INSERT alongside it
 * would then record a move that never happened — the one failure mode an audit trail must not
 * have. {@link locationHistoryStatement} therefore takes the **same** guard and folds it into the
 * INSERT, so the entry and the change are refused together or applied together.
 */
import type { SqlStatement, SqlValue } from '../rpc/driver';
import type { LocationHistoryAction } from './constants';

/** The optional detail columns of a location activity entry. */
export interface LocationHistoryFields {
  /** Already-British-English prose describing the change ("Renamed from … to …."). */
  readonly note?: string | null;
  /** Machine-readable detail (the ids either side of a move), serialised to JSON. */
  readonly metadata?: Record<string, unknown> | null;
  /**
   * A WHERE fragment the INSERT must satisfy, with its bindings — the caller's own guard, so the
   * entry lands only if the change does. Omit for an unconditional write.
   */
  readonly guard?: { readonly sql: string; readonly params: readonly SqlValue[] };
}

const COLUMNS = 'id, location_id, location_name, action, note, metadata, actor_user_id';

/**
 * Build an append-only location activity INSERT for inclusion in a write transaction.
 *
 * `locationName` is the name the location carries **at the moment of the change** — for a rename,
 * that is the new one, so the entry reads as the location a user is looking at rather than as the
 * one it used to be. The old name lives in the note and the metadata.
 *
 * `actorUserId` is a **required** positional argument for the same reason it is on
 * {@link import('./item/history').historyStatement}: every entry names who caused it, and a caller
 * that forgets must fail to compile rather than quietly recording the System user.
 *
 * With a `guard`, the row is written by `INSERT … SELECT … WHERE <guard>` instead of `VALUES`.
 * That is the one shape where "insert nothing" is the wanted outcome: the guard is exactly the
 * condition the accompanying `UPDATE` carries, so a vetoed change writes no record of itself.
 */
export function locationHistoryStatement(
  locationId: string,
  locationName: string,
  action: LocationHistoryAction,
  actorUserId: string,
  fields: LocationHistoryFields = {},
): SqlStatement {
  const params: SqlValue[] = [
    crypto.randomUUID(),
    locationId,
    locationName,
    action,
    fields.note ?? null,
    fields.metadata ? JSON.stringify(fields.metadata) : null,
    actorUserId,
  ];
  if (!fields.guard) {
    return {
      sql: `INSERT INTO location_history (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?);`,
      params,
    };
  }
  return {
    sql: `INSERT INTO location_history (${COLUMNS})
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${fields.guard.sql};`,
    params: [...params, ...fields.guard.params],
  };
}
