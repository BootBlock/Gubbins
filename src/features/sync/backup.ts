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
import type {
  GaugeHistoryDelta,
  ItemRegionEdge,
  ItemTagEdge,
  LocationTagEdge,
  SyncSnapshot,
  Tombstone,
} from './types';
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

/** The plain-format rejection every non-security envelope check shares. */
function malformed(): Error {
  return new Error('This backup file is not in the expected format.');
}

/** A JSON value that can be bound as a SQL parameter. Objects and arrays cannot. */
function isBindable(value: unknown): boolean {
  return (
    value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  );
}

/**
 * The largest instant `Date` can represent (±100 000 000 days from the epoch).
 *
 * Past it, `new Date(n)` is an Invalid Date and `toISOString()` throws a `RangeError` — which the
 * bridge does when it reports a snapshot's age (`bridge/src/cli.ts`, the `/api/v1` responses). A
 * value like `1e308` is perfectly ordinary JSON and finite, so `typeof … === 'number'` waves it
 * through; only the range check catches it.
 */
const MAX_TIMESTAMP = 8.64e15;

/** A number that is safe both to compare and to hand to `new Date(…)`. */
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIMESTAMP;
}

/**
 * The shape every optional array section shares: absent means empty, anything that is not an
 * array of non-null objects is malformed, and `check` applies the section's own field rules.
 *
 * Absent-means-empty is deliberate and load-bearing — older backups predate `gaugeHistory`,
 * `itemTags`, `locationTags`, `itemRegions` and `itemHistory` entirely, and must still restore.
 */
function validateObjectArray(
  value: unknown,
  check: (entry: Record<string, unknown>) => boolean,
): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw malformed();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) throw malformed();
    if (!check(entry as Record<string, unknown>)) throw malformed();
  }
  return value;
}

/**
 * Check that a value is an array of plain row objects whose values are all bindable.
 *
 * Not a security boundary — table names come from the fixed {@link SYNC_TABLES} list and row
 * values are always bound as parameters, never interpolated. It is purely so a malformed file
 * fails with the same plain "not in the expected format" message as the rest of the envelope,
 * rather than throwing a raw `Cannot use 'in' operator` from deep inside statement construction
 * (iterating a string section yields characters, and testing `'id' in 'x'` is a TypeError), or a
 * driver-level bind error part-way through the restore transaction because a row value was an
 * object. The transaction rolls back either way, so this changes the *message*, not the outcome —
 * but "not in the expected format" is a message the user can act on and the raw ones are not.
 *
 * Column *types* are deliberately not checked here: the declared type of each column lives in the
 * live schema, which this pure parser has no access to. A value of the wrong type for its STRICT
 * column is still rejected at bind time, inside the transaction, and rolls back cleanly.
 */
function validateRows(value: unknown): readonly SqlRow[] {
  return validateObjectArray(
    value,
    (row) => !Array.isArray(row) && Object.values(row).every(isBindable),
  ) as readonly SqlRow[];
}

/**
 * Check that each table section is an array of row objects (see {@link validateRows}).
 *
 * A section that is present but `null` is rejected rather than read as empty: `tables` is a map of
 * real sections, so unlike the optional top-level sections there is no "this build predates it"
 * case for a null one to mean. It is simply a malformed file.
 */
function validateTables(value: unknown): Record<string, SqlRow[]> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw malformed();
  for (const rows of Object.values(value)) {
    if (rows === null || rows === undefined) throw malformed();
    validateRows(rows);
  }
  return value as Record<string, SqlRow[]>;
}

/**
 * Check a membership-edge section: an array of objects whose `fields` are all strings.
 *
 * The `item_tags` / `location_tags` / `item_regions` sections are destructured
 * (`for (const { itemId, tagId } of …)`) and their fields bound as the composite primary key of
 * an `INSERT OR IGNORE`. A non-array throws a raw TypeError before any statement runs; a
 * non-string field is a bind error mid-transaction. Both become the plain message instead.
 */
function validateEdges<T>(value: unknown, fields: readonly string[]): readonly T[] {
  return validateObjectArray(value, (edge) =>
    fields.every((field) => typeof edge[field] === 'string'),
  ) as readonly T[];
}

/**
 * Check the §7.3 Delta-CRDT gauge deltas.
 *
 * `netValueDelta` and `createdAt` are checked for the same reason a tombstone's `deletedAt` is
 * (see {@link validateTombstones}): they are not merely stored but *arithmetic* — the deltas are
 * summed to replay a gauge's net value, and ordered by `createdAt`. A string would concatenate
 * rather than add and a non-finite value would poison the sum, so a bad one silently corrupts a
 * gauge reading instead of failing loudly.
 */
function validateGaugeHistory(value: unknown): readonly GaugeHistoryDelta[] {
  return validateObjectArray(value, (delta) => {
    const { id, itemId, netValueDelta, createdAt } = delta as Partial<GaugeHistoryDelta>;
    return (
      typeof id === 'string' &&
      typeof itemId === 'string' &&
      Number.isFinite(netValueDelta) &&
      isTimestamp(createdAt)
    );
  }) as readonly GaugeHistoryDelta[];
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
 *
 * **Every** section is checked, not just the envelope's version: the sections are otherwise
 * asserted into the structured `SyncSnapshot` types straight from `JSON.parse`, and this is not
 * a local-file-only path — a snapshot downloaded from a shared sync folder arrives here too.
 * Downstream code iterates and destructures each section and binds its values as SQL parameters,
 * so an unchecked one surfaces as a raw `TypeError` or driver bind error rather than something a
 * user can act on.
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
    // Fall back rather than reject: an unreadable stamp is cosmetic (it dates the snapshot), so
    // it is not worth refusing an otherwise-restorable backup over. It must still be a *usable*
    // instant though — see {@link isTimestamp}.
    generatedAt: isTimestamp(obj.generatedAt) ? obj.generatedAt : Date.now(),
    tables: validateTables(obj.tables),
    tombstones: validateTombstones(obj.tombstones),
    gaugeHistory: validateGaugeHistory(obj.gaugeHistory),
    // Phase 11 sync-set expansion: older backups predate these, so default to empty.
    itemTags: validateEdges<ItemTagEdge>(obj.itemTags, ['itemId', 'tagId']),
    // Issue #84: location tagging — older backups predate this, so default to empty.
    locationTags: validateEdges<LocationTagEdge>(obj.locationTags, ['locationId', 'tagId']),
    // Issue #81: item-to-region placements — older backups predate this, so default to empty.
    itemRegions: validateEdges<ItemRegionEdge>(obj.itemRegions, ['itemId', 'regionId']),
    itemHistory: validateRows(obj.itemHistory),
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
