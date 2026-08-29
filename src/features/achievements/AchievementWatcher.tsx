/**
 * AchievementWatcher — awards the item-count achievements (issue #412), replacing the narrower
 * `FirstItemCelebration` that watched the same count for one milestone only.
 *
 * Mounted once at the app root (inside BootGate, so the database is ready), it watches the global
 * item count and awards every threshold in {@link COUNT_ACHIEVEMENTS} the count has reached. It
 * renders no DOM of its own.
 *
 * The interesting part is the difference between *reaching* a threshold and *already being past*
 * it. The very first settled count this session says nothing about when those items arrived — an
 * inventory that loads in holding two hundred items may have held them for a year — so everything
 * it satisfies is recorded quietly, with no instant and no fanfare. Only a threshold crossed while
 * the watcher was already looking is a moment, and only that one bursts and toasts. Without the
 * distinction, opening the app on a full inventory would fire a run of fireworks for work done
 * long ago, and claim it happened just now.
 *
 * Refs hold the watching state, so a re-render or a query refetch never re-awards anything, and
 * the highest count seen is kept monotonic: deleting every item and re-adding one is not a fresh
 * "first item". {@link useAchievementsStore} persists the awards, so nothing replays across a
 * reload either.
 */
import { useEffect, useRef } from 'react';
import { useItemCount } from '@/features/inventory/queries';
import { COUNT_ACHIEVEMENTS } from './registry';
import { useUnlockAchievement } from './useUnlockAchievement';

export function AchievementWatcher() {
  // Count every item including inactive/archived, so the thresholds reflect everything the vault
  // holds rather than "how many happen not to be archived".
  const count = useItemCount({ includeInactive: true });
  const unlock = useUnlockAchievement();

  // The highest settled count seen this session, or null before the first settled reading.
  const highest = useRef<number | null>(null);

  useEffect(() => {
    if (count.isPending) return;
    const n = count.data ?? 0;
    const previous = highest.current;
    highest.current = previous === null ? n : Math.max(previous, n);

    for (const achievement of COUNT_ACHIEVEMENTS) {
      if (n < achievement.itemCount) continue;
      unlock(achievement.id, { celebrate: previous !== null && previous < achievement.itemCount });
    }
  }, [count.isPending, count.data, unlock]);

  return null;
}
