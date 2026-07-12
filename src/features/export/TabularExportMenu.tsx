import { Menu, MenuAction, useToast } from '@/components/foundry';
import { DownloadIcon } from '@/components/icons';
import { download } from './download';
import type { TabularExportFormat, TabularExportResult } from './tabular-export';

/**
 * A shared "export this list to a file" control (issue #27): a Foundry {@link Menu}
 * offering CSV, TSV, Markdown or a printable HTML document. Every list export (the project
 * BOM, the reorder / shopping list, …) renders this instead of a hand-rolled button +
 * download, so the format set, the download side-effect and the success toast live in one
 * place. Each caller owns *what* it serialises via {@link build} (its columns + document
 * framing, through `buildTabularExport`) and *how the file is named* via {@link filename}.
 */
const FORMATS: { value: TabularExportFormat; label: string }[] = [
  { value: 'csv', label: 'CSV (spreadsheet)' },
  { value: 'tsv', label: 'TSV (tab-separated)' },
  { value: 'markdown', label: 'Markdown table' },
  { value: 'html', label: 'HTML (printable)' },
];

export interface TabularExportMenuProps {
  /** Serialise the list to the chosen format (typically via `buildTabularExport`). */
  readonly build: (format: TabularExportFormat) => TabularExportResult;
  /** Build the download file name for a given extension (no dot). */
  readonly filename: (extension: string) => string;
  /** Visible trigger text (e.g. "Export BOM" or "Export"). */
  readonly triggerLabel: string;
  /** Accessible name for the menu panel and (icon-carrying) trigger. */
  readonly menuLabel: string;
  /** Success-toast heading (e.g. "BOM exported"). */
  readonly toastHeading: string;
  /** Disable the trigger (e.g. when the list is empty). */
  readonly disabled?: boolean;
  /** Test-id root: the trigger is `${testIdPrefix}`, each row `${testIdPrefix}-${format}`. */
  readonly testIdPrefix: string;
}

export function TabularExportMenu({
  build,
  filename,
  triggerLabel,
  menuLabel,
  toastHeading,
  disabled,
  testIdPrefix,
}: TabularExportMenuProps) {
  const { show } = useToast();

  const exportAs = (format: TabularExportFormat) => {
    const { content, mimeType, extension } = build(format);
    const name = filename(extension);
    download(new Blob([content], { type: mimeType }), name);
    show({
      tone: 'success',
      icon: <DownloadIcon />,
      heading: toastHeading,
      message: `${name} saved to your downloads.`,
    });
  };

  return (
    <Menu
      label={menuLabel}
      trigger={
        <>
          <DownloadIcon />
          {triggerLabel}
        </>
      }
      triggerVariant="outline"
      triggerSize="sm"
      triggerProps={{ 'data-testid': testIdPrefix, disabled }}
    >
      {FORMATS.map((f) => (
        <MenuAction
          key={f.value}
          onSelect={() => exportAs(f.value)}
          data-testid={`${testIdPrefix}-${f.value}`}
        >
          {f.label}
        </MenuAction>
      ))}
    </Menu>
  );
}
