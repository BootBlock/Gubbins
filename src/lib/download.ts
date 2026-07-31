/**
 * Browser download helpers. Used by the Safe Mode rescue (spec §3) now, and by
 * the Export Wizard / backups in later phases.
 *
 * **Convenience exports only.** {@link downloadBlob} is fire-and-forget by construction — it
 * cannot tell a completed save from one the browser refused, cancelled or dropped. Anything that
 * goes on to *delete or overwrite* what it just copied must use `lib/save-file.ts` instead, which
 * reports what actually happened (issue #502).
 */

/** Trigger a client-side file download for a Blob. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoke after a delay so the download has time to start.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** A filesystem-safe timestamp like `2026-06-27_13-09-14` for backup filenames. */
export function fileTimestamp(date = new Date()): string {
  return date.toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
}
