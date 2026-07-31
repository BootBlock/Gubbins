/**
 * Storage Triage recovery orchestration (spec §7.6.3 Workflows A & B).
 *
 * Wires the pure cutoff/archive maths to the repository reads/prunes and the browser
 * side-effects (JSON download, OPFS file deletion). Reads are paginated (≤100) and
 * looped to completion, mirroring the Export Wizard's full-table collection.
 *
 *  - Workflow A: collect the targeted `item_history` rows → save the cold-storage JSON
 *    archive *first* and confirm it landed → only then DELETE them (the §7.6.3
 *    audit-trail safeguard).
 *  - Workflow B: collect the stale full-resolution images → delete each raw OPFS file
 *    → mark the row downgraded (thumbnail retained). Local-only; never synced.
 */
import { getStorageRepository } from '@/db/repositories';
import type { DowngradableImage, ItemHistoryEntry } from '@/db/repositories';
import { deleteImageFile } from '@/features/images/opfs-images';
import { fileTimestamp } from '@/lib/download';
import { saveBeforeDestroying, type SafeSave, type SaveFileKind } from '@/lib/save-file';
import { buildHistoryArchive, pruneCutoff } from './triage';

const PAGE = 100;

/** How the cold-storage archive is offered in a save picker. */
export const HISTORY_ARCHIVE_FILE_KIND: SaveFileKind = {
  description: 'Gubbins history archive',
  mimeType: 'application/json',
  extensions: ['.json'],
};

/**
 * The archive's filename, needed by the caller *before* the rows are read: the save
 * destination is reserved inside the click that started the workflow (issue #502).
 */
export function historyArchiveFilename(now: number): string {
  return `inventory_history_archive_${fileTimestamp(new Date(now))}.json`;
}

export interface PruneHistoryResult {
  readonly cutoff: number;
  readonly archived: number;
  readonly pruned: number;
  /**
   * False when the archive never reached the user, in which case **nothing was deleted** —
   * `archived` and `pruned` are both zero and the history is exactly as it was.
   */
  readonly archiveSaved: boolean;
}

/**
 * Workflow A: archive then prune history older than `months`. Saves
 * `inventory_history_archive_<stamp>.json` through `save` and only deletes once that copy
 * is confirmed. Returns counts; a zero-row window is a no-op (no empty file is saved).
 */
export async function archiveAndPruneHistory(
  months: number,
  now: number,
  save: SafeSave,
): Promise<PruneHistoryResult> {
  const repo = getStorageRepository();
  const cutoff = pruneCutoff(now, months);

  const rows: ItemHistoryEntry[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await repo.listHistoryBefore(cutoff, { limit: PAGE, offset });
    rows.push(...page.rows);
    if (!page.hasMore) break;
  }

  if (rows.length === 0) return { cutoff, archived: 0, pruned: 0, archiveSaved: true };

  // Cold storage FIRST (§7.6.3) — and *established*, not assumed (issue #502). The prune also
  // advances the §7.6.3-A watermark, so peers will not re-supply these rows either: if the
  // archive did not reach the user then this is the last copy of it, and nothing may go.
  const archiveSaved = await saveBeforeDestroying(
    new Blob([buildHistoryArchive(rows, cutoff, now)], { type: 'application/json' }),
    save,
  );
  if (!archiveSaved) return { cutoff, archived: 0, pruned: 0, archiveSaved: false };

  const pruned = await repo.pruneHistoryBefore(cutoff);
  return { cutoff, archived: rows.length, pruned, archiveSaved: true };
}

export interface DowngradeImagesResult {
  readonly cutoff: number;
  readonly downgraded: number;
}

/**
 * Workflow B: drop the full-resolution OPFS file for images older than `months`,
 * keeping the thumbnail. Collected up front (a stable snapshot) so marking rows does
 * not shift a moving query window. Each raw file is deleted, then the row stamped.
 */
export async function downgradeImagesBefore(
  months: number,
  now: number = Date.now(),
): Promise<DowngradeImagesResult> {
  const repo = getStorageRepository();
  const cutoff = pruneCutoff(now, months);

  const candidates: DowngradableImage[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await repo.listDowngradableBefore(cutoff, { limit: PAGE, offset });
    candidates.push(...page.rows);
    if (!page.hasMore) break;
  }

  let downgraded = 0;
  for (const image of candidates) {
    await deleteImageFile(image.fullResOpfsPath);
    await repo.markImageDowngraded(image.id, image.owner, now);
    downgraded += 1;
  }
  return { cutoff, downgraded };
}
