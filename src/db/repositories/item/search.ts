/**
 * Visual-Builder AST search concern (spec §5.1). The AST is translated by the single
 * parameterised {@link parseASTtoSQL} utility; when it filters on `capability:<key>`
 * fields, results are ranked by the summed weight of those capabilities ("best match").
 *
 * It also holds the free-text **relevance** read ({@link ItemSearchRepository.searchByRelevance}) —
 * the one item read whose ordering is the FTS5 match quality itself rather than the list's
 * favourites-then-alphabetical order.
 */
import {
  astFiltersActiveFlag,
  astFiltersLocation,
  collectCapabilityKeys,
  parseASTtoSQL,
} from '../../search/parseASTtoSQL';
import { buildFtsMatch } from '../../search/fts';
import type { SearchAST } from '../../search/ast';
import type { SqlValue } from '../../rpc/driver';
import { rowToItem } from '../mappers';
import type { Cursor, Item, ItemRow, Page, PageParams } from '../types';
import { buildSeekPredicate, extractCursor, renderOrderBy, resolveItemOrder } from './list-order';
import {
  capabilityMatchScore,
  itemOrderByClause,
  ITEM_READ_COLUMNS,
  ITEM_READ_COLUMNS_NO_THUMBNAIL,
  type ItemRowNoThumbnail,
  type ItemSort,
} from './sql';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

/** Pagination + scope for a Visual-Builder AST search (spec §5.1). */
export interface SearchByAstParams extends PageParams, AstScopeParams {
  /**
   * Explicit sort (whitelisted fields). When set it **replaces** the default
   * capability-rank/alphabetical ordering with the caller's `ORDER BY`; omit to keep the
   * relevance ordering.
   */
  readonly sort?: readonly ItemSort[];
  /**
   * Page by a forward keyset (seek) walk instead of `LIMIT ? OFFSET ?` (issue #533) — the same
   * mechanism `ItemCoreRepository.list` offers, for the one caller that walks a filtered result
   * set to its end rather than serving one page of it: the bridge's CSV export.
   *
   * Present ⇒ keyset, absent ⇒ offset. It has to be the *option* that selects the walk rather
   * than the cursor, because seeking is only correct against the ordering the cursor was cut
   * from — so the first page (no `after`) must already run that ordering, and every page after
   * it seeks past the previous page's `endCursor`.
   */
  readonly seek?: AstSeek;
}

/**
 * A forward keyset walk over an AST search (issue #533). `after` is the previous page's
 * `endCursor`; omit it for the first page.
 *
 * Forward-only, unlike the list's bidirectional {@link import('./core').ItemSeek}: the caller is
 * an export streaming a result set from its start to its end, and a scroll-up has no meaning
 * there. It also carries no `startIndex` — nothing positions these rows in a virtualised list —
 * so `Page.offset` stays at the running row count the caller passes as `offset`.
 */
export interface AstSeek {
  readonly after?: Cursor;
}

/** The scope every AST read shares — the tree, plus where the caller says to look. */
export interface AstScopeParams {
  /**
   * Include soft-deleted items. Defaults to false (active inventory only) — except when the
   * tree itself filters on `active`, which lifts the implicit scope (see {@link activeScope}).
   */
  readonly includeInactive?: boolean;
  /**
   * Restrict the search to one location, matched exactly as the item list's own `locationId`
   * filter does (issue #626). Lifted when the tree filters on `location` itself — see
   * {@link locationScope}.
   */
  readonly locationId?: string | null;
}

/**
 * The implicit "active inventory only" clause an AST search is scoped by, or `''` when it
 * should be lifted (issue #140).
 *
 * It is lifted for an explicit `includeInactive`, and also whenever the tree filters on the
 * `active` field itself: `active:no` AND-ed with `is_active = 1` is unsatisfiable, so leaving
 * the scope on would silently return nothing for the one query that asks about it. The user's
 * own condition then decides, and every query that doesn't mention `active` keeps the default.
 */
function activeScope(ast: SearchAST, includeInactive: boolean | undefined): string {
  return includeInactive || astFiltersActiveFlag(ast) ? '' : ' AND items.is_active = 1';
}

/**
 * The caller's location scope as a clause and its bound parameter, or `['', []]` when there is
 * none to apply (issue #626).
 *
 * The Inventory sidebar's selection scopes the plain item list, and it scopes a Visual-Builder
 * search the same way — otherwise the sidebar shows "Garage" selected while the results span
 * every room. The clause is the exact `location_id = ?` test `buildListFilter` uses, so both
 * paths agree on what "in this location" means.
 *
 * It is lifted whenever the tree filters on `location` itself: the user's own condition already
 * says where to look, and AND-ing a different location onto it is unsatisfiable — the same
 * reasoning {@link activeScope} applies to `active`.
 */
