/**
 * Pure planners for the two reference kinds a merge cannot simply re-point (issue #99).
 *
 * Most things that name an item name it in one nullable-or-not column with no constraint across
 * rows, so moving them from the removed item to the kept one is a single `UPDATE`. Two are not
 * like that, and both would abort the merge transaction outright if they were treated as though
 * they were:
 *
 * - **Kit membership** (`kit_components`) carries `UNIQUE (kit_item_id, component_item_id)` and
 *   `CHECK (kit_item_id <> component_item_id)`. Re-pointing can duplicate an edge the kit already
 *   has, or fold a kit and its own component onto one id — and, past what the schema can see, it
 *   can close a **containment cycle** (a kit that transitively contains itself), which nothing in
 *   the database would refuse.
 * - **Item relations** (`item_relations`) has `CHECK (from_item_id <> to_item_id)` and — the part
 *   that makes an `UPDATE` wrong rather than merely risky — a **derived primary key**: the id
 *   *is* the canonical `from|to|kind` triple (see `features/inventory/item-relations`). Moving an
 *   endpoint without re-deriving the id leaves a row whose key no longer describes it, so the
 *   idempotent re-add every peer relies on stops recognising it.
 *
 * Both planners answer the same question — which rows survive re-pointed, and which have to be
 * dropped because the merge collapsed them into something the schema will not hold — and both do
 * it as pure functions over rows the caller has already read, so the reasoning is testable
 * without a database and the caller is left with a plain list of statements to run atomically.
 *
 * A dropped row is a real loss, so both planners drop as little as they can and only ever drop a
 * row the merge itself made impossible. Neither ever drops a row that does not touch the removed
 * item.
 */
import { planRelation } from '../item-relations';

/** One `kit_components` edge, as the merge reads it. */
export interface KitEdge {
  readonly id: string;
  readonly kitItemId: string;
  readonly componentItemId: string;
}

export interface KitEdgeRemap {
  /** Edges to `UPDATE` in place — same id, carrying the endpoints they should end up holding. */
  readonly remapped: readonly KitEdge[];
  /** Edge ids to `DELETE` (and tombstone): the merge left them impossible. */
  readonly dropped: readonly string[];
}

/**
 * Plan the `kit_components` re-point for merging `removeId` into `keepId`.
 *
 * `edges` must be **every** row in `kit_components`, not only the ones touching `removeId`: a
 * duplicate or a cycle is a property of the whole graph, and a planner shown only part of it
 * would approve an edge that then aborts the transaction.
 *
 * Candidates are considered in id order, so two devices planning the same merge over the same
 * rows drop the same edges. An edge is dropped when the substitution makes it
 *
 * 1. **self-containment** — both endpoints became the kept item;
 * 2. a **duplicate** of an edge that already survives; or
 * 3. a **cycle** — the kept graph can already reach the edge's kit from its component, so adding
 *    it would let a kit contain itself. Only the newly-impossible edge is dropped; an edge that
 *    was already in the graph is never removed to make room for one that was not.
 */
