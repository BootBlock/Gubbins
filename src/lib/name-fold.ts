/**
 * Case-insensitive folding for **natural keys** whose uniqueness the app enforces
 * (issue #343).
 *
 * Several tables identify a row by a human-typed name — the custom-field dictionary above
 * all, where the name *is* the identity that lets one category's `Manufacturer` and a
 * location's inheritable `Manufacturer` be the same field. Those tables carry a
 * `UNIQUE (… COLLATE NOCASE)` index so that case alone can't fork a definition in two.
 *
 * **SQLite's NOCASE folds ASCII A–Z and nothing else.** `Café` and `CAFÉ`, or `Größe` and
 * `GRÖSSE`, are therefore *distinct* keys to the index, which accepts both — the exact
 * near-duplicate the index exists to prevent, reachable by anyone whose language uses
 * accents. Widening the collation itself is not available: SQLite grows Unicode folding
 * only with the ICU extension, which none of the drivers this app runs on (wa-sqlite in
 * the browser, `node:sqlite` under the bridge and tests) is built with.
 *
 * So the fold lives here, in JS, and the write seam compares through it. The index stays
 * as the ASCII-level backstop it always was; this is what makes the guarantee hold for the
 * rest of Unicode.
 *
 * Three steps, in this order:
 *
 * 1. **NFC normalisation.** `é` typed as one code point and as `e` + a combining acute are
 *    different strings that render identically — a duplicate no user could ever tell apart.
 *    Composing first makes them one key.
 * 2. **Upper-case, then lower-case.** The round trip is what makes this a *full* case fold
 *    rather than a mere lower-casing, and the reported case needs it: `'Größe'.toLowerCase()`
 *    leaves the `ß` alone, so it would never meet the `GRÖSSE` a user gets by typing the same
 *    name in capitals. Upper-casing expands `ß` to `SS` (and `ﬁ` to `FI`, and final `ς` to
 *    `Σ`) first, so both spellings land on one key.
 * 3. Both steps are **locale-independent** — `toUpperCase`/`toLowerCase`, never the
 *    `toLocale…` forms. Under `tr-TR` an `I` lower-cases to a dotless `ı`, so a
 *    Turkish-locale device would fold a name differently from every other device, and from
 *    the same rows arriving over sync, which have no locale at all. Uniqueness must not
 *    depend on who is looking.
 *
 * The round trip does merge a few pairs that are distinct letters rather than distinct
 * cases — Turkish `ı` with `i`, most notably. That is the accepted cost: it can only ever
 * refuse a *second* name that already reads as one the user has, whereas the alternative is
 * the silent forked definition this exists to stop.
 */

/** The comparison key for `name`: trimmed, NFC-normalised and fully case-folded. */
export function foldName(name: string): string {
  return name.trim().normalize('NFC').toUpperCase().toLowerCase();
}

/** Whether two names are the same key — i.e. differ by case, spacing or composition only. */
export function namesMatch(a: string, b: string): boolean {
  return foldName(a) === foldName(b);
}
