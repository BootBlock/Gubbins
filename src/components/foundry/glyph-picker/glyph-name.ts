/**
 * Pure name helpers for the Foundry glyph picker (spec §2.4.1 icon registry).
 *
 * A glyph is stored and referenced by its canonical Lucide component name in
 * PascalCase (e.g. `Rocket`, `CircleAlert`, `ArrowDownAZ`) — the keys of the
 * `icons` map re-exported by `lucide-react`. These helpers turn that identifier
 * into a human-readable label and power the picker's free-text search. They are
 * deliberately free of any Lucide import so they stay cheap and unit-testable.
 */
import { includesAllTerms, splitSearchTerms } from '@/lib/text-terms';

/**
 * Turn a PascalCase Lucide name into spaced words for display and search —
 * `ArrowDownAZ` → `Arrow Down A Z`, `Volume2` → `Volume 2`, `CircleAlert` →
 * `Circle Alert`. Boundaries: lower/digit→upper, an acronym run followed by a
 * TitleCase word, and letter→digit.
 */
export function humanizeGlyphName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .trim();
}

/** The lower-cased haystack a glyph is matched against (spaced words + raw name). */
export function glyphSearchText(name: string): string {
  return `${humanizeGlyphName(name)} ${name}`.toLowerCase();
}

/**
 * Filter glyph names by a free-text query — the shared term-AND-substring model
 * (`@/lib/text-terms`), so `arrow down` narrows to down-arrows while either word
 * order works. An empty query returns the list unchanged (a fresh copy). The query
 * is split once and reused across the ~1,700-name sweep.
 */
export function filterGlyphNames(names: readonly string[], query: string): string[] {
  const terms = splitSearchTerms(query);
  if (terms.length === 0) return [...names];
  return names.filter((name) => includesAllTerms(glyphSearchText(name), terms));
}
