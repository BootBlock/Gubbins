import { foldName } from '@/lib/name-fold';

/**
 * {@link Autocomplete}'s type-ahead ranking — a pure seam, kept out of the component file so
 * it is unit-testable in isolation (and so the component module exports only components, for
 * fast-refresh).
 */

/**
 * Rank and cap a suggestion list against what the user has typed so far.
 *
 * Case-insensitive; a prefix match (`Te` → `Texas Instruments`) ranks above a mere substring
 * hit (`ne` → `TE Con`**`ne`**`ctivity`), which is what a type-ahead should surface first.
 * Input order is preserved within each group — the real list arrives already A→Z from
 * `mergeSuggestions`, so equal-rank matches stay alphabetical. A suggestion identical to the
 * current input is dropped (there is nothing left to complete), so a field already holding an
 * exact match shows no redundant one-item list. An empty query returns the whole list
 * (capped), which is what an untouched field's type-ahead offers. Browsing the list is not a
 * type-ahead and does not narrow through here — {@link browseStartIndex} borrows this ranking
 * only to decide which option a browse should start on.
 */
export function filterSuggestions(suggestions: readonly string[], query: string, limit = 10): string[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return suggestions.slice(0, limit);
  const prefix: string[] = [];
  const substring: string[] = [];
  for (const suggestion of suggestions) {
    const lower = suggestion.toLowerCase();
    if (lower === q) continue; // exact match — nothing to complete
    if (lower.startsWith(q)) prefix.push(suggestion);
    else if (lower.includes(q)) substring.push(suggestion);
  }
  return [...prefix, ...substring].slice(0, limit);
}

/**
 * Where the list already holds the field's own value, or `-1`. Names are compared through
 * {@link foldName} — the same fold the write paths use, so `größe` meets `GRÖSSE` here as it
 * does there. An empty value matches nothing, so an untouched field starts on no option.
 */
export function indexOfValue(suggestions: readonly string[], value: string): number {
  const folded = foldName(value);
  if (folded.length === 0) return -1;
  return suggestions.findIndex((suggestion) => foldName(suggestion) === folded);
}

/**
 * Where a browse of the whole list should start: the field's own value, or failing that the
 * option the type-ahead would have ranked first. `-1` when neither exists.
 *
 * The second branch is for a field whose text is a *prefix* of its option rather than the
 * whole of it — a currency field holding `USD` against a `USD — US Dollar` list. Matching
 * only the whole string would start that browse at the top of the catalogue, on an option
 * with nothing to do with the value the field holds. Where a near match is not good enough —
 * a creatable field, where the typed text is itself a candidate — use {@link indexOfValue}.
 */
export function browseStartIndex(suggestions: readonly string[], value: string): number {
  const exact = indexOfValue(suggestions, value);
  if (exact >= 0) return exact;
  // An empty field has nothing to be near, and `filterSuggestions` would answer it with the
  // whole list — starting a browse on the first option the user never asked for.
  if (value.trim().length === 0) return -1;
  const [best] = filterSuggestions(suggestions, value, 1);
  return best === undefined ? -1 : suggestions.indexOf(best);
}
