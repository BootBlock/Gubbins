/**
 * Database Maintenance engine (Settings → Database maintenance).
 *
 * A set of safe, on-demand housekeeping tasks for the local-first SQLite/OPFS store —
 * read-only checks/insights plus the two space-changing actions. Everything the browser
 * touches is behind an injected {@link MaintenancePorts} bag, so the whole engine is
 * driven in unit tests by the in-memory SQLite driver plus trivial OPFS fakes — no
 * worker, no OPFS, no WASM.
 *
 *  - **Database statistics** ({@link gatherDatabaseStats}) is a read-only snapshot: file
 *    size, free pages, per-table row counts, image storage (measured from OPFS where it
 *    can be), and the engine/schema versions. Cheap PRAGMAs and `COUNT(*)`s; mutates nothing.
 *  - **Compact & optimise** ({@link compactDatabase}) merges the FTS5 index segments,
 *    refreshes the query-planner statistics, then `VACUUM`s. Deletes (Danger-Zone
 *    erases, Storage-Triage prunes, ordinary item removals) leave free pages behind —
 *    the OPFS database file never shrinks on its own — so this is what actually returns
 *    the reclaimed space to the file system. Reports the byte size before/after.
 *  - **Check health** ({@link checkDatabaseHealth}) runs `PRAGMA integrity_check` and
 *    `PRAGMA foreign_key_check`. Read-only: it reports problems, it never mutates. In
 *    normal operation foreign keys are enforced (`PRAGMA foreign_keys = ON`) and every
 *    parent delete cascades, so in-database orphans cannot accumulate — this is the tool
 *    that would *surface* any that ever slipped past (e.g. a sync-reconcile bug), rather
 *    than silently deleting rows.
 *  - **Verify search index** ({@link checkSearchIndex}) content-verifies the `items_fts`
 *    external-content index against `items` and rebuilds it from the content when it has
 *    drifted (a missed trigger). The rebuild reconstructs the index from existing rows —
 *    it changes no inventory data — and is distinct from Compact's segment *merge*.
 *  - **Verify stock totals** ({@link verifyStockTotals}) confirms the trigger-maintained
 *    aggregates still agree: `items.quantity` = `SUM(item_stock)` = `SUM(stock_batches)`
 *    per placement. Read-only — it reports drift, it never rewrites a total.
 *  - **Find missing image files** ({@link findMissingImageFiles}) is the inverse of the
 *    orphan sweep: photo rows (not downgraded) whose OPFS file is absent on this
 *    device. Read-only and non-destructive — a missing file is often a peer's photo not
 *    yet downloaded, never something to delete.
 *  - **Remove orphaned image files** ({@link sweepOrphanImages}) is the one true orphan
 *    class foreign keys cannot manage: raw OPFS `images/<uuid>.webp` files that no
 *    photo row points at, left behind if a database write failed *after* the
 *    file landed (the media pipeline flags exactly this). It only ever deletes a file
 *    with **no** owning row; it never touches a row whose file is merely absent (that is
 *    a valid image synced from another device but not yet downloaded).
 *
 * VACUUM cannot run inside a transaction, so compaction is issued as plain `execute`
 * statements (never through `driver.transaction`).
 */
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { getDatabaseDriver } from '@/db/client';
import { deleteImageFile, imagesBytesOnDisk, listImageFilenames } from '@/features/images/opfs-images';
import { estimateTableBytes } from '@/features/storage/triage';

/** The side-effecting capabilities the engine needs, injected for testability. */
export interface MaintenancePorts {
  readonly db: IDatabaseDriver;
  /**
   * List the bare filenames in the OPFS `images/` directory, or `null` when OPFS is
   * unavailable (so the orphan sweep reports "unsupported" instead of deleting against
   * a falsely-empty list).
   */
  readonly listImageFilenames: () => Promise<string[] | null>;
  /** Delete one raw image file by its stored `images/<name>` path. */
  readonly deleteImageFile: (path: string) => Promise<void>;
  /**
   * Measure the true on-disk size (bytes) of the OPFS full-resolution image files, or
   * `null` when OPFS cannot be read (so the statistics fall back to the row-count
   * heuristic instead of reporting a false zero).
   */
  readonly imagesBytesOnDisk: () => Promise<number | null>;
}

