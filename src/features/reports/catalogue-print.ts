/**
 * Print-page furniture for the parts catalogue: an optional running header (the organisation
 * name / title repeated in the top page margin) and page numbers ("Page X of Y" in the bottom
 * margin). These use the modern CSS `@page` margin boxes (Chromium/Edge 131+); a browser that
 * doesn't support them simply ignores the rule — the document still prints, just without the
 * running furniture — so this degrades safely.
 *
 * The rule is injected into the page as a `<style>` only when at least one option is on, and the
 * user-entered header text is escaped through {@link cssContentString} so it can never break out
 * of the CSS string (a CSS/HTML-injection guard for the letterhead fields). Kept as a pure string
 * builder (no React/DOM) so the escaping and rule composition are unit-tested in isolation.
 *
 * Raw point sizes and ink colours are intentional here, as elsewhere in the print stylesheet:
 * print is a fixed, theme-less medium.
 */

/**
 * Escape a string for safe embedding inside a CSS `content: "…"` value. Collapses whitespace
 * runs (newlines/tabs) to single spaces, then escapes backslash and double-quote so the value
 * can never terminate the string early or inject further declarations.
 */
export function cssContentString(value: string): string {
  const cleaned = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"${cleaned}"`;
}

/** Inputs for {@link buildCataloguePageStyle}. */
export interface CataloguePageStyleOptions {
  /** Print "Page X of Y" in the bottom page margin. */
  readonly pageNumbers: boolean;
  /** Repeat {@link headerText} in the top page margin of every page. */
  readonly runningHeader: boolean;
  /** The running-header text (organisation name, else the document title). */
  readonly headerText: string;
}

/**
 * Build the `@media print { @page { … } }` rule for the catalogue's running header and page
 * numbers, or an empty string when neither applies (so the caller can skip the `<style>` tag).
 * The running header is omitted when its text is blank.
 */
export function buildCataloguePageStyle(opts: CataloguePageStyleOptions): string {
  const boxes: string[] = [];
  const header = opts.headerText.trim();
  if (opts.runningHeader && header.length > 0) {
    boxes.push(`@top-right { content: ${cssContentString(header)}; font-size: 9pt; color: #555; }`);
  }
  if (opts.pageNumbers) {
    boxes.push(
      `@bottom-right { content: "Page " counter(page) " of " counter(pages); font-size: 9pt; color: #555; }`,
    );
  }
  if (boxes.length === 0) return '';
  return `@media print { @page { ${boxes.join(' ')} } }`;
}
