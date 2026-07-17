import { includesAllTerms, splitSearchTerms } from '@/lib/text-terms';
import { ALL_EMOJIS, type EmojiEntry } from './emoji-data';

/**
 * Pure search over the curated emoji catalogue (issue #83), lucide-free so the matching
 * rules are unit-testable without the picker UI. Uses the same term-AND-substring model as
 * the rest of the app (`@/lib/text-terms`) applied to each emoji's name **and** its extra
 * keywords — so "car" finds 🚗 and "screw" finds 🔩 — and either word order works. An
 * empty/whitespace query returns the whole corpus (the picker's browse state).
 */
export function filterEmojis(query: string): readonly EmojiEntry[] {
  const terms = splitSearchTerms(query);
  if (terms.length === 0) return ALL_EMOJIS;
  return ALL_EMOJIS.filter((e) => includesAllTerms(`${e.name} ${e.keywords ?? ''}`, terms));
}

/**
 * The display name for a stored emoji character, or `null` when it isn't in the catalogue.
 * Used to give a chosen emoji an accessible label in triggers and previews.
 */
export function emojiName(char: string | null | undefined): string | null {
  if (!char) return null;
  return ALL_EMOJIS.find((e) => e.char === char)?.name ?? null;
}
