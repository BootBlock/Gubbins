/**
 * The application boot state machine (Tier-3 ephemeral state, spec §2.1).
 *
 * Runs once on mount and drives the gate the user sees before the app is usable:
 *   1. Critical platform support (OPFS — §2.2.6), plus the cross-origin isolation that decides
 *      which VFS the database opens on (issue #255).
 *   2. Single-tab ownership via the Web Lock guard (§2.2.7).
 *   3. Open the OPFS database, verify FTS5, and run migrations (§2.2, §2.3).
 *   4. Request persistent storage and begin quota telemetry (§2, §7.6.1).
 *
 * StrictMode-safe: the boot runs a single time even though effects double-invoke
 * in development, and never sets state after a genuine unmount.
 */
import { useEffect, useRef, useState } from 'react';
import { checkCriticalSupport, checkIsolationSupport } from '@/lib/env/feature-detection';
import { diagnoseCriticalSupport, type SupportDiagnosis } from '@/lib/env/support-diagnosis';
import { acquireDatabaseTabLock, type TabLockDenial } from '@/db/tab-lock';
import { bootDatabase, type DbBootResult } from '@/db/client';
import { DbError } from '@/db/errors';
import { storageWriteGate, useStorageStore } from '@/state/stores/useStorageStore';
import { setStorageWriteGate } from '@/features/storage/write-gate';
import { labFlag } from '@/state/stores/useLabStore';

export type BootState =
  | { readonly status: 'starting' }
  | { readonly status: 'unsupported'; readonly diagnosis: SupportDiagnosis }
  | {
      readonly status: 'multi-tab';
      readonly reason: TabLockDenial;
      readonly whenReleased: Promise<void> | null;
    }
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
    commit({ status: 'unsupported', diagnosis: await diagnoseCriticalSupport(support.missing) });
    return;
  }

  // 1a. Cross-origin isolation is preferred, not required (issue #255): without it the worker
  // opens the database on the `opfs-sahpool` VFS instead of failing. So the gate only stops for
  // the causes that would defeat *any* VFS — and for `isolation-pending`, which is not a failure
  // at all but the normal first visit, waiting on the service worker that supplies the COOP/COEP
  // headers. Booting through that wait would settle this origin on the fallback VFS for good,
  // since the database it created is then the one that must keep being opened.
  const isolation = checkIsolationSupport();
  if (!isolation.supported) {
    const diagnosis = await diagnoseCriticalSupport(isolation.missing);
    if (diagnosis.cause !== 'isolation-blocked') {
      commit({ status: 'unsupported', diagnosis });
      return;
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

    // 4. Persistence + telemetry — non-blocking; the UI surfaces the outcome.
    const storage = useStorageStore.getState();
    void storage.requestPersistence();
    storage.startMonitoring();

    // Issue #200: arm the Hard Stop for the bulk write paths that build their own statements
    // and never pass through a repository (sync merge, snapshot restore, catalog import).
    // Registered rather than imported by those modules, because the Bridge shares them and has
    // neither a quota nor these stores — see `features/storage/write-gate.ts`.
    setStorageWriteGate(storageWriteGate);

    // DEV-only test seam (stripped from production builds): the real-browser smoke
    // (§8.5.5) can force a storage tier to drive the §7.6 Triage Dashboard, which is
    // otherwise only reachable under genuine OPFS pressure.
    if (import.meta.env.DEV) {
      (window as unknown as { __storageStore?: typeof useStorageStore }).__storageStore = useStorageStore;
    }

    commit({ status: 'ready', result });
  } catch (error) {
    commit({ status: 'error', error: DbError.fromUnknown(error, 'INIT_FAILED') });
  }
}
