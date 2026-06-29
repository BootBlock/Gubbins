/**
 * Read-only query core (Phase HA-2) — the questions Home Assistant asks, answered
 * over the hydrated DB and **independent of any transport** (no HTTP here; that is
 * HA-3). Every read runs through the app's *own* search path so bridge answers match
 * the app exactly, and the only SQL is the parameterised {@link parseASTtoSQL} the
 * repositories already use — never string-built. Strictly read-only: nothing mutates.
 *
 *   - {@link searchItems} — parse a query → {@link SearchAST} → `searchByAst`, returning
 *     a compact DTO. A query the power-user grammar can't parse falls back to a bare
 *     name search, so a casual phrase still finds something.
 *   - {@link whereIs} — the same matches, each enriched with its per-location stock
 *     breakdown and a single spoken sentence for a voice assistant.
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { parseTextQuery } from '@/features/search/parse-text-query.ts';
import type { SearchAST } from '@/db/search/ast.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { speakWhereIs } from './spoken.ts';

/**
 * Default cap on how many items a single query may return. A vague query must never
 * dump the whole inventory to a voice device — {@link MAX_RESULT_LIMIT} is the hard
 * ceiling even when a caller asks for more.
 */
export const DEFAULT_RESULT_LIMIT = 5;
/** Absolute ceiling on a query's result size, regardless of the requested limit. */
export const MAX_RESULT_LIMIT = 25;

/** A compact, read-only view of a matched item. No mutation surface is exposed. */
export interface ItemMatch {
  readonly id: string;
  readonly name: string;
  /** On-hand grand total across every location (the §4 per-location ledger sum). */
  readonly quantity: number;
  /** The item's primary/home location name, or null if it has none. */
  readonly locationName: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
}

/** One location's share of an item's stock, for the "where is X?" breakdown. */
export interface LocationBreakdown {
  readonly locationName: string;
  readonly quantity: number;
}

/** An {@link ItemMatch} plus its per-location stock breakdown (busiest location first). */
export interface WhereIsMatch extends ItemMatch {
  readonly placements: readonly LocationBreakdown[];
}

/** The full "where is X?" answer: the enriched matches plus one spoken sentence. */
export interface WhereIsResult {
  readonly query: string;
  readonly matches: readonly WhereIsMatch[];
  /** A short British-English sentence suitable for a voice assistant to read aloud. */
  readonly spoken: string;
}

export interface SearchOptions {
  /** Cap on results, clamped to `[1, MAX_RESULT_LIMIT]`. Defaults to {@link DEFAULT_RESULT_LIMIT}. */
  readonly limit?: number;
}

/**
 * Search the inventory for `q` and return up to {@link DEFAULT_RESULT_LIMIT} compact
 * matches. The query is parsed by the app's hybrid grammar (so `cap:voltage>3.3`,
 * `qty>10`, boolean groups… all work); only when that genuinely can't parse do we fall
 * back to treating the raw text as a name search, so "M3 screws" still finds something.
 */
export async function searchItems(
  driver: IDatabaseDriver,
  q: string,
  options: SearchOptions = {},
): Promise<ItemMatch[]> {
  const trimmed = q.trim();
  if (trimmed.length === 0) return [];

  const limit = clampLimit(options.limit);
  const items = new ItemRepository(driver);
  const locations = new LocationRepository(driver);

  const page = await items.searchByAst(astForQuery(trimmed), { limit });
  return Promise.all(
    page.rows.map(async (row) => ({
      id: row.id,
      name: row.name,
      quantity: row.quantity,
      locationName: (await locations.getById(row.locationId))?.name ?? null,
      mpn: row.mpn,
      manufacturer: row.manufacturer,
    })),
  );
}

/**
 * Answer "where is X?": the top {@link searchItems} matches, each enriched with its
 * per-location stock breakdown (so a multi-location item reports "5 on Shelf 2, 2 in
 * Bin 4", not just its primary location), plus one spoken sentence for a voice device.
 */
export async function whereIs(
  driver: IDatabaseDriver,
  q: string,
  options: SearchOptions = {},
): Promise<WhereIsResult> {
  const matches = await searchItems(driver, q, options);
  const items = new ItemRepository(driver);

  const enriched: WhereIsMatch[] = await Promise.all(
    matches.map(async (match) => {
      const placements = await items.listStock(match.id);
      return {
        ...match,
        placements: placements.map((p) => ({ locationName: p.locationName, quantity: p.quantity })),
      };
    }),
  );

  return { query: q.trim(), matches: enriched, spoken: speakWhereIs(q.trim(), enriched) };
}

/**
 * Build the {@link SearchAST} for a raw query: the power-user grammar first, falling
 * back to a bare name-CONTAINS so a phrase the grammar rejects still searches. The
 * result is always run through `searchByAst`, which validates it via `parseASTtoSQL`.
 */
function astForQuery(q: string): SearchAST {
  const parsed = parseTextQuery(q);
  return parsed.ok ? parsed.ast : nameContainsAst(q);
}

/** The fallback tree: match items whose name contains the whole (trimmed) query. */
function nameContainsAst(q: string): SearchAST {
  return {
    type: 'GROUP',
    logicalOperator: 'AND',
    conditions: [{ field: 'name', operator: 'CONTAINS', value: q.trim() }],
  };
}

/** Clamp a requested limit into `[1, MAX_RESULT_LIMIT]`, defaulting when absent/invalid. */
function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_RESULT_LIMIT;
  return Math.min(MAX_RESULT_LIMIT, Math.max(1, Math.floor(requested)));
}
