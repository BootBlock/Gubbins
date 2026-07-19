/**
 * Pure projection of a replacement tag-name set onto the cached {@link Tag} rows (issue #293).
 * Kept separate from the hooks so the rule the optimistic patch follows is unit-testable
 * without a query client.
 */
import type { Tag } from '@/db/repositories/types/tags';

/**
 * Rebuild `names` as the `Tag[]` shape the tag queries serve, reusing the cached row for a
 * name that is already applied (so ids stay stable) and minting a provisional row for a
 * genuinely new one.
 *
 * Mirrors what `TagRepository.applyTagSet` will store and read back: names are trimmed,
 * blanks dropped, duplicates collapsed case-insensitively, and the result ordered by name
 * case-insensitively — so the chips don't reorder when the real rows land.
 */
export function projectTagSet(cached: readonly Tag[] | undefined, names: readonly string[]): Tag[] {
  const byName = new Map((cached ?? []).map((tag) => [tag.name.toLowerCase(), tag]));
  const seen = new Set<string>();
  const next: Tag[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // A provisional id only has to be unique within this list and stable for React's key —
    // the real row replaces it as soon as the write settles and the query refetches.
    next.push(byName.get(key) ?? { id: `pending:${key}`, name, updatedAt: 0 });
  }
  // Compare lower-cased rather than by locale: SQLite's `COLLATE NOCASE` folds case and
  // nothing else, so an accent-insensitive comparison would order the patch differently from
  // the rows that replace it and make the chips visibly reshuffle.
  return next.sort((a, b) => {
    const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}
