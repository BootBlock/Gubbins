/**
 * Pure tree maths over the *flat* location list (id + parentId), kept DOM-free so
 * the logic is unit-tested directly — mirroring the `tree-keyboard.ts` /
 * `list-window.ts` "extract the logic out of the glue" seam. Used by the location
 * Edit dialog to forbid invalid parent moves and to render an ancestry breadcrumb.
 */
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { includesAllTerms, splitSearchTerms } from '@/lib/text-terms';
import { fullLocationPath, LOCATION_PATH_SEPARATOR } from './labels/location-path';

/** The minimal shape these helpers need from a location row. */
export interface FlatNode {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  /**
   * The location's own free-text description, searched alongside its ancestry path
   * ({@link locationsMatchingQuery}, issue #617 `N2`). Optional because the tree/ancestry helpers
   * here don't need it and several callers construct a bare `{ id, name, parentId }`; the flat
   * list the sidebar passes carries it already, so surfacing it costs no extra read.
   */
  readonly description?: string | null;
}

/**
 * The set of ids a location may **not** be re-parented under: itself, plus every
 * one of its descendants (moving a node beneath its own child would create a cycle,
 * §7.5.3). The id itself is always included so the picker can exclude "self".
 */
export function collectDescendantIds(id: string, nodes: readonly FlatNode[]): ReadonlySet<string> {
  const childrenByParent = new Map<string, FlatNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const bucket = childrenByParent.get(node.parentId);
    if (bucket) bucket.push(node);
    else childrenByParent.set(node.parentId, [node]);
  }

  const result = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of childrenByParent.get(current) ?? []) {
      if (!result.has(child.id)) {
        result.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return result;
}

/** A flat node that also knows whether it is a system-locked or archived location. */
export interface FlatSystemNode extends FlatNode {
  readonly isSystem: boolean;
  /** Epoch-ms the location was archived; null/undefined = active. */
  readonly archivedAt?: number | null;
}

/**
 * Drop every archived location — and its whole subtree — from a nested tree, so the
 * sidebar can hide archived branches unless the user opts to "Show archived". Pure and
 * generic over any self-referential node carrying an `archivedAt` (null = active).
 */
export function pruneArchivedTree<T extends { archivedAt?: number | null; children: T[] }>(
  nodes: readonly T[],
): T[] {
  return nodes
    .filter((node) => !node.archivedAt)
    .map((node) => ({ ...node, children: pruneArchivedTree(node.children) }));
}

/**
 * Is `id` archived, or does it sit beneath a location that is? {@link pruneArchivedTree} drops an
 * archived node together with its whole subtree, so a live shelf inside an archived room loses its
 * row too — this answers the same question for a single id, over the flat list, without walking
 * the tree. Together they decide whether a location has a row while "Show archived" is off.
 *
 * The sidebar asks it of the *selected* location: a selection with no row on screen still scopes
 * the item list, with nothing visible to explain the filter or to click away from (issue #713).
 * `location-tree.test.ts` drives this predicate and `pruneArchivedTree` over the same tree and
 * asserts they agree on every node, so the two cannot drift apart.
 */
export function withinArchivedBranch(id: string, nodes: readonly FlatSystemNode[]): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  // Falsiness, not `!= null` — {@link pruneArchivedTree} drops a node on `!node.archivedAt`, so a
  // `0` timestamp has to read as "not archived" on this side too or the two disagree on it.
  return locationAncestry(id, nodes).some((ancestorId) => !!byId.get(ancestorId)?.archivedAt);
}

/**
 * One node of a nested tree by id, or `undefined` when nothing carries it. Depth-first, and
 * generic over any self-referential node — the tree counterpart of a `rows.find(…)` on the flat
 * list, for the callers that must read a row the *tree* read enriched (its volume totals, issue
 * #525) rather than the flat one.
 */
