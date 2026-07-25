/**
 * `LIKE`-pattern escaping for repository name filters.
 *
 * A user's search text is data, not syntax: typed as-is into a `LIKE` pattern, a `%` would
 * match everything and an `_` would match any single character, so searching for `50_ohm`
 * would quietly return rows it should not. Escaping the three special characters (and pairing
 * the query with `ESCAPE '\'`) makes the term match literally, which is the only behaviour a
 * search box can honestly promise.
 *
 * Shared rather than re-declared per repository so every name filter escapes identically —
 * one that forgot would be invisible until someone searched for a name containing `%`.
 */

/** Escape `LIKE` wildcards so user input is matched literally. Pair with `ESCAPE '\\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