function locationScope(ast: SearchAST, locationId: string | null | undefined): [string, SqlValue[]] {
  if (!locationId || astFiltersLocation(ast)) return ['', []];
  return [' AND items.location_id = ?', [locationId]];
}

/** Pagination + scope for the free-text relevance search (issue #629). */
export interface RelevanceSearchParams extends PageParams {
  /** Include soft-deleted items. Defaults to false — active inventory only, as `list` is. */
  readonly includeInactive?: boolean;
}

/** The best matches for a free-text query, and how many matched altogether. */
export interface RelevanceSearch {
  /** The `limit` closest matches, best first. */
  readonly rows: Item[];
  /** How many items matched in total — including the ones past `limit`. */
  readonly total: number;
}

/**
 * The relevance score a free-text search orders by: FTS5's BM25, weighted per indexed column so
 * that "closest" means what a person searching an inventory means by it.
 *
 * The weights are positional and must stay in the `items_fts` column order (`name`, `description`,
 * `notes`, `mpn`, `manufacturer`, `barcode`, `serial_number`). A name hit dominates; the exact
 * identifiers (`mpn` / `barcode` / `serial_number`) rank next, since typing one is an unambiguous
 * request for that item; `manufacturer` is weaker; the free prose (`description`, `notes`) is the
 * weakest, so a passing mention never outranks an item actually called that.
 *
 * `bm25()` returns a *negative* score whose magnitude grows with match quality, so the ordering is
 * ascending — a heavier weight makes its column's hits sort earlier, not later.
 */
const FTS_RELEVANCE = 'bm25(items_fts, 10.0, 1.0, 1.0, 5.0, 2.0, 5.0, 5.0)';

