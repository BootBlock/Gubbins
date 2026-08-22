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
 *
 * Permission: the statements go straight to the driver, so the repository guard never sees them
 * — {@link eraseTargets} asserts each selected target's own keys first, for the whole selection,
 * before a single statement runs (issue #519).
 */
import type { IDatabaseDriver, SqlStatement } from '@/db/rpc/driver';
import { getDatabaseDriver } from '@/db/client';
import { removeImagesDirectory } from '@/features/images/opfs-images';
import { PREFERENCES_KEY } from '@/features/backup/settings-groups';
import { assertPermissions } from '@/features/users/assert-permission';
import { currentAuthority } from '@/features/users/current-authority';
import { can, type Authority } from '@/features/users/permissions';
import { parsePersistedBlob, serialisePersistedBlob } from '@/lib/persisted-state';
import {
  ERASE_EVERYTHING_PERMISSIONS,
  ERASE_TARGETS,
  eraseTargetById,
  eraseTargetPermissions,
  type EraseTargetId,
} from './erase-targets';

/**
 * Whether a preference field currently holds something the user actually set, for the count badge
 * and nothing else. A field is "set" when it is present and is not an empty string — which is the
 * "never configured" state for every field a target names this way (issue #521).
 */
function prefFieldSet(state: Readonly<Record<string, unknown>>, field: string): boolean {
  const value = state[field];
  if (value === undefined || value === null) return false;
  return typeof value === 'string' ? value.trim() !== '' : true;
}

/**
 * Drop the named fields from the persisted preferences blob, keeping every other preference and
 * the blob's own version envelope. A blob that is missing or unparseable is left alone: there is
 * nothing to strip, and rewriting it from a guess would lose preferences this erase never claimed.
 *
 * This clears **storage** only. The live Zustand store still holds the value and would write it
 * straight back, so the caller resets the store too — the same division as {@link resetLocalStores}
 * after a whole-key removal (issue #381).
 */
function stripPreferenceFields(local: Storage, fields: readonly string[]): void {
  const raw = local.getItem(PREFERENCES_KEY);
  if (raw === null) return;
  const blob = parsePersistedBlob(raw);
  if (!blob) return;
  const state = { ...blob.state };
  for (const field of fields) delete state[field];
  local.setItem(PREFERENCES_KEY, serialisePersistedBlob(blob, state));
}

/** The side-effecting capabilities the executor needs, injected for testability. */
export interface ErasePorts {
  readonly db: IDatabaseDriver;
  /** Remove the whole OPFS `images/` directory (full photo wipe). */
  readonly removeImagesDirectory: () => Promise<void>;
  /** localStorage (or a fake) for clearing local-scope keys. */
  readonly local: Storage;
  /** Delete an IndexedDB database by name, resolving even if it was blocked/missing. */
  readonly deleteIdb: (name: string) => Promise<void>;
  /**
   * What the current session may do (issue #519). Read per call rather than captured, so an
   * authority that changes between opening the dialog and confirming is the one that applies.
   *
   * Required, not optional: an optional port would default to *something*, and the only honest
   * default — unrestricted — would leave the guard doing nothing at all in production. Note this
   * bounds the port, not the value: the session store's own default is unrestricted until
   * `refreshAuthority` resolves, exactly as the repository guards see it.
   */
  readonly authority: () => Authority;
}

/** What was erased, for the UI to report and to drive its own invalidation. */
export interface EraseSummary {
  readonly erased: readonly EraseTargetId[];
}

/**
 * Whether `authority` may erase `id` — the question the dialog asks of every checkbox, and the
 * one {@link assertMayErase} enforces. An id this build does not know is **not** erasable: the
 * executor skips it silently, and answering "yes" for something nothing can describe would put
 * an unexplained row in the list.
 */
export function mayEraseTarget(authority: Authority, id: EraseTargetId): boolean {
  if (!eraseTargetById(id)) return false;
  return eraseTargetPermissions(id).every((key) => can(authority, key));
}

/**
 * Refuse the whole selection unless `authority` holds every permission each target names
 * (issue #519).
 *
 * This is the boundary for the Danger Zone, not the dialog's disabled checkboxes: the erase
 * builds its own SQL and hands it to the driver, so `BaseRepository.assertPermission` — which
 * refuses this same session a single item — never sees it. Unknown ids are ignored here exactly
 * as {@link eraseTargets} ignores them, so a target from a newer peer neither erases anything
 * nor blocks the ids beside it.
 */
export function assertMayErase(authority: Authority, ids: readonly EraseTargetId[]): void {
  for (const id of ids) {
    if (eraseTargetById(id)) assertPermissions(authority, eraseTargetPermissions(id));
  }
}

/**
 * Refuse the factory reset unless `authority` holds every permission the catalog names
 * (issue #519).
 *
 * `hardResetLocalData` itself stays ungated on purpose: it is also the rescue screen's last
 * resort, and on the boot-failure route there is no readable database to resolve an authority
 * from, so gating it there would turn an unbootable device into a bricked one. The check
 * therefore sits at the one call site that is always inside a working app — the Danger Zone.
 * That leaves the rescue screen as a way round it for anyone who can reach Safe Mode, which is
 * the documented shape of this boundary rather than a gap in it (`db/repositories/base.ts`).
 */
export function assertMayEraseEverything(authority: Authority): void {
  assertPermissions(authority, ERASE_EVERYTHING_PERMISSIONS);
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
      let n = keys.reduce((total, key) => (ports.local.getItem(key) !== null ? total + 1 : total), 0);
      const prefFields = target.prefFields ?? [];
      if (prefFields.length > 0) {
        const raw = ports.local.getItem(PREFERENCES_KEY);
        const state = raw === null ? null : parsePersistedBlob(raw)?.state;
        if (state) n += prefFields.filter((field) => prefFieldSet(state, field)).length;
      }
      counts[id] = n;
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
  // Before anything else, and for the whole selection: a run that would be refused halfway
  // through must not have removed the first half already.
  assertMayErase(ports.authority(), ids);

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
  const targets = ids
    .map((id) => eraseTargetById(id))
    .filter((t): t is NonNullable<typeof t> => t !== undefined);

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
    if (target.prefFields && target.prefFields.length > 0) {
      stripPreferenceFields(ports.local, target.prefFields);
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
    authority: currentAuthority,
    deleteIdb: (name) =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      }),
  };
}
