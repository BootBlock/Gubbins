import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, LiveRegion, Modal, Select, Surface } from '@/components/foundry';
import { ExportIcon, ImportIcon, PackageIcon, ReportIcon, VaultIcon } from '@/components/icons';
import { getItemRepository, getLocationRepository, getProjectRepository } from '@/db/repositories';
import { buildItemLocationOptions } from '@/features/inventory/parent-options';
import { useFormatters } from '@/lib/useFormatters';
import { useT, type MessageKey } from '@/features/i18n';
import { runExport } from './run-export';
import type { TabularExportFormat } from './tabular-export';
import {
  ITEM_FILE_FORMATS,
  useExportStore,
  type ExportFormat,
  type ExportScope,
  type ReportExportKind,
} from './useExportStore';
import { useErrorMessage } from '@/features/errors';

/**
 * The Granular Export Wizard (spec §3, §4.5 Markdown vault).
 *
 * Every format here is an **outbound extract** for use in other tools — none of them restores
 * back into Gubbins; that is Backup & restore's job (issue #153), which the JSON hint says
 * plainly so the versioned JSON is not mistaken for a backup.
 *
 * Remembers the last-used format/scope via {@link useExportStore} (§3 "must remember the
 * user's last-used settings"). Phase 14 adds the §4.5 granularity — the whole inventory, a
 * single item, or a Project/BOM scope — in three formats: a versioned JSON data export, an
 * items CSV, and an Obsidian Markdown vault (with image assets) zipped off-thread (§4.5).
 * Phase 61 adds a fourth format — a §3 aggregate **report CSV** (valuation / consumption /
 * movement / dead-stock) — routed through this same wizard so the remembered-settings and
 * download paths are shared, not duplicated. Phase 67 adds a fifth format — a catalog CSV
 * that round-trips through the import wizard without requiring manual column mapping. A
 * `LOCATION` scope exports one location and everything whose primary home is there, and
 * — via `initialLocationId` — is auto-selected when the calling screen has a location in
 * view, so opening Export defaults to what's currently on screen instead of last time's scope.
 */
const FORMATS: { value: ExportFormat; label: string; hint: string; icon: typeof ExportIcon }[] = [
  {
    value: 'JSON',
    label: 'JSON data export',
    hint: 'Items, contacts & loans for use in other tools — Gubbins cannot import this file back. For a restorable backup, use Sync → Backup & restore.',
    icon: ExportIcon,
  },
  {
    value: 'CSV',
    label: 'Items file',
    hint: 'The selected items as a spreadsheet, a table or plain text — pick the file format below.',
    icon: PackageIcon,
  },
  {
    value: 'VAULT',
    label: 'Markdown vault',
    hint: 'Obsidian-ready .zip with image assets.',
    icon: VaultIcon,
  },
  {
    value: 'REPORTS',
    label: 'Report CSV',
    hint: 'A §3 aggregate report — valuation, consumption, movement or dead stock.',
    icon: ReportIcon,
  },
  {
    value: 'CATALOG_CSV',
    label: 'Catalogue CSV',
    hint: 'Whole-catalogue CSV that imports back without manual column mapping — including a column for each category custom field. Use this to migrate or back up your items as a spreadsheet.',
    icon: ImportIcon,
  },
];

/**
 * Catalog key per items file format (issue #132). A lookup rather than a template so every key
 * is a literal the `MessageKey` union checks — a format added to `ITEM_FILE_FORMATS` without a
 * catalog entry fails to compile rather than rendering a raw key.
 */
const ITEM_FILE_FORMAT_LABEL_KEY: Record<TabularExportFormat, MessageKey> = {
  csv: 'export.items.format.csv',
  tsv: 'export.items.format.tsv',
  xlsx: 'export.items.format.xlsx',
  json: 'export.items.format.json',
  markdown: 'export.items.format.markdown',
  html: 'export.items.format.html',
  txt: 'export.items.format.txt',
};

const SCOPES: { value: ExportScope; label: string }[] = [
  { value: 'ALL', label: 'Whole inventory' },
  { value: 'ITEM', label: 'A single item' },
  { value: 'PROJECT', label: 'A project / BOM' },
  { value: 'LOCATION', label: 'A location' },
];

