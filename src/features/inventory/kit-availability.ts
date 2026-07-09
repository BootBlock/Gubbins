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
