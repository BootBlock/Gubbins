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
 * (capped), which is what an untouched field's type-ahead offers. Browsing the list does not
 * come through here at all — the chevron shows the whole catalogue, uncapped.
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
 * Where a browse of the whole list should start, or `-1` when nothing in it fits the field's
 * current value — so an untouched field opens with no option highlighted.
 *
 * The value itself wins: names are compared through {@link foldName}, the same fold the write
 * paths use, so `größe` meets `GRÖSSE` here as it does there. Failing that, the option the
 * type-ahead would have ranked first stands in — a field whose text is a *prefix* of its
 * option rather than the whole of it (a currency field holding `USD` against a
 * `USD — US Dollar` list) would otherwise start at the top of the catalogue, which for a
 * keyboard user is one Enter away from replacing the value with an unrelated one.
 */
export function browseStartIndex(suggestions: readonly string[], value: string): number {
  const folded = foldName(value);
  if (folded.length === 0) return -1;
  const exact = suggestions.findIndex((suggestion) => foldName(suggestion) === folded);
  if (exact >= 0) return exact;
  const [best] = filterSuggestions(suggestions, value, 1);
  return best === undefined ? -1 : suggestions.indexOf(best);
}
