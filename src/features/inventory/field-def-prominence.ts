/**
 * Per-**definition** custom-field prominence (W1d) — the flag that lets one field outrank its
 * siblings wherever it appears.
 *
 * ## Not to be confused with its neighbour
 *
 * `./field-prominence.ts` (issue #619) is a **different axis with a different subject**, and the
 * two are deliberately kept apart:
 *
 * | | subject | question it answers | reach |
 * | --- | --- | --- | --- |
 * | `categories.field_prominence` (#619) | a **category** | *where does the whole field set sit?* | the item dialog's tab rail |
 * | `field_defs.prominence` (W1d, here) | a **definition** | *which member leads the set?* | every surface that renders a field set |
 *
 * They cannot fight, because neither can do the other's job and each is the only answer to its
 * own question. W1d never moves a tab — that is #619's single answer, and a second answer to it
 * would be a knob silently contradicting the first. #619 never reorders within the set — it says
 * so itself ("this only moves them"). So a key field leads its list identically whether that list
 * sits in Classification, in a promoted Classification, or in a category's own break-out tab: the
 * mode changes nothing about the rank, and the rank changes nothing about the mode.
 *
 * The two meet in exactly one place, and it needs no rule of its own: when the custom-fields
 * section is **hidden** (the device's module is off, or the category hides it and the item holds
 * nothing), no fields are rendered at all, so there is nothing to lead. W1d therefore inherits
 * #619's "never outrank a hiding decision" invariant for free rather than restating it, and can
 * never resurrect a field something else dropped.
 *
 * ## Why the flag lives on the definition, not on the category's use of it
 *
 * The counter-argument is real and was the strongest one this series has met: display *order* is
 * already category policy — `category_fields.position` sits beside `is_required` and
 * `default_value` — so a rank looks like it belongs there too. It loses on three counts.
 *
 * 1. **`position` cannot reach half the surfaces a rank must reach.** A **location's** field
 *    values have no `category_fields` row at all, so `listLocationFieldValues` can only order by
 *    name — and a location feeds every item that inherits from it. An item's *effective* field
 *    set can likewise carry a value inherited from a location or left behind by a change of
 *    category; those key on `def_id`, exactly as the due-date opt-in (W1a) and the unit and range
 *    (W1b/W1c) do.
 * 2. **The two say different things, so neither replaces the other.** `position` is an
 *    *arrangement* — where this category chose to put its fields in its own list. Prominence is a
 *    claim about the field itself: a *Serial number* matters more than a *Notes* wherever either
 *    appears. This change takes nothing away from `position`; it sorts ahead of it, and a
 *    category that wants a bespoke arrangement still gets one within each rank.
 * 3. **The dictionary exists so a definition means one thing everywhere.** One name carries one
 *    type, enforced, precisely so a field cannot mean two things at once. Letting importance fork
 *    per category would reintroduce that: *Voltage* leading on Batteries and trailing on
 *    Chargers, with nothing on screen to explain the difference.
 *
 * The cost is the same accepted one the rest of the dictionary already carries: marking a shared
 * definition reorders it in every category using it, exactly as a rename, a retype, a unit or a
 * range already does. The editor says so.
 *
 * ## Why the shape is one tolerant column, unlike W1a–W1c
 *
 * `due_lead_days` (W1a) and `min_value`/`max_value` (W1c) are **behavioural** — one gates an
 * alert, the others refuse a save — so a value they cannot honour must be refused at the storage
 * boundary, and each carries a table CHECK. A rank is **presentational**: the worst a value this
 * build doesn't recognise can do is fail to change a sort order. So the right failure mode is the
 * opposite one — keep whatever a peer wrote and narrow it here, at the render boundary. A CHECK
 * would instead fail a newer peer's *whole sync apply* over a display preference. That is the
 * reasoning `categories.field_prominence` already carries, adopted because this is the same
 * **kind** of setting, not because it happens to sit next door.
 *
 * There is deliberately **no field-type gate** either, and this is the one place W1d diverges from
 * all three of its predecessors: a unit means nothing on a `DATE` and a lead time means nothing on
 * a `NUMBER`, but *any* type can be the field that matters most. Nothing to clear on a retype,
 * therefore, and no `field_type` term in any constraint.
 */

