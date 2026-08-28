/**
 * useNavOrder — resolves the user's persisted nav-tile arrangement for {@link DashboardNav}
 * (card-customisation backlog **B1**).
 *
 * The hub lets the user reorder the nav tiles, move them between the `primary` / `manage` /
 * `system` groups, and pin a tile to the top of its group. This hook is the seam between
 * that per-device intent (persisted in `useLayoutStore.navTileOrder`) and the presentation:
 * it reconciles the stored order against the live {@link NAV_DESTINATIONS} set, applies
 * Modular UI feature-gating, and hands {@link DashboardNav} ready-to-render **ordered groups**
 * plus the edit callbacks — so the component stays pure presentation, mirroring how
 * {@link useNavCounts} owns the count logic. All the arrangement maths is the pure
 * `dashboard-nav-order.ts` seam.
 *
 * A hidden tile (its feature switched off) never appears and can't be ordered, but on every
 * write it is spliced back beside the visible neighbour it sat behind (`mergeGated`) — so
 * re-enabling the module reveals it where the user left it, not at the end of its group. A
 * stored order referencing tiles that no longer exist resolves gracefully: unknown ids are
 * dropped and newly-added tiles append into their default group.
 */
import { useCallback, useMemo } from 'react';
import {
  NAV_DESTINATIONS,
  NAV_GROUP_ORDER,
  type NavDestination,
  type NavGroup,
} from '@/components/nav/nav-destinations';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { usePermissionCheck } from '@/features/users/usePermission';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import {
  mergeGated,
  moveTile,
  nudgeTile,
  reconcileOrder,
  setTilePinned,
  tilesInGroup,
  type NavMoveDirection,
  type NavOrder,
  type NavTileDefault,
} from './dashboard-nav-order';

/** The tiles eligible for the hub: every destination except the dashboard (the current screen). */
const NAV_TILE_DEFAULTS: readonly NavTileDefault[] = NAV_DESTINATIONS.filter((d) => d.to !== '/').map(
  (d) => ({ id: d.to, group: d.group }),
);

const DEST_BY_ROUTE = new Map<string, NavDestination>(NAV_DESTINATIONS.map((d) => [d.to, d]));
const FEATURE_BY_ROUTE = new Map(NAV_DESTINATIONS.map((d) => [d.to as string, d.feature] as const));
const PERMISSION_BY_ROUTE = new Map(NAV_DESTINATIONS.map((d) => [d.to as string, d.permission] as const));

/** One tile ready to render: its destination plus whether it is pinned. */
export interface OrderedNavTile {
  readonly dest: NavDestination;
  readonly pinned: boolean;
}

/** A group's enabled tiles in display order (pinned first). Empty groups are omitted upstream. */
export interface NavOrderGroup {
  readonly group: NavGroup;
  readonly tiles: readonly OrderedNavTile[];
}

/**
 * Where a tile ended up after an edit — the raw facts a caller needs to phrase a
 * screen-reader announcement (the copy lives in the component, the logic here). `null` from
 * an op means nothing changed (a clamped nudge or a redundant pin), so nothing is announced.
 */
export interface NavMoveResult {
  readonly id: string;
  /** The tile's visible label ("Projects"), for the announcement. */
  readonly label: string;
  readonly group: NavGroup;
  /** 0-based position among the group's *visible* tiles after the move. */
  readonly index: number;
  /** Number of visible tiles in the destination group after the move. */
  readonly count: number;
  readonly pinned: boolean;
}

export interface UseNavOrder {
  /** Non-empty groups in display order, each with its enabled tiles pinned-first. */
  readonly groups: readonly NavOrderGroup[];
  /** Keyboard nudge: up/down within the group, left/right across groups. */
  readonly move: (id: string, dir: NavMoveDirection) => NavMoveResult | null;
  /** Drag-and-drop reinsertion: move `id` into `group` at display `index`. */
  readonly moveTo: (id: string, group: NavGroup, index: number) => NavMoveResult | null;
  /** Toggle a tile's pinned state (pinned tiles float to the top of their group). */
  readonly togglePin: (id: string) => NavMoveResult | null;
  /** Clear the saved arrangement — every tile reverts to its shipped group and order. */
  readonly reset: () => void;
}

export function useNavOrder(): UseNavOrder {
  const stored = useLayoutStore((s) => s.navTileOrder);
  const setStored = useLayoutStore((s) => s.setNavTileOrder);
  const enabledFeatures = useEnabledFeatures();
  const allows = usePermissionCheck();

  // Reconcile against the live tile set every render so the arrangement survives the nav
  // destinations changing across releases (unknown ids dropped, new tiles appended).
  const full = useMemo(() => reconcileOrder(stored, NAV_TILE_DEFAULTS, NAV_GROUP_ORDER), [stored]);

  // Drop the tiles whose module is switched off, or whose read permission this session lacks
  // (issue #522): `enabled` is what the hub draws and every edit operates on. The hidden tiles
  // are merged back from `full` on persist (see `apply`), so one keeps its place and reappears
  // where it was when the module comes back or the role changes.
  const enabled = useMemo(
    () =>
      full.filter((p) => {
        const feature = FEATURE_BY_ROUTE.get(p.id);
        return (!feature || enabledFeatures.has(feature)) && allows(PERMISSION_BY_ROUTE.get(p.id));
      }),
    [full, enabledFeatures, allows],
  );

  const groups = useMemo<readonly NavOrderGroup[]>(
    () =>
      NAV_GROUP_ORDER.map((group) => ({
        group,
        tiles: tilesInGroup(enabled, group).flatMap((p) => {
          const dest = DEST_BY_ROUTE.get(p.id);
          return dest ? [{ dest, pinned: p.pinned }] : [];
        }),
      })).filter((g) => g.tiles.length > 0),
    [enabled],
  );

  // Persist an op's result only when it actually changed the enabled order (the pure ops
  // return the same reference on a no-op). `mergeGated` splices each hidden tile back beside
  // the visible neighbour it sat behind, so it keeps its place (issue #628).
  // Returns the tile's resulting placement so the caller can announce the move, or null on
  // a no-op. `next` is the enabled-only order, so the reported position/count count only the
  // visible tiles — exactly what a sighted user sees.
  const apply = useCallback(
    (next: NavOrder, id: string): NavMoveResult | null => {
      if (next === enabled) return null;
      setStored(mergeGated(full, next, NAV_GROUP_ORDER));
      const placement = next.find((p) => p.id === id);
      if (!placement) return null;
      const groupTiles = tilesInGroup(next, placement.group);
      return {
        id,
        label: DEST_BY_ROUTE.get(id)?.label ?? id,
        group: placement.group,
        index: groupTiles.findIndex((p) => p.id === id),
        count: groupTiles.length,
        pinned: placement.pinned,
      };
    },
    [enabled, full, setStored],
  );

  const move = useCallback(
    (id: string, dir: NavMoveDirection) => apply(nudgeTile(enabled, id, dir, NAV_GROUP_ORDER), id),
    [enabled, apply],
  );
  const moveTo = useCallback(
    (id: string, group: NavGroup, index: number) =>
      apply(moveTile(enabled, id, group, index, NAV_GROUP_ORDER), id),
    [enabled, apply],
  );
  const togglePin = useCallback(
    (id: string) => {
      const current = enabled.find((p) => p.id === id);
      return current ? apply(setTilePinned(enabled, id, !current.pinned, NAV_GROUP_ORDER), id) : null;
    },
    [enabled, apply],
  );
  const reset = useCallback(() => setStored([]), [setStored]);

  return { groups, move, moveTo, togglePin, reset };
}
