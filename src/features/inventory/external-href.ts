/**
 * The rule deciding whether a stored custom-field value may become an `<a href>` (W1f).
 *
 * A `URL` field's value is an address; a `FILE` field's may be an address *or* a path, a UNC
 * share or a `file://` URI — the type covers both, so only the string can say which it is. This
 * is the seam that answers that question for the surfaces which *render* a value.
 *
 * It sits in the inventory feature rather than in `lib/` because that is what it is: a rule
 * about a custom-field value, with one consumer (`card-fields.ts`). `lib/` is where this repo
 * keeps rules that are genuinely cross-feature — as `image-data-url.ts` says of itself, and it
 * has the callers to show for it. Lift this there if a second feature ever needs it, not before.
 *
 * **Deliberately separate from the write-time validators.** `validateFieldValue` applies the
 * same http(s) rule when a `URL` value is saved or imported, and `AttachmentRepository` when a
 * `URL` attachment is added. Those exist to *explain a refusal* to the person typing, each in
 * its own words for its own reason. This one only has to answer yes or no, about a string that
 * may never have been past them.
 */

/**
 * True when `value` is an absolute `http:` or `https:` URL.
 *
 * The narrowness is the point, twice over. It is a **safety** gate — `javascript:` and
 * `data:text/html` are addresses a browser will act on, and a value merged from a sync peer or
 * read out of a restored backup reaches the renderer without meeting `validateFieldValue` at
 * all. And it is a **usefulness** gate: a browser refuses to navigate an http(s) page to
 * `file://`, a UNC share or a bare disc path, so linking one would be a control that looks live
 * and does nothing.
 *
 * Trims first, so a pasted address that carried a leading space is judged on what it says.
 * Callers use that same trimmed string, so what is opened is exactly what was tested.
 */
export function isExternalHref(value: string): boolean {
  try {
    const { protocol } = new URL(value.trim());
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false; // not an absolute URI at all — a path, a UNC share, or free text
  }
}
