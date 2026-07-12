/**
 * Project BOM export (issue #27): serialise a project's bill of materials to a
 * downloadable file in the user's chosen format. Pure — it maps {@link ProjectBomLine}
 * rows onto the shared tabular column model and hands them to the generic serialisers in
 * `@/features/export/tabular-export`, so CSV / TSV / Markdown / HTML all come from one
 * column definition (no per-format duplication). Kept free of React and repositories.
 */
import type { ProjectBomLine } from '@/db/repositories';
import {
  toCsv,
  toHtmlTable,
  toMarkdownTable,
  toTsv,
  type TabularCell,
  type TabularColumn,
} from '@/features/export/tabular-export';
import { PROCUREMENT_STATUS_LABELS, RESERVATION_STATUS_LABELS } from './components/projects-ui';

/** The file formats a BOM can be exported to (issue #27). */
export type BomExportFormat = 'csv' | 'tsv' | 'markdown' | 'html';

export interface BomExportResult {
  readonly content: string;
  /** MIME type for the download `Blob`. */
  readonly mimeType: string;
  /** File-name extension (no dot). */
  readonly extension: string;
}

/** Display name for a BOM line's part — mirrors the on-screen BOM table's fallback chain. */
function partLabel(line: ProjectBomLine): string {
  return line.description ?? line.mpn ?? line.designator ?? 'Unnamed part';
}

/**
 * The line's total cost under its captured snapshot (`required × unit cost`), rounded to
 * strip binary-float noise (`0.1 × 3`) so a spreadsheet shows a clean currency figure.
 * Null when the line has no cost snapshot.
 */
function lineCost(line: ProjectBomLine): number | null {
  if (line.unitCostSnapshot == null) return null;
  return Math.round(line.unitCostSnapshot * line.requiredQty * 1e6) / 1e6;
}

/**
 * The BOM export columns: the on-screen part identity plus the quantity, status and
 * costing detail. Costs stay raw numbers (blank when unknown) so the file is
 * machine-readable and locale-independent.
 */
export function bomExportColumns(): readonly TabularColumn<ProjectBomLine>[] {
  return [
    { header: 'Designator', value: (l) => l.designator },
    { header: 'Part', value: partLabel },
    { header: 'MPN', value: (l) => l.mpn },
    { header: 'Manufacturer', value: (l) => l.manufacturer },
    { header: 'Required', value: (l) => l.requiredQty },
    { header: 'Reserved', value: (l) => l.reservedQty },
    { header: 'Received', value: (l) => l.receivedQty },
    { header: 'Reservation', value: (l) => RESERVATION_STATUS_LABELS[l.reservationStatus] },
    { header: 'Procurement', value: (l) => PROCUREMENT_STATUS_LABELS[l.procurementStatus] },
    { header: 'Unit cost', value: (l): TabularCell => l.unitCostSnapshot },
    { header: 'Line cost', value: (l): TabularCell => lineCost(l) },
    { header: 'Matched', value: (l) => (l.itemId ? 'Yes' : 'No') },
  ];
}

/** Human title for the exported document / heading. */
function documentTitle(projectName: string): string {
  return `${projectName} — Bill of materials`;
}

/**
 * Serialise a project's BOM to the chosen format, returning the file content alongside
 * the MIME type and extension the download side-effect needs.
 */
export function buildBomExport(
  projectName: string,
  lines: readonly ProjectBomLine[],
  format: BomExportFormat,
): BomExportResult {
  const columns = bomExportColumns();
  switch (format) {
    case 'csv':
      return { content: toCsv(columns, lines), mimeType: 'text/csv;charset=utf-8', extension: 'csv' };
    case 'tsv':
      return {
        content: toTsv(columns, lines),
        mimeType: 'text/tab-separated-values;charset=utf-8',
        extension: 'tsv',
      };
    case 'markdown':
      return {
        content: `# ${documentTitle(projectName)}\n\n${toMarkdownTable(columns, lines)}`,
        mimeType: 'text/markdown;charset=utf-8',
        extension: 'md',
      };
    case 'html':
      return {
        content: toHtmlTable(columns, lines, {
          title: documentTitle(projectName),
          caption: `${lines.length} line${lines.length === 1 ? '' : 's'}`,
        }),
        mimeType: 'text/html;charset=utf-8',
        extension: 'html',
      };
  }
}

/** A file-safe download name for a project's BOM export, e.g. `gubbins-bom-Robot_Arm-2026-07-12.csv`. */
export function bomExportFilename(projectName: string, extension: string, date = new Date()): string {
  const slug =
    projectName
      .replace(/[^\w-]+/g, '_')
      .slice(0, 40)
      .replace(/^_+|_+$/g, '') || 'project';
  return `gubbins-bom-${slug}-${date.toISOString().slice(0, 10)}.${extension}`;
}
