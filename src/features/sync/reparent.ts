/**
 * Orphan re-parenting & cyclical-nesting prevention (spec §7.5, Phase 7).
 *
 * Distributed writes can produce relational conflicts LWW alone cannot resolve:
 *  - §7.5.2 an incoming item points at a location that another device deleted —
 *    blindly applying it would raise SQLITE_CONSTRAINT_FOREIGNKEY and abort the whole
 *    atomic sync. {@link resolveLocationTarget} intercepts this and re-parents the
 *    item to the system "Unassigned" location.
 *  - §7.5.3 two devices nest locations into each other — {@link wouldCreateCycle}
 *    detects the loop so the engine can discard that one location move.
 * Both pure, so they are exhaustively unit-tested without a database.
 */
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';

export interface LocationTargetResolution {
  /** The location id the item should end up in (its own, or Unassigned). */
  readonly locationId: string;
  /** True when the target was missing/tombstoned and we re-parented to Unassigned. */
  readonly reparented: boolean;
}

/**
 * §7.5.2: keep `targetLocationId` if it is a live (non-tombstoned) location, else
 * re-parent to Unassigned. `activeLocationIds` is the set of location ids that will
 * exist after the merge; Unassigned is always treated as present.
 */
export function resolveLocationTarget(
  targetLocationId: string,
  activeLocationIds: ReadonlySet<string>,
): LocationTargetResolution {
  if (targetLocationId === UNASSIGNED_LOCATION_ID || activeLocationIds.has(targetLocationId)) {
    return { locationId: targetLocationId, reparented: false };
  }
  return { locationId: UNASSIGNED_LOCATION_ID, reparented: true };
}

/**
 * §7.5.3: would setting `locationId`'s parent to `newParentId` create a cycle? Walks
 * the prospective parent chain (using `parentOf`, which must already reflect the
 * proposed move's *other* edges) up to the root. A node that is its own ancestor —
 * or that points at itself — is a cycle. Bounded by `maxDepth` as a backstop against
 * a pre-existing corrupt chain.
 */
export function wouldCreateCycle(
  locationId: string,
  newParentId: string | null,
  parentOf: ReadonlyMap<string, string | null>,
  maxDepth = 10_000,
): boolean {
  if (newParentId === null) return false;
  if (newParentId === locationId) return true;

  let current: string | null = newParentId;
  let steps = 0;
  while (current !== null && steps < maxDepth) {
    if (current === locationId) return true;
    current = parentOf.get(current) ?? null;
    steps += 1;
  }
  return false;
}
