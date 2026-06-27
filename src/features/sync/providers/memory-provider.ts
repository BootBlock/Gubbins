/**
 * In-memory CloudProvider adapter (spec §8.5, Phase 7).
 *
 * Holds a single snapshot in memory — the simplest concrete {@link CloudProvider}.
 * It backs the unit tests and the §8.5.5 real-browser round-trip smoke (a second
 * "device" syncing against the same store), and stands in for a real cloud transport
 * without adding any SDK. `getServerTime` returns an injectable clock so the §7.3
 * offset path is testable.
 */
import type { CloudProvider } from '../provider';
import type { SyncSnapshot } from '../types';

export interface MemoryProviderOptions {
  /** Seeded remote snapshot, or null for an empty remote. */
  readonly initial?: SyncSnapshot | null;
  /** Server clock for the §7.3 offset guard (defaults to the real clock). */
  readonly clock?: () => number;
}

export class MemoryCloudProvider implements CloudProvider {
  readonly id = 'memory';
  readonly label = 'In-memory (test) provider';
  private snapshot: SyncSnapshot | null;
  private readonly clock: () => number;

  constructor(options: MemoryProviderOptions = {}) {
    this.snapshot = options.initial ?? null;
    this.clock = options.clock ?? (() => Date.now());
  }

  async getServerTime(): Promise<number | null> {
    return this.clock();
  }

  async fetchSnapshot(): Promise<SyncSnapshot | null> {
    return this.snapshot;
  }

  async pushSnapshot(snapshot: SyncSnapshot): Promise<void> {
    this.snapshot = snapshot;
  }

  /** Test/inspection helper: the current remote snapshot. */
  peek(): SyncSnapshot | null {
    return this.snapshot;
  }
}
