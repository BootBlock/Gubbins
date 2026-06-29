/**
 * Full-backup format — the pure codec for the "Backup & Restore" feature.
 *
 * A complete backup is a single `.zip` (built/read here as a pure `path → bytes` map, so
 * the whole format is unit-tested without the DOM, OPFS, or a worker):
 *
 *   gubbins-backup-<stamp>.zip
 *   ├── manifest.json   — what's inside (app version, created-at, contents, counts)
 *   ├── backup.json     — the portable, version-guarded {@link SyncSnapshot} (always present;
 *   │                     the importable artifact, shaped by the history/removed-items toggles)
 *   ├── database/gubbins.sqlite3   — an exact byte copy of the DB (optional; complete & unfiltered)
 *   ├── images/<uuid>.webp …       — full-resolution OPFS image files (optional)
 *   └── settings.json   — device-local preferences (optional; secrets scrubbed)
 *
 * The browser glue ({@link import('./build-backup')} / {@link import('./restore-backup')})
 * gathers the raw pieces (snapshot, sqlite bytes, OPFS images, settings) and the worker
 * zips/unzips; everything *decided* about the format lives here.
 */
import { unzipSync, strFromU8, strToU8 } from 'fflate';
import { parseBackupJson } from '../sync/backup';
import type { SyncSnapshot } from '../sync/types';
import type { SqlRow, SqlValue } from '@/db/rpc/driver';
import type { OpfsImageFile } from '@/features/images/opfs-images';
import { EXPORTABLE_SETTING_KEYS, sanitiseSettingsRecord } from './backup-settings';

/** Bump when the *container* layout changes incompatibly (independent of the snapshot's own version). */
export const BACKUP_FORMAT_VERSION = 1;

/** Zip entry paths — the single source of truth shared by the builder and the reader. */
export const MANIFEST_ENTRY = 'manifest.json';
export const SNAPSHOT_ENTRY = 'backup.json';
export const SETTINGS_ENTRY = 'settings.json';
export const DATABASE_ENTRY = 'database/gubbins.sqlite3';
export const IMAGES_PREFIX = 'images/';

/** Marks a Gubbins backup manifest (so a foreign zip is rejected early). */
export const BACKUP_MANIFEST_KIND = 'gubbins-backup';

/** What the user chose to include. The portable snapshot (`backup.json`) is always included. */
export interface BackupSelection {
  /** An exact byte-for-byte `.sqlite` copy (complete & unfiltered — for guaranteed recovery). */
  readonly rawSqlite: boolean;
  /** Full-resolution OPFS image files (the heavy bytes the JSON omits). */
  readonly images: boolean;
  /** The activity ledger + gauge history inside the portable snapshot. */
  readonly history: boolean;
  /** Removed/decommissioned (inactive) items inside the portable snapshot. */
  readonly removedItems: boolean;
  /** Device-local settings & preferences (theme, units, layout, saved searches). */
  readonly settings: boolean;
}

/** Sensible defaults: a complete backup of everything. */
export const DEFAULT_BACKUP_SELECTION: BackupSelection = {
  rawSqlite: true,
  images: true,
  history: true,
  removedItems: true,
  settings: true,
};

/** A summary of what a backup contains — written on create, read back on restore for preview. */
export interface BackupManifest {
  readonly kind: typeof BACKUP_MANIFEST_KIND;
  readonly formatVersion: number;
  /** The app version that created the backup. */
  readonly appVersion: string;
  /** Creation time (epoch ms). */
  readonly createdAt: number;
  /** Which optional parts are present. */
  readonly contents: {
    readonly snapshot: true;
    readonly rawSqlite: boolean;
    readonly images: boolean;
    readonly settings: boolean;
    readonly history: boolean;
    readonly removedItems: boolean;
  };
  /** Headline counts for the preview. */
  readonly counts: {
    readonly items: number;
    readonly images: number;
  };
}

/** Thrown when a file is not a readable Gubbins backup (a malformed zip, or a foreign one). */
export class InvalidBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBackupError';
  }
}

// --- snapshot filtering (FK-safe) ----------------------------------------------------

/** Whether a snapshot `items` row is removed/decommissioned (`is_active = 0`). */
function isRemovedItem(row: SqlRow): boolean {
  return Number(row.is_active) === 0;
}

/**
 * Shape the portable snapshot per the user's toggles. **Pure** (returns a new snapshot).
 *
 *  - `includeHistory=false` drops the activity ledger (`itemHistory`) and gauge deltas.
 *  - `includeRemovedItems=false` drops every inactive item **and every row that references
 *    it**, so the result is foreign-key-safe to import. References are by `item_id` on the
 *    child tables and the self-referential `parent_id` on `items` (single-level variants):
 *    a kept item never points at a dropped one, and no orphan child survives.
 */
