/**
 * Kit build-availability maths (Kits v1), kept pure and dependency-free.
 *
 * "How many whole kits can I build right now?" is the minimum, over every component, of
 * how many kits that component's on-hand stock can cover: `floor(stock / qtyPerKit)`. The
 * kit is limited by its scarcest component(s), so the result also names which component(s)
 * pin the count — the UI surfaces them so the user knows what to restock. A kit with no
 * components can build nothing. This is the same "min over ratios" shape a BOM coverage or
 * a recipe-yield calculation takes, isolated here so it is exhaustively unit-testable.
 */

/** The stock facts one component contributes to a kit's buildable count. */
export interface ComponentStock {
  /** Units of this component consumed per whole kit — always ≥ 1 (a DB CHECK enforces > 0). */
  readonly quantity: number;
  /** The component's current on-hand stock. */
  readonly stock: number;
}

export interface BuildableResult<T> {
  /** How many whole kits the current component stock can build (0 for an empty kit). */
  readonly count: number;
  /** The component(s) that pin the count — the scarcest, holding `count` back. Empty when
   *  there are no (constraining) components. */
  readonly limiting: readonly T[];
}

/**
 * The number of whole kits buildable from the given components, and which component(s)
 * limit it. Each component covers `floor(stock / quantity)` kits; the kit's total is the
 * minimum of those. A component with a non-positive `quantity` (never expected — the DB
 * forbids it) imposes no constraint and is ignored. An empty component list yields 0.
 */
export function buildableCount<T extends ComponentStock>(components: readonly T[]): BuildableResult<T> {
  const constraining = components.filter((c) => c.quantity > 0);
  if (constraining.length === 0) {
    return { count: 0, limiting: [] };
  }
  const perComponent = constraining.map((c) => Math.floor(c.stock / c.quantity));
  const count = Math.min(...perComponent);
  const limiting = constraining.filter((c) => Math.floor(c.stock / c.quantity) === count);
  return { count, limiting };
}

// ---------------------------------------------------------------------------
// Nested-kit roll-up & cascade planning (Kits v3)
// ---------------------------------------------------------------------------
//
// A kit's component may itself be a kit. `buildableCount` above answers the *single-level*
// question (how many can I build from direct components already on hand). Roll-up answers the
// *effective* one: a sub-kit contributes not just the sub-kits already on hand but also however
// many more could be assembled from its own components, recursively down the acyclic containment
// graph (the same graph the cycle guard keeps acyclic, so every walk terminates).
//
// Both the roll-up availability number and the cascade-assemble plan are derived from one core —
// a **requirements explosion** that nets demand against on-hand stock across the whole graph. This
// keeps the two honest: the buildable ceiling and the plan that realises it can never disagree
// (crucially in a *diamond*, where two sub-kits share a leaf — the shared leaf is split between
// them, not double-counted, exactly as the real draw would). Gauge components fold in for free:
// their `quantity` is a per-kit net-value draw and their `stock` a net value, so `floor(stock /
// quantity)` is the same coverage ratio a discrete component uses.

/** One directed containment edge in the flattened kit graph. */
export interface KitDagEdge {
  /** The component item's id. */
  readonly itemId: string;
  /** Per-parent-kit requirement — whole units (discrete) or a net-value draw (gauge). ≥ 0. */
  readonly quantity: number;
}

/**
 * One item in the flattened kit containment graph: its on-hand supply (a discrete count or a
 * gauge net value) and its direct component edges. A node with no edges is a *leaf* — a raw
 * material, a gauge, or an un-composed sub-kit held only on hand — whose supply is fixed at its
 * stock and cannot be manufactured.
 */
export interface KitTreeNode {
  readonly itemId: string;
  readonly name: string;
  /** On-hand supply: DISCRETE quantity, or a gauge's current net value. */
  readonly stock: number;
  readonly components: readonly KitTreeComponent[];
}

/** A component line of a {@link KitTreeNode}: the per-kit requirement and the sub-node it points at. */
export interface KitTreeComponent {
  readonly quantity: number;
  readonly node: KitTreeNode;
}

/** A leaf item whose scarcity pins a roll-up count — the raw material to restock. */
export interface RollUpLimit {
  readonly itemId: string;
  readonly name: string;
}

