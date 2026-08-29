/**
 * useCountDraftStore — the saved count sheets behind a resumable stock-take (issue #587).
 *
 * The guided walk's cross-location progress already survived a reload in
 * {@link useAuditSessionStore}; the quantities typed at the location in hand did not, because
 * they lived only in the ephemeral {@link CycleCountProvider} that the dialog unmounts. So
 * "Pause & close" — and Escape, a backdrop tap, or a phone reclaiming a backgrounded tab —
 * quietly threw away every count on the shelf, recoverable only by walking back and counting
 * it again. This store is the missing half: one sheet per location id, written as the auditor
 * types and cleared the moment that location is authorised, skipped or abandoned.
 *
 * It is deliberately a store of its own rather than a field on the audit session, because the
 * standalone single-location {@link CycleCountDialog} has exactly the same exposure and no
 * session at all. Both dialogs share one `CycleCountProvider`, so wiring the drafts in there
 * fixes both at once.
 *
 * Everything with a decision in it — what counts as work worth saving, what a resumed sheet is
 * seeded with, the eviction cap, the rehydration reconcile — lives in the pure, unit-tested
 * {@link module:count-draft} seam; this module is only the persistence and the clock.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { adoptUnversioned } from '@/lib/persisted-state';
import type { FoundHereEntry, SerialisedPresence } from './cycle-count';
import {
  capCountDrafts,
  draftFrom,
  normaliseCountDrafts,
  sameCountDraft,
  type CountDraft,
} from './count-draft';

interface CountDraftStore {
  /** The saved sheets, keyed by location id. A location with no unfinished work has no entry. */
  readonly drafts: Readonly<Record<string, CountDraft>>;

  /**
   * Save the live sheet for a location, stamped now. An empty sheet clears the entry instead
   * of storing one, and a sheet identical to what is already stored is a no-op — so neither a
   * re-render nor a re-seed rewrites storage or resets the age the resume notice reports.
   */
  save: (
    locationId: string,
    counts: Readonly<Record<string, string>>,
    presence: Readonly<Record<string, SerialisedPresence>>,
    found: readonly FoundHereEntry[],
  ) => void;

  /** Drop a location's sheet — it has been authorised, skipped, or explicitly started over. */
  clear: (locationId: string) => void;

  /** Drop several sheets at once (a whole abandoned walk's scope). */
  clearMany: (locationIds: readonly string[]) => void;
}

/** The draft map without the given location ids. */
function without(
  drafts: Readonly<Record<string, CountDraft>>,
  locationIds: ReadonlySet<string>,
): Readonly<Record<string, CountDraft>> {
  return Object.fromEntries(Object.entries(drafts).filter(([id]) => !locationIds.has(id)));
}

export const useCountDraftStore = create<CountDraftStore>()(
  persist(
    (set) => ({
      drafts: {},

      save: (locationId, counts, presence, found) =>
        set((state) => {
          const next = draftFrom(counts, presence, found, Date.now());
          if (sameCountDraft(next, state.drafts[locationId] ?? null)) return state;
          if (!next) return { drafts: without(state.drafts, new Set([locationId])) };
          return { drafts: capCountDrafts({ ...state.drafts, [locationId]: next }) };
        }),

      clear: (locationId) =>
        set((state) =>
          state.drafts[locationId] ? { drafts: without(state.drafts, new Set([locationId])) } : state,
        ),

      clearMany: (locationIds) =>
        set((state) => {
          const ids = new Set(locationIds);
          const remaining = without(state.drafts, ids);
          return Object.keys(remaining).length === Object.keys(state.drafts).length
            ? state
            : { drafts: remaining };
        }),
    }),
    {
      name: 'gubbins:count-drafts',
      // v1 is this store's first shipped shape, so there is no earlier state to convert — but a
      // `version` without a `migrate` is data loss, not a warning: zustand hydrates with
      // `undefined` on any mismatch (see `lib/persisted-state`). The pass-through therefore
      // hands a mismatched blob — a downgrade from a later version, a hand-edit — to `merge`,
      // which reconciles it field by field, rather than discarding a half-counted shelf.
      version: 1,
      migrate: adoptUnversioned,
      // Rehydrated JSON is untyped and these values are fed straight into the count inputs, so
      // reconcile the whole map back to a valid shape on read rather than letting a truncated
      // or hand-edited write reach the sheet.
      merge: (persisted, current) => ({
        ...current,
        drafts: normaliseCountDrafts((persisted as { drafts?: unknown } | null | undefined)?.drafts),
      }),
    },
  ),
);
