/**
 * Pure tree maths over the *flat* location list (id + parentId), kept DOM-free so
 * the logic is unit-tested directly — mirroring the `tree-keyboard.ts` /
 * `list-window.ts` "extract the logic out of the glue" seam. Used by the location
 * Edit dialog to forbid invalid parent moves and to render an ancestry breadcrumb.
 */

/** The minimal shape these helpers need from a location row. */
export interface FlatNode {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

/**
 * The set of ids a location may **not** be re-parented under: itself, plus every
 * one of its descendants (moving a node beneath its own child would create a cycle,
 * §7.5.3). The id itself is always included so the picker can exclude "self".
 */
export function collectDescendantIds(
  id: string,
  nodes: readonly FlatNode[],
): ReadonlySet<string> {
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

/**
 * A human-readable ancestry breadcrumb for a location, root-first and joined by
 * `" / "` (e.g. `Workshop / Cabinet A / Drawer 3`). Defensive against a broken
 * parent chain: a missing or cyclic ancestor simply stops the walk.
 */
export function locationPath(id: string, nodes: readonly FlatNode[], separator = ' / '): string {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const names: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names.join(separator);
}
