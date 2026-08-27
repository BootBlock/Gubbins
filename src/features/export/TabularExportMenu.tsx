import { Menu, MenuAction, MenuSeparator, useToast } from '@/components/foundry';
import { DownloadIcon, ErrorIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { usePermission } from '@/features/users/usePermission';
import { download } from './download';
import type { TabularExportFormat, TabularExportResult } from './tabular-export';

/**
 * A shared "export this list to a file" control (issue #27; formats extended in issue #29):
 * a Foundry {@link Menu} offering CSV, TSV, an Excel workbook, JSON, Markdown, a printable
 * HTML document or plain text. Every list export (the project BOM, the reorder / shopping
 * list, …) renders this instead of a hand-rolled button + download, so the format set, the
 * download side-effect and the success toast live in one place. Each caller owns *what* it
 * serialises via {@link build} (its columns + document framing, through `buildTabularExport`)
 * and *how the file is named* via {@link filename}. A caller can also append its own bespoke
 * exports (e.g. a grouped EDA BOM) via {@link extraActions} — they reuse the same download +
 * toast.
 */
const FORMATS: { value: TabularExportFormat; label: string }[] = [
  { value: 'csv', label: 'CSV (spreadsheet)' },
  { value: 'tsv', label: 'TSV (tab-separated)' },
  { value: 'xlsx', label: 'Excel workbook (.xlsx)' },
  { value: 'json', label: 'JSON' },
  { value: 'markdown', label: 'Markdown table' },
  { value: 'html', label: 'HTML (printable)' },
  { value: 'txt', label: 'Plain text' },
];

/** An extra, caller-specific export appended below the standard formats (e.g. an EDA BOM). */
export interface TabularExportExtraAction {
  /** Stable key / test-id suffix (`${testIdPrefix}-${key}`). */
  readonly key: string;
  /** Menu-row label. */
  readonly label: string;
  /** Serialise the export (may be async, e.g. when it defers to `buildTabularExport`). */
  readonly build: () => TabularExportResult | Promise<TabularExportResult>;
  /** Build the download file name for the produced extension (no dot). */
  readonly filename: (extension: string) => string;
}

export interface TabularExportMenuProps {
  /** Serialise the list to the chosen format (typically via `buildTabularExport`). */
  readonly build: (format: TabularExportFormat) => TabularExportResult | Promise<TabularExportResult>;
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
  /** Bespoke extra exports appended below the standard formats. */
  readonly extraActions?: readonly TabularExportExtraAction[];
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
  extraActions,
  testIdPrefix,
}: TabularExportMenuProps) {
  const { show } = useToast();
  const t = useT();
  // Every list export in the app is *this* component — the activity feed, alerts, bookings,
  // contacts, the item activity log and the location sidebar all render it rather than rolling
  // their own button + download. That makes it the one honest place to ask whether the session
  // may export at all, so the gate is deliberately here and not repeated at the six call sites
  // (issue #429): one check that no new caller can forget, instead of six that will drift. A
  // refused session is offered no trigger rather than a disabled one — `disabled` above means
  // "there is nothing in this list to export", which is a different, recoverable thing to say.
  const mayExport = usePermission('export:run');
  if (!mayExport) return null;

  const save = async (
    produce: () => TabularExportResult | Promise<TabularExportResult>,
    nameFor: (extension: string) => string,
  ) => {
    try {
      const { content, mimeType, extension, notice } = await produce();
      const name = nameFor(extension);
      // Both a string and a Uint8Array are valid Blob parts at runtime; the cast sidesteps the
      // lib.dom `ArrayBufferLike`-vs-`ArrayBuffer` mismatch on the typed-array branch.
      download(new Blob([content as BlobPart], { type: mimeType }), name);
      show({
        // A file that stopped short still saved, so this stays a success — but it is a warning
        // tone and carries the caveat, because a short file that reports itself as a clean
        // success is exactly the silent truncation the export seam exists to prevent.
        tone: notice ? 'warning' : 'success',
        icon: <DownloadIcon />,
        heading: toastHeading,
        // Both halves go through the catalog rather than being concatenated: `notice` is itself
        // a translated sentence, so splicing it onto an English literal would render a
        // mixed-language toast — and a `{notice}` placeholder lets a translation put the caveat
        // where that language wants it rather than always trailing.
        message: notice
          ? t('export.list.savedTruncated', { vars: { name, notice } })
          : t('export.list.saved', { vars: { name } }),
      });
    } catch {
      // Serialising can fail — e.g. the lazily-loaded spreadsheet module can't be fetched
      // the first time it's needed while offline. Surface it rather than silently doing nothing.
      show({
        tone: 'danger',
        icon: <ErrorIcon />,
        heading: t('export.list.failed.heading'),
        message: t('export.list.failed.body'),
      });
    }
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
          onSelect={() => void save(() => build(f.value), filename)}
          data-testid={`${testIdPrefix}-${f.value}`}
        >
          {f.label}
        </MenuAction>
      ))}
      {extraActions && extraActions.length > 0 ? (
        <>
          <MenuSeparator />
          {extraActions.map((action) => (
            <MenuAction
              key={action.key}
              onSelect={() => void save(action.build, action.filename)}
              data-testid={`${testIdPrefix}-${action.key}`}
            >
              {action.label}
            </MenuAction>
          ))}
        </>
      ) : null}
    </Menu>
  );
}
