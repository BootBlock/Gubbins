/**
 * Browser download helpers. Used by the Safe Mode rescue (spec §3) now, and by
 * the Export Wizard / backups in later phases.
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
