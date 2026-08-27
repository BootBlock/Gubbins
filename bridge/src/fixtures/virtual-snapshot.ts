/**
 * A test-only in-memory stand-in for the on-disk snapshot, modelling the **precondition** the real
 * {@link import('../snapshot-io.ts') snapshot IO} enforces (issue #549).
 *
 * A fake that simply reassigns a string would let a write publish over a file it never read — the
 * exact bug the precondition exists to stop — so every test using this seam would be asserting a
 * weaker contract than production has. This models the file as `{ text, stamp }` and refuses a
 * publish whose expected stamp has moved, so a test that stages a concurrent writer sees the same
 * `SnapshotConflictError` the filesystem would produce.
 */
import { SnapshotConflictError, type SnapshotStamp } from '../snapshot-io.ts';
import type { WriteIo } from '../write.ts';

export interface VirtualSnapshot {
  /** The `WriteIo` override to hand to `executeWrite` / `createWriteExecutor`. */
  readonly io: Partial<WriteIo>;
  /** The snapshot JSON currently "on disk". */
  read(): string;
  /** Replace the stored JSON out-of-band, as a writer outside this process would. */
  replace(text: string): void;
  /** How many publishes were refused because the stamp had moved. */
  conflicts(): number;
}

/** Build a {@link VirtualSnapshot} holding `initial`. Each replacement gets a fresh stamp. */
export function createVirtualSnapshot(initial: string): VirtualSnapshot {
  let text = initial;
  let version = 0;
  let conflicts = 0;

  const stamp = (): SnapshotStamp => ({ mtimeMs: version, size: text.length, ino: version });

  return {
    io: {
      readSnapshot: async () => ({ text, stamp: stamp() }),
      writeSnapshotAtomic: async (_path, next, expected) => {
        if (expected === null || expected.ino !== version) {
          conflicts += 1;
          throw new SnapshotConflictError('The inventory snapshot changed.');
        }
        text = next;
        version += 1;
      },
    },
    read: () => text,
    replace: (next) => {
      text = next;
      version += 1;
    },
    conflicts: () => conflicts,
  };
}
