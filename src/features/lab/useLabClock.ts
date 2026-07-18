/**
 * useLabClock — pushes the lab's date override into the {@link import('@/lib/clock') clock}.
 *
 * The clock module deliberately holds a plain module-level offset rather than reading a store, so
 * `nowMs()` stays synchronous and importable from the repository layer (which the Node bridge
 * loads, and which must never pull in React). This hook is the one place that bridges the two: it
 * is mounted once at the composition root and keeps the offset in step with the stored choice.
 *
 * Mounted at the root rather than inside the lab screen on purpose — the override has to apply
 * everywhere in the app, including after a reload with the lab screen closed.
 */
import { useEffect } from 'react';
import { offsetForDate, setClockOffsetMs } from '@/lib/clock';
import { useLabStore } from '@/state/stores/useLabStore';

export function useLabClock(): void {
  const dateOverride = useLabStore((state) => state.dateOverride);
  useEffect(() => {
    setClockOffsetMs(dateOverride ? offsetForDate(dateOverride) : 0);
    // Restore the real clock if the app shell ever unmounts, so a stale offset can't outlive it.
    return () => setClockOffsetMs(0);
  }, [dateOverride]);
}
