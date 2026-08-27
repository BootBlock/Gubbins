/**
 * Kit → component linkage rules (Kits v1), kept pure — the write-time guard and the post-merge
 * repair that restores the same invariant after a sync (issue #539).
 *
 * A kit is a reusable many-to-many item→component definition: the kit item is composed
 * of fixed per-kit quantities of other items. The only structural invariant is that the
 * containment graph stays acyclic — a kit cannot contain itself, directly or transitively
 * (§7.5.3-style discipline, exactly as nested locations and variants). The repository
 * gathers the facts (the proposed component's descendant set, via a recursive CTE) and
 * this pure validator decides, so the decision is exhaustively unit-testable.
 *
 * That guard is a read-then-write check across sibling rows, so it holds on one device only: two
 * offline devices can each make a locally valid nesting move whose merge closes a loop. The sync
 * reconciler repairs that with {@link findKitCycleBreaks} below, which decides the same question
 * over a whole merged edge set rather than one proposed link.
 */

/**
 * Why a proposed `kit → component` link was rejected, or `null` if valid:
 * - `SELF` — an item cannot be a component of itself.
 * - `CYCLE` — the kit already appears in the component's own sub-component tree, so the
 *   link would make the kit contain itself transitively (the sole structural rule).
 */
export type KitRejection = 'SELF' | 'CYCLE';

export interface KitLinkFacts {
  /** The kit gaining a component. */
  readonly kitId: string;
  /** The item proposed as a component of it. */
  readonly componentId: string;
  /**
   * The component's own descendant ids (every item reachable *below* it through the
   * containment graph), for cycle detection. The component itself may be included; only
   * the kit's presence matters.
   */
  readonly componentDescendantIds: readonly string[];
}

export function validateKitLink(facts: KitLinkFacts): KitRejection | null {
  if (facts.kitId === facts.componentId) return 'SELF';
  if (facts.componentDescendantIds.includes(facts.kitId)) return 'CYCLE';
  return null;
}

/** Human-readable reason for a rejected kit link (British English, for toasts). */
export function kitRejectionMessage(reason: KitRejection): string {
  switch (reason) {
    case 'SELF':
      return 'A kit cannot contain itself as a component.';
    case 'CYCLE':
      return 'That would create a circular kit relationship.';
  }
}

// ---------------------------------------------------------------------------
// Post-merge cycle repair (issue #539)
// ---------------------------------------------------------------------------

/**
 * One `kit_components` edge as the cycle repair sees it — the row id, the two items it joins,
 * and the frame-stable `created_at` the deterministic "oldest wins" rule ranks by.
 *
 * `created_at` is safe to compare across devices because the sync frame conversion shifts only
 * `updated_at` / `deleted_at`, never it, so the value is byte-identical everywhere (the same
 * property the booking-overlap and serialised-loan repairs rely on).
 */
export interface KitEdge {
  /** The `kit_components` row id. */
  readonly id: string;
  /** The kit end of the edge (`kit_item_id`). */
  readonly kitId: string;
  /** The component end of the edge (`component_item_id`). */
  readonly componentId: string;
  /** The edge's creation instant, frame-stable and therefore comparable across devices. */
  readonly createdAt: number;
}

/**
 * Which edges of a merged containment graph have to go for it to be acyclic again.
 *
 * {@link validateKitLink} keeps the graph acyclic on one device, but that is a read-then-write
 * check across sibling rows: two devices can each make a locally valid nesting move (A adds kit Y
 * to X, B adds X to Y) that only closes a loop once merged. The two edges are separate rows with
 * separate ids and a different `(kit_item_id, component_item_id)` pair, so neither the UNIQUE index
 * nor per-row last-write-wins can see the loop — only a pass over the whole merged edge set can.
 *
 * The rule is **oldest wins**: the edges are ranked by `created_at` (ties broken by the
 * lexicographically smaller id) and re-admitted one at a time, and any edge whose kit is already
 * reachable *below* its component is left out. That is the same verdict {@link validateKitLink}
 * would have reached had the edges been added in that order on one device, and it is a pure
 * function of frame-stable row data — so every device breaks exactly the same edges without
 * reference to which side is local. An already-acyclic graph is returned untouched (no churn).
 *
 * Only the edges to drop are returned, in the caller's own iteration order; the caller decides
 * what to do with them.
 */
export function findKitCycleBreaks(edges: readonly KitEdge[]): KitEdge[] {
  if (!hasKitCycle(edges)) return [];

  const ordered = [...edges].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const accepted = new Map<string, string[]>();
  const broken: KitEdge[] = [];
  for (const edge of ordered) {
    // A self-edge is blocked by a CHECK constraint, but a graph that arrives corrupt by some
    // other route must not be trusted to be free of one.
    if (edge.kitId === edge.componentId || reaches(accepted, edge.componentId, edge.kitId)) {
      broken.push(edge);
      continue;
    }
    const out = accepted.get(edge.kitId);
    if (out) out.push(edge.componentId);
    else accepted.set(edge.kitId, [edge.componentId]);
  }
  return broken;
}

/** Adjacency (kit → its components) for a set of edges. */
function adjacency(edges: readonly KitEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const out = adj.get(e.kitId);
    if (out) out.push(e.componentId);
    else adj.set(e.kitId, [e.componentId]);
  }
  return adj;
}

/** Whether `target` is `from` or sits anywhere below it in `adj`. Iterative, so a loop cannot hang. */
function reaches(adj: ReadonlyMap<string, string[]>, from: string, target: string): boolean {
  if (from === target) return true;
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length > 0) {
    for (const next of adj.get(stack.pop()!) ?? []) {
      if (next === target) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}

/** Node colours for the {@link hasKitCycle} depth-first walk. */
const OPEN = 1;
const CLOSED = 2;

/**
 * Whether the containment graph holds a cycle — the cheap pre-check that keeps the ordinary
 * (acyclic) merge off the quadratic re-admission walk above. Iterative depth-first with the
 * classic open/closed colouring: an edge back into a node still open on the stack is a loop.
 */
function hasKitCycle(edges: readonly KitEdge[]): boolean {
  const adj = adjacency(edges);
  const colour = new Map<string, number>();
  for (const edge of edges) {
    const root = edge.kitId;
    if (colour.has(root)) continue;
    colour.set(root, OPEN);
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const out = adj.get(frame.id) ?? [];
      if (frame.next >= out.length) {
        colour.set(frame.id, CLOSED);
        stack.pop();
        continue;
      }
      const child = out[frame.next]!;
      frame.next += 1;
      const seen = colour.get(child);
      if (seen === OPEN) return true;
      if (seen === undefined) {
        colour.set(child, OPEN);
        stack.push({ id: child, next: 0 });
      }
    }
  }
  return false;
}