/** OPFS subdirectory the full-resolution image files live in (mirrors opfs-images). */
const IMAGES_DIR = 'images';

// --- Compact & optimise ---------------------------------------------------------

export interface CompactResult {
  /** On-disk database size (bytes) before compaction. */
  readonly beforeBytes: number;
  /** On-disk database size (bytes) after compaction. */
  readonly afterBytes: number;
  /** Space returned to the file system (`beforeBytes − afterBytes`, clamped ≥ 0). */
  readonly reclaimedBytes: number;
  /**
   * Fraction of the file reclaimed (`reclaimedBytes / beforeBytes`, 0–1); 0 when the
   * file was empty or nothing was freed. Lets the UI quote a percentage without a
   * divide-by-zero guard at the call site.
   */
  readonly reclaimedFraction: number;
  /**
   * Unused (free) pages sitting in the file before compaction — the space that past
   * deletes left behind for VACUUM to reclaim. The "why" behind the reclaimed bytes.
   */
  readonly freePagesBefore: number;
}

/** Current database size in bytes: `page_count × page_size` (both cheap PRAGMAs). */
export async function databaseBytes(db: IDatabaseDriver): Promise<number> {
  const pageCount = await db.queryOne<{ page_count: number }>('PRAGMA page_count;');
  const pageSize = await db.queryOne<{ page_size: number }>('PRAGMA page_size;');
  return Number(pageCount?.page_count ?? 0) * Number(pageSize?.page_size ?? 0);
}

/** Number of unused (free) pages currently held in the file (`PRAGMA freelist_count`). */
async function freePageCount(db: IDatabaseDriver): Promise<number> {
  const row = await db.queryOne<{ freelist_count: number }>('PRAGMA freelist_count;');
  return Number(row?.freelist_count ?? 0);
}

/**
 * Merge FTS segments, refresh planner statistics, then VACUUM. Returns the byte size
 * before and after (plus the free-page count going in) so the UI can report both the
 * space reclaimed and what there was to reclaim.
 */
export async function compactDatabase(ports: Pick<MaintenancePorts, 'db'>): Promise<CompactResult> {
  const { db } = ports;
  const beforeBytes = await databaseBytes(db);
  // Capture the free pages before any step touches the file, so the count reflects the
  // deletes/erases that accumulated slack — the story behind the bytes VACUUM returns.
  const freePagesBefore = await freePageCount(db);

  // Merge the FTS5 index b-tree segments accumulated by many small writes into fewer,
  // larger ones — shrinking the index and speeding future searches. Harmless if the
  // index is already tidy.
  await db.execute(`INSERT INTO items_fts(items_fts) VALUES ('optimize');`);
  // Refresh the query-planner statistics (runs ANALYZE on tables that have changed
  // enough to matter). Cheap and recommended after bulk changes.
  await db.execute('PRAGMA optimize;');
  // Rebuild the file, releasing free pages left by deletes back to the file system.
  // Must be the last step and must not run inside a transaction.
  await db.execute('VACUUM;');

  const afterBytes = await databaseBytes(db);
  const reclaimedBytes = Math.max(0, beforeBytes - afterBytes);
  return {
    beforeBytes,
    afterBytes,
    reclaimedBytes,
    reclaimedFraction: beforeBytes > 0 ? reclaimedBytes / beforeBytes : 0,
    freePagesBefore,
  };
}

// --- Check health ---------------------------------------------------------------

export interface HealthResult {
  /** True when both integrity and foreign-key checks come back clean. */
  readonly ok: boolean;
  /** Human-readable descriptions of any problems found (empty when `ok`). */
  readonly problems: readonly string[];
}

/**
 * Run `PRAGMA integrity_check` + `PRAGMA foreign_key_check`. Read-only. A healthy
 * database yields a single `integrity_check` row of `ok` and no foreign-key rows.
 */