export interface RollUpResult {
  /** Most whole kits assemblable with sub-kits built on demand (nets shared leaves precisely). */
  readonly count: number;
  /**
   * The deepest limiting leaf/leaves — the raw material(s) whose scarcity holds the count back,
   * following the containment chain down past any intermediate sub-kits. Restocking one of these
   * is what raises the buildable total. Empty for an empty kit.
   */
  readonly limiting: readonly RollUpLimit[];
  /** How many of the kit's *direct* components are themselves sub-kits (have their own components). */
  readonly subKitCount: number;
}

/** A leaf that could not meet the exploded requirement — a shortfall that fails a plan. */
export interface RollUpShortfall extends RollUpLimit {
  /** Total units the explosion needs of this leaf. */
  readonly needed: number;
  /** Units actually on hand. */
  readonly available: number;
}

/** The flattened, de-duplicated containment graph keyed by item id (a diamond shares one node). */
type KitDag = ReadonlyMap<string, { name: string; stock: number; components: readonly KitDagEdge[] }>;

/**
 * Flatten a nested {@link KitTreeNode} into a de-duplicated DAG keyed by item id. A shared
 * component reached by two paths (a diamond) collapses to a single node — the first occurrence
 * wins (all occurrences of an item describe the same stock/components, so this is lossless), and
 * de-duplication is what makes the explosion net a shared leaf instead of double-counting it.
 */
function flattenKit(root: KitTreeNode): KitDag {
  const dag = new Map<string, { name: string; stock: number; components: KitDagEdge[] }>();
  const visit = (node: KitTreeNode): void => {
    if (dag.has(node.itemId)) return;
    dag.set(node.itemId, {
      name: node.name,
      stock: node.stock,
      components: node.components
        .filter((c) => c.quantity > 0)
        .map((c) => ({ itemId: c.node.itemId, quantity: c.quantity })),
    });
    for (const c of node.components) visit(c.node);
  };
  visit(root);
  return dag;
}

