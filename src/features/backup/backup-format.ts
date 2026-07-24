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
import { FK_REFS, type FkRef } from '../sync/fk-refs';
import type { SyncSnapshot } from '../sync/types';
// Imported from the defining module, not the `@/db/repositories` barrel: this codec stays
// free of the repository layer (screen tests mock that barrel wholesale).
import { ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE } from '@/db/repositories/tombstone';
import type { SqlRow, SqlValue } from '@/db/rpc/driver';
import type { OpfsImageFile } from '@/features/images/opfs-images';
import { EXPORTABLE_SETTING_KEYS, sanitiseSettingsRecord } from './backup-settings';
import { CHECKSUM_ALGORITHM, checksumBytes } from './checksum';
import { DEFAULT_SETTINGS_GROUPS, type SettingsGroupSelection } from './settings-groups';

/** Bump when the *container* layout changes incompatibly (independent of the snapshot's own version). */
export const BACKUP_FORMAT_VERSION = 1;

/**
 * Zip entry paths — the single source of truth shared by the builder and the reader.
 *
 * @internal Exported for unit tests only.
 */
export const MANIFEST_ENTRY = 'manifest.json';
/** @internal Exported for unit tests only. */
export const SNAPSHOT_ENTRY = 'backup.json';
/** @internal Exported for unit tests only. */
export const SETTINGS_ENTRY = 'settings.json';
/** @internal Exported for unit tests only. */
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
  /**
   * Which **groups** of settings travel (issue #175) — only consulted when `settings` is on.
   * Lets the user send their theme and units without their dashboard layout, and so on.
   */
  readonly settingGroups: SettingsGroupSelection;
}

/** Sensible defaults: a complete backup of everything (bar the device-specific settings group). */
export const DEFAULT_BACKUP_SELECTION: BackupSelection = {
  rawSqlite: true,
  images: true,
  history: true,
  removedItems: true,
  settings: true,
  settingGroups: DEFAULT_SETTINGS_GROUPS,
};

