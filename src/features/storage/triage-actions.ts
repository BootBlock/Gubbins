/**
 * Storage Triage recovery orchestration (spec §7.6.3 Workflows A & B).
 *
 * Wires the pure cutoff/archive maths to the repository reads/prunes and the browser
 * side-effects (JSON download, OPFS file deletion). Reads are paginated (≤100) and
 * looped to completion, mirroring the Export Wizard's full-table collection.
 *
 *  - Workflow A: collect the targeted `item_history` rows → download the cold-storage
 *    JSON archive *first* → only then DELETE them (the §7.6.3 audit-trail safeguard).
 *  - Workflow B: collect the stale full-resolution images → delete each raw OPFS file
 *    → mark the row downgraded (thumbnail retained). Local-only; never synced.
 */
import { getStorageRepository } from '@/db/repositories';
import type { DowngradableImage, ItemHistoryEntry } from '@/db/repositories';
import { deleteImageFile } from '@/features/images/opfs-images';
import { downloadBlob, fileTimestamp } from '@/lib/download';
import { buildHistoryArchive, pruneCutoff } from './triage';

const PAGE = 100;

export interface PruneHistoryResult {
  readonly cutoff: number;
  readonly archived: number;
  readonly pruned: number;
}

/**
 * Workflow A: archive then prune history older than `months`. Downloads
 * `inventory_history_archive_<stamp>.json` before deleting. Returns counts; a
 * zero-row window is a no-op (no empty file is downloaded).
 */
export async function archiveAndPruneHistory(
  months: number,
  now: number = Date.now(),
): Promise<PruneHistoryResult> {
  const repo = getStorageRepository();
  const cutoff = pruneCutoff(now, months);

  const rows: ItemHistoryEntry[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await repo.listHistoryBefore(cutoff, { limit: PAGE, offset });
    rows.push(...page.rows);
    if (!page.hasMore) break;
  }

  if (rows.length === 0) return { cutoff, archived: 0, pruned: 0 };

  // Cold storage FIRST (§7.6.3): never delete before the audit trail is saved.
  downloadBlob(
    `inventory_history_archive_${fileTimestamp(new Date(now))}.json`,
    new Blob([buildHistoryArchive(rows, cutoff, now)], { type: 'application/json' }),
  );

  const pruned = await repo.pruneHistoryBefore(cutoff);
  return { cutoff, archived: rows.length, pruned };
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
    await repo.markImageDowngraded(image.id, now);
    downgraded += 1;
  }
  return { cutoff, downgraded };
}