export function findTreeNode<T extends { id: string; children: T[] }>(
  nodes: readonly T[],
  id: string,
): T | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findTreeNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * The set of ids covering every location in `matchIds` **plus all of their ancestors** — the
 * rows a tag filter must keep visible so a matching location stays reachable in the tree with
 * its parent context intact (issue #84). Walks each match up its parent chain; defensive against
 * a broken/cyclic chain (a repeated id stops the walk).
 */
export function matchingWithAncestors(matchIds: ReadonlySet<string>, flat: readonly FlatNode[]): Set<string> {
  const byId = new Map(flat.map((n) => [n.id, n] as const));
  const keep = new Set<string>();
  for (const id of matchIds) {
    let current: FlatNode | undefined = byId.get(id);
    while (current && !keep.has(current.id)) {
      keep.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return keep;
}

/**
 * Prune a nested tree to only the nodes in `keep` (issue #84 — the tag-filtered location tree).
 * Pair with {@link matchingWithAncestors} so a kept leaf always keeps its ancestor path. Pure and
 * generic over any self-referential `{ id, children }` node.
 */
export function pruneTreeToIds<T extends { id: string; children: T[] }>(
  nodes: readonly T[],
  keep: ReadonlySet<string>,
): T[] {
  const out: T[] = [];
  for (const node of nodes) {
    if (!keep.has(node.id)) continue;
    out.push({ ...node, children: pruneTreeToIds(node.children, keep) });
  }
  return out;
}

/**
 * One rendered row of a tree, flattened in render order (issue #129). Carries the ARIA
 * position facts a **flat** `role="tree"` needs — `aria-level`, plus the `aria-posinset` /
 * `aria-setsize` pair that tells assistive tech how many siblings a row has even when the
 * others aren't in the DOM. That last part is what makes the tree safe to virtualise.
 */
export interface VisibleTreeRow<T> {
  readonly node: T;
  /** 1-based depth, matching `aria-level`. */
  readonly level: number;
  /** 1-based index among the node's siblings (`aria-posinset`). */
  readonly posInSet: number;
  /** How many siblings the node has in total (`aria-setsize`). */
  readonly setSize: number;
}

/**
 * Flatten a nested tree to the rows that are actually visible, in render order —
 * descendants of a collapsed node are omitted. The single source of truth for "which rows
 * exist and in what order", shared by the sidebar's rendering, its keyboard navigation and
 * its virtualiser so all three can never disagree about row identity or position.
 */
export function flattenVisibleTree<T extends { id: string; children: T[] }>(
  nodes: readonly T[],
  isOpen: (id: string, level: number) => boolean,
  level = 1,
  out: VisibleTreeRow<T>[] = [],
): VisibleTreeRow<T>[] {
  nodes.forEach((node, index) => {
    out.push({ node, level, posInSet: index + 1, setSize: nodes.length });
    if (node.children.length > 0 && isOpen(node.id, level)) {
      flattenVisibleTree(node.children, isOpen, level + 1, out);
    }
  });
  return out;
}

/**
 * Ids of the locations matching a free-text query (issue #129), using the shared
 * whitespace-splits-into-AND-ed-substrings model (`lib/text-terms`) that every searchable
 * picker uses. An empty query matches nothing (the caller treats that as "no filter" rather than
 * "no results"). Pair with {@link matchingWithAncestors} so a match keeps its parent context.
 * Paths are memoised per call, so this is linear in the tree, and a broken or cyclic parent chain
 * simply stops the walk.
 *
 * Each location is matched against three pieces of its own text, taken together:
 *
 * - its **full ancestry path**, not just its own name, so `shed 3` finds `Shed / Bin 3` — the
 *   point of the box is finding a deeply nested bin without expanding branches by hand;
 * - its own **description** — free text a user wrote *about the place*, which until now could be
 *   typed in and then never retrieved from anywhere in the app (issue #617, `N2`);
 * - the text of the **custom-field values** it holds, passed in as `fieldText` because those come
 *   from a different read than the flat list (see `useLocationFieldSearchText`). Omit it and
 *   matching simply falls back to path + description.
 *
 * The three are joined with newlines rather than searched separately, so a query may draw one
 * term from each — `garage damp` finds the *Garage* whose description mentions damp. Newlines are
 * whitespace and terms are split on whitespace, so no term can straddle the join and match text
 * the location doesn't hold.
 *
 * Description and field text are each the location's **own**; unlike the path, they are never
 * inherited down the tree. A child does not match because its parent's note does.
 */
export function locationsMatchingQuery(
  flat: readonly FlatNode[],
  query: string,
  fieldText?: ReadonlyMap<string, string>,
): Set<string> {
  const matches = new Set<string>();
  const terms = splitSearchTerms(query);
  if (terms.length === 0) return matches;

  const byId = new Map(flat.map((n) => [n.id, n] as const));
  // A memoised walk rather than {@link fullLocationPath} per node: this runs over the whole tree
  // on every keystroke, and that helper rebuilds its own index each call. It must nevertheless
  // spell a path exactly as the helper does, or a query matching what the sidebar shows would
  // miss — `location-tree.test.ts` drives both and compares (issue #596).
  const paths = new Map<string, string>();
  const pathOf = (id: string): string => {
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    if (!node) return '';
    // Seed the cache with the bare name *before* recursing: a cyclic parent chain then
    // resolves to that partial value instead of recursing forever.
    paths.set(id, node.name);
    const parent = node.parentId ? pathOf(node.parentId) : '';
    const full = parent ? `${parent}${LOCATION_PATH_SEPARATOR}${node.name}` : node.name;
    paths.set(id, full);
    return full;
  };

  for (const node of flat) {
    const haystack = [pathOf(node.id), node.description ?? '', fieldText?.get(node.id) ?? ''].join('\n');
    if (includesAllTerms(haystack, terms)) matches.add(node.id);
  }
  return matches;
}

/**
 * The parent a freshly-added location should default to, given the current sidebar
 * selection. Adding *inside* a real, user-created location nests under it; but the
 * synthetic "All items" (a `null` selection), the system-locked rows ("Unassigned",
 * "In Transit") and archived rows are never valid parents, so a new location started
 * from any of those defaults to top level (`null`).
 *
 * These are the same exclusions the Add-location dialog's own `buildParentOptions` applies
 * to every row it offers. (That filter drops one thing more — the `excludeIds` a *re-parent*
 * passes to keep a node off its own subtree — which has no counterpart here, because seeding
 * a brand-new location has no subtree to avoid.) A seeded parent the picker does not offer
 * would either blank the field or — worse — survive submission and file the new location
 * under a parent the user cannot see. The archived half is reachable only with "Show
 * archived" on, which is why `archivedAt` has to reach this seam at all; a parity test in
 * `location-tree.test.ts` holds the two together.
 */
export function defaultParentForNewLocation(
  selectedId: string | null,
  nodes: readonly FlatSystemNode[],
): string | null {
  if (!selectedId) return null;
  const selected = nodes.find((n) => n.id === selectedId);
  return selected && !selected.isSystem && !selected.archivedAt ? selected.id : null;
}

/**
 * The location a freshly-added *item* should default to, given the current sidebar
 * selection. Built on {@link defaultParentForNewLocation} — one definition of "a real,
 * selectable location", not a second copy of it: starting "Add item" from a real,
 * user-created location pre-fills that location; but the synthetic "All items" (a `null`
 * selection), the system-locked rows ("Unassigned", "In Transit") and archived rows are not
 * meaningful homes to seed, so those fall back to `fallbackLocationId` — the user's marked
 * **default** location when one is set, else the Unassigned holding pen. Unlike a top-level
 * location (whose parent is `null`), an item always needs a concrete home — hence the
 * non-null return.
 */
export function defaultLocationForNewItem(
  selectedId: string | null,
  nodes: readonly FlatSystemNode[],
  fallbackLocationId: string = UNASSIGNED_LOCATION_ID,
): string {
  return defaultParentForNewLocation(selectedId, nodes) ?? fallbackLocationId;
}

/**
 * The id of the user's marked **default** location (the single non-archived row flagged
 * `isDefault`), or `undefined` when none is set. The natural `fallbackLocationId` to pass
 * {@link defaultLocationForNewItem} when seeding "Add item" from a place that isn't itself a
 * concrete home (the "All items" view, a share/deep-link draft).
 */
export function markedDefaultLocationId(
  locations: readonly { id: string; isDefault?: boolean | null; archivedAt?: unknown }[],
): string | undefined {
  return locations.find((l) => l.isDefault && !l.archivedAt)?.id;
}

/**
 * A human-readable ancestry breadcrumb for a location, root-first and joined by
 * `" / "` (e.g. `Workshop / Cabinet A / Drawer 3`). Defensive against a broken
 * parent chain: a missing or cyclic ancestor simply stops the walk.
 *
 * The walk itself is {@link fullLocationPath}'s, so the breadcrumb a user reads on screen and
 * the path the catalogue CSV writes and resolves are the same string by construction. An id the
 * set does not contain has no path at all, which is what an empty breadcrumb means here.
 */
export function locationPath(id: string, nodes: readonly FlatNode[], separator = ' / '): string {
  const node = nodes.find((n) => n.id === id);
  return node ? fullLocationPath(node, nodes, separator) : '';
}

/**
 * A location's own id followed by each of its ancestors', nearest first (e.g. `Drawer 3`,
 * `Cabinet A`, `Workshop`). Defensive in exactly the way {@link locationPath} is: a missing
 * or cyclic parent stops the walk rather than looping.
 *
 * Used where a location's *containing* places are as relevant as the location itself — the
 * item-side placement picker offers photos of the cabinet and the room, not only of the
 * drawer, because that is where a small item's region is usually drawn.
 */
export function locationAncestry(id: string, nodes: readonly FlatNode[]): readonly string[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const ids: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    ids.push(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return ids;
}