/** A summary of what a backup contains — written on create, read back on restore for preview. */
export interface BackupManifest {
  readonly kind: typeof BACKUP_MANIFEST_KIND;
  readonly formatVersion: number;
  /** The app version that created the backup. */
  readonly appVersion: string;
  /**
   * Fingerprint of the schema baseline that built the source database (issue #84). Optional:
   * backups written before this field existed simply omit it. A `replace` restore of an exact
   * `.sqlite` copy checks it *before* overwriting, so a backup from an incompatible schema is
   * refused while the current database is still intact.
   */
  readonly baselineRevision?: string;
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
  /** Headline counts for the preview — and, on restore, cross-checked against the payload. */
  readonly counts: {
    readonly items: number;
    readonly images: number;
  };
  /**
   * A digest of every other entry in the container (issue #201). Optional: backups written
   * before this field existed simply omit it, and are checked against the manifest's `counts`
   * and `contents` alone. See {@link import('./checksum')} for what this does and doesn't prove.
   */
  readonly checksums?: {
    /** Digest algorithm — an unrecognised one is skipped rather than treated as a failure. */
    readonly algorithm: string;
    /** Zip entry path → digest of the bytes stored at that path. */
    readonly entries: Readonly<Record<string, string>>;
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
 * Every column of a snapshot table that points at `items(id)`, taken from the shared
 * {@link FK_REFS} registry so this codec can never drift from the reconciliation engine's
 * view of the schema (issue #152 — `item_relations` referenced items via
 * `from_item_id`/`to_item_id`, which an `item_id`-only check missed entirely).
 *
 * `item_history` and `stock_deltas` are not synced tables, so their own `item_id` references are
 * added here.
 */
const ITEM_REF_COLUMNS: ReadonlyMap<string, readonly FkRef[]> = (() => {
  const byTable = new Map<string, readonly FkRef[]>();
  const sources: Record<string, readonly FkRef[] | undefined> = {
    ...FK_REFS,
    [ITEM_HISTORY_TABLE]: [{ col: 'item_id', parent: 'items', nullable: false }],
    [STOCK_DELTAS_TABLE]: [{ col: 'item_id', parent: 'items', nullable: false }],
  };
  for (const [table, refs] of Object.entries(sources)) {
    const itemRefs = (refs ?? []).filter((ref) => ref.parent === 'items');
    if (itemRefs.length > 0) byTable.set(table, itemRefs);
  }
  return byTable;
})();

/**
 * Shape the portable snapshot per the user's toggles. **Pure** (returns a new snapshot).
 *
 *  - `includeHistory=false` drops the activity ledger (`itemHistory`) and gauge deltas.
 *  - `includeRemovedItems=false` drops every inactive item **and repairs every row that
 *    references it**, so the result is foreign-key-safe to import. A restore applies the
 *    whole snapshot in one transaction, so a single dangling reference aborts the *entire*
 *    restore — the repair is what makes the file importable at all:
 *      - a NOT-NULL reference (ON DELETE CASCADE) cannot outlive its item → drop the row;
 *      - a nullable reference (ON DELETE SET NULL) keeps the row with the link cleared, so
 *        a purchase-order line still records what was spent;
 *      - the self-referential `items.parent_id` excludes variants **transitively**, so a
 *        grandchild of a removed item goes too rather than dangling.
 */
export function filterSnapshot(
  snapshot: SyncSnapshot,
  options: { includeHistory: boolean; includeRemovedItems: boolean },
): SyncSnapshot {
  let tables = snapshot.tables;
  let itemHistory = snapshot.itemHistory;
  let gaugeHistory = snapshot.gaugeHistory;
  let stockDeltas = snapshot.stockDeltas;
  let itemTags = snapshot.itemTags;
  let itemRegions = snapshot.itemRegions;

  if (!options.includeHistory) {
    itemHistory = [];
    gaugeHistory = [];
    // The stock-delta convergence ledger is history too, so the toggle drops it — but see the
    // note in {@link assembleBackup}: dropping it means concurrent stock movements in the restored
    // copy will not converge, only the current LWW quantities travel.
    stockDeltas = [];
  }

  if (!options.includeRemovedItems) {
    const excluded = excludedItemIds(snapshot.tables.items ?? []);

    const next: Record<string, readonly SqlRow[]> = {};
    for (const [table, rows] of Object.entries(snapshot.tables)) {
      next[table] =
        table === 'items'
          ? rows.filter((row) => !excluded.has(String(row.id)))
          : repairRows(rows, ITEM_REF_COLUMNS.get(table), excluded);
    }
    tables = next;
    itemHistory = repairRows(itemHistory, ITEM_REF_COLUMNS.get(ITEM_HISTORY_TABLE), excluded);
    stockDeltas = repairRows(stockDeltas, ITEM_REF_COLUMNS.get(STOCK_DELTAS_TABLE), excluded);
    itemTags = itemTags.filter((edge) => !excluded.has(edge.itemId));
    itemRegions = itemRegions.filter((edge) => !excluded.has(edge.itemId));
    gaugeHistory = gaugeHistory.filter((delta) => !excluded.has(delta.itemId));
  }

  return { ...snapshot, tables, itemHistory, gaugeHistory, stockDeltas, itemTags, itemRegions };
}

/**
 * The ids that must not appear in the file: every removed item, plus — transitively — every
 * variant beneath one, since `items.parent_id` is itself a reference to `items(id)`.
 */
function excludedItemIds(items: readonly SqlRow[]): ReadonlySet<string> {
  // Index children by parent first, so the walk below costs one pass rather than re-scanning
  // every item per level (an inventory can carry six figures of rows).
  const childrenByParent = new Map<string, string[]>();
  const excluded = new Set<string>();
  for (const row of items) {
    const id = String(row.id);
    if (isRemovedItem(row)) excluded.add(id);
    const parent = row.parent_id;
    if (parent == null) continue;
    const siblings = childrenByParent.get(String(parent));
    if (siblings) siblings.push(id);
    else childrenByParent.set(String(parent), [id]);
  }

  // Variants can nest, so walk the whole subtree rather than a single level: a grandchild of
  // a removed item dangles just as badly as a child. Visiting each id at most once also makes
  // a `parent_id` cycle (which the schema does not prevent) terminate.
  const queue = [...excluded];
  while (queue.length > 0) {
    for (const child of childrenByParent.get(queue.pop()!) ?? []) {
      if (excluded.has(child)) continue;
      excluded.add(child);
      queue.push(child);
    }
  }
  return excluded;
}

/**
 * Drop or repair the rows of one table so none references an excluded item. Returns the rows
 * as-is when the table has no reference to `items` at all.
 */
function repairRows(
  rows: readonly SqlRow[],
  refs: readonly FkRef[] | undefined,
  excluded: ReadonlySet<string>,
): readonly SqlRow[] {
  if (!refs) return rows;

  const kept: SqlRow[] = [];
  for (const row of rows) {
    let next = row;
    let drop = false;
    for (const { col, nullable } of refs) {
      const value = next[col];
      if (value == null || !excluded.has(String(value))) continue;
      if (!nullable) {
        drop = true;
        break;
      }
      next = { ...next, [col]: null };
    }
    if (!drop) kept.push(next);
  }
  return kept;
}

// --- manifest ------------------------------------------------------------------------

/**
 * Build the manifest describing a backup's contents. Pure.
 *
 * @internal Exported for unit tests only.
 */
export function buildManifest(input: {
  readonly snapshot: SyncSnapshot;
  /** Only the two content filters the manifest records; the rest of the selection is irrelevant here. */
  readonly selection: Pick<BackupSelection, 'history' | 'removedItems'>;
  readonly appVersion: string;
  readonly baselineRevision?: string;
  readonly createdAt: number;
  readonly imageCount: number;
  readonly hasSqlite: boolean;
  readonly hasSettings: boolean;
  /** Digest of every entry bar the manifest itself; omitted only by the format's own tests. */
  readonly checksums?: Readonly<Record<string, string>>;
}): BackupManifest {
  return {
    kind: BACKUP_MANIFEST_KIND,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: input.appVersion,
    ...(input.baselineRevision ? { baselineRevision: input.baselineRevision } : {}),
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
    ...(input.checksums ? { checksums: { algorithm: CHECKSUM_ALGORITHM, entries: input.checksums } } : {}),
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
  readonly baselineRevision?: string;
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
  const selection: Pick<BackupSelection, 'history' | 'removedItems'> = {
    history:
      sources.snapshot.itemHistory.length > 0 ||
      sources.snapshot.gaugeHistory.length > 0 ||
      sources.snapshot.stockDeltas.length > 0,
    removedItems: (sources.snapshot.tables.items ?? []).some(isRemovedItem),
  };

  // Entries first, manifest last: the manifest records a digest of everything else in the
  // container, so it can only be written once the rest of the payload is final.
  const files: Record<string, string> = {
    [SNAPSHOT_ENTRY]: JSON.stringify(sources.snapshot, null, 2),
  };
  if (sources.settings) files[SETTINGS_ENTRY] = JSON.stringify(sources.settings, null, 2);

  const assets: Record<string, Uint8Array> = {};
  if (sources.sqlite) assets[DATABASE_ENTRY] = sources.sqlite;
  let imageCount = 0;
  for (const image of sources.images) {
    if (image.name.includes('/')) continue; // never nest; keep the flat images/<name> layout
    assets[`${IMAGES_PREFIX}${image.name}`] = image.bytes;
    imageCount += 1;
  }

  const checksums: Record<string, string> = {};
  // Text entries are zipped through `strToU8`, so digest the same UTF-8 bytes the reader sees.
  for (const [path, text] of Object.entries(files)) checksums[path] = checksumBytes(strToU8(text));
  for (const [path, bytes] of Object.entries(assets)) checksums[path] = checksumBytes(bytes);

  const manifest = buildManifest({
    snapshot: sources.snapshot,
    selection,
    appVersion: sources.appVersion,
    baselineRevision: sources.baselineRevision,
    createdAt: sources.createdAt,
    // Counted from the entries actually written, not from `sources.images` — a nested name is
    // skipped above, and a manifest that over-counts would fail its own cross-check on restore.
    imageCount,
    hasSqlite: sources.sqlite !== null,
    hasSettings: sources.settings !== null,
    checksums,
  });
  files[MANIFEST_ENTRY] = JSON.stringify(manifest, null, 2);

  return { files, assets, manifest };
}

// --- parsing (restore side) ----------------------------------------------------------

/** The decoded contents of a backup, ready for {@link import('./restore-backup').restoreBackup}. */
export interface ParsedBackup {
  /**
   * The manifest when it read cleanly; null both for a `.zip` that carries `backup.json` but no
   * manifest, and for one whose manifest was damaged — {@link manifestUnreadable} separates them.
   */
  readonly manifest: BackupManifest | null;
  /**
   * True when the container *did* carry a `manifest.json` that could not be read as a valid
   * manifest (issue #353). `manifest: null` alone cannot tell the two apart, and the difference
   * matters: a backup written before manifests existed is trusted through the schema gate on an
   * exact-`.sqlite` restore, whereas a damaged one must not be — dropping the manifest would
   * otherwise turn corruption into a silent bypass of the check that protects the live database.
   */
  readonly manifestUnreadable: boolean;
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

/** A plain non-array object, the shape every nested manifest section must have. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A usable headline count: a whole, non-negative number. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** The widest epoch-ms `new Date()` can represent; beyond it every read is `Invalid Date`. */
const MAX_TIMESTAMP = 8.64e15;

/** A timestamp the preview can actually render as a date. */
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIMESTAMP;
}

/**
 * The digest block, or undefined when absent or malformed.
 *
 * A block we cannot read is dropped rather than rejected: it is the backup's safety net, not its
 * payload, and refusing an otherwise-sound file over an unreadable net is the worse outcome. The
 * `counts`/`contents` cross-checks still apply.
 */
function parseChecksums(value: unknown): BackupManifest['checksums'] {
  if (!isRecord(value) || typeof value.algorithm !== 'string' || !isRecord(value.entries)) return undefined;
  const entries: Record<string, string> = {};
  for (const [path, digest] of Object.entries(value.entries)) {
    if (typeof digest !== 'string') return undefined; // a partly-readable block proves nothing
    entries[path] = digest;
  }
  return { algorithm: value.algorithm, entries };
}

/**
 * Parse a manifest blob, returning null when absent/foreign rather than throwing.
 *
 * The manifest is parsed JSON from a file the user chose, so its *shape* is as untrusted as its
 * values: {@link verifyBackupIntegrity} reads nested sections off it, and a hand-edited or
 * partly-overwritten manifest carrying the right `kind` but no `counts` would otherwise fail
 * with a raw `Cannot read properties of undefined` instead of a message the user can act on.
 * Anything that isn't a well-formed manifest is treated as no manifest at all.
 *
 * Every field is checked and the result rebuilt from scratch — a correct `kind` says only that
 * the file claims to be ours, never that the rest of it is intact (issue #353). Dropping a
 * damaged manifest is safe for the *preview*, but it must not quietly disarm the schema gate
 * that {@link import('./restore-backup')} applies before an exact-`.sqlite` overwrite, so
 * {@link parseBackupEntries} refuses that path whenever a manifest was present but unreadable.
 */
function parseManifest(entries: Record<string, Uint8Array>): BackupManifest | null {
  const raw = entries[MANIFEST_ENTRY];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(raw));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.kind !== BACKUP_MANIFEST_KIND) return null;

  const { formatVersion, appVersion, createdAt, baselineRevision, contents, counts } = parsed;
  if (!isCount(formatVersion) || typeof appVersion !== 'string' || !isTimestamp(createdAt)) return null;
  // Optional, but only ever a string when written: a stamp of any other type is damage, and it
  // gates a destructive restore, so it can never be shrugged off as "this backup predates it".
  if (baselineRevision !== undefined && typeof baselineRevision !== 'string') return null;
  if (!isRecord(contents) || !isRecord(counts)) return null;
  // Whole, non-negative counts only: a `NaN` or fractional count would fail its own cross-check
  // and report "should contain NaN items", which tells the user nothing.
  if (!isCount(counts.items) || !isCount(counts.images)) return null;

  // Rebuilt field by field rather than spread-and-patched, so a malformed `checksums` (or any
  // other stray property) cannot survive into the value the integrity check reads.
  const checksums = parseChecksums(parsed.checksums);
  return {
    kind: BACKUP_MANIFEST_KIND,
    formatVersion,
    appVersion,
    createdAt,
    ...(baselineRevision !== undefined ? { baselineRevision } : {}),
    contents: {
      snapshot: true,
      rawSqlite: contents.rawSqlite === true,
      images: contents.images === true,
      settings: contents.settings === true,
      history: contents.history === true,
      removedItems: contents.removedItems === true,
    },
    counts: { items: counts.items, images: counts.images },
    ...(checksums ? { checksums } : {}),
  };
}

/**
 * Cross-check a backup's payload against the manifest that describes it (issue #201).
 *
 * Zip decoding only proves the container's *structure* survived — fflate needs no more than an
 * intact end-of-central-directory record, so an entry that lost its contents, or a snapshot
 * that lost whole sections, decodes perfectly happily. `parseBackupJson` then defaults every
 * missing section to empty, and the restore preview reports the *snapshot's* own numbers, so a
 * backup that quietly lost data previews as internally consistent. The manifest is the only
 * independent record of what the file is supposed to hold, so it is what we check against.
 *
 * Throws {@link InvalidBackupError} on the first discrepancy; a backup with no manifest (or a
 * manifest from before a given field existed) is checked only as far as it can be.
 *
 * @internal Exported for unit tests only.
 */
export function verifyBackupIntegrity(input: {
  readonly manifest: BackupManifest | null;
  readonly entries: Record<string, Uint8Array>;
  readonly snapshot: SyncSnapshot;
  readonly images: readonly OpfsImageFile[];
}): void {
  const { manifest, entries, snapshot, images } = input;
  if (!manifest) return;

  // Digests first: they name the damaged entry, where a count mismatch only says something is off.
  // An algorithm this build doesn't know is skipped rather than failed — a checksum is a safety
  // net, and refusing an otherwise-sound backup over an unreadable one would be a worse outcome.
  if (manifest.checksums && manifest.checksums.algorithm === CHECKSUM_ALGORITHM) {
    for (const [path, expected] of Object.entries(manifest.checksums.entries)) {
      const bytes = entries[path];
      if (!bytes) {
        throw new InvalidBackupError(
          `This backup is incomplete: it should contain "${path}", but that part is missing. The file was probably damaged or only partly downloaded.`,
        );
      }
      if (checksumBytes(bytes) !== expected) {
        throw new InvalidBackupError(
          `This backup is damaged: "${path}" does not match the checksum recorded when the backup was created. Restoring it could lose data, so try another copy.`,
        );
      }
    }
  }

  if (manifest.contents.rawSqlite && !entries[DATABASE_ENTRY]) {
    throw new InvalidBackupError(
      'This backup is incomplete: it says it contains an exact database copy, but that part is missing.',
    );
  }
  if (manifest.contents.settings && !entries[SETTINGS_ENTRY]) {
    throw new InvalidBackupError(
      'This backup is incomplete: it says it contains your settings, but that part is missing.',
    );
  }

  const items = snapshot.tables.items?.length ?? 0;
  if (manifest.counts.items !== items) {
    throw new InvalidBackupError(
      `This backup is damaged: it should contain ${manifest.counts.items} items, but only ${items} could be read. Restoring it would lose the rest, so try another copy.`,
    );
  }
  if (manifest.counts.images !== images.length) {
    throw new InvalidBackupError(
      `This backup is damaged: it should contain ${manifest.counts.images} images, but ${images.length} were found.`,
    );
  }

  // The content flags are derived from the snapshot when a backup is written, so a section that
  // emptied out between then and now is loss — exactly what an empty-defaulting parse hides.
  if (
    manifest.contents.history &&
    snapshot.itemHistory.length === 0 &&
    snapshot.gaugeHistory.length === 0 &&
    snapshot.stockDeltas.length === 0
  ) {
    throw new InvalidBackupError(
      'This backup is damaged: it says it contains your history, but no history could be read from it.',
    );
  }
  if (manifest.contents.removedItems && !(snapshot.tables.items ?? []).some(isRemovedItem)) {
    throw new InvalidBackupError(
      'This backup is damaged: it says it contains removed items, but none could be read from it.',
    );
  }
}

/**
 * Parse an unzipped backup `path → bytes` map into {@link ParsedBackup}. Pure.
 *
 * @internal Exported for unit tests only.
 */
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

  const manifest = parseManifest(entries);
  verifyBackupIntegrity({ manifest, entries, snapshot, images });

  return {
    manifest,
    manifestUnreadable: manifest === null && entries[MANIFEST_ENTRY] !== undefined,
    snapshot,
    sqlite: sqliteRaw,
    images,
    settings,
  };
}

/**
 * Read a chosen backup file (its raw bytes) into {@link ParsedBackup}. Accepts a full `.zip`
 * backup — the only format Gubbins produces. Pure; throws {@link InvalidBackupError} for a
 * non-zip or a zip missing its data file, or the snapshot version-guard error for a backup
 * written by a newer build.
 */
export function readBackupFile(bytes: Uint8Array): ParsedBackup {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new InvalidBackupError('That file is not a Gubbins backup (.zip).');
  }

  if (!(SNAPSHOT_ENTRY in entries || MANIFEST_ENTRY in entries)) {
    throw new InvalidBackupError('That file is not a Gubbins backup (.zip).');
  }
  return parseBackupEntries(entries);
}

/** Re-export so call sites can build/inspect settings via one module. */
export { EXPORTABLE_SETTING_KEYS };

/** The fields used only as `SqlValue` carriers — re-exported to keep call sites typed. */
export type { SqlValue, SqlRow };
