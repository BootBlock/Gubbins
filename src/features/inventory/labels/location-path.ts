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
 */

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
