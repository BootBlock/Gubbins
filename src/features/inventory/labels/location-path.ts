/**
 * A location's ancestor path, as one definition.
 *
 * Four surfaces spell a location's ancestry — printed labels, the location-list export, the
 * Markdown vault's folder notes, and (since issue #596) the catalogue CSV, whose `location`
 * column the importer has to resolve *back* to an id. A second walk anywhere would be free to
 * drift, and drift here is silent: a path the exporter writes and the importer cannot match
 * simply reads as "Unknown location" on every row.
 *
 * Kept in its own module rather than beside the label renderer that used to hold it, because
 * the importer must not drag a QR encoder and a barcode generator in behind it.
 *
 * One walk remains separate: the location sidebar's search haystack memoises its own, because it
 * runs over the whole tree on every keystroke and this helper rebuilds its index per call. It is
 * held to the same output by a test that drives both — see `locationsMatchingQuery` in
 * `location-tree.ts` and the parity case in `location-tree.test.ts`.
 */

import { foldName } from '@/lib/name-fold';

/** A minimal `{id, parentId, name}` shape for {@link locationPath} ancestor walking. */
export interface LocationPathNode {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

/** The separator between path levels, used by every surface that prints a location's ancestry. */
export const LOCATION_PATH_SEPARATOR = ' / ';

/**
 * The ancestor path of a location as a separator-joined string (root first, excluding
 * the location itself), e.g. `Workshop / Shelf B`. Returns `''` for a top-level
 * location. Cycle-safe: a malformed parent chain stops at the first repeat.
 */
export function locationPath(
  id: string,
  nodes: readonly LocationPathNode[],
  separator = LOCATION_PATH_SEPARATOR,
): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ancestors: string[] = [];
  const seen = new Set<string>([id]);
  let parentId = byId.get(id)?.parentId ?? null;
  while (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    ancestors.push(parent.name);
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return ancestors.reverse().join(separator);
}

/**
 * The full path **including** the location itself, e.g. `Workshop / Cabinet A / Drawer 3`.
 *
 * The form the catalogue CSV writes and the importer reads back, so both ends derive it here
 * rather than each joining the ancestors to the name in its own way.
 */
export function fullLocationPath(
  node: LocationPathNode,
  nodes: readonly LocationPathNode[],
  separator = LOCATION_PATH_SEPARATOR,
): string {
  const ancestors = locationPath(node.id, nodes, separator);
  return ancestors ? `${ancestors}${separator}${node.name}` : node.name;
}

/**
 * The comparison key for a full path: each segment folded by {@link foldName}, rejoined on the
 * separator without its padding.
 *
 * Lives here rather than beside either user because both ends of the catalogue CSV have to fold
 * identically (issue #596). The exporter decides whether a path names one location before it
 * writes it, and the importer decides whether the path it reads names one location — a pair of
 * paths the exporter thinks distinct and the importer folds together would be written as names
 * and then rejected on the way back in.
 *
 * Segment by segment, not over the whole string: `foldName` trims, so folding the joined form
 * would leave the spacing around each separator to be agreed rather than normalised away.
 */
export function foldLocationPath(raw: string): string {
  const bare = LOCATION_PATH_SEPARATOR.trim();
  return raw
    .split(bare)
    .map((segment) => foldName(segment))
    .join(bare);
}

/**
 * Whether a cell spells a **path** rather than a bare name, and is therefore resolved against
 * paths rather than against names.
 *
 * One rule, read by both ends of the catalogue CSV (issue #596): the importer picks which index
 * to answer a cell from, and the exporter has to judge a label's uniqueness by the index the
 * importer will really consult. A root location's path *is* its own name, so a label unique
 * among paths can still name two locations — deciding that separately at each end is how the
 * exporter comes to write a cell the importer then rejects.
 */
export function isLocationPathCell(cell: string): boolean {
  return cell.includes(LOCATION_PATH_SEPARATOR.trim());
}
