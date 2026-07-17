import type { ProjectBomLine } from '@/db/repositories';
import { TabularExportMenu } from '@/features/export/TabularExportMenu';
import { buildBomExport, bomExportFilename, buildEdaBomExport, edaBomExportFilename } from '../bom-export';

/**
 * The "Export BOM" control (issue #27; formats extended in issue #29): the project's bill of
 * materials as CSV, TSV, an Excel workbook, JSON, Markdown, a printable HTML document or
 * plain text — plus a grouped, EDA-oriented CSV (references collected, quantities summed) for
 * import into an electronics BOM tool. A thin adapter over the shared {@link TabularExportMenu}
 * — it supplies the BOM's serialisation and file names; the menu owns the format list, the
 * download side-effect and the success toast. Disabled while the BOM is empty (there is
 * nothing to export yet).
 */
export function ExportBomMenu({
  projectName,
  lines,
}: {
  projectName: string;
  lines: readonly ProjectBomLine[];
}) {
  return (
    <TabularExportMenu
      build={(format) => buildBomExport(projectName, lines, format)}
      filename={(extension) => bomExportFilename(projectName, extension)}
      triggerLabel="Export BOM"
      menuLabel="Export bill of materials"
      toastHeading="BOM exported"
      disabled={lines.length === 0}
      testIdPrefix="export-bom"
      extraActions={[
        {
          key: 'eda',
          label: 'EDA BOM (grouped CSV)',
          build: () => buildEdaBomExport(projectName, lines),
          filename: (extension) => edaBomExportFilename(projectName, extension),
        },
      ]}
    />
  );
}
