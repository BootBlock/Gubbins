/**
 * Emulate the snapshot reader's keyset paging (issue #204) for the hand-rolled fake drivers
 * that stand in for a database of a different shape.
 *
 * Shared by the rescue-path fakes so there is one copy to keep in step with `keysetPage` in
 * `features/sync/snapshot.ts`. Honouring the `LIMIT` is not cosmetic: the reader pages until a
 * short page tells it to stop, so a fake that ignores the limit and returns every row makes any
 * fixture of a full page or more loop forever, appending the same rows on each pass.
 */
import type { SqlParams, SqlRow, SqlValue } from '@/db/rpc/driver';

/** The page size `features/sync/snapshot.ts` reads with. */
const PAGE = 100;

/**
 * The slice of `rows` a keyset-paged `SELECT` would return for `params`.
 *
 * The reader binds `[limit]` for the first page and `[...cursor, limit]` for each one after, so
 * the limit is always last and anything before it is the cursor to resume past. Only the
 * single-column `id` cursor is emulated — the fixtures using this are far short of one page, so
 * the resume path exists to keep the loop honest rather than to be exercised.
 */
export function pageOf(rows: SqlRow[], params?: SqlParams): SqlRow[] {
  const values = (params as SqlValue[] | undefined) ?? [];
  const limit = values.length > 0 ? values[values.length - 1] : undefined;
  const after = values.length === 2 ? values[0] : undefined;

  const ordered = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const remaining = after === undefined ? ordered : ordered.filter((row) => String(row.id) > String(after));
  return remaining.slice(0, typeof limit === 'number' ? limit : PAGE);
}