export function filterSnapshot(
  snapshot: SyncSnapshot,
  options: { includeHistory: boolean; includeRemovedItems: boolean },
): SyncSnapshot {
  let tables = snapshot.tables;
  let itemHistory = snapshot.itemHistory;
  let gaugeHistory = snapshot.gaugeHistory;
  let itemTags = snapshot.itemTags;

  if (!options.includeHistory) {
    itemHistory = [];
    gaugeHistory = [];
  }

  if (!options.includeRemovedItems) {
    const items = snapshot.tables.items ?? [];
    const excluded = new Set<string>();
    for (const row of items) if (isRemovedItem(row)) excluded.add(String(row.id));
    // Single-level variants: a child of an excluded parent must go too, else its FK dangles.
    for (const row of items) {
      const parent = row.parent_id;
      if (parent != null && excluded.has(String(parent))) excluded.add(String(row.id));
    }

    const next: Record<string, SqlRow[]> = {};
    for (const [table, rows] of Object.entries(snapshot.tables)) {
      next[table] =
        table === 'items'
          ? rows.filter((row) => !excluded.has(String(row.id)))
          : rows.filter((row) => !referencesExcludedItem(row, excluded));
    }
    tables = next;
    itemHistory = itemHistory.filter((row) => !referencesExcludedItem(row, excluded));
    itemTags = itemTags.filter((edge) => !excluded.has(edge.itemId));
    gaugeHistory = gaugeHistory.filter((delta) => !excluded.has(delta.itemId));
  }

  return { ...snapshot, tables, itemHistory, gaugeHistory, itemTags };
}

/** Whether a child row points at an excluded item via its `item_id` column. */
function referencesExcludedItem(row: SqlRow, excluded: ReadonlySet<string>): boolean {
  const itemId = row.item_id;
  return itemId != null && excluded.has(String(itemId));
}

// --- manifest ------------------------------------------------------------------------

/** Build the manifest describing a backup's contents. Pure. */
export function buildManifest(input: {
  readonly snapshot: SyncSnapshot;
  readonly selection: BackupSelection;
  readonly appVersion: string;
  readonly createdAt: number;
  readonly imageCount: number;
  readonly hasSqlite: boolean;
  readonly hasSettings: boolean;
}): BackupManifest {
  return {
    kind: BACKUP_MANIFEST_KIND,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: input.appVersion,
    createdAt: input.createdAt,
    contents: {
      snapshot: true,
      rawSqlite: input.hasSqlite,
      images: input.imageCount > 0,
      settings: input.hasSettings,
      history: input.selection.history,
      removedItems: input.selection.removedItems,
    },
    counts: {
      items: input.snapshot.tables.items?.length ?? 0,
      images: input.imageCount,
    },
  };
}

// --- assembly (build side) -----------------------------------------------------------

/** The raw pieces the orchestrator has gathered, ready to assemble into zip entries. */
export interface BackupSources {
  /** The already-filtered portable snapshot. */
  readonly snapshot: SyncSnapshot;
  /** Exact `.sqlite` bytes, or null when not requested. */
  readonly sqlite: Uint8Array | null;
  /** Full-resolution OPFS image files (empty when not requested / none present). */
  readonly images: readonly OpfsImageFile[];
  /** Already-sanitised settings record, or null when not requested. */
  readonly settings: Record<string, string> | null;
  readonly appVersion: string;
  readonly createdAt: number;
}

/** The zip-entry maps the worker zips, plus the manifest (returned for the success summary). */
export interface BackupArtifacts {
  readonly files: Record<string, string>;
  readonly assets: Record<string, Uint8Array>;
  readonly manifest: BackupManifest;
}

/** Build the zip-entry maps for a backup. Pure (string/bytes in → string/bytes out). */
export function assembleBackup(sources: BackupSources): BackupArtifacts {
  const selection: BackupSelection = {
    rawSqlite: sources.sqlite !== null,
    images: sources.images.length > 0,
    history: sources.snapshot.itemHistory.length > 0 || sources.snapshot.gaugeHistory.length > 0,
    removedItems: (sources.snapshot.tables.items ?? []).some(isRemovedItem),
    settings: sources.settings !== null,
  };

  const manifest = buildManifest({
    snapshot: sources.snapshot,
    selection,
    appVersion: sources.appVersion,
    createdAt: sources.createdAt,
    imageCount: sources.images.length,
    hasSqlite: sources.sqlite !== null,
    hasSettings: sources.settings !== null,
  });

  const files: Record<string, string> = {
    [MANIFEST_ENTRY]: JSON.stringify(manifest, null, 2),
    [SNAPSHOT_ENTRY]: JSON.stringify(sources.snapshot, null, 2),
  };
  if (sources.settings) files[SETTINGS_ENTRY] = JSON.stringify(sources.settings, null, 2);

  const assets: Record<string, Uint8Array> = {};
  if (sources.sqlite) assets[DATABASE_ENTRY] = sources.sqlite;
  for (const image of sources.images) {
    if (image.name.includes('/')) continue; // never nest; keep the flat images/<name> layout
    assets[`${IMAGES_PREFIX}${image.name}`] = image.bytes;
  }

  return { files, assets, manifest };
}