export async function checkDatabaseHealth(ports: Pick<MaintenancePorts, 'db'>): Promise<HealthResult> {
  const { db } = ports;
  const problems: string[] = [];

  const integrity = await db.query<{ integrity_check: string }>('PRAGMA integrity_check;');
  for (const row of integrity) {
    const message = row.integrity_check;
    if (message && message !== 'ok') problems.push(message);
  }

  const fkViolations = await db.query<{
    table: string;
    rowid: number | null;
    parent: string;
    fkid: number;
  }>('PRAGMA foreign_key_check;');
  for (const v of fkViolations) {
    problems.push(
      `Foreign-key violation in "${v.table}"${v.rowid == null ? '' : ` (row ${v.rowid})`} → missing "${v.parent}".`,
    );
  }

  return { ok: problems.length === 0, problems };
}

// --- Remove orphaned image files ------------------------------------------------

export interface OrphanSweepResult {
  /** False when OPFS could not be read (e.g. no browser) — nothing was scanned. */
  readonly supported: boolean;
  /** Number of raw image files found in OPFS. */
  readonly scanned: number;
  /** Number of files that were referenced by a photo row (kept). */
  readonly referenced: number;
  /** Number of unreferenced (orphaned) files deleted. */
  readonly removed: number;
}

/** Extract the bare filename from a stored `images/<uuid>.webp` path. */
function filenameOf(path: string): string | undefined {
  const name = path.split('/').pop();
  return name && name.length > 0 ? name : undefined;
}

/**
 * Delete raw OPFS image files that **no owning row** references. Conservative: it reads the
 * DB references first (a throw there aborts before any delete), and only removes files with
 * no owning row — never a row whose file is merely missing.
 *
 * The referenced set spans *every* table that owns an OPFS image, not just `item_images`:
 * item photos and location photos share one flat `images/` directory, so a sweep that knew
 * about only one of them would see the other's files as unreferenced and delete a user's
 * photos. Any future image-owning table must be added here too.
 */
export async function sweepOrphanImages(ports: MaintenancePorts): Promise<OrphanSweepResult> {
  const filenames = await ports.listImageFilenames();
  if (filenames === null) {
    return { supported: false, scanned: 0, referenced: 0, removed: 0 };
  }

  const rows = await ports.db.query<{ full_res_opfs_path: string }>(
    `SELECT full_res_opfs_path FROM item_images
     UNION ALL
     SELECT full_res_opfs_path FROM location_photos;`,
  );
  const referenced = new Set<string>();
  for (const row of rows) {
    const name = filenameOf(row.full_res_opfs_path);
    if (name) referenced.add(name);
  }

  let removed = 0;
  let referencedCount = 0;
  for (const name of filenames) {
    if (referenced.has(name)) {
      referencedCount += 1;
      continue;
    }
    await ports.deleteImageFile(`${IMAGES_DIR}/${name}`);
    removed += 1;
  }

  return { supported: true, scanned: filenames.length, referenced: referencedCount, removed };
}

// --- Find missing image files (inverse orphan) ----------------------------------

export interface MissingImagesResult {
  /** False when OPFS could not be read — nothing could be checked. */
  readonly supported: boolean;
  /** Image rows expected to hold a local full-res file (not already downgraded). */
  readonly checked: number;
  /** How many of those rows point at a file that is not on this device. */
  readonly missing: number;
  /** Up to a handful of item names with a missing file, for the inline report. */
  readonly sampleNames: readonly string[];
}

/** How many item-name samples to surface for a set of missing files. */
const MISSING_SAMPLE_LIMIT = 5;

/**
 * The inverse of {@link sweepOrphanImages}: find photo rows — item images and location
 * photos alike — whose full-resolution OPFS file is **missing on this device**. Read-only and deliberately non-destructive — a
 * missing file is often a legitimate image synced from a peer that this device has not
 * downloaded yet (never a downgraded one, which no longer expects a local file), so the
 * report only informs; it never deletes a row or downgrades it.
 */
