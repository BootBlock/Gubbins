import type { ProjectBomLine } from '@/db/repositories';
import { TabularExportMenu } from '@/features/export/TabularExportMenu';
import { buildBomExport, bomExportFilename } from '../bom-export';

/**
 * The "Export BOM" control (issue #27): the project's bill of materials as CSV, TSV,
 * Markdown or a printable HTML document. A thin adapter over the shared
 * {@link TabularExportMenu} — it supplies the BOM's serialisation and file name; the menu
 * owns the format list, the download side-effect and the success toast. Disabled while the
 * BOM is empty (there is nothing to export yet).
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
    />
  );
}
