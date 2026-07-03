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
 * (capped), which powers "click the chevron to browse everything" on an empty field.
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
