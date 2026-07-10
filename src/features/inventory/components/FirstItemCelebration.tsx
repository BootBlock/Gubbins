/**
 * FirstItemCelebration — fires the one-shot milestone success burst (visual-flair F4) the first
 * time an item ever exists on this device.
 *
 * Mounted once at the app root (inside BootGate, so the database is ready), it watches the global
 * item count and celebrates the empty → first-item transition exactly once:
 *  - It fires only when it has *witnessed* a settled, genuinely empty inventory this session and
 *    then seen it become non-empty. Without that "saw empty first" guard, an already-populated
 *    inventory loading in (its count resolving straight to > 0) — or a later refetch that keeps the
 *    count > 0 — would falsely read as "you just added your first item". The rising edge is caught
 *    with a ref, so a re-render or refetch never re-fires it.
 *  - {@link useMilestonesStore} persists that this burst has played, so deleting every item and
 *    re-adding one later never replays what is meant to be a one-time first-run moment.
 *
 * The burst itself is pure decoration (the overlay is `aria-hidden`); the milestone is *also*
 * surfaced as a success toast (`role="status"`, announced politely) so screen-reader users receive
 * it as text rather than a silent animation. This component renders no visible DOM of its own.
 */
import { useEffect, useRef } from 'react';
import { useBurst, useToast } from '@/components/foundry';
import { SuccessIcon } from '@/components/icons';
import { useItemCount } from '@/features/inventory/queries';
import { useMilestonesStore } from '@/state/stores/useMilestonesStore';

export function FirstItemCelebration() {
  // Count every item including inactive/archived, so the milestone reflects a truly empty database
  // rather than "all remaining items happen to be archived".
  const count = useItemCount({ includeInactive: true });
  const celebrated = useMilestonesStore((s) => s.firstItemCelebrated);
  const celebrateFirstItem = useMilestonesStore((s) => s.celebrateFirstItem);
  const { burst } = useBurst();
  const { show } = useToast();

  // Set once we've seen a settled count of exactly zero — the "this really started empty" gate.
  const sawEmpty = useRef(false);
  // Belt-and-braces against a double-fire within a session (the persistent store guards across
  // sessions; this guards a same-session flurry of query updates before the store write lands).
  const fired = useRef(false);

  useEffect(() => {
    if (celebrated || fired.current || count.isPending) return;
    const n = count.data ?? 0;
    if (n === 0) {
      sawEmpty.current = true;
      return;
    }
    // Non-empty, but we never witnessed the empty state this session → not a first-item edge.
    if (!sawEmpty.current) return;

    fired.current = true;
    burst();
    show({
      tone: 'success',
      icon: <SuccessIcon aria-hidden />,
      heading: 'Your first item!',
      message: 'Your inventory is off the ground — everything you add from here builds on it.',
    });
    celebrateFirstItem();
  }, [celebrated, count.isPending, count.data, burst, show, celebrateFirstItem]);

  return null;
}
