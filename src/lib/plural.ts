/**
 * Minimal English noun pluralisation. Replaces the scattered inline
 * `` `${n} thing${n === 1 ? '' : 's'}` `` ternaries with one honest helper so the
 * `'' : 's'` suffix logic and irregular plurals live in a single place.
 *
 * Scope is deliberately narrow — noun forms only. Verb agreement (`need`/`needs`)
 * and pronouns (`it`/`them`) are a different concern and stay at their call sites.
 */

/**
 * The correctly-pluralised noun for `count`, without the count itself.
 *
 * Regular nouns take the default `+s` rule; pass an explicit `pluralForm` for
 * irregulars (e.g. `plural(n, 'category', 'categories')`). Compose with the count
 * where needed: `` `${n} ${plural(n, 'item')}` ``.
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
  if (count === 1) return singular;
  return pluralForm ?? `${singular}s`;
}