export async function findMissingImageFiles(ports: MaintenancePorts): Promise<MissingImagesResult> {
  const filenames = await ports.listImageFilenames();
  if (filenames === null) {
    return { supported: false, checked: 0, missing: 0, sampleNames: [] };
  }
  const present = new Set(filenames);

  // Only rows that still expect a local file: a downgraded row intentionally dropped its
  // full-res file (Storage Triage / §7.6.3 B), so its absence is by design, not a fault.
  const rows = await ports.db.query<{ full_res_opfs_path: string; item_name: string }>(
    `SELECT ii.full_res_opfs_path AS full_res_opfs_path, i.name AS item_name
       FROM item_images ii JOIN items i ON i.id = ii.item_id
      WHERE ii.full_res_downgraded_at IS NULL
     UNION ALL
     SELECT lp.full_res_opfs_path AS full_res_opfs_path, l.name AS item_name
       FROM location_photos lp JOIN locations l ON l.id = lp.location_id
      WHERE lp.full_res_downgraded_at IS NULL;`,
  );

  const sampleNames: string[] = [];
  let missing = 0;
  for (const row of rows) {
    const name = filenameOf(row.full_res_opfs_path);
    if (name && !present.has(name)) {
      missing += 1;
      if (sampleNames.length < MISSING_SAMPLE_LIMIT) sampleNames.push(row.item_name);
    }
  }

  return { supported: true, checked: rows.length, missing, sampleNames };
}

// --- Verify / rebuild the search index ------------------------------------------

export interface SearchIndexResult {
  /** True when the FTS index matches its content table (after any repair). */
  readonly ok: boolean;
  /** True when a desynced index was found and rebuilt from the content table. */
  readonly repaired: boolean;
}

/**
 * Run the FTS5 `integrity-check`; true when the index is consistent, false when it is not.
 * The `rank`-column argument of `1` asks FTS5 to additionally verify that the index matches
 * the `items` content table (not just that it is *internally* consistent) — the check that
 * actually catches a trigger-miss desync, where the index is well-formed but out of step
 * with the rows. Available since SQLite 3.37; both the WASM and node:sqlite builds are newer.
 */
async function ftsIntegrityOk(db: IDatabaseDriver): Promise<boolean> {
  try {
    await db.execute(`INSERT INTO items_fts(items_fts, rank) VALUES ('integrity-check', 1);`);
    return true;
  } catch {
    // A desynced/corrupt external-content index raises SQLITE_CORRUPT_VTAB here.
    return false;
  }
}

/**
 * Verify the `items_fts` external-content search index against the `items` table and, if
 * it has drifted (a missed trigger, an interrupted write), rebuild it from the content.
 * The rebuild reconstructs the index from existing rows — it changes no inventory data —
 * so it is safe to run unattended, matching the dialog's no-confirm ethos. Distinct from
 * the Compact task's `optimize`, which only *merges* segments and cannot fix a desync.
 */
export async function checkSearchIndex(ports: Pick<MaintenancePorts, 'db'>): Promise<SearchIndexResult> {
  const { db } = ports;
  if (await ftsIntegrityOk(db)) return { ok: true, repaired: false };

  // Rebuild wipes and repopulates the index from the `items` content table, then verify
  // it took. If it still fails the caller surfaces a warning rather than a false "fixed".
  await db.execute(`INSERT INTO items_fts(items_fts) VALUES ('rebuild');`);
  return { ok: await ftsIntegrityOk(db), repaired: true };
}

// --- Verify stock totals (trigger-derived aggregate integrity) -------------------

/** One row whose stored total disagrees with the sum of the level below it. */
export interface StockDrift {
  /** Human-readable subject: the item name (level 1) or `item @ location` (level 2). */
  readonly subject: string;
  /** The stored total that should have been kept in step by a trigger. */
  readonly declared: number;
  /** The total recomputed from the level below (`SUM` of the children). */
  readonly computed: number;
}

