/**
 * A location's **own detail** — the description and custom-field values it holds about itself —
 * as a pure, DOM-free model (issue #617, candidates `N1`/`N2`).
 *
 * A location can already carry free text and any number of typed custom-field values, and until
 * now the app showed the values nowhere outside the Edit dialog: a value marked *inheritable* was
 * read all over the app (as the **item's** field, once an item adopted it), while the location's
 * own reading of the same row appeared only to whoever opened the editor. This seam is the
 * missing half — it turns those stored rows into the same `{ label, value }` descriptors the item
 * card renders (`card-fields.ts`), so the two surfaces share one presentation rather than
 * inventing a second one. (The other half of the answer, the text the sidebar's search matches,
 * is assembled per location in SQL — see `CategoryRepository.listLocationFieldSearchText`.)
 *
 * **Every value the location holds is its own detail, inheritable or not.** The inheritable flag
 * says "*also* offer this downward", not "this is not about the place" — and the editor seeds a
 * newly-added field as inheritable, so a non-inheritable-only panel would be empty for almost
 * everyone. What inheritance changes is who *else* reads the value, never whether the location
 * does.
 */
import type { FieldType } from '@/db/repositories/constants';
import { customFieldValue, type ResolvedCardField } from './card-fields';

/** The minimum a stored location field value must expose to be displayed or searched. */
export interface LocationDetailField {
  /** The dictionary definition's id — stable per field, so it keys the rendered row. */
  readonly defId: string;
  /** The definition's name, which is the row's label. */
  readonly name: string;
  readonly fieldType: FieldType;
  /**
   * The definition's unit of measure for a `NUMBER` field (W1b); null when it has none. Shown
   * beside the value here for the same reason it is on an item's card — the panel has no
   * label-and-control pair to hang it on, so it travels with the value.
   */
  readonly unit: string | null;
  /**
   * The definition's decimal places for a `NUMBER` field (W1e); null for "as entered". Applied
   * here for the same reason as on an item's card: how a number is written is a property of the
   * definition, so a location's value must not read `5.5` where an item's reads `5.50`.
   */
  readonly precision: number | null;
  /** The stored value; `null` when the location holds the field but has not filled it in. */
  readonly value: string | null;
  /**
   * The device the value was authored on, or null when unattributed (W1g). A location's `FILE`
   * value is the one an item can *inherit*, so a path recorded elsewhere has to be marked here
   * too — otherwise the place that offers it is the one surface that never says so.
   */
  readonly originDeviceId: string | null;
}

/**
 * Resolve a location's stored field values into the descriptors the detail panel renders.
 *
 * Values that are unset or blank are **dropped**, which is the one deliberate difference from the
 * item card: a card resolves an empty field to an em-dash so every card in a list keeps the same
 * height for a given configuration, whereas this panel shows one location and has no row to line
 * up with. An em-dash row here would only add noise — a location holding an as-yet-unfilled field
 * has nothing to say about itself yet.
 */
export function resolveLocationDetailFields(
  values: readonly LocationDetailField[],
  currentDeviceId: string,
): ResolvedCardField[] {
  const out: ResolvedCardField[] = [];
  for (const field of values) {
    const value = customFieldValue(field.fieldType, field.value, field.unit, field.precision, {
      originDeviceId: field.originDeviceId,
      currentDeviceId,
    });
    if (value.kind === 'empty') continue;
    out.push({ id: field.defId, label: field.name, value });
  }
  return out;
}

/**
 * The maximum length of the one-line description preview shown on a sub-location card.
 *
 * The card is a navigation aid, so the preview exists to hint at *what the place is*, not to
 * reproduce the note — the full text renders in the detail panel once the location is open, and
 * in the tree's hover tooltip. Long enough for a sentence; short enough that the cards in a grid
 * stay the same height whatever the description holds.
 */
export const DESCRIPTION_SNIPPET_MAX_LENGTH = 120;

/** A Markdown link or image, reduced to its label — `[manual](https://…)` reads as `manual`. */
const SNIPPET_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
/**
 * Block markers, which only mean anything at the **start of a line**: a heading, a blockquote,
 * or a list bullet. Anchored so a literal `#` or `-` mid-sentence ("Bin #3", "M3-10") survives.
 */
const SNIPPET_BLOCK = /^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm;
/**
 * Inline emphasis markers, stripped anywhere.
 *
 * Deliberately not `_`: a literal underscore in free text (`part_number`, a filename) is far more
 * likely than `_italics_`, and stripping it would silently mangle the text this preview exists to
 * show. Flattening is lossy by nature — it errs toward keeping what the user typed.
 */
const SNIPPET_EMPHASIS = /[*`~]/g;

/**
 * A location's description as a single short line of plain text, for a surface with no room to
 * render Markdown (the sub-location cards).
 *
 * The description is Markdown, and showing its **source** on a card would leak `##` and `**` into
 * the UI, so the heading/quote/bullet markers are stripped from the start of each line, emphasis
 * markers anywhere, and links reduced to their label. This is deliberately *not* a Markdown
 * parser — the `Markdown` primitive stays the one renderer; this is the lossy flattening a
 * one-line preview needs, and it is only ever used for display, never stored or searched.
 *
 * Returns `null` when there is nothing to show, so the caller renders no line at all rather than
 * an empty one.
 */
export function descriptionSnippet(
  description: string | null | undefined,
  maxLength = DESCRIPTION_SNIPPET_MAX_LENGTH,
): string | null {
  if (!description) return null;
  // Block markers go before the whitespace collapse, while there are still lines to anchor to.
  const flat = description
    .replace(SNIPPET_LINK, '$1')
    .replace(SNIPPET_BLOCK, '')
    .replace(SNIPPET_EMPHASIS, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length === 0) return null;
  if (flat.length <= maxLength) return flat;
  // Cut on a word boundary where there is one near the limit, so the preview doesn't end
  // mid-word. Code points, not UTF-16 units: slicing an astral character in half leaves a lone
  // surrogate, which renders as the replacement glyph.
  const cut = [...flat].slice(0, maxLength).join('');
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = (lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return `${trimmed}…`;
}
