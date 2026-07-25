/**
 * Visual-Builder AST search concern (spec §5.1). The AST is translated by the single
 * parameterised {@link parseASTtoSQL} utility; when it filters on `capability:<key>`
 * fields, results are ranked by the summed weight of those capabilities ("best match").
 */
import { astFiltersActiveFlag, collectCapabilityKeys, parseASTtoSQL } from '../../search/parseASTtoSQL';
import type { SearchAST } from '../../search/ast';
import { rowToItem } from '../mappers';
import type { Item, ItemRow, Page, PageParams } from '../types';
import { capabilityMatchScore, itemOrderByClause, ITEM_READ_COLUMNS, type ItemSort } from './sql';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

/** Pagination + scope for a Visual-Builder AST search (spec §5.1). */
export interface SearchByAstParams extends PageParams {
  /**
   * Include soft-deleted items. Defaults to false (active inventory only) — except when the
   * tree itself filters on `active`, which lifts the implicit scope (see {@link activeScope}).
   */
  readonly includeInactive?: boolean;
  /**
   * Explicit sort (whitelisted fields). When set it **replaces** the default
   * capability-rank/alphabetical ordering with the caller's `ORDER BY`; omit to keep the
   * relevance ordering.
   */
  readonly sort?: readonly ItemSort[];
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

export function withSearch<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemSearchRepository extends Base {
    /**
     * Run a Visual-Builder {@link SearchAST} as a paginated item query. The AST is
     * translated by the single parameterised {@link parseASTtoSQL} utility (§5.1) and
     * scoped to active inventory unless `includeInactive` is set or the tree filters on
     * `active` itself ({@link activeScope}). Throws `SearchAstError` on an invalid/over-deep tree.
     */
    async searchByAst(ast: SearchAST, params: SearchByAstParams = {}): Promise<Page<Item>> {
      const { limit, offset } = this.resolvePage(params);
      const [where, whereParams] = parseASTtoSQL(ast);
      const active = activeScope(ast, params.includeInactive);

      // Weighted-capability "best match" ranking (spec §4, §5.1): when the query
      // filters on one or more `capability:<key>` fields, order results by the summed
      // weight of *those* capabilities each item carries — heaviest matches first —
      // before the stable alphabetical tie-break. A query with no capability conditions
      // keeps the plain alphabetical order untouched (zero behavioural change).
      const capabilityKeys = collectCapabilityKeys(ast);
      const rankSelect = capabilityKeys.length > 0 ? `, ${capabilityMatchScore(capabilityKeys.length)}` : '';
      const rankParams = capabilityKeys.length > 0 ? capabilityKeys : [];
      const rankOrder = capabilityKeys.length > 0 ? 'match_score DESC, ' : '';

      // An explicit sort replaces the relevance ordering entirely; otherwise keep the
      // capability-rank-then-alphabetical default (zero behavioural change when unsorted).
      const order =
        itemOrderByClause(params.sort) ??
        `${rankOrder}name COLLATE NOCASE ASC, serial_no ASC, created_at ASC`;

      const rows = await this.driver.query<ItemRow>(
        `SELECT ${ITEM_READ_COLUMNS}${rankSelect} FROM items WHERE (${where})${active}
         ORDER BY ${order}
         LIMIT ? OFFSET ?;`,
        [...rankParams, ...whereParams, limit, offset],
      );
      return this.toPage(rows.map(rowToItem), limit, offset);
    }

    /** Count items matching a {@link SearchAST} (for result headers). */
    async countByAst(ast: SearchAST, params: { includeInactive?: boolean } = {}): Promise<number> {
      const [where, whereParams] = parseASTtoSQL(ast);
      const active = activeScope(ast, params.includeInactive);
      const row = await this.driver.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM items WHERE (${where})${active};`,
        whereParams,
      );
      return Number(row?.n ?? 0);
    }
  };
}