export interface StockTotalsResult {
  /** True when every stored total matches its recomputed sum. */
  readonly ok: boolean;
  /** `items.quantity` rows that disagree with `SUM(item_stock.quantity)`. */
  readonly itemDrift: readonly StockDrift[];
  /** `item_stock.quantity` rows that disagree with `SUM(stock_batches.quantity)`. */
  readonly placementDrift: readonly StockDrift[];
}

/** How many drift rows to surface per level in the inline report. */
const DRIFT_SAMPLE_LIMIT = 10;

/**
 * Read-only integrity check for the trigger-maintained stock aggregates (Phase 25/28):
 * `items.quantity` is kept equal to `SUM(item_stock.quantity)`, itself kept equal to
 * `SUM(stock_batches.quantity)` per placement. Every item is seeded a ledger row at
 * creation, so under correct triggers these always agree — any mismatch means a trigger
 * was bypassed or missed. Reports drift; it never rewrites a total (repair is a separate,
 * deliberate action).
 */
export async function verifyStockTotals(ports: Pick<MaintenancePorts, 'db'>): Promise<StockTotalsResult> {
  const { db } = ports;

  const itemRows = await db.query<{ name: string; declared: number; computed: number }>(
    `SELECT i.name AS name, i.quantity AS declared, COALESCE(s.total, 0) AS computed
       FROM items i
       LEFT JOIN (SELECT item_id, SUM(quantity) AS total FROM item_stock GROUP BY item_id) s
         ON s.item_id = i.id
      WHERE i.quantity <> COALESCE(s.total, 0)
      ORDER BY ABS(i.quantity - COALESCE(s.total, 0)) DESC
      LIMIT ?;`,
    [DRIFT_SAMPLE_LIMIT + 1],
  );

  const placementRows = await db.query<{
    name: string;
    location_id: string;
    declared: number;
    computed: number;
  }>(
    `SELECT i.name AS name, st.location_id AS location_id,
            st.quantity AS declared, COALESCE(b.total, 0) AS computed
       FROM item_stock st
       JOIN items i ON i.id = st.item_id
       LEFT JOIN (
         SELECT item_id, location_id, SUM(quantity) AS total
           FROM stock_batches GROUP BY item_id, location_id
       ) b ON b.item_id = st.item_id AND b.location_id = st.location_id
      WHERE st.quantity <> COALESCE(b.total, 0)
      ORDER BY ABS(st.quantity - COALESCE(b.total, 0)) DESC
      LIMIT ?;`,
    [DRIFT_SAMPLE_LIMIT + 1],
  );

  const itemDrift = itemRows.map((r) => ({
    subject: r.name,
    declared: Number(r.declared),
    computed: Number(r.computed),
  }));
  const placementDrift = placementRows.map((r) => ({
    subject: `${r.name} @ ${r.location_id}`,
    declared: Number(r.declared),
    computed: Number(r.computed),
  }));

  return { ok: itemDrift.length === 0 && placementDrift.length === 0, itemDrift, placementDrift };
}

// --- Database statistics (read-only breakdown) ----------------------------------

/** One user table and its live row count. */
export interface TableRowCount {
  readonly table: string;
  readonly rows: number;
}

export interface DatabaseStats {
  /** On-disk database size in bytes (`page_count × page_size`). */
  readonly fileBytes: number;
  /** Unused (free) pages held in the file, and the bytes they occupy. */
  readonly freePages: number;
  readonly freeBytes: number;
  /** Per-table row counts, busiest first, excluding empty tables and FTS shadows. */
  readonly tables: readonly TableRowCount[];
  /** Sum of every user table's rows. */
  readonly totalRows: number;
  /**
   * How many photos exist across **every** image-owning table
   * ({@link IMAGE_OWNING_TABLES}), so this counts the same set {@link imageBytes}
   * measures — item photos *and* location photos both live in the one OPFS directory.
   */
  readonly imageCount: number;
  /** Measured OPFS image bytes, or an estimate when OPFS cannot be measured. */
  readonly imageBytes: number;
  /** True when {@link imageBytes} is the measured on-disk figure (not the heuristic). */
  readonly imageBytesMeasured: boolean;
  /** SQLite engine version and the applied schema (`user_version`) version. */
  readonly sqliteVersion: string;
  readonly schemaVersion: number;
}

