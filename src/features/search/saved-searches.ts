/**
 * Saved text searches (spec §3 Advanced Search — Phase 48).
 *
 * A power user who has crafted a useful hybrid text query (`cap:voltage>3.3 (qty<10
 * OR mfr:acme)`) can name and recall it later. The query is stored as its **text**
 * (re-parsed through {@link parseTextQuery} on recall, which re-validates it) — the
 * canonical, human-editable form — rather than a frozen AST.
 *
 * These are the pure list operations behind {@link useSavedSearchesStore}; keeping
 * the add/dedupe/cap maths here (the `settings.ts` / `dashboard-layout.ts` "logic out
 * of the store" seam) makes them directly unit-testable. The store is thin glue and
 * persists the result to localStorage (device-local — no DB migration).
 */

/** One named, recallable text query. */
export interface SavedSearch {
  readonly id: string;
  readonly name: string;
  /** The raw hybrid-syntax query text, re-parsed on recall. */
  readonly query: string;
}

/** Keep the list bounded so localStorage never grows without limit. */
export const MAX_SAVED_SEARCHES = 50;

/** A saved-search name is a short label, not a paragraph. */
export const MAX_SAVED_SEARCH_NAME_LENGTH = 60;

/**
 * Add (or update) a saved search. A blank name or blank query is a no-op (you can't
 * save nothing). Names match case-insensitively: saving under an existing name
 * **replaces** that entry's query (and re-labels it) in place rather than duplicating.
 * A genuinely new entry is prepended (most-recent first) and the list is capped at
 * {@link MAX_SAVED_SEARCHES}, dropping the oldest.
 *
 * `makeId` is injectable so tests get deterministic ids (defaults to the native
 * `crypto.randomUUID`, the project-wide id source).
 */
export function addSavedSearch(
  list: readonly SavedSearch[],
  rawName: string,
  rawQuery: string,
  makeId: () => string = () => crypto.randomUUID(),
): readonly SavedSearch[] {
  const name = rawName.trim().slice(0, MAX_SAVED_SEARCH_NAME_LENGTH);
  const query = rawQuery.trim();
  if (name.length === 0 || query.length === 0) return list;

  const lower = name.toLowerCase();
  const existingIndex = list.findIndex((s) => s.name.toLowerCase() === lower);
  if (existingIndex >= 0) {
    return list.map((s, i) => (i === existingIndex ? { ...s, name, query } : s));
  }

  return [{ id: makeId(), name, query }, ...list].slice(0, MAX_SAVED_SEARCHES);
}

/** Remove a saved search by id (no-op if it isn't there). */
export function removeSavedSearch(
  list: readonly SavedSearch[],
  id: string,
): readonly SavedSearch[] {
  return list.filter((s) => s.id !== id);
}
