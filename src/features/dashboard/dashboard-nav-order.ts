/**
 * Pure dashboard nav-tile ordering maths (card-customisation backlog **B1** —
 * "reorder & pin tiles within a group").
 *
 * The landing hub ({@link DashboardNav}) lays the nav destinations out as grouped tiles.
 * B1 lets the user **reorder** those tiles, **move them between groups**, and **pin** a
 * tile so it floats to the top of its group. All the arrangement arithmetic —
 * reconcile-against-the-live-set, move, keyboard nudge, pin — lives here as
 * deterministic, side-effect-free functions, mirroring the sibling
 * `dashboard-layout.ts` widget-board seam ("extract the logic out of the DOM glue").
 * The React nav is a thin shell over these; `useLayoutStore` persists the result to
 * localStorage (device-local, no schema migration), and {@link useNavOrder} resolves it
 * against Modular UI feature-gating.
 *
 * **Model.** A tile's placement is `{ id, group, pinned }`. The stored array is kept in
 * *display order* with one invariant, enforced by {@link normaliseOrder} after every op:
 * within each group, pinned tiles precede unpinned tiles, and the array order is the
 * on-screen order. So a group's rendered list is simply `order.filter(group)` — no
 * separate sort at the call site. Keeping display order == stored order is what makes
 * keyboard nudge predictable (arrow-up swaps with the tile literally above it).
 */
import type { NavGroup } from '@/components/nav/nav-destinations';

/** The default home of a tile — its id (route) and the group it ships in. */
export interface NavTileDefault {
  readonly id: string;
  readonly group: NavGroup;
}

/** One tile's arrangement: which group it sits in and whether it is pinned to the top. */
export interface NavTilePlacement {
  readonly id: string;
  readonly group: NavGroup;
  /** Pinned tiles float to the top of their group (ahead of the unpinned tiles). */
  readonly pinned: boolean;
}

export type NavOrder = readonly NavTilePlacement[];

/** Keyboard reorder directions: up/down move within a group, left/right across groups. */
export type NavMoveDirection = 'up' | 'down' | 'left' | 'right';

/** Two orders are equal when their (id, group, pinned) sequences match element-for-element. */
function ordersEqual(a: NavOrder, b: NavOrder): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return y !== undefined && x.id === y.id && x.group === y.group && x.pinned === y.pinned;
  });
}

/**
 * Re-lay an arbitrary set of placements into the canonical form: group blocks in
 * `groupOrder`, and within each group the pinned tiles first (both partitions keeping
 * their incoming relative order — a stable partition). This is the one place the
 * "pinned float to the top" invariant is established, so every op can produce a loose
 * arrangement and hand it here to be tidied. Placements in an unrecognised group are
 * appended verbatim at the end so a stale group value can never drop a tile.
 *
 * @internal Exported for unit tests only.
 */
export function normaliseOrder(placements: NavOrder, groupOrder: readonly NavGroup[]): NavOrder {
  const out: NavTilePlacement[] = [];
  for (const group of groupOrder) {
    const inGroup = placements.filter((p) => p.group === group);
    for (const p of inGroup) if (p.pinned) out.push(p);
    for (const p of inGroup) if (!p.pinned) out.push(p);
  }
  for (const p of placements) if (!groupOrder.includes(p.group)) out.push(p);
  return out;
}

/**
 * The row-major default: every tile in its shipped group, unpinned, in SSOT order.
 *
 * @internal Exported for unit tests only.
 */
export function defaultOrder(defaults: readonly NavTileDefault[], groupOrder: readonly NavGroup[]): NavOrder {
  return normaliseOrder(
    defaults.map((d) => ({ id: d.id, group: d.group, pinned: false })),
    groupOrder,
  );
}

/**
 * Reconcile a persisted order against the live tile set so a saved arrangement survives
 * the nav destinations changing across releases (a forward/backward-compatibility seam,
 * mirroring `reconcileLayout`): placements for **unknown ids are dropped**, a stored tile
 * with a **stale group** falls back to its default group, known placements keep their
 * group + pin + relative order, and **newly-added tiles are appended** into their default
 * group (unpinned). An empty stored order yields the {@link defaultOrder}. Never throws on
 * a malformed stored order — the worst case is a tile reverting to its default position.
 */
