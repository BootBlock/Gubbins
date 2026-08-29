/**
 * The application boot state machine (Tier-3 ephemeral state, spec §2.1).
 *
 * Runs once on mount and drives the gate the user sees before the app is usable:
 *   1. Critical platform support (OPFS — §2.2.6), plus the cross-origin isolation that decides
 *      which VFS the database opens on (issue #255).
 *   2. Single-tab ownership via the Web Lock guard (§2.2.7).
 *   3. Open the OPFS database, verify FTS5, and run migrations (§2.2, §2.3).
 *   3a. Check what opened against what this device recorded last time, so a browser storage wipe
 *      cannot pass for a first run (issue #505 — see `db-presence.ts`).
 *   4. Request persistent storage and begin quota telemetry (§2, §7.6.1).
 *
 * StrictMode-safe: the boot runs a single time even though effects double-invoke
 * in development, and never sets state after a genuine unmount.
 */
import { useEffect, useRef, useState } from 'react';
import { checkCriticalSupport, checkIsolationSupport } from '@/lib/env/feature-detection';
import {
  diagnoseCriticalSupport,
  isolationIsSettled,
  isolationMayStillArrive,
  waitForServiceWorkerControl,
  ISOLATION_CONTROL_WAIT_MS,
  type SupportDiagnosis,
} from '@/lib/env/support-diagnosis';
import { isolationWaived } from '@/lib/env/isolation-waiver';
import { detectDbStorageLayout } from '@/db/db-storage';
import { acquireDatabaseTabLock, type TabLockDenial } from '@/db/tab-lock';
import { bootDatabase, countStoredItems, type DbBootResult } from '@/db/client';
import { DbError } from '@/db/errors';
import { storageWriteGate, useStorageStore } from '@/state/stores/useStorageStore';
import { setStorageWriteGate } from '@/features/storage/write-gate';
import { setStorageOutcomeObserver } from '@/features/storage/exhaustion';
import { labFlag } from '@/state/stores/useLabStore';
import {
  evaluateDbPresence,
  readDbPresence,
  recordKnownItemCount,
  writeDbPresence,
  type DbLossRecord,
} from '@/db/db-presence';

export type BootState =
  | { readonly status: 'starting' }
  | {
      readonly status: 'unsupported';
      readonly diagnosis: SupportDiagnosis;
      /**
       * The gate is out of ways to reach isolation on its own, so the user may choose to open
       * the database on the fallback VFS instead of waiting further (issue #260). False for
       * every other verdict, where continuing would not help — there is nothing to fall back
       * *to* without OPFS, and a blocked script or blocked site data is not the user's to waive.
       */
      readonly isolationWaivable: boolean;
    }
  | {
      readonly status: 'multi-tab';
      readonly reason: TabLockDenial;
      readonly whenReleased: Promise<void> | null;
    }
  /**
   * The database opened fine — because this boot *created* it, on a device that had one before
   * (issue #505). Carries the boot result alongside the loss, since the app underneath is
   * perfectly usable and the user is free to carry on into it once they have been told.
   */
  | { readonly status: 'data-lost'; readonly loss: DbLossRecord; readonly result: DbBootResult }
  | { readonly status: 'ready'; readonly result: DbBootResult }
  | { readonly status: 'error'; readonly error: DbError };

export function useDatabaseBoot(): BootState {
  const [state, setState] = useState<BootState>({ status: 'starting' });
  const startedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!startedRef.current) {
      startedRef.current = true;
      void runBoot(() => mountedRef.current, setState);
    }
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return state;
}

