/**
 * The live sync runtime (spec §1.2, §7, Phase 7).
 *
 * Holds the *connected* {@link CloudProvider} instance for the session. It is kept
 * out of the persisted `useAuthStore` because a provider can own non-serialisable
 * handles (a File System Access directory handle) that cannot survive a reload. The
 * production sync driver is the OPFS worker driver — the same singleton the
 * repositories use — so the engine writes through the one queued connection (§2.2.4).
 */
import { getDatabaseDriver } from '@/db/client';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { CloudProvider } from './provider';

let activeProvider: CloudProvider | null = null;

export function setActiveProvider(provider: CloudProvider | null): void {
  activeProvider = provider;
}

export function getActiveProvider(): CloudProvider | null {
  return activeProvider;
}

/** The driver the sync engine writes through (the shared OPFS worker driver). */
export function getSyncDriver(): IDatabaseDriver {
  return getDatabaseDriver();
}
