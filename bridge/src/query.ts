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
import type { Item } from '@/db/repositories/types';
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
  /**
   * The item's primary/home location id, or null if it has none. Carried alongside the name for
   * the same reason placements carry one: a name is what a person hears, an id is what a consumer
   * can act on. Null exactly when {@link locationName} is — i.e. the item's location could not be
   * resolved — so the two are always consistent.
   */
  readonly locationId: string | null;
  /** The item's primary/home location name, or null if it has none. */
  readonly locationName: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
}

/** One location's share of an item's stock, for the "where is X?" breakdown. */
export interface LocationBreakdown {
  /**
   * The location's stable id. Carried alongside the name because a *name* is for a human to hear
   * and an *id* is what a consumer can act on — an automation lighting the right shelf, or a
   * follow-up REST call — and matching a name back to a location is guesswork once two locations
   * share one. `listStock` already returns it; this DTO simply stopped dropping it.
   */
  readonly locationId: string;
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
 * The observer {@link whereIs} notifies once a lookup has resolved — the seam behind the opt-in
 * `lookup.resolved` event (`GUBBINS_BRIDGE_LOOKUP_EVENTS`).
 *
 * Declared here **structurally** and injected per call, deliberately: this module is the
 * transport-agnostic, side-effect-free query core, and importing the event pipeline into it would
 * couple every read to I/O and make it un-unit-testable. The composition root
 * (`serve.ts` → `server.ts`) supplies the real implementation; with nothing injected, `whereIs`
 * behaves exactly as it always has and emits nothing.
 */
export interface LookupObserver {
  /** Called once per resolved lookup. Must not throw, and must return promptly. */
  onLookupResolved(result: WhereIsResult): void;
}

export interface WhereIsOptions extends SearchOptions {
  /** Optional resolved-lookup observer. Absent (the default) means nothing is emitted. */
  readonly observer?: LookupObserver;
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
  const rows = await searchItemRows(driver, q, options);
  const locations = new LocationRepository(driver);
  return Promise.all(
    rows.map(async (row) => {
      // One read, both fields: resolving the location once keeps the id and the name from ever
      // disagreeing about whether the item has a home location.
      const location = await locations.getById(row.locationId);
      return {
        id: row.id,
        name: row.name,
        quantity: row.quantity,
        locationId: location?.id ?? null,
        locationName: location?.name ?? null,
        mpn: row.mpn,
        manufacturer: row.manufacturer,
      };
    }),
  );
}

/**
 * The same relevance search as {@link searchItems}, but returning the **raw** {@link Item}
 * rows rather than the compact {@link ItemMatch} DTO. This is the projection-friendly seam:
 * the field-selection layer needs every column available (e.g. `unitCost`, `notes`) so it can
 * emit an arbitrary sparse fieldset, which the compact DTO has already discarded. Same query
 * grammar, same fallback, same limit clamp — only the shape returned differs.
 */
export async function searchItemRows(
  driver: IDatabaseDriver,
  q: string,
  options: SearchOptions = {},
): Promise<readonly Item[]> {
  const trimmed = q.trim();
  if (trimmed.length === 0) return [];
  const page = await new ItemRepository(driver).searchByAst(astForQuery(trimmed), {
    limit: clampLimit(options.limit),
  });
  return page.rows;
}

/**
 * Answer "where is X?": the top {@link searchItems} matches, each enriched with its
 * per-location stock breakdown (so a multi-location item reports "5 on Shelf 2, 2 in
 * Bin 4", not just its primary location), plus one spoken sentence for a voice device.
 */
export async function whereIs(
  driver: IDatabaseDriver,
  q: string,
  options: WhereIsOptions = {},
): Promise<WhereIsResult> {
  const matches = await searchItems(driver, q, options);
  const items = new ItemRepository(driver);

  const enriched: WhereIsMatch[] = await Promise.all(
    matches.map(async (match) => {
      const placements = await items.listStock(match.id);
      return {
        ...match,
        placements: placements.map((p) => ({
          locationId: p.locationId,
          locationName: p.locationName,
          quantity: p.quantity,
        })),
      };
    }),
  );

  const result: WhereIsResult = {
    query: q.trim(),
    matches: enriched,
    spoken: speakWhereIs(q.trim(), enriched),
  };
  // Notify the (optional) observer *after* the answer is fully built, and never let it affect the
  // answer: a caller asking "where is X?" must get the same result whether or not anything is
  // listening, so a throwing observer is swallowed here rather than failing the read.
  if (options.observer) {
    try {
      options.observer.onLookupResolved(result);
    } catch {
      // The observer owns its own error reporting; the query core stays silent and side-effect-free.
    }
  }
  return result;
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
