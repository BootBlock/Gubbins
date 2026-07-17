/**
 * Project BOM export (issue #27): serialise a project's bill of materials to a
 * downloadable file in the user's chosen format. Pure — it maps {@link ProjectBomLine}
 * rows onto the shared tabular column model and hands them to the generic serialisers in
 * `@/features/export/tabular-export`, so CSV / TSV / Markdown / HTML all come from one
 * column definition (no per-format duplication). Kept free of React and repositories.
 */
import type { ProjectBomLine } from '@/db/repositories';
import {
  buildTabularExport,
  type TabularCell,
  type TabularColumn,
  type TabularExportFormat,
  type TabularExportResult,
} from '@/features/export/tabular-export';
import { PROCUREMENT_STATUS_LABELS, RESERVATION_STATUS_LABELS } from './components/projects-ui';

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
 * Serialise a project's BOM to the chosen format via the shared tabular exporter,
 * returning the file content alongside the MIME type and extension the download needs.
 */
export function buildBomExport(
  projectName: string,
  lines: readonly ProjectBomLine[],
  format: TabularExportFormat,
): Promise<TabularExportResult> {
  return buildTabularExport(format, bomExportColumns(), lines, {
    title: documentTitle(projectName),
    caption: `${lines.length} line${lines.length === 1 ? '' : 's'}`,
  });
}

/** A file-name-safe slug of a project's name, e.g. `Robot Arm!` → `Robot_Arm`. */
function projectSlug(projectName: string): string {
  return (
    projectName
      .replace(/[^\w-]+/g, '_')
      .slice(0, 40)
      .replace(/^_+|_+$/g, '') || 'project'
  );
}

/** A file-safe download name for a project's BOM export, e.g. `gubbins-bom-Robot_Arm-2026-07-12.csv`. */
export function bomExportFilename(projectName: string, extension: string, date = new Date()): string {
  return `gubbins-bom-${projectSlug(projectName)}-${date.toISOString().slice(0, 10)}.${extension}`;
}

/**
 * One grouped EDA BOM row: parts sharing a value + MPN + manufacturer are merged, their
 * reference designators collected and their required quantities summed — the "one row per
 * distinct part, all references listed" layout EDA tools (KiCad, Altium, …) expect.
 */
export interface EdaBomRow {
  readonly references: string;
  readonly quantity: number;
  readonly value: string;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
}

/** Group BOM lines by distinct part, collecting references and summing quantities (order-stable). */
export function groupEdaBom(lines: readonly ProjectBomLine[]): EdaBomRow[] {
  interface Group {
    readonly references: string[];
    quantity: number;
    readonly value: string;
    readonly mpn: string | null;
    readonly manufacturer: string | null;
  }
  const groups = new Map<string, Group>();
  const order: string[] = [];
  for (const line of lines) {
    const value = partLabel(line);
    // A JSON tuple keeps the composite key unambiguous when a field itself holds a separator
    // (and avoids a raw control character in the source).
    const key = JSON.stringify([value, line.mpn, line.manufacturer]);
    let group = groups.get(key);
    if (!group) {
      group = { references: [], quantity: 0, value, mpn: line.mpn, manufacturer: line.manufacturer };
      groups.set(key, group);
      order.push(key);
    }
    if (line.designator) group.references.push(line.designator);
    group.quantity += line.requiredQty;
  }
  return order.map((key) => {
    const group = groups.get(key)!;
    return {
      references: group.references.join(', '),
      quantity: group.quantity,
      value: group.value,
      mpn: group.mpn,
      manufacturer: group.manufacturer,
    };
  });
}

/** The EDA BOM columns — the reference designators, quantity and part identity EDA tools import. */
export function edaBomColumns(): readonly TabularColumn<EdaBomRow>[] {
  return [
    { header: 'References', value: (r) => r.references },
    { header: 'Quantity', value: (r) => r.quantity },
    { header: 'Value', value: (r) => r.value },
    { header: 'MPN', value: (r) => r.mpn },
    { header: 'Manufacturer', value: (r) => r.manufacturer },
  ];
}

/**
 * Serialise a project's BOM as an EDA-oriented **CSV** (grouped by part, references listed) —
 * the layout an electronics BOM tool expects. Always CSV: it is the interchange format EDA
 * tools read, and it routes through the shared exporter so the quoting stays consistent.
 */
export function buildEdaBomExport(
  projectName: string,
  lines: readonly ProjectBomLine[],
): Promise<TabularExportResult> {
  const rows = groupEdaBom(lines);
  return buildTabularExport('csv', edaBomColumns(), rows, {
    title: `${projectName} — EDA bill of materials`,
    caption: `${rows.length} part${rows.length === 1 ? '' : 's'}`,
  });
}

/** A file-safe download name for a project's EDA BOM, e.g. `gubbins-eda-bom-Robot_Arm-2026-07-12.csv`. */
export function edaBomExportFilename(projectName: string, extension: string, date = new Date()): string {
  return `gubbins-eda-bom-${projectSlug(projectName)}-${date.toISOString().slice(0, 10)}.${extension}`;
}