// --- parsing (restore side) ----------------------------------------------------------

/** The decoded contents of a backup, ready for {@link import('./restore-backup').restoreBackup}. */
export interface ParsedBackup {
  /** The manifest when present; null for a legacy bare-`.json` snapshot import. */
  readonly manifest: BackupManifest | null;
  /** The portable snapshot (always present and version-validated). */
  readonly snapshot: SyncSnapshot;
  /** Exact `.sqlite` bytes when the backup carried them (validated as a real SQLite file). */
  readonly sqlite: Uint8Array | null;
  /** Full-resolution image files to re-hydrate into OPFS. */
  readonly images: OpfsImageFile[];
  /** Allow-listed settings to restore, or null when absent. */
  readonly settings: Record<string, string> | null;
}

/** The 16-byte magic string every SQLite 3 database file begins with. */
const SQLITE_MAGIC = 'SQLite format 3\0';

/** Pure SQLite-header check (kept local so the codec needs no DB/OPFS imports). */
function looksLikeSqlite(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i += 1) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/** Parse a manifest blob, returning null when absent/foreign rather than throwing. */
function parseManifest(entries: Record<string, Uint8Array>): BackupManifest | null {
  const raw = entries[MANIFEST_ENTRY];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(strFromU8(raw)) as Partial<BackupManifest>;
    return parsed.kind === BACKUP_MANIFEST_KIND ? (parsed as BackupManifest) : null;
  } catch {
    return null;
  }
}

/** Parse an unzipped backup `path → bytes` map into {@link ParsedBackup}. Pure. */
export function parseBackupEntries(entries: Record<string, Uint8Array>): ParsedBackup {
  const snapshotRaw = entries[SNAPSHOT_ENTRY];
  if (!snapshotRaw) {
    throw new InvalidBackupError(`This backup is missing its data file (${SNAPSHOT_ENTRY}).`);
  }
  // parseBackupJson enforces the snapshot version guard (a newer build's backup is refused).
  const snapshot = parseBackupJson(strFromU8(snapshotRaw));

  const sqliteRaw = entries[DATABASE_ENTRY] ?? null;
  if (sqliteRaw && !looksLikeSqlite(sqliteRaw)) {
    throw new InvalidBackupError('The embedded database copy is not a valid SQLite file.');
  }

  const images: OpfsImageFile[] = [];
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.startsWith(IMAGES_PREFIX)) continue;
    const name = path.slice(IMAGES_PREFIX.length);
    if (name.length === 0 || name.includes('/')) continue; // dir marker / nested entry
    images.push({ name, bytes });
  }

  let settings: Record<string, string> | null = null;
  const settingsRaw = entries[SETTINGS_ENTRY];
  if (settingsRaw) {
    try {
      // Re-sanitise on the way in too, so a hand-edited backup can never write a non-allow-listed
      // key (or a scrubbed secret) into localStorage.
      settings = sanitiseSettingsRecord(JSON.parse(strFromU8(settingsRaw)) as Record<string, unknown>);
    } catch {
      settings = null;
    }
  }

  return { manifest: parseManifest(entries), snapshot, sqlite: sqliteRaw, images, settings };
}

/**
 * Read a chosen backup file (its raw bytes) into {@link ParsedBackup}. Accepts a full `.zip`
 * backup or a legacy bare `.json` snapshot (the previous "Download backup" output). Pure;
 * throws {@link InvalidBackupError} or the snapshot version-guard error for unreadable input.
 */
export function readBackupFile(bytes: Uint8Array): ParsedBackup {
  let entries: Record<string, Uint8Array> | null = null;
  try {
    entries = unzipSync(bytes);
  } catch {
    entries = null; // not a zip — fall through to the bare-JSON path
  }

  if (entries && (SNAPSHOT_ENTRY in entries || MANIFEST_ENTRY in entries)) {
    return parseBackupEntries(entries);
  }

  // Legacy bare-JSON backup (or a hand-exported snapshot).
  let snapshot: SyncSnapshot;
  try {
    snapshot = parseBackupJson(strFromU8(bytes));
  } catch (err) {
    if (err instanceof Error && err.message.includes('newer version')) throw err; // keep the version guard wording
    throw new InvalidBackupError('That file is not a Gubbins backup (.zip or backup .json).');
  }
  return { manifest: null, snapshot, sqlite: null, images: [], settings: null };
}

/** Re-export so call sites can build/inspect settings via one module. */
export { EXPORTABLE_SETTING_KEYS };

/** Convenience: encode a text entry to bytes (used by tests/builders that bypass the worker). */
export function encodeEntry(text: string): Uint8Array {
  return strToU8(text);
}

/** The fields used only as `SqlValue` carriers — re-exported to keep call sites typed. */
export type { SqlValue, SqlRow };
