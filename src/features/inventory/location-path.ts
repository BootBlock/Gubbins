/**
 * Location-path parsing (spec §4 nested-create shortcut).
 *
 * A single Name field can describe a whole branch of the hierarchy at once by separating the
 * levels with a `/` or `\` — e.g. typing `Workshop/Cabinet A/Drawer 3` means "Drawer 3 inside
 * Cabinet A inside Workshop". This pure helper turns that raw string into the ordered list of
 * segment names; the repository ({@link LocationRepository.createPath}) walks the list,
 * reusing any level that already exists rather than duplicating it.
 */

/** Either slash is accepted as a level separator, so `\` from Windows-style paths works too. */
const PATH_SEPARATOR = /[/\\]/;

/**
 * Split a raw location name into its ordered path segments, trimming each and dropping empty
 * ones (so leading/trailing/doubled separators like `Workshop//Drawer/` collapse cleanly). A
 * name with no separator yields a single-element list; an all-blank input yields `[]`.
 */
export function splitLocationPath(raw: string): string[] {
  return raw
    .split(PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** True when the raw name describes more than one level (i.e. contains a usable separator). */
export function isLocationPath(raw: string): boolean {
  return splitLocationPath(raw).length > 1;
}
