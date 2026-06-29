import type { Migration } from './migration';

/**
 * v18 — Attachment origin device for the §4 "Unlinked Local File" degradation (Phase 53).
 *
 * §4 "Attachments & Datasheets" Option B lets a datasheet be a `LOCAL_POINTER` — only the
 * literal file *path* is stored and synced (the blob never leaves the device, §4 Strict
 * Sync Isolation). The spec mandates that when such a pointer is synced to a *secondary*
 * device where the path is invalid, the UI must "gracefully degrade to display an
 * 'Unlinked Local File' placeholder, prompting the user to either supply a new local path
 * for that device or an external URL" — and "never attempt to upload or download the heavy
 * file blob". That degradation was unbuilt: a foreign pointer just showed its path.
 *
 * To know a pointer is foreign, a device must know which device created it. This single
 * additive, **nullable** column records that origin. NULL means "unknown origin" — every
 * pre-v18 row reads correctly with no backfill, and the pure `resolveAttachmentLink` seam
 * treats a NULL-origin pointer as local (non-regressive: a pre-existing pointer doesn't
 * suddenly degrade on the device that made it). A new local pointer is stamped with the
 * current device id (`lib/env/device-id`); a re-link restamps it; replacing it with a URL
 * clears it.
 *
 * It is NOT a foreign key — a device id is a synthetic local identity, not a row in any
 * table — so there is no `FK_REFS` entry and no location-delete/`applyPlan` null-out. It
 * SHOULD sync (the receiving device needs the origin to compare), so it is deliberately
 * left out of `SYNC_EXCLUDED_COLUMNS`; `item_attachments` is already in `SYNC_TABLES` and
 * the LWW schema dictionary reads columns live via `PRAGMA table_info`, so it round-trips
 * with no further registration. (A nullable `ADD COLUMN` needs no §2.3.3 table recreation.)
 */
export const v18AttachmentOriginDevice: Migration = {
  version: 18,
  name: 'attachment-origin-device',
  statements: [
    {
      sql: `ALTER TABLE item_attachments ADD COLUMN origin_device_id TEXT;`,
    },
  ],
};
