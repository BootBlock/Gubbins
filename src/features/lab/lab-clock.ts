/**
 * lab-clock — bridges the lab's stored date override into the {@link import('@/lib/clock') clock}.
 *
 * The clock module deliberately holds a plain module-level offset rather than reading a store, so
 * `nowMs()` stays synchronous and importable from the repository layer (which the Node bridge
 * loads, and which must never pull in React or zustand). This module is the one place that joins
 * the two.
 *
 * ## Why this is not a hook
 *
 * The offset has to be in place **before the first render**, not after it. Date-driven queries
 * (expiring soon, due for service, dead stock) fire as the app mounts and cache their results; an
 * offset applied in a mount effect would arrive after those reads had already evaluated against
 * the real date, leaving the UI showing one date's answers while the rest of the app believes
 * another. So {@link startLabClock} is called from `main.tsx` alongside the appearance projection —
 * the same "apply persisted state before first paint" step, for the same reason. The persisted
 * store hydrates synchronously from localStorage, so the saved choice is available that early.
 */
import { offsetForDate, setClockOffsetMs } from '@/lib/clock';
import { useLabStore } from '@/state/stores/useLabStore';

/** Push one stored value into the clock (`null` restores the real clock). */
function apply(dateOverride: string | null): void {
  setClockOffsetMs(dateOverride ? offsetForDate(dateOverride) : 0);
}

/**
 * Apply the stored date override and keep the clock in step with later changes. Idempotent —
 * calling it twice re-applies the same offset and adds a second subscription only if the returned
 * unsubscribe from the first was never used, so callers should treat it as a once-per-boot call.
 */
export function startLabClock(): () => void {
  apply(useLabStore.getState().dateOverride);
  return useLabStore.subscribe((state, previous) => {
    if (state.dateOverride !== previous.dateOverride) apply(state.dateOverride);
  });
}
