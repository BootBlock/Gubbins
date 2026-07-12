import { Menu, MenuAction, useToast } from '@/components/foundry';
import { DownloadIcon } from '@/components/icons';
import type { ProjectBomLine } from '@/db/repositories';
import { download } from '@/features/export/download';
import { buildBomExport, bomExportFilename, type BomExportFormat } from '../bom-export';

/**
 * The "Export BOM" control (issue #27): a Foundry {@link Menu} beside the project's other
 * BOM actions offering the bill of materials as CSV, TSV, Markdown or a printable HTML
 * document. Reuses the shared, unit-tested serialisers (`bom-export`) and the single
 * download side-effect (`@/features/export/download`) — no hand-rolled export here.
 * Disabled while the BOM is empty (there is nothing to export yet).
 */
const FORMATS: { value: BomExportFormat; label: string }[] = [
  { value: 'csv', label: 'CSV (spreadsheet)' },
  { value: 'tsv', label: 'TSV (tab-separated)' },
  { value: 'markdown', label: 'Markdown table' },
  { value: 'html', label: 'HTML (printable)' },
];

export function ExportBomMenu({
  projectName,
  lines,
}: {
  projectName: string;
  lines: readonly ProjectBomLine[];
}) {
  const { show } = useToast();
  const empty = lines.length === 0;

  const exportAs = (format: BomExportFormat) => {
    const { content, mimeType, extension } = buildBomExport(projectName, lines, format);
    const filename = bomExportFilename(projectName, extension);
    download(new Blob([content], { type: mimeType }), filename);
    show({
      tone: 'success',
      icon: <DownloadIcon />,
      heading: 'BOM exported',
      message: `${filename} saved to your downloads.`,
    });
  };

  return (
    <Menu
      label="Export bill of materials"
      trigger={
        <>
          <DownloadIcon />
          Export BOM
        </>
      }
      triggerVariant="outline"
      triggerSize="sm"
      triggerProps={{ 'data-testid': 'export-bom', disabled: empty }}
    >
      {FORMATS.map((f) => (
        <MenuAction key={f.value} onSelect={() => exportAs(f.value)} data-testid={`export-bom-${f.value}`}>
          {f.label}
        </MenuAction>
      ))}
    </Menu>
  );
}
