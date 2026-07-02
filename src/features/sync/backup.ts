/**
 * Versioned-JSON backup & restore (spec §2 "Versioned JSON File", §3 Export Wizard).
 *
 * A full backup is the {@link SyncSnapshot} serialised to JSON — by design it
 * *mirrors the LWW sync payload* (§2), so the same document round-trips through both
 * the cloud provider and a manual Export/Import. Restoring replaces the local
 * database wholesale (§2 "prevent catastrophic schema mismatches"): the payload is
 * sanitised against the live schema on the way in, so a backup from an older build
 * still imports cleanly. {@link parseBackupJson} validates the envelope and refuses a
 * version it cannot read.
 */
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { buildLocalSnapshot, restoreSnapshot } from './snapshot';
import type { SyncSnapshot } from './types';
import { SYNC_FORMAT_VERSION } from './types';

/** Serialise a snapshot to the canonical, human-diffable backup JSON. */
export function snapshotToBackupJson(snapshot: SyncSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Parse & validate a backup/sync JSON document into a {@link SyncSnapshot}. Throws on
 * a malformed envelope or a future format version this build cannot read (§2 schema
 * mismatch guard).
 */
export function parseBackupJson(text: string): SyncSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('This backup file is not in the expected format.');
  }
  const obj = parsed as Partial<SyncSnapshot>;
  if (typeof obj.formatVersion !== 'number') {
    throw new Error('This backup file is missing its format version.');
  }
  if (obj.formatVersion > SYNC_FORMAT_VERSION) {
    throw new Error(
      `This backup was made by a newer version of Gubbins (format ${obj.formatVersion}). Update before importing.`,
    );
  }
  return {
    formatVersion: obj.formatVersion,
    generatedAt: typeof obj.generatedAt === 'number' ? obj.generatedAt : Date.now(),
    tables: obj.tables ?? {},
    tombstones: obj.tombstones ?? [],
    gaugeHistory: obj.gaugeHistory ?? [],
    // Phase 11 sync-set expansion: older backups predate these, so default to empty.
    itemTags: obj.itemTags ?? [],
    itemHistory: obj.itemHistory ?? [],
  };
}

/** Build the full versioned-JSON backup string for the current database (§2). */
export async function buildBackupJson(driver: IDatabaseDriver): Promise<string> {
  return snapshotToBackupJson(await buildLocalSnapshot(driver));
}

/**
 * Restore the database from a backup JSON string (§2). **Destructive** — replaces all
 * syncable data. The caller must confirm with the user first.
 */
export async function restoreFromBackupJson(driver: IDatabaseDriver, text: string): Promise<SyncSnapshot> {
  const snapshot = parseBackupJson(text);
  await restoreSnapshot(driver, snapshot);
  return snapshot;
}
