/**
 * §7.5 natural-key collision resolution for the **wholesale-apply** paths (issue #538).
 *
 * `resolveUniqueKeyCollisions` (see `./unique-keys`) was written for the delta merge, and for a
 * long time the delta merge was the only path that called it. It is not, however, the only path
 * that writes a *foreign* snapshot into this database:
 *
 * - the §2 "Merge" backup restore (`restoreSnapshot`) upserts every row of a backup taken on
 *   another device, non-destructively, against the live local rows;
 * - the §7.2 tombstone-TTL recovery (`cloneWithSalvage`) wipes the syncable tables, clones the
 *   remote wholesale, then re-applies the local salvage over the top.
 *
 * Both wrote their rows with a plain `ON CONFLICT(id)` upsert, whose conflict target does not
 * cover a `UNIQUE(name)` index. So a backup from a device that had independently invented the
 * tag "Tools" — the ordinary state of any synced pair — aborted the whole restore on
 * `SQLITE_CONSTRAINT_UNIQUE`, and a device past the tombstone TTL could never complete the very
 * clone the salvage machinery exists to give it. This is the same bug issue #187 fixed for the
 * delta merge, on the two paths it never reached.
 *
 * The resolution itself is unchanged, and deliberately so — one module decides who keeps a
 * natural key, on the same last-write-wins footing, for all three paths. What differs is only
 * the *shape* each path hands it, and what the apply must then emit:
 *
 * | path    | "local" rows          | "incoming" rows | can a local row be doomed? |
 * | ------- | --------------------- | --------------- | -------------------------- |
 * | delta   | the local snapshot    | the merge plan  | yes (peer tombstones)      |
 * | restore | the live local tables | the backup      | no (a merge never deletes) |
 * | clone   | the cloned remote     | the salvage     | yes (salvage tombstones)   |
 *
 * {@link repairUniqueKeys} adapts either wholesale path onto that one resolution and returns the
 * statements the apply needs on each side of its upserts. It mirrors `applyPlan`'s collision
 * block, including the two repairs that block cannot express as a re-keyed row:
 *
 * - a retired **user** is parked on a throwaway username so the winner's INSERT can take the
 *   real one, and is not deleted until its ledger rows have followed the winner — otherwise
 *   `actor_user_id`'s `ON DELETE SET DEFAULT` re-attributes this device's history to System
 *   (issue #79);
 * - a retired **tag**'s M:N edges are re-pointed at the winner before the delete cascades them
 *   away, so the two devices' tagged items merge into one tag rather than losing a membership.
 *
 * It also emits the same ordering repair `applyPlan` does for a **rename swap** (issue #707) —
 * see `planKeyParks` — which is not a retirement at all: both rows survive, and one is only
 * moved off the key the other is about to take.
 */
import {
  ITEM_HISTORY_TABLE,
  ITEM_TAGS_TABLE,
  LOCATION_TAGS_TABLE,
  SYNC_TABLES,
} from '@/db/repositories/tombstone';
import type { SqlStatement } from '@/db/rpc/driver';
import { enforceForeignKeys } from './fk-refs';
import type { SyncTable, TableRow, Tombstone } from './types';
import {
  deferredRetirementParkColumn,
  planKeyParks,
  resolveUniqueKeyCollisions,
  type LocalTables,
} from './unique-keys';

/** Everything one wholesale apply needs to write its rows without tripping a UNIQUE index. */
export interface UniqueKeyRepair {
  /**
   * The incoming rows to write, ordered parents-before-children: losing rows dropped,
   * references to a retired id repointed, and stored rows a retirement would otherwise cascade
   * away re-emitted against the winner.
   */
  readonly rows: readonly TableRow[];
  /** Statements that must run **before** {@link rows} are written. */
  readonly before: readonly SqlStatement[];
  /** Statements that must run **after** {@link rows} are written. */
  readonly after: readonly SqlStatement[];
  /** `loser → winner` for `tags`, to map the M:N edge sections through. */
  readonly tagRekeys: ReadonlyMap<string, string>;
  /** `loser → winner` for `users`, to map inbound ledger `actor_user_id` through. */
  readonly userRekeys: ReadonlyMap<string, string>;
  /** Every retired id, by table. An id listed here must not be written or tombstone-cleared. */
  readonly retired: ReadonlyMap<SyncTable, ReadonlySet<string>>;
}

