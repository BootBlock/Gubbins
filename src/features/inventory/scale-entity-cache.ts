/**
 * Session cache of the Home Assistant scale list, keyed by bridge URL (issue #122).
 *
 * The bridge answers "which entities are scales?" by pulling Home Assistant's *entire* entity
 * list, so refetching it every time the weigh-count dialog opens — while counting a run of items
 * — would be a lot of traffic for a set that does not realistically change mid-session.
 *
 * Module scope rather than component state, so it survives the dialog unmounting between items.
 * Deliberately **not** persisted: a page reload starts fresh, which is also how a user who has
 * just added a scale in Home Assistant picks it up without a "refresh" affordance in the UI.
 */
import type { ScaleEntity } from './scale-reading';

const cache = new Map<string, readonly ScaleEntity[]>();

/** The cached scale list for a bridge, or `undefined` when it hasn't been fetched yet. */
export function getCachedScaleEntities(bridgeUrl: string): readonly ScaleEntity[] | undefined {
  return cache.get(bridgeUrl.trim());
}

/** Cache a successfully-fetched scale list against its bridge. */
export function setCachedScaleEntities(bridgeUrl: string, entities: readonly ScaleEntity[]): void {
  cache.set(bridgeUrl.trim(), entities);
}

/** Drop everything cached. Used by tests, which must not leak state between cases. */
export function clearScaleEntityCache(): void {
  cache.clear();
}
