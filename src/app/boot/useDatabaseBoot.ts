/**
 * The application boot state machine (Tier-3 ephemeral state, spec §2.1).
 *
 * Runs once on mount and drives the gate the user sees before the app is usable:
 *   1. Critical platform support (COOP/COEP + SharedArrayBuffer + OPFS — §2.2.6).
 *   2. Single-tab ownership via the Web Lock guard (§2.2.7).
 *   3. Open the OPFS database, verify FTS5, and run migrations (§2.2, §2.3).
 *   4. Request persistent storage and begin quota telemetry (§2, §7.6.1).
 *
 * StrictMode-safe: the boot runs a single time even though effects double-invoke
 * in development, and never sets state after a genuine unmount.
 */
import { useEffect, useRef, useState } from 'react';
import { checkCriticalSupport } from '@/lib/env/feature-detection';
import { acquireDatabaseTabLock } from '@/db/tab-lock';
import { bootDatabase, type DbBootResult } from '@/db/client';
import { DbError } from '@/db/errors';
import { useStorageStore } from '@/state/stores/useStorageStore';

export type BootState =
  | { readonly status: 'starting' }
  | { readonly status: 'unsupported'; readonly missing: readonly string[] }
  | { readonly status: 'multi-tab'; readonly whenReleased: Promise<void> }
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

async function runBoot(
  isMounted: () => boolean,
  setState: (state: BootState) => void,
): Promise<void> {
  const commit = (next: BootState) => {
    if (isMounted()) setState(next);
  };

  // 1. Critical platform support.
  const support = checkCriticalSupport();
  if (!support.supported) {
    commit({ status: 'unsupported', missing: support.missing });
    return;
  }

  // 2. Single-tab guard — must precede opening the OPFS database.
  const lock = await acquireDatabaseTabLock();
  if (!lock.acquired) {
    commit({ status: 'multi-tab', whenReleased: lock.whenReleased });
    return;
  }

  // 3. Boot the database and migrate to the target schema.
  try {
    const result = await bootDatabase();

    // 4. Persistence + telemetry — non-blocking; the UI surfaces the outcome.
    const storage = useStorageStore.getState();
    void storage.requestPersistence();
    storage.startMonitoring();

    commit({ status: 'ready', result });
  } catch (error) {
    commit({ status: 'error', error: DbError.fromUnknown(error, 'INIT_FAILED') });
  }
}
