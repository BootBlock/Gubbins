/**
 * FTS5 MATCH-query construction (spec §5 FTS5 text matching, §2.2.1a).
 *
 * The genuine search backend for the indexed item text columns is the `items_fts`
 * FTS5 virtual table (created in the squashed `v1-initial` baseline — there is no
 * separate v5 step left to point at), **never** a `LIKE` scan: the app's search
 * box, the text-query grammar and the bridge's `$search` all arrive here. The one
 * exception over those columns is the AST's `SUBSTRING` operator, added so the
 * bridge's OData `contains()` can mean substring (issue #369) — no index can serve
 * that, so it bypasses this module entirely.
 *
 * User text is turned into a prefix query here and passed to SQLite as a **bound
 * parameter** — it is never concatenated into SQL. Each whitespace token is wrapped
 * as a double-quoted FTS string (so special characters like `-`, `:` or `*` are
 * treated literally, not as FTS operators) with a trailing `*` for prefix matching,
 * then AND-combined.
 *
 *   buildFtsMatch('lm78 reg')            → '"lm78"* "reg"*'
 *   buildFtsMatch('wifi', 'description') → 'description : ("wifi"*)'
 *
 * A column filter scopes the match to one indexed column. The column name is an
 * identifier drawn from a fixed allow-list (never user input), so embedding it is
 * safe; only the *tokens* carry user data and they live inside the bound string.
 */
import { FTS_ITEM_COLUMNS, type FtsItemColumn } from '@/db/repositories/constants';

/** Escape a single token into a literal FTS5 phrase with a prefix wildcard. */
function toPrefixPhrase(token: string): string {
  // Double-quotes inside an FTS5 string are escaped by doubling them.
  return `"${token.replace(/"/g, '""')}"*`;
}

/**
 * Build an FTS5 MATCH query string from free user text, or `null` when the text
 * has no usable tokens (so callers can skip the predicate entirely).
 *
 * @param column Optional indexed column to scope the match to (§4.2.4 style).
 */
export function buildFtsMatch(text: string, column?: FtsItemColumn): string | null {
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const query = tokens.map(toPrefixPhrase).join(' ');
  return column ? `${column} : (${query})` : query;
}

/** Type guard: is `field` one of the FTS5-indexed item columns? */
export function isFtsColumn(field: string): field is FtsItemColumn {
  return (FTS_ITEM_COLUMNS as readonly string[]).includes(field);
}