const EMPTY_REKEY: ReadonlyMap<string, string> = new Map();

/**
 * Resolve every natural-key collision between `incoming` and `local`, and return the repaired
 * row set plus the statements that bracket it.
 *
 * `incoming` is **mutated in place** by the resolution (the same contract
 * `resolveUniqueKeyCollisions` already has with the delta merge) and its settled contents are
 * returned, sorted, as {@link UniqueKeyRepair.rows}. Callers should treat the array they passed
 * as consumed and read the result instead.
 *
 * `incomingDeletes` are the tombstones this same apply will act on *after* its upserts. They are
 * not contestants — those rows are on their way out — but a doomed row still holds its natural
 * key at the moment the upserts run, so the resolution hoists their DELETEs forward. Pass an
 * empty list from a path that deletes nothing, such as the non-destructive merge restore.
 */
export function repairUniqueKeys(
  local: LocalTables,
  incoming: TableRow[],
  incomingDeletes: readonly Tombstone[] = [],
): UniqueKeyRepair {
  // `offset: 0` — both sides are already in one clock frame by the time either wholesale path
  // calls this. The restore compares a decoded backup against live local rows, and the clone's
  // remote was shifted into this device's frame before any of it was written.
  const { collisions, rekeys } = resolveUniqueKeyCollisions(local, incoming, incomingDeletes, 0);

  const before: SqlStatement[] = [];
  const after: SqlStatement[] = [];
  const retired = new Map<SyncTable, Set<string>>();

  for (const { table, loserId, winnerId, deletedAt, hoistOnly } of collisions) {
    let ids = retired.get(table);
    if (ids === undefined) {
      ids = new Set();
      retired.set(table, ids);
    }
    ids.add(loserId);

    const deferredParkColumn = hoistOnly ? undefined : deferredRetirementParkColumn(table);
    if (table === 'users' && !hoistOnly) {
      // Issue #79, exactly as `applyPlan` does it: free the username now, move the ledger to the
      // winner once the winner exists, and only then remove the row. Deleting it up front would
      // fire `actor_user_id`'s ON DELETE SET DEFAULT and re-attribute this device's history to
      // System. A `hoistOnly` entry is *not* a naming contest — that account was already deleted
      // — so it takes the plain path below, and its history is not handed to whoever now holds
      // the username.
      before.push(parkNaturalKey(table, 'username', loserId));
      after.push({
        sql: `UPDATE ${ITEM_HISTORY_TABLE} SET actor_user_id = ? WHERE actor_user_id = ?;`,
        params: [winnerId, loserId],
      });
      after.push(deleteRow(table, loserId));
    } else if (table === 'tags' && !hoistOnly) {
      // The same shape, for the same reason, on the other table whose dependants cannot be
      // re-keyed as rows: `item_tags` / `location_tags` carry no `id`, so a repointed edge has to
      // be written as SQL against the joins themselves rather than emitted as an upsert.
      //
      // That forces the whole retirement to the far side of the upserts. The re-pointed edge
      // names the *winner*, which does not exist yet while the upserts are still pending, so
      // writing it up front fails the foreign key and aborts the transaction; and the winner's
      // own INSERT cannot run while the loser still holds the name. Parking the loser's name
      // breaks the cycle exactly as it does for a user: the name is free immediately, the edges
      // move once the winner is really there, and the row goes last. `INSERT OR IGNORE` absorbs
      // the case where an item already carries both tags, and doing it in SQL covers every edge
      // this device holds without the apply having to read the joins first.
      //
      // A `hoistOnly` tag is skipped for a different reason than a user's: those edges belong to
      // a row a peer already deleted, so re-pointing them would resurrect a membership the user
      // removed.
      before.push(parkNaturalKey(table, 'name', loserId));
      after.push(repointTagEdges(ITEM_TAGS_TABLE, 'item_id', winnerId, loserId));
      after.push(repointTagEdges(LOCATION_TAGS_TABLE, 'location_id', winnerId, loserId));
      after.push(deleteRow(table, loserId));
    } else if (deferredParkColumn !== undefined) {
      // Issue #603: a table whose cascade reaches past its direct children — retiring a supplier
      // up front would take its parts' price history and its order lines' `supplier_part_id`
      // with it, neither of which the repointed rows re-emit. Free the natural key now so the
      // winner can be written, and delete once every child has followed it onto the winner.
      before.push(parkNaturalKey(table, deferredParkColumn, loserId));
      after.push(deleteRow(table, loserId));
    } else {
      before.push(deleteRow(table, loserId));
    }

    before.push({
      sql: 'INSERT OR REPLACE INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?);',
      params: [table, loserId, deletedAt],
    });
  }

  // A retired id is a parent that will not exist after this apply, so anything still pointing at
  // one has to go — `ON CONFLICT` resolution does not extend to FOREIGN KEY, and one orphan aborts
  // the whole transaction rather than costing that row (issue #405). The resolution has already
  // repointed every reference `UNIQUE_KEY_SPECS` lists; what is left is the reference it
  // deliberately omits, `api_tokens.user_id`, whose ON DELETE CASCADE is meant to revoke a losing
  // account's Bridge token rather than hand it to the winner. The delta merge reaches the same
  // outcome through its own `enforceForeignKeys` pass a few steps later; a wholesale apply has no
  // such pass, so it happens here.
  enforceForeignKeys(incoming, Object.fromEntries(retired));

  // Issue #707: the ordering guarantee the contest above does not give. Where an incoming row
  // takes a natural key a *different* stored row still holds, and that stored row is itself only
  // being renamed by this same apply, park the holder before the writes and let its own row
  // restore the real name. Computed here rather than inside the resolution because the FK guard
  // above is the last pass that can drop a row, and a parked row is restored only by its own.
  for (const { table, column, id } of planKeyParks(local, incoming)) {
    before.push(parkNaturalKey(table, column, id));
  }

  // Parents before children, the same FK-safe ordering `applyPlan` gives its upserts. The
  // resolution appends re-emitted rows for whatever referenced a retired id, so the incoming
  // list is no longer grouped by table by the time it comes back.
  const order = (table: SyncTable) => SYNC_TABLES.indexOf(table);
  const rows = [...incoming].sort((a, b) => order(a.table) - order(b.table));

  return {
    rows,
    before,
    after,
    tagRekeys: rekeys.get('tags') ?? EMPTY_REKEY,
    userRekeys: rekeys.get('users') ?? EMPTY_REKEY,
    retired,
  };
}

