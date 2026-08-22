/**
 * The rule deciding whether a stored string may become an `<a href>` the app renders (W1f).
 *
 * Four surfaces store an address the user typed, and all four render it as a link: a custom
 * field's `URL`/`FILE` value, a datasheet attachment, a wishlist entry and a supplier part. A
 * `FILE` field's value may be an address *or* a path, a UNC share or a `file://` URI — the type
 * covers both, so only the string can say which it is. This is the seam that answers that
 * question for the surfaces which *render* a value.
 *
 * It lives in `lib/` because the rule is now genuinely cross-feature: inventory (card fields,
 * datasheets, supplier parts) and purchasing (the wishlist) all ask it, and the answer must be
 * the same in every one of them.
 *
 * **Deliberately separate from the write-time validators.** `validateFieldValue` applies the
 * same http(s) rule when a `URL` value is saved or imported, `AttachmentRepository` when a
 * `URL` attachment is added, `sanitiseWishlistUrl` when a wish is planned, and
 * `SupplierPartRepository` when a supplier part is written. Those exist to *explain a refusal*
 * to the person typing, each in its own words for its own reason. This one only has to answer
 * yes or no, about a string that may never have been past them — the sync/restore path applies
 * remote rows column by column, with no repository in the way, so a value in the database can
 * be anything the peer that sent it chose.
 */

/**
 * True when `value` is an absolute `http:` or `https:` URL.
 *
 * The narrowness is the point, twice over. It is a **safety** gate — `javascript:` and
 * `data:text/html` are addresses a browser will act on, and a value merged from a sync peer or
 * read out of a restored backup reaches the renderer without meeting any validator at all. And
 * it is a **usefulness** gate: a browser refuses to navigate an http(s) page to `file://`, a UNC
 * share or a bare disc path, so linking one would be a control that looks live and does nothing.
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

/**
 * The trimmed address when `value` may safely become an `href`, else `null`.
 *
 * The companion to {@link isExternalHref} for the common shape at a render site: "give me the
 * href, or tell me there isn't one". Returning the *trimmed* string is what makes the check
 * binding — a caller that fell back to the raw value would open something the gate never saw.
 * A `null`/`undefined`/blank value is simply "no link", indistinguishable here from a rejected
 * one; a render site that must tell those apart still has the original string to test.
 */
export function safeExternalHref(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return isExternalHref(trimmed) ? trimmed : null;
}
