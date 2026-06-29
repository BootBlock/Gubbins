/**
 * Stable per-device identity (spec §4 "Attachments & Datasheets" graceful degradation).
 *
 * A `LOCAL_POINTER` datasheet path is only valid on the device that linked it. To know,
 * on a *secondary* device, that a synced pointer is foreign — and so render the §4
 * "Unlinked Local File" placeholder rather than a dead path — each device needs a stable
 * identity to compare against the pointer's stored origin (the v18
 * `item_attachments.origin_device_id`). The comparison itself is the pure
 * `resolveAttachmentLink` seam; this module just supplies the current device's id.
 *
 * The id is **device-local** (it must NOT sync — it identifies *this* device), so it lives
 * in `localStorage` under {@link DEVICE_ID_KEY}, generated once via the native
 * `crypto.randomUUID()` (§2.4.3). Feature-detected: where storage is unavailable it falls
 * back to a process-stable in-memory id so a call never throws — mirroring the optimistic
 * defaults in `network.ts` / `install.ts` / `motion.ts`. The `storage` argument is
 * injectable so the logic is unit-testable without touching real `localStorage`.
 */

export const DEVICE_ID_KEY = 'gubbins:device-id';

/** Process-lifetime fallback when no persistent storage is available. */
let memoryId: string | null = null;

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // Accessing localStorage can throw in some locked-down/SSR contexts.
    return null;
  }
}

/** The current device's stable id, generating and persisting one on first read. */
export function getDeviceId(storage: Storage | null | undefined = defaultStorage()): string {
  if (!storage) {
    return (memoryId ??= crypto.randomUUID());
  }
  let id = storage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    storage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