export function reconcileOrder(
  stored: NavOrder,
  defaults: readonly NavTileDefault[],
  groupOrder: readonly NavGroup[],
): NavOrder {
  const defaultGroup = new Map(defaults.map((d) => [d.id, d.group] as const));
  const kept = stored
    .filter((p) => defaultGroup.has(p.id))
    .map((p) => (groupOrder.includes(p.group) ? p : { ...p, group: defaultGroup.get(p.id)! }));

  const present = new Set(kept.map((p) => p.id));
  const appended = defaults
    .filter((d) => !present.has(d.id))
    .map((d) => ({ id: d.id, group: d.group, pinned: false }));

  return normaliseOrder([...kept, ...appended], groupOrder);
}

/** A group's tiles in display order (pinned-first) — the invariant means this is just a filter. */
export function tilesInGroup(order: NavOrder, group: NavGroup): NavOrder {
  return order.filter((p) => p.group === group);
}

/**
 * Split an order into the tiles that render (`enabled`) and those whose feature is off
 * (`gated`), by an id predicate. The gated placements are kept verbatim so the caller can
 * concatenate them back on persist — a hidden module's tiles then keep their exact
 * arrangement, and re-enabling the module restores it untouched (mirrors the widget board).
 */
export function partitionByEnabled(
  order: NavOrder,
  isEnabled: (id: string) => boolean,
): { readonly enabled: NavOrder; readonly gated: NavOrder } {
  const enabled: NavTilePlacement[] = [];
  const gated: NavTilePlacement[] = [];
  for (const p of order) (isEnabled(p.id) ? enabled : gated).push(p);
  return { enabled, gated };
}

/**
 * Move a tile to `group` at display `index` (the general reinsertion used by drag-and-drop).
 * The tile keeps its pinned flag; the result is re-normalised, so dropping an unpinned tile
 * among the pins lands it at the top of the *unpinned* run (its partition), not above them.
 * The index is clamped into range; an unknown id or a no-op move returns the same reference.
 */
export function moveTile(
  order: NavOrder,
  id: string,
  group: NavGroup,
  index: number,
  groupOrder: readonly NavGroup[],
): NavOrder {
  const subject = order.find((p) => p.id === id);
  if (!subject) return order;

  const moved: NavTilePlacement = { ...subject, group };
  const without = order.filter((p) => p.id !== id);
  const target = without.filter((p) => p.group === group);
  const others = without.filter((p) => p.group !== group);
  const at = Math.max(0, Math.min(Math.floor(index), target.length));
  const nextTarget = [...target.slice(0, at), moved, ...target.slice(at)];

  const result = normaliseOrder([...others, ...nextTarget], groupOrder);
  return ordersEqual(result, order) ? order : result;
}

/**
 * Nudge a tile one step by keyboard. Up/Down swap it with the adjacent tile **of the same
 * pinned state** in its group (so an unpinned tile can't jump above the pinned run — pin it
 * instead), clamping at the group / partition edge. Left/Right move it to the previous / next
 * group, appended to the end of its own partition there. Any off-grid move is a no-op.
 */
export function nudgeTile(
  order: NavOrder,
  id: string,
  dir: NavMoveDirection,
  groupOrder: readonly NavGroup[],
): NavOrder {
  const subject = order.find((p) => p.id === id);
  if (!subject) return order;

  if (dir === 'up' || dir === 'down') {
    const groupList = tilesInGroup(order, subject.group);
    const idx = groupList.findIndex((p) => p.id === id);
    const targetIdx = dir === 'up' ? idx - 1 : idx + 1;
    const neighbour = groupList[targetIdx];
    if (!neighbour) return order;
    // Don't cross the pinned/unpinned partition boundary — that is what pinning is for.
    if (neighbour.pinned !== subject.pinned) return order;
    return moveTile(order, id, subject.group, targetIdx, groupOrder);
  }

  const gi = groupOrder.indexOf(subject.group);
  const targetGi = dir === 'left' ? gi - 1 : gi + 1;
  const targetGroup = groupOrder[targetGi];
  if (!targetGroup) return order;
  const targetList = tilesInGroup(order, targetGroup);
  // Append to the end of the matching partition in the destination group.
  const index = subject.pinned ? targetList.filter((p) => p.pinned).length : targetList.length;
  return moveTile(order, id, targetGroup, index, groupOrder);
}

/**
 * Pin or unpin a tile. Pinning floats it into its group's pinned run (at the end of it);
 * unpinning drops it to the top of the unpinned run. A no-op when the flag already matches
 * or the id is unknown.
 */
export function setTilePinned(
  order: NavOrder,
  id: string,
  pinned: boolean,
  groupOrder: readonly NavGroup[],
): NavOrder {
  const subject = order.find((p) => p.id === id);
  if (!subject || subject.pinned === pinned) return order;
  const updated = order.map((p) => (p.id === id ? { ...p, pinned } : p));
  return normaliseOrder(updated, groupOrder);
}