async function runBoot(isMounted: () => boolean, setState: (state: BootState) => void): Promise<void> {
  const commit = (next: BootState) => {
    if (isMounted()) setState(next);
  };

  // 1. Critical platform support. A failure here is usually *not* the browser's fault (a blocked
  // script, blocked site data, or the header-injecting worker still starting up on a first visit),
  // so work out which before the gate accuses it of anything — see support-diagnosis.ts. The probe
  // can wait on the service worker, so the user stays on <StartingScreen> until it has an answer
  // rather than seeing a verdict that changes a moment later.
  const support = checkCriticalSupport();
  if (!support.supported) {
    commit({
      status: 'unsupported',
      diagnosis: await diagnoseCriticalSupport(support.missing),
      isolationWaivable: false,
    });
    return;
  }

  // 1a. Cross-origin isolation is preferred, not required (issue #255): without it the worker
  // opens the database on the `opfs-sahpool` VFS instead of failing. So the gate proceeds for the
  // one diagnosis that means isolation is genuinely not coming — and only once that is *settled*
  // (`isolationIsSettled`), because the choice is effectively permanent: the fallback database
  // this boot would create is the one the origin must keep opening afterwards. Every other cause
  // still stops here.
  const isolation = checkIsolationSupport();
  if (!isolation.supported) {
    // What is already on disk answers this before any diagnosis can, so ask it first (#260).
    // The gate waits, and offers a way past the wait, only where the choice is still open:
    //
    //  - `sahpool` — this origin's database is already in the fallback store, and
    //    `detectDbStorageLayout` will keep opening it there. Nothing is left to decide, so
    //    waiting would be a delay that changes nothing.
    //  - `opfs` — the database is a plain OPFS file, which the fallback cannot reach at all:
    //    `openConnection` refuses rather than opening a second, empty one beside it. Waiting is
    //    still right, but "carry on without isolation" is an offer this gate could not keep, so
    //    it is never made — and a waiver left over from another screen is not honoured either.
    //  - `none` — nothing on disk, so the choice is genuinely open and genuinely permanent.
    const layout = await detectDbStorageLayout();
    if (!isMounted()) return;
    const choiceIsOpen = layout === 'none';

    if (layout !== 'sahpool' && !(choiceIsOpen && isolationWaived())) {
      let diagnosis = await diagnoseCriticalSupport(isolation.missing);

      // Watch the answer settle, rather than commit to the first reading (issue #260). The
      // un-settled causes — `isolation-pending`, and an `isolation-blocked` whose worker has
      // not reached `active` — both describe a boot still in motion, and a gate that answers
      // from either of them is answering a question that is still open. Nothing here can make
      // *this* document isolated, since only a fresh navigation can; the point of waiting is
      // that once a worker controls the page and isolation still has not arrived, the answer
      // is final and the fallback VFS is the right one to open.
      if (isolationMayStillArrive(diagnosis.cause, diagnosis.signals)) {
        commit({ status: 'unsupported', diagnosis, isolationWaivable: false });
        await waitForServiceWorkerControl(ISOLATION_CONTROL_WAIT_MS);
        if (!isMounted()) return;
        diagnosis = await diagnoseCriticalSupport(checkIsolationSupport().missing);
      }

      if (diagnosis.cause !== 'isolation-blocked' || !isolationIsSettled(diagnosis.signals)) {
        // One wait, then the decision goes to the user. A worker could still take control a
        // minute from now, so this is not a proof that it never will — it is the point past
        // which holding a spinner up costs more than it can win. Any other cause is a genuine
        // stop with its own guidance, and offering the fallback there would answer a question
        // the user did not ask.
        commit({
          status: 'unsupported',
          diagnosis,
          isolationWaivable: choiceIsOpen && isolationMayStillArrive(diagnosis.cause, diagnosis.signals),
        });
        return;
      }
    }
  }

  // Lab-only test seam (`schema-too-new`): present the "database is from a newer build"
  // screen without ever touching the tab lock or the real database, so nothing on disk is
  // read, migrated or reset.
  if (labFlag('schema-too-new')) {
    commit({
      status: 'error',
      error: new DbError(
        'SCHEMA_TOO_NEW',
        'The on-device database is at a newer schema than this build supports. ' +
          '(Forced by the lab’s "schema-too-new" flag — nothing on disk was changed.)',
      ),
    });
    return;
  }

  // 2. Single-tab guard — must precede opening the OPFS database. It fails closed, so this
  // also catches "we could not tell": the screen explains that and offers an override.
  const lock = await acquireDatabaseTabLock();
  if (!lock.acquired) {
    commit({ status: 'multi-tab', reason: lock.reason, whenReleased: lock.whenReleased });
    return;
  }

  // 3. Boot the database and migrate to the target schema.
  try {
    const result = await bootDatabase();

    // 3a. Was there a database here before this one? Read the marker *before* re-stamping it, and
    // stamp it either way: a device that has booted once is a device whose next disappearance is
    // detectable. `Date.now()`, never `nowMs()` — this is a record, not a judgement (lib/clock.ts).
    const presence = evaluateDbPresence(readDbPresence(), result.migration.from === 0, Date.now());
    writeDbPresence(presence.marker);

    // 4. Persistence + telemetry — non-blocking; the UI surfaces the outcome.
    const storage = useStorageStore.getState();
    void storage.requestPersistence();
    storage.startMonitoring();

    // Issue #200: arm the Hard Stop for the bulk write paths that build their own statements
    // and never pass through a repository (sync merge, snapshot restore, catalog import).
    // Registered rather than imported by those modules, because the Bridge shares them and has
    // neither a quota nor these stores — see `features/storage/write-gate.ts`.
    setStorageWriteGate(storageWriteGate);

    // Issue #504: let a write that *actually* ran out of space raise the tier, rather than leaving
    // the whole storage subsystem subordinate to an estimate the browser is entitled to pad. Same
    // registration reason as the gate above — the database driver and the raw OPFS image writes
    // that report into it must not reach into a store, and the Bridge has none.
    setStorageOutcomeObserver({
      onExhausted: () => useStorageStore.getState().reportExhaustion(),
      onWriteSucceeded: () => useStorageStore.getState().reportWriteSucceeded(),
    });

    // DEV-only test seam (stripped from production builds): the real-browser smoke
    // (§8.5.5) can force a storage tier to drive the §7.6 Triage Dashboard, which is
    // otherwise only reachable under genuine OPFS pressure.
    if (import.meta.env.DEV) {
      (window as unknown as { __storageStore?: typeof useStorageStore }).__storageStore = useStorageStore;
    }

    // Refresh the figure a *later* boot's loss notice would quote. Deliberately off the boot
    // path and best-effort: it is only ever read if the database subsequently disappears, so
    // nothing the user is waiting for should hang on a table scan, and a failure to count is
    // not a failure to start.
    void countStoredItems()
      .then(recordKnownItemCount)
      .catch((error: unknown) => {
        // Logged rather than swallowed silently: the only symptom otherwise is a loss notice,
        // months later, that cannot say how much was here.
        console.warn('[gubbins] could not record the item count for the data-loss notice', error);
      });

    if (presence.verdict.kind === 'lost') {
      commit({ status: 'data-lost', loss: presence.verdict.loss, result });
      return;
    }

    commit({ status: 'ready', result });
  } catch (error) {
    commit({ status: 'error', error: DbError.fromUnknown(error, 'INIT_FAILED') });
  }
}
