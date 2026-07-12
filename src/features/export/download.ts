/**
 * The single browser-download side-effect shared by every export path.
 *
 * Extracted so each export — the Export Wizard, the Reports CSV, and the project BOM
 * export (issue #27) — triggers a download exactly one way, never a hand-rolled copy.
 * Kept tiny and DOM-only so the pure builders stay free of side-effects.
 */
export function download(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(href);
}
