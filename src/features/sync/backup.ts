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
import { isTombstoneTable } from '@/db/repositories';
import type { IDatabaseDriver, SqlRow } from '@/db/rpc/driver';
import { JSON_EXPORT_KIND } from '@/lib/json-export-kind';
import { buildLocalSnapshot, restoreSnapshot } from './snapshot';
import type { SyncSnapshot, Tombstone } from './types';
import { SYNC_FORMAT_VERSION } from './types';

/**
 * Validate the tombstone list of an incoming snapshot (**security boundary**).
 *
 * A tombstone's `tableName` is interpolated into `DELETE FROM <table>` downstream — SQLite
 * cannot parameterise an identifier — so an unchecked name from parsed JSON is arbitrary SQL
 * against the user's database. Every route a foreign snapshot can take into Gubbins funnels
 * through {@link parseBackupJson}: an imported backup file, a peer's snapshot picked up from a
 * shared sync folder, and a bridge push. Checking here covers all three.
 *
 * A bad name rejects the **whole** snapshot rather than skipping the row. A snapshot naming a
 * table that does not exist did not come from Gubbins, and applying the remainder of it would
 * carry out the rest of a hostile payload and then report a successful restore.
 */
function validateTombstones(value: unknown): readonly Tombstone[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('This backup file is not in the expected format.');
  }
  for (const tombstone of value) {
    if (typeof tombstone !== 'object' || tombstone === null) {
      throw new Error('This backup file is not in the expected format.');
    }
    const { tableName, id, deletedAt } = tombstone as Partial<Tombstone>;
    // `deletedAt` is checked alongside the other two because it is not merely stored: it is the
    // Last-Write-Wins clock a deletion is resolved on, and it is *arithmetic* (`deletedAt + delta`
    // when shifting to the server's time frame). A string would concatenate rather than add and a
    // non-finite value would lose every comparison, so a bad one silently corrupts merge outcomes
    // instead of failing loudly.
    if (!isTombstoneTable(tableName) || typeof id !== 'string' || !Number.isFinite(deletedAt)) {
      throw new Error(
        'This backup file refers to data that is not part of Gubbins, so it has not been restored. ' +
          'Only open backups from a source you trust.',
      );
    }
  }
  return value as readonly Tombstone[];
}

/**
 * Check that each table section is an array of row objects.
 *
 * Not a security boundary — table names come from the fixed {@link SYNC_TABLES} list and row
 * values are always bound as parameters. It is purely so a malformed file fails with the same
 * plain "not in the expected format" message as the rest of the envelope, rather than throwing a
 * raw `Cannot use 'in' operator` from deep inside statement construction: iterating a string
 * section yields characters, and testing `'id' in 'x'` is a TypeError.
 */
function validateTables(value: unknown): Record<string, SqlRow[]> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('This backup file is not in the expected format.');
  }
  for (const rows of Object.values(value)) {
    if (!Array.isArray(rows) || rows.some((row) => typeof row !== 'object' || row === null)) {
      throw new Error('This backup file is not in the expected format.');
    }
  }
  return value as Record<string, SqlRow[]>;
}

/** Serialise a snapshot to the canonical, human-diffable backup JSON. */
export function snapshotToBackupJson(snapshot: SyncSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Parse & validate a backup/sync JSON document into a {@link SyncSnapshot}. Throws on
 * a malformed envelope, a future format version this build cannot read (§2 schema
 * mismatch guard), or a tombstone naming a table Gubbins does not have
 * (see {@link validateTombstones} — this is the trust boundary for foreign snapshots).
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
  const obj = parsed as Partial<SyncSnapshot> & {
    readonly kind?: unknown;
    readonly items?: unknown;
  };
  // A JSON *data export* from the export wizard is a read-only extract, not a snapshot, but it
  // would otherwise satisfy every check below: it carries a `formatVersion` and simply has no
  // `tables`, so it parses as a valid *empty* snapshot and imports nothing while reporting
  // success. Name the file for what it is instead.
  //
  // Files exported before the `kind` marker existed (issue #153) carry no marker at all, so the
  // shape is checked too: a top-level `items` array with no `tables` section is the data
  // export's signature. A genuinely empty database still backs up with a `tables` object
  // present, so this does not reject a real snapshot.
  const looksLikeDataExport =
    obj.kind === JSON_EXPORT_KIND || (obj.tables === undefined && Array.isArray(obj.items));
  if (looksLikeDataExport) {
    throw new Error(
      'This is a JSON data export, not a backup, so it cannot be restored. ' +
        'Restore from a backup .zip made by Backup & restore.',
    );
  }
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
    tables: validateTables(obj.tables),
    tombstones: validateTombstones(obj.tombstones),
    gaugeHistory: obj.gaugeHistory ?? [],
    // Phase 11 sync-set expansion: older backups predate these, so default to empty.
    itemTags: obj.itemTags ?? [],
    // Issue #84: location tagging — older backups predate this, so default to empty.
    locationTags: obj.locationTags ?? [],
    // Issue #81: item-to-region placements — older backups predate this, so default to empty.
    itemRegions: obj.itemRegions ?? [],
    itemHistory: obj.itemHistory ?? [],
  };
}

/**
 * Build the full versioned-JSON backup string for the current database (§2).
 *
 * @internal Exported for unit tests only.
 */
export async function buildBackupJson(driver: IDatabaseDriver): Promise<string> {
  return snapshotToBackupJson(await buildLocalSnapshot(driver));
}

/**
 * Restore the database from a backup JSON string (§2). **Destructive** — replaces all
 * syncable data. The caller must confirm with the user first.
 *
 * @internal Exported for unit tests only.
 */
export async function restoreFromBackupJson(driver: IDatabaseDriver, text: string): Promise<SyncSnapshot> {
  const snapshot = parseBackupJson(text);
  await restoreSnapshot(driver, snapshot);
  return snapshot;
}
