/**
 * "Erase my data" (Danger Zone) executor & browser ports (spec §3 Settings).
 *
 * Turns a selection of {@link EraseTargetId}s into real erasure. Two concerns are separated:
 *
 *  - **Pure orchestration** ({@link eraseTargets}, {@link countTargets}) takes its side-effecting
 *    capabilities as an injected {@link ErasePorts} bag, so the whole engine is driven in unit
 *    tests by the in-memory SQLite driver plus trivial fakes — no browser, no OPFS, no IndexedDB.
 *  - **Real wiring** ({@link browserErasePorts}) binds those ports to the production worker driver,
 *    OPFS, `localStorage` and `indexedDB` exactly once, for the UI to pass in.
 *
 * The executor's job ends at the data layer: it runs the DB transaction and the post-commit
 * file/local cleanup, then returns. It deliberately does NOT touch React Query, Zustand stores,
 * or reload the page — that orchestration belongs to the UI, which knows what to invalidate.
 *
 * Atomicity: every selected DB target's statements are concatenated (in {@link ERASE_TARGETS}
 * order, for determinism) behind a single `PRAGMA defer_foreign_keys = ON;` and run through one
 * `driver.transaction(...)`. Deferring FK enforcement to commit lets the `items` self-reference
 * and the cross-table cascade/unlink deletes resolve regardless of statement order. The
 * non-transactional cleanup (OPFS dir, IndexedDB, localStorage) runs only *after* the DB commit
 * succeeds, so a rolled-back transaction never leaves orphaned files behind.
 */
import type { IDatabaseDriver, SqlStatement } from '@/db/rpc/driver';
import { getDatabaseDriver } from '@/db/client';
import { removeImagesDirectory } from '@/features/images/opfs-images';
import { ERASE_TARGETS, eraseTargetById, type EraseTargetId } from './erase-targets';

/** The side-effecting capabilities the executor needs, injected for testability. */
export interface ErasePorts {
  readonly db: IDatabaseDriver;
  /** Remove the whole OPFS `images/` directory (full photo wipe). */
  readonly removeImagesDirectory: () => Promise<void>;
  /** localStorage (or a fake) for clearing local-scope keys. */
  readonly local: Storage;
  /** Delete an IndexedDB database by name, resolving even if it was blocked/missing. */
  readonly deleteIdb: (name: string) => Promise<void>;
}

/** What was erased, for the UI to report and to drive its own invalidation. */
export interface EraseSummary {
  readonly erased: readonly EraseTargetId[];
}

/**
 * Count how many rows (or present local keys) each selected target would affect, for the
 * UI's confirmation badges. Keyed by {@link EraseTargetId}. A DB target runs its `countSql`;
 * a local target reports how many of its `localKeys` are currently present.
 */
export async function countTargets(
  ids: readonly EraseTargetId[],
  ports: Pick<ErasePorts, 'db' | 'local'>,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const id of ids) {
    const target = eraseTargetById(id);
    if (!target) continue;
    if (target.countSql) {
      const row = await ports.db.queryOne<{ n: number }>(target.countSql);
      counts[id] = Number(row?.n ?? 0);
    } else {
      const keys = target.localKeys ?? [];
      counts[id] = keys.reduce((n, key) => (ports.local.getItem(key) !== null ? n + 1 : n), 0);
    }
  }
  return counts;
}

/**
 * Erase the selected targets. Runs all DB statements atomically (deferred-FK), then the
 * post-commit OPFS/IndexedDB/localStorage cleanup. Returns the list erased; does NOT reload
 * or invalidate caches (the UI owns that).
 */
export async function eraseTargets(
  ids: readonly EraseTargetId[],
  opts: { tombstone: boolean; now?: number },
  ports: ErasePorts,
): Promise<EraseSummary> {
  const now = opts.now ?? Date.now();
  const selected = new Set(ids);

  // 1. Collect DB statements in catalog order so a combined erase is deterministic and a
  //    parent deletion always precedes its dependants.
  const dbStatements: SqlStatement[] = [];
  for (const target of ERASE_TARGETS) {
    if (!selected.has(target.id) || !target.buildStatements) continue;
    dbStatements.push(...target.buildStatements({ tombstone: opts.tombstone, now }));
  }

  // 2. Run the whole batch atomically behind the deferred-FK pragma. Skip the transaction
  //    entirely when nothing DB-bound was selected (a purely-local erase).
  if (dbStatements.length > 0) {
    await ports.db.transaction([{ sql: 'PRAGMA defer_foreign_keys = ON;' }, ...dbStatements]);
  }

  // 3. Post-commit, non-transactional cleanup — only after the DB write has durably landed.
  const targets = ids.map((id) => eraseTargetById(id)).filter((t): t is NonNullable<typeof t> => t !== undefined);

  // Remove the OPFS images directory once if any selected target clears it.
  if (targets.some((target) => target.clearsImages)) {
    await ports.removeImagesDirectory();
  }

  for (const target of targets) {
    for (const dbName of target.clearsIdb ?? []) {
      await ports.deleteIdb(dbName);
    }
    for (const key of target.localKeys ?? []) {
      ports.local.removeItem(key);
    }
  }

  return { erased: ids };
}

/**
 * Wire the real browser capabilities for production use: the worker DB driver, the OPFS image
 * directory remover, `localStorage`, and an `indexedDB.deleteDatabase` wrapper that resolves on
 * any outcome (success, error, or blocked) so a held-open connection can never hang the erase.
 */
export function browserErasePorts(): ErasePorts {
  return {
    db: getDatabaseDriver(),
    removeImagesDirectory: () => removeImagesDirectory(),
    local: localStorage,
    deleteIdb: (name) =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      }),
  };
}
