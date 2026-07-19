/**
 * Where a newly-compressed image's full-resolution file goes — or doesn't (spec §7.6.1).
 *
 * The critical tier's promise to the user is that "new high-resolution image uploads are
 * disabled until you free space", and this is the single place that keeps it. Both media
 * pipelines (item images and location photos) route their full-resolution write through
 * here so the promise can't hold on one and lapse on the other.
 *
 * At `critical`/`locked` the ~200 KB WebP is simply never written: the row is created
 * *already* downgraded, keeping the few-KB thumbnail the UI actually renders. That is the
 * same end state Storage Triage's "downgrade old images" produces (§7.6.3 Workflow B), so
 * every reader — the detail view, the archive, the orphan sweep — already handles it.
 *
 * Writing the file anyway is what drives a full origin toward the 95% Hard Stop and, on a
 * non-persisted origin, toward the browser evicting the *whole* dataset without notice.
 */
import { areNonEssentialFeaturesDisabled, type StorageTier } from '@/features/storage/tiers';
import { reserveImagePath, saveImageFile } from './opfs-images';

/** The stored location of a new image's full-resolution bytes, and whether they exist. */
export interface FullResPlacement {
  /** Relative OPFS path for the `full_res_opfs_path` column (always non-empty). */
  readonly fullResOpfsPath: string;
  /**
   * UNIX-ms instant the full-resolution file was refused, or `null` when it was written.
   * Non-null means the path points at a file that was never created.
   */
  readonly fullResDowngradedAt: number | null;
}

/**
 * Whether a *new* image may keep its full-resolution file at this tier. False from
 * `critical` upward, where the row is stored thumbnail-only instead.
 */
export function isFullResWriteAllowed(tier: StorageTier): boolean {
  return !areNonEssentialFeaturesDisabled(tier);
}

/**
 * Write the full-resolution WebP to OPFS, unless the tier has disabled it — in which case
 * a path is reserved and stamped as downgraded, and no bytes are written.
 */
export async function placeFullResImage(
  fullRes: Blob,
  tier: StorageTier,
  now: number = Date.now(),
): Promise<FullResPlacement> {
  if (!isFullResWriteAllowed(tier)) {
    return { fullResOpfsPath: reserveImagePath(), fullResDowngradedAt: now };
  }
  return { fullResOpfsPath: await saveImageFile(fullRes), fullResDowngradedAt: null };
}
