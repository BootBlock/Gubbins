/**
 * The "last counted" stamp, as a composable statement (issue #301).
 *
 * Authorising a cycle count is one user action but three writes — the discrete reconciliation,
 * the serialised presence audit, and stamping the location as counted. Run as separate awaited
 * transactions a mid-way failure left stock adjusted, presence unreconciled and the location
 * never stamped, with no way to tell which half applied. The cycle-count concern therefore
 * needs the location's stamp as a *statement* it can splice into its own transaction, which is
 * what this tiny module exists to hand over.
 *
 * Its own module rather than a `LocationRepository` export so `item/cycle-count` can import it
 * without pulling the location repository (and its item-history import) into an import cycle.
 */
import type { SqlStatement } from '../rpc/driver';

/** Stamp a location's durable `last_counted_at` (stock-take backlog G1). */
export function markCountedStatement(id: string, at: number): SqlStatement {
  return { sql: 'UPDATE locations SET last_counted_at = ? WHERE id = ?;', params: [at, id] };
}
