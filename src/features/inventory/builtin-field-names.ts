/**
 * Pure seam for detecting a **custom field named after a built-in item attribute**
 * (follow-up to issue #97).
 *
 * Items already carry built-in attributes — `manufacturer`, `notes`, `quantity` and so on —
 * and the field dictionary happily accepts a *custom* field with the same name. Nothing
 * breaks: the two are genuinely different things, stored in different places, and an item
 * can end up showing "Manufacturer" twice, in two different tabs, holding two different
 * values.
 *
 * **The decision: warn, don't reserve.** Blocking the name outright would be wrong — a user
 * who never fills in the built-in Manufacturer column is perfectly entitled to define their
 * own Manufacturer field, and a hard reservation would also be a breaking change for anyone
 * who already has one. Silently allowing it is what produces the confusing duplicate. So the
 * name is allowed and the *collision* is surfaced at the point of naming, where the user can
 * still cheaply choose a different word. This seam is the pure half; the UI renders it.
 *
 * Matching is case-insensitive on a trimmed name, mirroring the `field_defs.name` NOCASE
 * unique index — the dictionary already treats "manufacturer" and "Manufacturer" as one
 * name, so the warning must agree with it.
 */
import { BUILDER_FIELDS } from '@/features/search/fields';
import { BUILTIN_CARD_FIELDS } from './card-fields';

/**
 * Built-in item attribute names that no existing registry spells out.
 *
 * {@link BUILDER_FIELDS} and {@link BUILTIN_CARD_FIELDS} between them already name most of
 * the item's built-in attributes, and deriving from those keeps this in step with them
 * automatically. These few are user-visible item fields that neither registry happens to
 * list, so they are named here rather than left as gaps in the warning.
 */
const EXTRA_BUILT_IN_NAMES: readonly string[] = [
  'Unit cost',
  'Acquired date',
  'Supplier',
  'Model',
  'Warranty expiry',
];

/**
 * Every name the app already uses for a built-in item attribute, de-duplicated and sorted.
 * Derived from the existing registries rather than restated, so a label renamed there is
 * reflected here without a second list to remember.
 */
export const BUILT_IN_ITEM_FIELD_NAMES: readonly string[] = [
  ...new Set([
    // The search builder omits id-keyed fields (category, location); the card registry has them.
    ...BUILDER_FIELDS.filter((f) => f.kind !== 'capability' && f.kind !== 'customfield').map((f) => f.label),
    ...BUILTIN_CARD_FIELDS.map((f) => f.label),
    ...EXTRA_BUILT_IN_NAMES,
  ]),
].sort((a, b) => a.localeCompare(b));

/**
 * Normalise a field name for comparison the way the dictionary's NOCASE index would.
 *
 * Deliberately locale-**in**dependent `toLowerCase`, not `toLocaleLowerCase`: SQLite's NOCASE
 * collation folds ASCII only, and a locale-aware fold disagrees with it. Under `tr-TR`,
 * `'MANUFACTURER'.toLocaleLowerCase()` yields a dotless 'ı', which would stop matching the
 * catalog entry — so a Turkish-locale user would silently lose the collision warning for a
 * name the database still considers identical.
 */
function normalise(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The built-in attribute a proposed custom-field name collides with, or `undefined` when
 * there is no collision.
 *
 * Returns the built-in's **canonical label** rather than a boolean so the caller can name it
 * back to the user ("Items already have a built-in *Manufacturer*"), which is the part that
 * makes the warning actionable. A blank or whitespace-only name never collides.
 */
export function builtInFieldNameClash(name: string): string | undefined {
  const needle = normalise(name);
  if (needle === '') return undefined;
  // Some labels carry a unit suffix the user would never type ("Weight (g)"), so compare
  // against the label with any trailing parenthetical stripped as well as the label itself.
  return BUILT_IN_ITEM_FIELD_NAMES.find((label) => {
    const bare = label.replace(/\s*\([^)]*\)\s*$/, '');
    return normalise(label) === needle || normalise(bare) === needle;
  })?.replace(/\s*\([^)]*\)\s*$/, '');
}
