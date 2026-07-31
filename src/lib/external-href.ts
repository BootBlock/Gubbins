/**
 * The one rule for "is this string an address safe to put in an `<a href>`" (W1f).
 *
 * Gubbins stores a handful of user-typed addresses that later have to be *rendered* as links —
 * a `URL` custom field's value, and a `FILE` field's when what the user pointed at is a web
 * address rather than a path. Both **travel**, via sync, restored backups and imports, so
 * neither can be trusted on the way back in: a value that isn't an address must never reach an
 * `href`, or a click would run whatever scheme a string chosen somewhere else names.
 *
 * Lives in `lib/` for the same reason {@link import('./image-data-url').isImageDataUrl} does —
 * it is the render-side counterpart of that rule, and one definition is what stops two callers
 * drifting into subtly different notions of "safe link".
 *
 * **This is the render-time gate, and it is deliberately not the write-time one.** A `URL`
 * field value is checked on save by `validateFieldValue`, and a `URL` attachment by
 * `AttachmentRepository`; both apply the same http(s) rule but exist to *explain the refusal*
 * to the person typing, in their own words. This one only has to answer yes or no, about a
 * string that may have arrived from anywhere.
 */

/**
 * True when `value` is an absolute `http:` or `https:` URL.
 *
 * The narrowness is the point, twice over. It is a **safety** gate — `javascript:` and
 * `data:text/html` are addresses a browser will happily act on, and nothing revalidates a
 * value merged from a sync peer or read out of a backup. And it is a **usefulness** gate: a
 * browser refuses to navigate an http(s) page to `file://`, a UNC share or a bare disc path,
 * so linking one would be a control that looks live and does nothing.
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
