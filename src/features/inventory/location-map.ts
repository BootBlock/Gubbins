/**
 * Pure seam behind the inventory **location map** view (a spatial, drill-down treemap of the
 * location hierarchy). Kept DOM-, React- and token-free — the same "logic out of glue" seam as
 * `location-tree.ts` / `treemap-layout.ts` — so the counting and navigation maths are unit-tested
 * directly and the view component is left to render tiles and wire clicks.
 *
 * The map draws one level of the hierarchy at a time: the direct children of the current map root
 * (top level when the root is `null`), each tile sized by how much stock sits in that place *and
 * everything nested beneath it* (its subtree total), so a cabinet whose stock lives in its drawers
 * still reads as full. Clicking a tile with children re-roots the map into it; a leaf is opened in
 * the item list. Archived branches are pruned, mirroring the sidebar's default.
 */
import type { LocationTreeNode } from '@/db/repositories';
import { pruneArchivedTree } from './location-tree';

/** A location laid out as one tile of the map at the current level. */
export interface LocationMapTile {
  readonly id: string;
  readonly name: string;
  /** Semantic colour swatch key, or null for none. */
  readonly color: string | null;
  /** Optional capacity limit (drives the fullness tint), or null when unbounded. */
  readonly capacity: number | null;
  /** Items sitting *directly* in this location. */
  readonly directCount: number;
  /** Items across this location and its whole subtree — what the tile's size represents. */
  readonly subtreeCount: number;
  /** How many direct child locations nest inside (0 ⇒ a leaf). */
  readonly childCount: number;
  /**
   * The treemap area weight: the subtree total plus a small `baseline` floor so an empty but
   * real location still renders as a small, clickable tile rather than vanishing (this is a
   * navigational map — every place must stay reachable). Always ≥ `baseline`.
   */
  readonly weight: number;
}

/**
 * Total items in a location and everything nested beneath it.
 *
 * @internal Exported for unit tests only.
 */
export function subtreeItemCount(node: LocationTreeNode): number {
  let total = node.itemCount;
  for (const child of node.children) total += subtreeItemCount(child);
  return total;
}

/**
 * Index a nested location tree by id, so the map can resolve a re-root target and walk a
 * breadcrumb ancestry without re-scanning the tree each time.
 *
 * @internal Exported for unit tests only.
 */
export function indexLocationTree(nodes: readonly LocationTreeNode[]): Map<string, LocationTreeNode> {
  const index = new Map<string, LocationTreeNode>();
  const visit = (list: readonly LocationTreeNode[]) => {
    for (const node of list) {
      index.set(node.id, node);
      visit(node.children);
    }
  };
  visit(nodes);
  return index;
}

/**
 * The sibling nodes shown at a given map root: the top-level locations when `rootId` is null, else
 * the direct children of that location (empty when the id is unknown, e.g. a re-rooted location
 * that has since been removed).
 *
 * @internal Exported for unit tests only.
 */
export function childrenAtRoot(
  nodes: readonly LocationTreeNode[],
  rootId: string | null,
  index: ReadonlyMap<string, LocationTreeNode>,
): readonly LocationTreeNode[] {
  if (rootId === null) return nodes;
  return index.get(rootId)?.children ?? [];
}

/**
 * The root-first ancestry of a map root (the breadcrumb trail), from the top-level location down
 * to and including `rootId` itself. Empty for the `null` (top-level) root. Defensive against a
 * broken/cyclic parent chain — a missing or repeated ancestor stops the walk.
 *
 * @internal Exported for unit tests only.
 */
export function rootAncestry(
  rootId: string | null,
  index: ReadonlyMap<string, LocationTreeNode>,
): LocationTreeNode[] {
  const trail: LocationTreeNode[] = [];
  const seen = new Set<string>();
  let current = rootId ? index.get(rootId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.unshift(current);
    current = current.parentId ? index.get(current.parentId) : undefined;
  }
  return trail;
}

/**
 * Turn a level of sibling locations into map tiles, sized by their subtree stock totals. Each
 * tile's `weight` is `subtreeCount + baseline`; the `baseline` (default 1) guarantees an empty
 * location still shows as a small tile so it stays navigable. Tiles keep the tree's given order.
 *
 * @internal Exported for unit tests only.
 */
export function locationMapTiles(nodes: readonly LocationTreeNode[], baseline = 1): LocationMapTile[] {
  return nodes.map((node) => {
    const subtreeCount = subtreeItemCount(node);
    return {
      id: node.id,
      name: node.name,
      color: node.color,
      capacity: node.capacity,
      directCount: node.itemCount,
      subtreeCount,
      childCount: node.children.length,
      weight: subtreeCount + Math.max(0, baseline),
    };
  });
}

/**
 * The full tile model for the map at `rootId`: prune archived branches, index the surviving tree,
 * and return the current level's tiles alongside the breadcrumb ancestry. A single entry point the
 * view calls per render so all the pure work stays here.
 */
export function buildLocationMap(
  tree: readonly LocationTreeNode[],
  rootId: string | null,
  baseline = 1,
): { tiles: LocationMapTile[]; ancestry: LocationTreeNode[]; index: Map<string, LocationTreeNode> } {
  const pruned = pruneArchivedTree(tree);
  const index = indexLocationTree(pruned);
  const children = childrenAtRoot(pruned, rootId, index);
  return {
    tiles: locationMapTiles(children, baseline),
    ancestry: rootAncestry(rootId, index),
    index,
  };
}