const REPORT_KINDS: { value: ReportExportKind; label: string }[] = [
  { value: 'VALUATION', label: 'Inventory valuation' },
  { value: 'CONSUMPTION', label: 'Consumption rate' },
  { value: 'MOVEMENT', label: 'Stock movement' },
  { value: 'DEAD_STOCK', label: 'Dead stock' },
  { value: 'ABC', label: 'ABC analysis' },
  { value: 'TURNOVER', label: 'Inventory turnover' },
  { value: 'AGING', label: 'Stock aging' },
  { value: 'VALUATION_TREND', label: 'Valuation over time' },
  { value: 'DATA_HYGIENE', label: 'Data hygiene' },
  { value: 'SPEND', label: 'Spend analytics' },
];

export function ExportWizard({
  open,
  onClose,
  initialLocationId,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * The location currently in view on the calling screen (e.g. the Inventory sidebar's
   * selection), if any. Pre-selects the `LOCATION` scope on each fresh open so "Export"
   * defaults to exporting what the user is actually looking at, rather than silently
   * replaying whatever scope was last remembered. Ignored (no forced pre-selection) when
   * the caller has no such context — e.g. viewing "All items", or opened from a screen
   * (like Reports) with no location concept at all.
   */
  initialLocationId?: string | null;
}) {
  const {
    format,
    scope,
    scopeTargetId,
    includeInactive,
    reportKind,
    itemFileFormat,
    setFormat,
    setScope,
    setScopeTargetId,
    setIncludeInactive,
    setReportKind,
    setItemFileFormat,
  } = useExportStore();
  const t = useT();
  const formatters = useFormatters();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();

  // Re-derive the default scope from the current page every time the dialog opens fresh
  // (not while it stays open) so it reflects whatever the user is looking at right now.
  useEffect(() => {
    if (open && initialLocationId) {
      setScope('LOCATION');
      setScopeTargetId(initialLocationId);
    }
  }, [open, initialLocationId, setScope, setScopeTargetId]);

  const isReport = format === 'REPORTS';
  // CATALOG_CSV always exports the whole catalogue — no scope picker needed.
  const isCatalogCsv = format === 'CATALOG_CSV';
  const hasScope = !isReport && !isCatalogCsv;
  // The items export is the one format that also picks a *file* format (issue #132).
  const isItemsFile = format === 'CSV';

  const itemList = useQuery({
    queryKey: ['export', 'item-picker'],
    queryFn: () => getItemRepository().list({ limit: 100, includeInactive: true }),
    enabled: open && scope === 'ITEM',
  });
  const projectList = useQuery({
    queryKey: ['export', 'project-picker'],
    queryFn: () => getProjectRepository().list({ limit: 100 }),
    enabled: open && scope === 'PROJECT',
  });
  // Every location, not a page: this picker chooses *which* location to export, so a capped read
  // simply made the ones past the first page impossible to pick (issue #148).
  const locationList = useQuery({
    queryKey: ['export', 'location-picker'],
    queryFn: () => getLocationRepository().listAll(),
    enabled: open && scope === 'LOCATION',
  });

  const needsTarget = hasScope && scope !== 'ALL';
  const targetMissing = needsTarget && !scopeTargetId;

  const run = async () => {
    setBusy(true);
    setDone(null);
    setError(null);
    try {
      const filename = await runExport(format, {
        includeInactive,
        scope,
        targetId: scopeTargetId,
        reportKind,
        itemFileFormat,
      });
      setDone(filename);
    } catch (e) {
      setError(describeError(e, 'The export failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export"
      description="Your last settings are remembered for next time."
    >
      <div className="space-y-4">
        <div className="grid gap-2">
          {FORMATS.map((f) => {
            const Icon = f.icon;
            const selected = format === f.value;
            return (
              <button
                key={f.value}
                onClick={() => setFormat(f.value)}
                aria-pressed={selected}
                className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors [&_svg]:size-5 ${
                  selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary/50'
                }`}
              >
                <Icon className={selected ? 'text-primary' : 'text-muted-foreground'} />
                <span className="flex-1">
                  <span className="block text-sm font-medium">{f.label}</span>
                  <span className="block text-xs text-muted-foreground">{f.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        {/* §3 report picker (Phase 61) — shown only for the report-CSV format. */}
        {isReport ? (
          <div className="space-y-2">
            <span
              id="export-report-kind-label"
              className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Report
            </span>
            <Select
              id="export-report-kind"
              aria-labelledby="export-report-kind-label"
              value={reportKind}
              onChange={(value) => setReportKind(value as ReportExportKind)}
              data-testid="export-report-kind"
              options={REPORT_KINDS.map((r) => ({ value: r.value, label: r.label }))}
            />
          </div>
        ) : null}

        {/*
         * File format for the items export (issue #132) — shown only for that format, because it
         * is the only one of the five with a choice to make. The other four each produce one
         * specific artefact (a versioned JSON extract, a zipped vault, a report CSV, a
         * round-trippable catalogue CSV) whose shape is the point of choosing it.
         */}
        {isItemsFile ? (
          <div className="space-y-field-gap-compact">
            <span
              id="export-item-file-format-label"
              className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              {t('export.items.fileFormat.label')}
            </span>
            <Select
              id="export-item-file-format"
              aria-labelledby="export-item-file-format-label"
              value={itemFileFormat}
              onChange={(value) => setItemFileFormat(value as TabularExportFormat)}
              data-testid="export-item-file-format"
              options={ITEM_FILE_FORMATS.map((value) => ({
                value,
                label: t(ITEM_FILE_FORMAT_LABEL_KEY[value]),
              }))}
            />
            <p className="text-xs text-muted-foreground">{t('export.items.fileFormat.hint')}</p>
          </div>
        ) : null}

        {/* §4.5 scope (item/project/location/whole-inventory exports only; not shown for report or catalog CSV) */}
        {hasScope ? (
          <div className="space-y-2">
            <span
              id="export-scope-label"
              className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Scope
            </span>
            <Select
              id="export-scope"
              aria-labelledby="export-scope-label"
              value={scope}
              onChange={(value) => setScope(value as ExportScope)}
              data-testid="export-scope"
              options={SCOPES.map((s) => ({ value: s.value, label: s.label }))}
            />

            {scope === 'ITEM' ? (
              <Select
                value={scopeTargetId ?? ''}
                onChange={(value) => setScopeTargetId(value || null)}
                data-testid="export-target-item"
                aria-label="Item to export"
                options={[
                  { value: '', label: 'Choose an item…' },
                  ...(itemList.data?.rows ?? []).map((it) => ({ value: it.id, label: it.name })),
                ]}
              />
            ) : null}

            {scope === 'PROJECT' ? (
              <Select
                value={scopeTargetId ?? ''}
                onChange={(value) => setScopeTargetId(value || null)}
                data-testid="export-target-project"
                aria-label="Project to export"
                options={[
                  { value: '', label: 'Choose a project…' },
                  ...(projectList.data?.rows ?? []).map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            ) : null}

            {scope === 'LOCATION' ? (
              <Select
                value={scopeTargetId ?? ''}
                onChange={(value) => setScopeTargetId(value || null)}
                data-testid="export-target-location"
                aria-label="Location to export"
                options={[
                  { value: '', label: 'Choose a location…' },
                  ...buildItemLocationOptions(locationList.data ?? [], formatters.quantity),
                ]}
              />
            ) : null}
          </div>
        ) : null}

        {(hasScope && scope === 'ALL') || isCatalogCsv ? (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="size-4 accent-primary"
            />
            Include removed (decommissioned) items
          </label>
        ) : null}

        {done ? (
          <Surface className="p-3 text-sm text-foreground">
            Exported <span className="font-medium">{done}</span> to your downloads.
          </Surface>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {/* Always-mounted polite region: announces progress and success in place
            after "Export" is clicked — a screen reader would otherwise miss the
            in-place state change (WCAG 4.1.3). A second assertive region handles
            errors so they interrupt immediately. Both regions must pre-exist so the
            later content change is actually announced (see LiveRegion). */}
        <LiveRegion visuallyHidden data-testid="export-live-region">
          {busy ? <p>Exporting…</p> : done ? <p>Exported {done} to your downloads.</p> : null}
        </LiveRegion>
        <LiveRegion urgency="assertive" visuallyHidden data-testid="export-error-live-region">
          {error ? <p>{error}</p> : null}
        </LiveRegion>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void run()} disabled={busy || targetMissing} data-testid="run-export">
            <ExportIcon />
            {busy ? 'Exporting…' : 'Export'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
