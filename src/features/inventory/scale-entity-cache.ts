/**
 * Session cache of the Home Assistant scale list, keyed by bridge URL (issue #122).
 *
 * The bridge answers "which entities are scales?" by pulling Home Assistant's *entire* entity
 * list, so refetching it every time the weigh-count dialog opens — while counting a run of items
 * — would be a lot of traffic for a set that does not realistically change mid-session.
 *
 * Module scope rather than component state, so it survives the dialog unmounting between items.
 * Deliberately **not** persisted: a page reload starts fresh.
 *
 * A session-long cache used to mean that a user who had *just* added a scale in Home Assistant
 * had to reload the page before it appeared. {@link forgetCachedScaleEntities} closes that
 * without giving up the saving: the picker offers an explicit refresh, which drops this bridge's
 * entry so the next fetch goes to Home Assistant. An automatic TTL was the alternative and is
 * worse here — it re-pulls the entity list on a timer nobody asked for, to catch a change that
 * only the user knows they made.
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

/**
 * Forget one bridge's cached list, so the next read re-asks Home Assistant. Backs the picker's
 * refresh control — scoped to the one bridge, because another bridge's list is still good.
 */
export function forgetCachedScaleEntities(bridgeUrl: string): void {
  cache.delete(bridgeUrl.trim());
}

/** Drop everything cached. Used by tests, which must not leak state between cases. */
export function clearScaleEntityCache(): void {
  cache.clear();
}
