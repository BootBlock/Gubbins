/**
 * Where a category's custom fields sit in the item dialog (issue #619).
 *
 * Custom fields are the whole point of some categories and an afterthought in others. A `Movie`
 * exists *because* of its Format, Director and Year; a `Fastener` is fully described by the
 * built-in fields and its custom ones are a footnote. Today both get the same treatment — the
 * fields sit inside **Classification**, eighth of nine tabs — which is right for the fastener and
 * wrong for the film.
 *
 * So the position is a property of the **category**, not of the app and not of the item:
 *
 * - The category is the only thing that knows *which* custom fields an item has — they are
 *   declared on it, and an uncategorised item has none. A per-item switch would let two films in
 *   the same category disagree about where their identical field set lives, which is noise rather
 *   than flexibility.
 * - It is also the axis the request is actually about ("not all custom fields should be made more
 *   prominent"): prominence follows the *kind of thing*, exactly as `hidden_capabilities` does.
 *
 * Three invariants, each load-bearing:
 *
 * 1. **Presentation only.** This moves a tab. It never changes which fields exist, what they
 *    hold, whether they sync, or what any of them mean.
 * 2. **Never outrank a hiding decision.** Prominence is applied *after* the module and
 *    category-hiding axes have had their say ({@link isCapabilityVisible}), so a promoted tab can
 *    never resurrect a section either of them dropped. The caller enforces this by resolving
 *    {@link effectiveProminenceMode} against the surviving custom-fields section.
 * 3. **Unknown modes read as the default.** Storage keeps whatever it was given, so a peer on a
 *    newer version can add a fourth mode without this build discarding its choice on a round-trip;
 *    {@link toFieldProminenceMode} is the boundary where that tolerance turns into a rendering
 *    decision. This mirrors `hidden_capabilities` exactly — see
 *    {@link ./category-capabilities.ts}.
 */

/**
 * How prominently a category's custom fields are presented on an item.
 *
 * - `default` — unchanged: the fields stay in the **Classification** tab, where it sits today.
 * - `promoted` — the whole **Classification** tab moves to sit directly after **Details**. The
 *   cheap option: nothing is restructured, the fields are simply two clicks closer, and the tags
 *   and capabilities beside them come along for the ride.
 * - `own-tab` — the **Custom fields** section breaks out of Classification into a tab of its own,
 *   directly after **Details**, under a label the category chooses. The strongest option, and the
 *   only one that lets a category name the thing its fields collectively *are* ("Film details",
 *   "Pressing", "Provenance") rather than leaving them under a generic heading.
 */
export type FieldProminenceMode = 'default' | 'promoted' | 'own-tab';

/** Every mode, in the order the editor offers them: least to most prominent. */
export const FIELD_PROMINENCE_MODES: readonly FieldProminenceMode[] = ['default', 'promoted', 'own-tab'];

const MODE_SET: ReadonlySet<string> = new Set<string>(FIELD_PROMINENCE_MODES);

/**
 * The upper bound on a break-out tab's label.
 *
 * The tab rail is a fixed-width column beside the dialog body, so a long label wraps and pushes
 * the rail's other tabs out of alignment rather than truncating gracefully. 24 characters leaves
 * comfortable room past the longest built-in labels ("Classification" and "Supplier & ops", both
 * 14) to be descriptive, while staying short enough that the rail keeps its shape at the
 * narrowest supported width.
 */
export const MAX_FIELD_TAB_LABEL_LENGTH = 24;

/**
 * Narrow a stored prominence value to a mode this build renders.
 *
 * Anything unrecognised — null, a blank string, or a mode a newer peer invented — reads as
 * `default`, which is also the only mode that changes nothing. Storage keeps the original string
 * verbatim; this is purely the render boundary.
 */
export function toFieldProminenceMode(value: string | null | undefined): FieldProminenceMode {
  return value != null && MODE_SET.has(value) ? (value as FieldProminenceMode) : 'default';
}

/**
 * Canonicalise a break-out tab's label for storage.
 *
 * Trimmed, length-capped, and empty-as-null so the column has exactly one spelling of "no label
 * of my own" — an editor that stored `''` beside another device's `null` would look like an edit
 * to LWW sync and churn the row for nothing.
 *
 * The cap counts **code points**, not UTF-16 code units: a label is free text and an emoji in one
 * is entirely plausible ("🎬 Film details"), and `String.slice` at the boundary of an astral
 * character leaves a lone surrogate — which renders as `` and would then be persisted verbatim.
 */
export function normaliseFieldTabLabel(label: string | null | undefined): string | null {
  if (label == null) return null;
  const trimmed = [...label.trim()].slice(0, MAX_FIELD_TAB_LABEL_LENGTH).join('').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The label a break-out tab actually shows: the category's own, or the built-in fallback.
 *
 * The fallback is passed in rather than hard-coded because it is user-facing copy and belongs to
 * the translation catalog, which this DB-adjacent seam has no business importing.
 */
export function resolveFieldTabLabel(stored: string | null | undefined, fallback: string): string {
  return normaliseFieldTabLabel(stored) ?? fallback;
}

/**
 * The mode that actually applies, given whether the custom-fields section survived the visibility
 * axes.
 *
 * Invariant 2 in one line. When the device's module is off, or the category hides custom fields
 * and the item has none stored, there is nothing to make prominent — promoting **Classification**
 * would then push a tab holding only tags and capabilities to the top, and breaking out a tab
 * would produce an empty one. Both are worse than doing nothing.
 */
export function effectiveProminenceMode(
  mode: FieldProminenceMode,
  customFieldsVisible: boolean,
): FieldProminenceMode {
  return customFieldsVisible ? mode : 'default';
}

/** The minimum a tab must expose for the two ordering helpers below to place it. */
interface Identified {
  readonly id: string;
}

/**
 * Move an existing tab to sit directly after another, preserving every other tab's relative order.
 *
 * Returns the input unchanged when either id is absent, so a tab dropped by a feature gate simply
 * leaves the order alone instead of throwing or silently reordering something else.
 */
export function moveTabAfter<T extends Identified>(
  tabs: readonly T[],
  movedId: string,
  anchorId: string,
): readonly T[] {
  const moved = tabs.find((tab) => tab.id === movedId);
  if (moved === undefined || movedId === anchorId) return tabs;
  const rest = tabs.filter((tab) => tab.id !== movedId);
  const anchorAt = rest.findIndex((tab) => tab.id === anchorId);
  if (anchorAt === -1) return tabs;
  return [...rest.slice(0, anchorAt + 1), moved, ...rest.slice(anchorAt + 1)];
}

/**
 * Insert a new tab directly after another.
 *
 * A missing anchor puts the tab **first** rather than last: the anchor is the Details tab, whose
 * whole purpose here is "as near the front as makes sense", so losing it should not exile the tab
 * to the far end of the rail.
 */
export function insertTabAfter<T extends Identified>(
  tabs: readonly T[],
  tab: T,
  anchorId: string,
): readonly T[] {
  const anchorAt = tabs.findIndex((t) => t.id === anchorId);
  if (anchorAt === -1) return [tab, ...tabs];
  return [...tabs.slice(0, anchorAt + 1), tab, ...tabs.slice(anchorAt + 1)];
}