/** User tables to skip in the breakdown: SQLite internals and the FTS5 shadow tables. */
function isReportableTable(name: string): boolean {
  return !name.startsWith('sqlite_') && !name.includes('items_fts');
}

/**
 * Every table whose rows own a full-res OPFS image file.
 *
 * Item photos and location photos share the one flat `images/` directory (see
 * {@link sweepOrphanImages}), so any *count* reported beside a measurement of that
 * directory has to span the same set — counting only `item_images` puts a small number
 * next to a large size, and makes the fallback estimate treat location photos as
 * weightless. It is also what `estimateTableBytes`'s `photos` input already asks for
 * ("photo rows across every table that anchors an OPFS image"), and what Storage Triage
 * counts. Any future image-owning table must be added here, and to the reference queries
 * in {@link sweepOrphanImages} and {@link findMissingImageFiles}.
 */
const IMAGE_OWNING_TABLES: readonly string[] = ['item_images', 'location_photos'];

/**
 * Gather a read-only snapshot of the database: file size, free space, per-table row
 * counts, image storage (measured from OPFS where possible), and the engine/schema
 * versions. Everything here is a cheap PRAGMA or `COUNT(*)`; it mutates nothing.
 */
export async function gatherDatabaseStats(ports: MaintenancePorts): Promise<DatabaseStats> {
  const { db } = ports;

  const pageSize = Number((await db.queryOne<{ page_size: number }>('PRAGMA page_size;'))?.page_size ?? 0);
  const pageCount = Number(
    (await db.queryOne<{ page_count: number }>('PRAGMA page_count;'))?.page_count ?? 0,
  );
  const freePages = await freePageCount(db);

  // Enumerate the real user tables, then count each. `sqlite_master` lists FTS shadow
  // tables and internals too, so filter to the reportable set first.
  const tableNames = (
    await db.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;`)
  )
    .map((r) => r.name)
    .filter(isReportableTable);

  const tables: TableRowCount[] = [];
  let totalRows = 0;
  let imageCount = 0;
  for (const table of tableNames) {
    const row = await db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}";`);
    const rows = Number(row?.n ?? 0);
    totalRows += rows;
    if (IMAGE_OWNING_TABLES.includes(table)) imageCount += rows;
    if (rows > 0) tables.push({ table, rows });
  }
  tables.sort((a, b) => b.rows - a.rows || a.table.localeCompare(b.table));

  // Prefer the true OPFS bytes; fall back to the §7.6.2 row-count heuristic when OPFS
  // cannot be measured (e.g. a browser without the async-iterable directory handle). The
  // heuristic reads `imageCount`, so it only estimates every photo's bytes because that
  // count spans every image-owning table.
  const measured = await ports.imagesBytesOnDisk();
  const imageBytesMeasured = measured !== null;
  const imageBytes =
    measured !== null
      ? measured
      : estimateTableBytes({ items: 0, itemHistory: 0, photos: imageCount }).photos;

  const sqliteVersion = String(
    (await db.queryOne<{ v: string }>('SELECT sqlite_version() AS v;'))?.v ?? 'unknown',
  );
  const schemaVersion = Number(
    (await db.queryOne<{ user_version: number }>('PRAGMA user_version;'))?.user_version ?? 0,
  );

  return {
    fileBytes: pageCount * pageSize,
    freePages,
    freeBytes: freePages * pageSize,
    tables,
    totalRows,
    imageCount,
    imageBytes,
    imageBytesMeasured,
    sqliteVersion,
    schemaVersion,
  };
}

/**
 * Wire the real browser capabilities: the shared worker DB driver and the OPFS image
 * helpers. The single place production maintenance meets the worker/OPFS layers.
 */
export function browserMaintenancePorts(): MaintenancePorts {
  return {
    db: getDatabaseDriver(),
    listImageFilenames: () => listImageFilenames(),
    deleteImageFile: (path) => deleteImageFile(path),
    imagesBytesOnDisk: () => imagesBytesOnDisk(),
  };
}