/** Retire one row. The table name is a `UNIQUE_KEY_SPECS` constant, never snapshot-supplied. */
function deleteRow(table: SyncTable, id: string): SqlStatement {
  return { sql: `DELETE FROM ${table} WHERE id = ?;`, params: [id] };
}

/**
 * Move a row onto a throwaway natural key — its own id — so another row's INSERT can take the
 * real one. The parked value is never observable: the row is either deleted (a retirement) or
 * re-written with its real new name (a rename, issue #707) a few statements later, in this same
 * transaction. An id cannot collide with another id, so the throwaway is always free.
 *
 * Shared with `applyPlan`, which emits the identical statement for the delta merge.
 */
export function parkNaturalKey(table: SyncTable, column: string, id: string): SqlStatement {
  return { sql: `UPDATE ${table} SET ${column} = ? WHERE id = ?;`, params: [id, id] };
}

/** Move every `tag_id = loser` edge of one join table onto `winner`. */
function repointTagEdges(
  table: string,
  ownerColumn: string,
  winnerId: string,
  loserId: string,
): SqlStatement {
  return {
    sql:
      `INSERT OR IGNORE INTO ${table} (${ownerColumn}, tag_id) ` +
      `SELECT ${ownerColumn}, ? FROM ${table} WHERE tag_id = ?;`,
    params: [winnerId, loserId],
  };
}