export function planKitEdgeRemap(edges: readonly KitEdge[], removeId: string, keepId: string): KitEdgeRemap {
  const touched = edges.filter((e) => e.kitItemId === removeId || e.componentItemId === removeId);
  if (touched.length === 0) return { remapped: [], dropped: [] };

  const touchedIds = new Set(touched.map((e) => e.id));
  // The graph the candidates are judged against: everything the merge does not move, which is
  // by definition already valid, plus each candidate as it is accepted.
  const kept = edges.filter((e) => !touchedIds.has(e.id));
  const pairs = new Set(kept.map((e) => `${e.kitItemId} ${e.componentItemId}`));
  const children = new Map<string, string[]>();
  const addChild = (kit: string, component: string) => {
    const list = children.get(kit);
    if (list) list.push(component);
    else children.set(kit, [component]);
  };
  for (const edge of kept) addChild(edge.kitItemId, edge.componentItemId);

  /** Whether `to` is reachable from `from` by following containment downwards. */
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length > 0) {
      for (const child of children.get(stack.pop()!) ?? []) {
        if (child === to) return true;
        if (seen.has(child)) continue;
        seen.add(child);
        stack.push(child);
      }
    }
    return false;
  };

  const remapped: KitEdge[] = [];
  const dropped: string[] = [];
  for (const edge of [...touched].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const kitItemId = edge.kitItemId === removeId ? keepId : edge.kitItemId;
    const componentItemId = edge.componentItemId === removeId ? keepId : edge.componentItemId;
    const pair = `${kitItemId} ${componentItemId}`;
    // A cycle closes when the component can already reach the kit — the same test
    // `assertKitLinkValid` makes for a hand-added link, asked here of the post-merge graph.
    if (kitItemId === componentItemId || pairs.has(pair) || reaches(componentItemId, kitItemId)) {
      dropped.push(edge.id);
      continue;
    }
    remapped.push({ id: edge.id, kitItemId, componentItemId });
    pairs.add(pair);
    addChild(kitItemId, componentItemId);
  }
  return { remapped, dropped };
}

/** One `item_relations` row, as the merge reads it. */
export interface ItemRelationEdge {
  readonly id: string;
  readonly fromItemId: string;
  readonly toItemId: string;
  readonly kind: string;
}

/** A relation that survives, re-keyed to the id its new endpoints derive. */
export interface RemappedRelation {
  /** The row to delete — its id no longer describes it. */
  readonly oldId: string;
  /** The row to insert in its place. */
  readonly id: string;
  readonly fromItemId: string;
  readonly toItemId: string;
  readonly kind: string;
}

export interface RelationRemap {
  /** Relations to re-key: delete the old row (and tombstone it), insert the new one. */
  readonly remapped: readonly RemappedRelation[];
  /** Relation ids to delete (and tombstone): the merge left them impossible or redundant. */
  readonly dropped: readonly string[];
}

/**
 * Plan the `item_relations` re-point for merging `removeId` into `keepId`.
 *
 * `relations` must be every relation touching **either** item: a re-keyed row can collide with
 * one the kept item already holds, and a planner shown only the removed item's rows would not
 * see it. A relation is dropped when the substitution makes it a **self-relation**, when its new
 * id is one the kept item already has, or when its `kind` is not one this build understands (a
 * value a newer peer synced, which cannot be re-canonicalised here without guessing).
 *
 * Rows are re-keyed rather than updated because the id *is* the endpoints: see
 * `itemRelationId` in `features/inventory/item-relations`.
 */
export function planRelationRemap(
  relations: readonly ItemRelationEdge[],
  removeId: string,
  keepId: string,
): RelationRemap {
  const touched = relations.filter((r) => r.fromItemId === removeId || r.toItemId === removeId);
  if (touched.length === 0) return { remapped: [], dropped: [] };

  const touchedIds = new Set(touched.map((r) => r.id));
  const taken = new Set(relations.filter((r) => !touchedIds.has(r.id)).map((r) => r.id));

  const remapped: RemappedRelation[] = [];
  const dropped: string[] = [];
  for (const relation of [...touched].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const from = relation.fromItemId === removeId ? keepId : relation.fromItemId;
    const to = relation.toItemId === removeId ? keepId : relation.toItemId;
    // The same seam the ordinary "add a relation" path uses, so the merge cannot mint a row the
    // hand-added one would have refused, and a symmetric kind's endpoints are canonicalised
    // exactly as they are everywhere else.
    const plan = planRelation(from, to, relation.kind);
    if (!plan.ok || taken.has(plan.id)) {
      dropped.push(relation.id);
      continue;
    }
    remapped.push({
      oldId: relation.id,
      id: plan.id,
      fromItemId: plan.spec.fromItemId,
      toItemId: plan.spec.toItemId,
      kind: plan.spec.kind,
    });
    taken.add(plan.id);
  }
  return { remapped, dropped };
}
