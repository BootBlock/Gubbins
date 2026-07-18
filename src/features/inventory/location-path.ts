/**
 * Location-path parsing (spec §4 nested-create shortcut).
 *
 * A single Name field can describe a whole branch of the hierarchy at once, along two axes:
 *
 * - **Down** the tree with a `/` or `\` — e.g. `Workshop/Cabinet A/Drawer 3` means "Drawer 3
 *   inside Cabinet A inside Workshop".
 * - **Across** one level with a `,` — e.g. `Garage/Box 1, Box 2, Box 3` means "Box 1 *and*
 *   Box 2 *and* Box 3, all as siblings inside Garage". This fan-out applies to the **leaf**
 *   (final) level only; a comma anywhere above the leaf is treated as a literal character.
 *
 * A literal comma in a leaf name is written by **doubling** it (`,,`), since `\` — the usual
 * escape character — is already a path separator here and would be ambiguous.
 *
 * These pure helpers turn the raw string into the ordered ancestor chain plus the list of leaf
 * names; the repository ({@link LocationRepository.createPath}) walks the chain, reusing any
 * level that already exists rather than duplicating it, then creates each leaf underneath.
 */

/** Either slash is accepted as a level separator, so `\` from Windows-style paths works too. */
const PATH_SEPARATOR = /[/\\]/;

/** The character that fans a single (leaf) level out into several sibling locations. */
const SIBLING_SEPARATOR = ',';

/** Result of parsing a raw location-name shortcut into structure the repository can walk. */
export interface LocationBranch {
  /** The shared ancestor levels above the leaf, in order (reused/created as a single chain). */
  readonly ancestors: string[];
  /** One or more sibling leaf names to create under the resolved ancestor. */
  readonly leaves: string[];
}

/**
 * Split a raw location name into its ordered path levels, trimming each and dropping empty
 * ones (so leading/trailing/doubled separators like `Workshop//Drawer/` collapse cleanly). A
 * name with no separator yields a single-element list; an all-blank input yields `[]`. The
 * leaf level is returned intact (commas untouched) — {@link splitLeafSiblings} fans it out.
 *
 * @internal Exported for unit tests only.
 */
export function splitLocationPath(raw: string): string[] {
  return raw
    .split(PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Split a single leaf level into its sibling names on the `,` separator, treating a doubled
 * comma (`,,`) as an escaped literal comma so names like `Bay 1,, 2` survive intact. Each name
 * is trimmed and empties are dropped, so stray/doubled separators (`Box 1, , Box 2,`) collapse
 * cleanly. A separator-free leaf yields a single-element list; an all-blank leaf yields `[]`.
 *
 * @internal Exported for unit tests only.
 */
export function splitLeafSiblings(leaf: string): string[] {
  const names: string[] = [];
  let current = '';
  for (let i = 0; i < leaf.length; i += 1) {
    if (leaf[i] === SIBLING_SEPARATOR) {
      if (leaf[i + 1] === SIBLING_SEPARATOR) {
        // Doubled comma → one literal comma in the name; skip the second one.
        current += SIBLING_SEPARATOR;
        i += 1;
      } else {
        names.push(current);
        current = '';
      }
    } else {
      current += leaf[i]!;
    }
  }
  names.push(current);
  return names.map((name) => name.trim()).filter((name) => name.length > 0);
}

/**
 * Parse a raw name into its {@link LocationBranch}: the ancestor chain (everything above the
 * leaf) plus the fanned-out sibling leaves. An all-blank or separator-only input yields no
 * leaves, which callers treat as "nothing to create".
 */
export function parseLocationBranch(raw: string): LocationBranch {
  const levels = splitLocationPath(raw);
  if (levels.length === 0) {
    return { ancestors: [], leaves: [] };
  }
  const leaves = splitLeafSiblings(levels[levels.length - 1]!);
  return { ancestors: levels.slice(0, -1), leaves };
}

/**
 * True when the raw name describes more than one level (i.e. contains a usable separator).
 *
 * @internal Exported for unit tests only.
 */
export function isLocationPath(raw: string): boolean {
  return splitLocationPath(raw).length > 1;
}