export function withSearch<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemSearchRepository extends Base {
    /**
     * Run a Visual-Builder {@link SearchAST} as a paginated item query. The AST is
     * translated by the single parameterised {@link parseASTtoSQL} utility (§5.1) and
     * scoped to active inventory unless `includeInactive` is set or the tree filters on
     * `active` itself ({@link activeScope}). Throws `SearchAstError` on an invalid/over-deep tree.
     *
     * `params.seek` swaps the `OFFSET` for a keyset walk (issue #533); see {@link AstSeek} for
     * what that changes about the ordering, and why only a full-result-set walk asks for it.
     */
    async searchByAst(ast: SearchAST, params: SearchByAstParams = {}): Promise<Page<Item>> {
      const { limit, offset } = this.resolvePage(params);
      const [where, whereParams] = parseASTtoSQL(ast);
      const active = activeScope(ast, params.includeInactive);
      const [location, locationParams] = locationScope(ast, params.locationId);
      const seek = params.seek;

      // Weighted-capability "best match" ranking (spec §4, §5.1): when the query
      // filters on one or more `capability:<key>` fields, order results by the summed
      // weight of *those* capabilities each item carries — heaviest matches first —
      // before the stable alphabetical tie-break. A query with no capability conditions
      // keeps the plain alphabetical order untouched (zero behavioural change).
      //
      // A keyset walk cannot rank: `match_score` is a projected expression, not a stored column,
      // so no cursor can be cut from it and no seek predicate can compare against it. A walk
      // therefore takes the list's own total order below instead — which is what its one caller
      // wants anyway, since an export returns every matching row and "best first" ranks nothing.
      const capabilityKeys = seek === undefined ? collectCapabilityKeys(ast) : [];
      const rankSelect = capabilityKeys.length > 0 ? `, ${capabilityMatchScore(capabilityKeys.length)}` : '';
      const rankParams = capabilityKeys.length > 0 ? capabilityKeys : [];
      const rankOrder = capabilityKeys.length > 0 ? 'match_score DESC, ' : '';

      // The keyset walk orders by the list's total-order spec — the one `buildSeekPredicate` cuts
      // its cursors from, and the same order `list` (the unfiltered CSV's path) already returns.
      // An explicit sort otherwise replaces the relevance ordering entirely; without one, keep the
      // capability-rank-then-alphabetical default (zero behavioural change when unsorted).
      const seekTerms = seek !== undefined ? resolveItemOrder(params.sort) : undefined;
      const order =
        seekTerms !== undefined
          ? renderOrderBy(seekTerms)
          : (itemOrderByClause(params.sort) ??
            `${rankOrder}name COLLATE NOCASE ASC, serial_no ASC, created_at ASC`);

      // Seeking past a cursor is an extra WHERE conjunct and no `OFFSET`; the first page of a walk
      // has no cursor yet, so it is the same statement with nothing to seek past.
      const predicate =
        seekTerms !== undefined && seek?.after !== undefined
          ? buildSeekPredicate(seekTerms, seek.after)
          : undefined;
      const seekClause = predicate !== undefined ? ` AND (${predicate.sql})` : '';
      const pageClause = seek !== undefined ? 'LIMIT ?' : 'LIMIT ? OFFSET ?';

      const rows = await this.driver.query<ItemRow>(
        `SELECT ${ITEM_READ_COLUMNS}${rankSelect} FROM items WHERE (${where})${active}${location}${seekClause}
         ORDER BY ${order}
         ${pageClause};`,
        [
          ...rankParams,
          ...whereParams,
          ...locationParams,
          ...(predicate?.params ?? []),
          limit,
          ...(seek !== undefined ? [] : [offset]),
        ],
      );
      const page = this.toPage(rows.map(rowToItem), limit, offset);
      // Only a keyset read can hand back a usable cursor — an offset read's ordering is not the
      // total order the cursor is defined against, so it leaves `endCursor` absent (as `Page`
      // documents) rather than minting one that cannot be seeked with.
      if (seekTerms === undefined || rows.length === 0) return page;
      return { ...page, endCursor: extractCursor(rows[rows.length - 1]!, seekTerms) };
    }

    /** Count items matching a {@link SearchAST} (for result headers). */
    async countByAst(ast: SearchAST, params: AstScopeParams = {}): Promise<number> {
      const [where, whereParams] = parseASTtoSQL(ast);
      const active = activeScope(ast, params.includeInactive);
      const [location, locationParams] = locationScope(ast, params.locationId);
      const row = await this.driver.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM items WHERE (${where})${active}${location};`,
        [...whereParams, ...locationParams],
      );
      return Number(row?.n ?? 0);
    }

    /**
     * The **best** `limit` items for a free-text query, ordered by FTS5 relevance, plus how many
     * matched in total (issue #629).
     *
     * `list({ search })` answers a different question: it filters by the same FTS5 predicate but
     * orders favourites-then-alphabetically, so its first page is the alphabetically-first slice of
     * the match set, not the closest one. That is right for a browsable list the user scrolls, and
     * wrong for a fixed-size picker like the command palette — with more matches than fit in one
     * page, the item whose *name* is the query could sit past the cut and never be offered.
     *
     * So this read joins the FTS5 table instead of testing membership against it, which brings
     * `bm25()` into scope of the outer `ORDER BY`. The column weights say what "closest" means: a
     * hit in `name` outranks one in an identifier, which outranks one in the free prose — the same
     * intent {@link import('@/lib/fuzzy').rankFuzzy} applies on the client, but decided over the
     * *whole* match set rather than over whatever one page happened to contain.
     *
     * `total` is the size of that whole match set, taken in the same statement (`COUNT(*) OVER ()`
     * is evaluated before `LIMIT`) so the count and the rows can never describe different sets. It
     * is what lets the caller say "8 of 240" rather than presenting a capped read as the whole one.
     *
     * Relevance is the *whole* ordering here — the list's favourites-first lead is deliberately
     * not carried over, because a picker asked "which of these is closest to what I typed" should
     * not answer with something else. Name then id follow only as a total-order tiebreak.
     *
     * Text with no usable FTS tokens matches nothing, exactly as the list filter treats it.
     */
    async searchByRelevance(text: string, params: RelevanceSearchParams = {}): Promise<RelevanceSearch> {
      const match = buildFtsMatch(text.trim());
      if (match === null) return { rows: [], total: 0 };
      const { limit } = this.resolvePage(params);
      const rows = await this.driver.query<ItemRowNoThumbnail & { total_matches: number }>(
        // The active scope is a *bound* flag rather than an interpolated clause, so the statement
        // is one fixed text the read-shape guard can prepare and check (issue #356).
        `SELECT ${ITEM_READ_COLUMNS_NO_THUMBNAIL}, COUNT(*) OVER () AS total_matches FROM items
         JOIN (SELECT rowid AS fts_rowid, ${FTS_RELEVANCE} AS fts_score
               FROM items_fts WHERE items_fts MATCH ?) ON fts_rowid = items.rowid
         WHERE (? = 1 OR items.is_active = 1)
         ORDER BY fts_score ASC, items.name COLLATE NOCASE ASC, items.id ASC
         LIMIT ?;`,
        [match, params.includeInactive ? 1 : 0, limit],
      );
      // Every row carries the same window total; no rows means nothing matched.
      return { rows: rows.map(rowToItem), total: rows.length === 0 ? 0 : Number(rows[0]!.total_matches) };
    }
  };
}