/**
 * How prominently one custom-field **definition** is presented among its siblings.
 *
 * - `default` — unchanged: the field sorts by the category's `position`, then by name.
 * - `key` — the field **leads**: it sorts ahead of every non-key field in the same set, with
 *   ties broken by the ordinary rule, so several key fields keep a stable, predictable order
 *   among themselves.
 *
 * A symmetric third mode ("sink this one to the bottom") was considered and left out: it is a
 * different request from the one W1d exists to answer, and the vocabulary is stored as text
 * precisely so adding one later costs no column change.
 */
export type FieldDefProminence = 'default' | 'key';

/** Every mode, in the order the editor offers them: least to most prominent. */
export const FIELD_DEF_PROMINENCE_MODES: readonly FieldDefProminence[] = ['default', 'key'];

/**
 * The stored token for a key field — the single source of truth shared by this seam and the
 * `ORDER BY` that ranks the same fields in SQL, so the two can never disagree about which string
 * means "leads".
 */
export const KEY_FIELD_PROMINENCE: FieldDefProminence = 'key';

const MODE_SET: ReadonlySet<string> = new Set<string>(FIELD_DEF_PROMINENCE_MODES);

/**
 * Narrow a stored prominence value to a mode this build renders.
 *
 * Anything unrecognised — null, a blank string, or a mode a newer peer invented — reads as
 * `default`, which is also the only mode that changes nothing. Storage keeps the original string
 * verbatim; this is purely the render boundary. Matching is exact: no case folding and no
 * trimming, so `'Key'` and `' key '` are *not* key fields here — the write seam is what
 * canonicalises, and a value that reached storage uncanonicalised came from somewhere this build
 * has no business second-guessing.
 */
export function toFieldDefProminence(value: string | null | undefined): FieldDefProminence {
  return value != null && MODE_SET.has(value) ? (value as FieldDefProminence) : 'default';
}

/** Whether a stored prominence value marks this definition as a key field. */
export function isKeyField(value: string | null | undefined): boolean {
  return toFieldDefProminence(value) === KEY_FIELD_PROMINENCE;
}

/**
 * Canonicalise a prominence mode for storage.
 *
 * Trimmed, and `'default'` collapsed to `null`: "no more prominent than its siblings" is the
 * absence of a preference, and storing two spellings of it would make an LWW merge see an edit
 * where the user changed nothing. An unrecognised mode is *not* rejected — the column keeps
 * whatever a newer peer wrote, and {@link toFieldDefProminence} decides what this build renders.
 *
 * The body is identical to the category axis's private `serialiseFieldProminence` in
 * `CategoryRepository`, and the two are deliberately **not** shared. They canonicalise different
 * columns holding different vocabularies that happen to agree on the `'default'` sentinel today;
 * folding them together would mean a change to either axis's vocabulary silently altering the
 * other's storage — the precise coupling this pair of settings exists to avoid.
 */
export function serialiseFieldDefProminence(mode: string | null | undefined): string | null {
  if (mode == null) return null;
  const trimmed = mode.trim();
  return trimmed.length === 0 || trimmed === 'default' ? null : trimmed;
}

/** The minimum a field must expose to be ranked. */
interface Rankable {
  readonly prominence: string | null;
}

/**
 * Sort key fields to the front, preserving the relative order of everything else.
 *
 * A **stable partition**, not a comparator: the input already arrives in the order its source
 * decided (`position` then name for a category's fields, name alone for a location's), and that
 * order stays intact *within* each rank. So prominence is a coarser key layered on top of the
 * existing one rather than a replacement for it — which is what makes it compose with
 * `category_fields.position` instead of overruling it.
 *
 * Returns the **same reference** when no field is key, so the overwhelmingly common case
 * allocates nothing and a memoised consumer sees a stable identity.
 *
 * Note what this is *not*: no render surface re-sorts, because every rendered field set already
 * arrives ranked from the SQL `ORDER BY`. This is the independently-written counterpart to that
 * `ORDER BY`, which keeps {@link ../custom-fields.ts}'s `fieldsForCategory` honest about the
 * ordering its contract promises to mirror — and which a repository test compares against a real
 * read, so the two implementations cannot quietly disagree.
 */
export function orderByFieldProminence<T extends Rankable>(fields: readonly T[]): readonly T[] {
  const leading: T[] = [];
  const rest: T[] = [];
  for (const field of fields) (isKeyField(field.prominence) ? leading : rest).push(field);
  return leading.length === 0 ? fields : [...leading, ...rest];
}
