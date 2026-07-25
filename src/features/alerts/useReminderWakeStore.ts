/**
 * useReminderWakeStore — the outcome of the last Periodic Background Sync registration attempt
 * (G3).
 *
 * The background wake-up is registered by {@link ./useReminderNotifications} (mounted app-wide,
 * rendering nothing) but is only *reportable* in Settings, so its outcome needs somewhere to
 * live between the two. Deliberately **not** persisted: it describes what the browser did on
 * this page load, and re-asserting a stale "unavailable" across a reload would be a worse lie
 * than saying nothing.
 *
 * A browser may refuse the registration outright — Chrome, for instance, declines it for a site
 * it considers too little used — leaving reminders working while Gubbins is open but with no
 * background check behind them. `'unavailable'` is what lets Settings say so instead of showing
 * an unqualified "on".
 */
import { create } from 'zustand';

/**
 * - `'unknown'` — not attempted, not wanted, or torn down: nothing to report.
 * - `'registered'` — a background wake-up for our tag exists.
 * - `'unavailable'` — one was wanted, and the browser refused or the attempt failed.
 */
export type ReminderWakeStatus = 'unknown' | 'registered' | 'unavailable';

interface ReminderWakeStore {
  readonly status: ReminderWakeStatus;
  setStatus: (status: ReminderWakeStatus) => void;
}

export const useReminderWakeStore = create<ReminderWakeStore>()((set) => ({
  status: 'unknown',
  setStatus: (status) => set({ status }),
}));
