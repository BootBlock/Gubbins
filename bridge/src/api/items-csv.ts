/**
 * The streamed CSV export behind `GET /api/v1/items.csv` (issue #533).
 *
 * The export is a *refreshable* pull — its whole reason to exist is that Excel or Power BI points
 * "From Web" at it and re-fetches on every open — so it is the one read whose cost is paid over
 * and over by a client that mostly wants the same bytes it already has. It used to pay that cost
 * three times over: it walked the catalogue in 100-row `OFFSET` pages (SQLite produces and
 * discards every row before an offset, so the walk cost grew with the square of the inventory),
 * held every hydrated item in memory while it did, and then built the entire document as one
 * JavaScript string before a byte went out.
 *
 * This walks with a **keyset cursor** and writes as it goes:
 *
 *   - Each page is fetched by seeking past the previous page's last row, so a page costs the same
 *     whether it is the first or the ten-thousandth, and the walk is linear in the row count.
 *   - Each page is serialised and written to the response as it arrives, then dropped. Neither the
 *     row set nor the document is ever fully resident — the process holds one page.
 *
 * Because memory no longer grows with the result set, the export no longer needs the row cap that
 * used to bound it (`MAX_CSV_ROWS`, 100,000). That cap truncated **silently**: a larger catalogue
 * exported its first 100,000 rows and nothing in the response said the rest existed. A walk that
 * costs one page of memory can honestly return everything the caller asked for, so it does.
 *
 * The response is written by hand rather than through a `send*` helper because the helpers all end
 * the response with their content in one call, which is precisely what this must not do.
 */
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import type { Cursor, Item, Page } from '@/db/repositories/types';
import type { ItemSort } from '@/db/repositories/item/sql.ts';
import type { SearchAST } from '@/db/search/ast.ts';
import { itemsCsvHeader, itemsCsvRow } from '@/features/export/export-data.ts';
import { DELIMITED_ROW_SEPARATOR } from '@/features/export/tabular-export.ts';
import { itemPage, type Driver, type ItemQueryFilters } from './reads.ts';
import { MAX_PAGE_LIMIT } from './limits.ts';
import { beginCsv } from './respond.ts';
import type { CacheValidators } from './conditional.ts';

/**
 * Rows fetched per read while streaming. The repositories clamp every page to their own
 * `MAX_PAGE_SIZE`, so asking for more would not get more — and with a keyset walk it would not
 * help much anyway: the page size now decides only how many round-trips the walk makes, not how
 * much work each one does.
 */
export const CSV_WALK_PAGE_SIZE = MAX_PAGE_LIMIT;

/**
 * Stream the matching items to `res` as a CSV attachment, a page at a time.
 *
 * The **first** page is read before anything is written, because until it comes back the request
 * may still turn out to be a `400` (an invalid `$filter` is only discovered when the AST is
 * translated) — and once a status line is on the wire it cannot be taken back. So a
 * `SearchAstError` propagates to the caller from here exactly as it did when the whole export was
 * buffered, and the caller answers it. Every later page is read with the response already open;
 * see {@link failMidStream} for what happens if one of those fails.
 */
export async function streamItemsCsv(
  res: ServerResponse,
  driver: Driver,
  ast: SearchAST | undefined,
  filters: ItemQueryFilters,
  sort: readonly ItemSort[] | undefined,
  validators: CacheValidators | undefined,
): Promise<void> {
  const items = new ItemRepository(driver);
  const read = (after: Cursor | undefined, index: number): Promise<Page<Item>> =>
    itemPage(items, ast, filters, sort, CSV_WALK_PAGE_SIZE, index, after === undefined ? {} : { after });

  let page = await read(undefined, 0);

  beginCsv(res, 'items.csv', validators);
  if (!(await write(res, itemsCsvHeader()))) return;

  let written = 0;
  for (;;) {
    if (page.rows.length > 0) {
      // One string per page, not per row: `res.write` per row would put a chunk header around
      // every line on the wire, and the page is already resident.
      const chunk = page.rows.map((item) => DELIMITED_ROW_SEPARATOR + itemsCsvRow(item)).join('');
      if (!(await write(res, chunk))) return;
      written += page.rows.length;
    }
    // A short page is the end of the result set. `endCursor` is absent only on an empty page,
    // which `hasMore` has already ruled out — but a walk that lost its cursor must stop rather
    // than fall back to an offset read and risk repeating or skipping rows.
    if (!page.hasMore || page.endCursor === undefined) break;
    try {
      page = await read(page.endCursor, written);
    } catch (err) {
      return void failMidStream(res, err);
    }
  }
  res.end();
}

/**
 * Write one chunk, waiting for the socket to drain when it is full, and report whether the walk
 * should continue.
 *
 * Both halves matter for an export this size. Without the drain wait, a client slower than SQLite
 * — every client, at 10MB of CSV — has the whole document buffered in the process anyway, which is
 * the memory this change exists to stop holding. Without the `destroyed` check, a cancelled
 * download (the spreadsheet closed, the tab shut) leaves the walk running to the end of the
 * catalogue with nowhere to put the rows.
 */
async function write(res: ServerResponse, chunk: string): Promise<boolean> {
  if (res.destroyed) return false;
  if (res.write(chunk)) return true;
  try {
    await once(res, 'drain');
  } catch {
    // The socket failed while we waited (the client went away mid-download). There is nothing
    // left to write to and nothing to report to — stop the walk quietly.
    return false;
  }
  return !res.destroyed;
}

/**
 * Abandon a response whose headers are already on the wire.
 *
 * A `200` was promised before the failure happened, so there is no status left to change: the only
 * honest signal is to destroy the connection, which is what a client reads as a truncated
 * download. Ending it cleanly would hand a spreadsheet a well-formed CSV that silently stops
 * short, and the whole point of the change above is that this export does not truncate in silence.
 * The failure is handed to `destroy` so it surfaces on the response as an `'error'` rather than
 * disappearing.
 */
function failMidStream(res: ServerResponse, err: unknown): void {
  res.destroy(err instanceof Error ? err : new Error(String(err)));
}
