/**
 * The provider-agnostic Cloud Sync contract (spec §1.2, §2 "Initial Handshake", §7).
 *
 * Per the §1.2 locked decision, Gubbins commits to **no** concrete cloud SDK. The
 * sync engine and the Initial-Handshake wizard depend only on this strict interface;
 * concrete adapters (an in-memory test double, a File System Access "sync folder")
 * implement it, and a real cloud provider can be added later behind the same shape
 * without touching the engine.
 */
import type { SyncSnapshot } from './types';

export interface CloudProvider {
  /** Stable adapter id, e.g. `'memory'` or `'file-system'`. */
  readonly id: string;
  /** Human-readable label for the handshake wizard (British English). */
  readonly label: string;

  /**
   * Authoritative server time as UNIX-ms for the §7.3 clock-offset guard — typically
   * read from the transport's response `Date` header. Returns `null` when the adapter
   * has no server clock (e.g. a local File System folder), in which case the engine
   * trusts the local clock unchanged (offset 0).
   */
  getServerTime(): Promise<number | null>;

  /** Download the remote snapshot, or `null` when the remote has none yet. */
  fetchSnapshot(): Promise<SyncSnapshot | null>;

  /** Upload the merged snapshot, replacing the remote state (§7.3 step 4). */
  pushSnapshot(snapshot: SyncSnapshot): Promise<void>;
}
