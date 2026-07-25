/**
 * The one rule for "is this string an image safe to put in an `<img src>`" (issue: CodeQL
 * `js/xss-through-dom`).
 *
 * Gubbins stores a couple of images as self-contained `data:` URLs rather than as files —
 * an `IMAGE` custom field's value, and the catalogue letterhead logo. Both are produced by
 * a canvas encoder, so both are always `data:image/…;base64,…`; and both **travel**, via
 * sync and restored backups, so neither can be trusted on the way back in. A value that
 * isn't this shape must never reach an `<img src>`, or the app would fetch a string chosen
 * somewhere else — and a stored string is not a URL the app should be willing to load.
 *
 * Lives in `lib/` because it is a cross-feature rule (inventory *and* reports), for the same
 * reason `money.ts` and `calendar-days.ts` do: one definition, so the two callers cannot
 * drift into subtly different notions of "safe image".
 */

/**
 * True when `text` is a base64 image `data:` URL (`data:image/…;base64,…`).
 *
 * Deliberately strict, and anchored at both ends: the payload class admits only the base64
 * alphabet, so no whitespace, quote or angle bracket can ride along inside a value that
 * passes. Callers test the **trimmed** string and use that same trimmed string, so what
 * displays is exactly what validated.
 *
 * Note this admits `data:image/svg+xml;base64,…`. That is not a hole here: an SVG loaded
 * through `<img>` runs in the restricted mode — no scripts, no external subresources — and
 * as a `data:` URL it makes no request at all.
 */
export function isImageDataUrl(text: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i.test(text);
}
