import type { Migration } from './migration';

/**
 * v9 — Image Downgrading marker (spec §7.6.3 Workflow B, Phase 10).
 *
 * The §7.6 OPFS Quota Recovery "Image Downgrading" workflow drops a stale item's
 * full-resolution image to reclaim local OPFS space while retaining its lightweight
 * thumbnail. In this codebase the full-resolution bytes are an OPFS *file* pointed
 * to by the NOT-NULL `item_images.full_res_opfs_path` (§4.2.3 — never a DB blob), so
 * "downgrading" deletes the raw OPFS file and must record that the pointer is now
 * stale without violating the column's NOT-NULL constraint or losing the row.
 *
 * This single additive, nullable column is the marker: NULL = full-res present;
 * a UNIX-ms stamp = full-res was dropped at that time, thumbnail retained. A plain
 * `ALTER TABLE ADD COLUMN` (no table recreation, so the §2.3.3 12-step pattern is
 * not required). The downgrade is a *local-only* recovery action and is deliberately
 * NOT propagated to cloud sync (§7.6.3 B); `item_images` is not in `SYNC_TABLES`, so
 * stamping this column never leaks to a peer.
 */
export const v9ImageDowngrade: Migration = {
  version: 9,
  name: 'image-downgrade-marker',
  statements: [
    { sql: `ALTER TABLE item_images ADD COLUMN full_res_downgraded_at INTEGER;` },
  ],
};