/** Topological order of the reachable graph, parents strictly before children (root first). */
function topoOrder(dag: KitDag, rootId: string): string[] {
  const order: string[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const walk = (id: string): void => {
    if (state.get(id) === 'done') return;
    state.set(id, 'open');
    for (const edge of dag.get(id)?.components ?? []) {
      if (state.get(edge.itemId) !== 'done') walk(edge.itemId);
    }
    state.set(id, 'done');
    order.push(id);
  };
  walk(rootId);
  return order.reverse(); // post-order reversed = parents before children
}

/**
 * One build step of a cascade: assemble `buildQty` of `itemId` by consuming its `draws`. Steps
 * are ordered children-first, so every sub-kit is produced before the parent step that consumes
 * it; the root is the final step.
 */
export interface CascadeStep {
  readonly itemId: string;
  readonly name: string;
  readonly buildQty: number;
  /** Total units to consume of each direct component for this step (`buildQty × per-kit qty`). */
  readonly draws: readonly KitDagEdge[];
}

export interface AssemblyPlan {
  /** True when every leaf requirement is covered by on-hand stock. */
  readonly feasible: boolean;
  /** Build steps, children-first, root last (only when feasible). */
  readonly steps: readonly CascadeStep[];
  /** Leaves that fell short (only when infeasible) — what to restock and by how much. */
  readonly shortfalls: readonly RollUpShortfall[];
}

interface Explosion {
  /** Units to assemble of each item (root plus any sub-kit built to cover a shortfall). */
  readonly produce: ReadonlyMap<string, number>;
  /** Total units of each item demanded by its parents' builds. */
  readonly grossDemand: ReadonlyMap<string, number>;
  readonly feasible: boolean;
  readonly shortfalls: readonly RollUpShortfall[];
}

/**
 * The requirements explosion: produce `count` of the root, netting each item's gross demand
 * against its on-hand stock. When `cascade` is on, a sub-kit short on hand is *built* to cover
 * the gap (exploding its own components); when off, every non-root item is treated as a leaf
 * (consumed from stock only — the single-level v2 behaviour). Feasibility bottoms out at the
 * leaves: the plan is possible iff every leaf's total demand is covered by its stock.
 */
function explode(dag: KitDag, rootId: string, count: number, cascade: boolean): Explosion {
  const grossDemand = new Map<string, number>();
  const produce = new Map<string, number>();
  const add = (map: Map<string, number>, id: string, n: number): void =>
    void map.set(id, (map.get(id) ?? 0) + n);

  for (const id of topoOrder(dag, rootId)) {
    const node = dag.get(id);
    if (!node) continue;
    const isRoot = id === rootId;
    const isSubKit = node.components.length > 0;
    const demand = isRoot ? count : (grossDemand.get(id) ?? 0);
    // How many of this item to actually assemble: the root always builds the requested count; a
    // sub-kit (when cascading) builds only the shortfall its on-hand can't cover; everything else
    // is drawn from stock, never manufactured.
    const build = isRoot ? count : cascade && isSubKit ? Math.max(0, demand - Math.max(0, node.stock)) : 0;
    if (build > 0) {
      produce.set(id, build);
      for (const edge of node.components) add(grossDemand, edge.itemId, build * edge.quantity);
    }
  }

  const shortfalls: RollUpShortfall[] = [];
  for (const [id, node] of dag) {
    // A node is a "leaf" for feasibility if it is never built — a true leaf, or (non-cascade) a
    // sub-kit consumed from stock. Its demand must be covered by on-hand stock.
    if (!produce.has(id) || (produce.get(id) ?? 0) === 0) {
      const needed = grossDemand.get(id) ?? 0;
      const available = Math.max(0, node.stock);
      if (needed > available) shortfalls.push({ itemId: id, name: node.name, needed, available });
    }
  }
  return { produce, grossDemand, feasible: shortfalls.length === 0, shortfalls };
}

/**
 * The most whole kits assemblable from the graph with sub-kits built on demand, and the deepest
 * leaves that pin the count. Monotonic in the requested count (more kits ⇒ more demand ⇒ no more
 * feasible than fewer), so the ceiling is found by binary search over the explosion's feasibility,
 * and the limiting leaves are those that first fall short at one kit beyond the ceiling.
 */
export function rollUpBuildable(root: KitTreeNode): RollUpResult {
  const dag = flattenKit(root);
  const rootNode = dag.get(root.itemId)!;
  const subKitCount = rootNode.components.filter(
    (e) => (dag.get(e.itemId)?.components.length ?? 0) > 0,
  ).length;
  if (rootNode.components.length === 0) {
    return { count: 0, limiting: [], subKitCount };
  }

  // Each assembled kit consumes at least one unit somewhere in the graph, so the total on-hand
  // stock is a safe (loose) upper bound on how many are buildable.
  let upper = 0;
  for (const node of dag.values()) upper += Math.max(0, Math.floor(node.stock));

  const feasible = (n: number): boolean => explode(dag, root.itemId, n, true).feasible;
  let lo = 0;
  let hi = upper;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (feasible(mid)) lo = mid;
    else hi = mid - 1;
  }

  // The binding constraints are the leaves that go short when we try one more kit than the ceiling.
  const limiting = explode(dag, root.itemId, lo + 1, true).shortfalls.map((s) => ({
    itemId: s.itemId,
    name: s.name,
  }));
  return { count: lo, limiting, subKitCount };
}

/**
 * Plan the assembly of `count` whole kits into an ordered list of build steps. With `cascade`
 * off this is the single-level v2 build (one step: the root, drawing its direct components from
 * stock); with it on, every sub-kit short on hand is built first (its step ordered before the
 * parent that consumes it) so the whole tree assembles in one pass. An infeasible request returns
 * `feasible: false` with the leaf shortfalls, leaving the caller to reject it before any stock moves.
 */
export function planAssembly(root: KitTreeNode, count: number, cascade: boolean): AssemblyPlan {
  const dag = flattenKit(root);
  const ex = explode(dag, root.itemId, count, cascade);
  if (!ex.feasible) return { feasible: false, steps: [], shortfalls: ex.shortfalls };

  // Children-first order so a sub-kit is produced before the parent step consumes it; the root
  // (which nothing consumes) falls out last.
  const order = topoOrder(dag, root.itemId).reverse();
  const steps: CascadeStep[] = [];
  for (const id of order) {
    const buildQty = ex.produce.get(id) ?? 0;
    if (buildQty <= 0) continue;
    const node = dag.get(id)!;
    steps.push({
      itemId: id,
      name: node.name,
      buildQty,
      draws: node.components.map((e) => ({ itemId: e.itemId, quantity: e.quantity * buildQty })),
    });
  }
  return { feasible: true, steps, shortfalls: [] };
}
