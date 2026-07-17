/**
 * Shared free-text term matching — the single home of the "whitespace splits the query
 * into terms that must *all* appear as case-insensitive substrings (AND)" model used by
 * every searchable picker (the glyph picker's icon filter, the category-preset picker's
 * library search). Kept pure and dependency-free so the matching rules are unit-testable
 * and can never drift between the pickers that document themselves as sharing one model.
 */

/** Split a query into its lower-cased search terms; empty/whitespace queries yield none. */
export function splitSearchTerms(query: string): readonly string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * True when every term appears in `haystack` (case-insensitive substring). Terms come
 * from {@link splitSearchTerms}; callers filtering many haystacks against one query
 * should split once and reuse the terms. No terms (an empty query) matches everything —
 * the "browse" state of a filterable list.
 */
export function includesAllTerms(haystack: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const hay = haystack.toLowerCase();
  return terms.every((term) => hay.includes(term));
}
