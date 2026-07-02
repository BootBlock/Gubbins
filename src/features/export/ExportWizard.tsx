import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, LiveRegion, Modal, Surface } from '@/components/foundry';
import { ExportIcon, ImportIcon, PackageIcon, ReportIcon, VaultIcon } from '@/components/icons';
import { getItemRepository, getProjectRepository } from '@/db/repositories';
import { runExport } from './run-export';
import { useExportStore, type ExportFormat, type ExportScope, type ReportExportKind } from './useExportStore';

/**
 * The Granular Export Wizard (spec §3, §2 JSON backup, §4.5 Markdown vault).
 *
 * Remembers the last-used format/scope via {@link useExportStore} (§3 "must remember the
 * user's last-used settings"). Phase 14 adds the §4.5 granularity — the whole inventory, a
 * single item, or a Project/BOM scope — in three formats: a versioned JSON backup (§2), an
 * items CSV, and an Obsidian Markdown vault (with image assets) zipped off-thread (§4.5).
 * Phase 61 adds a fourth format — a §3 aggregate **report CSV** (valuation / consumption /
 * movement / dead-stock) — routed through this same wizard so the remembered-settings and
 * download paths are shared, not duplicated. Phase 67 adds a fifth format — a catalog CSV
 * that round-trips through the import wizard without requiring manual column mapping.
 */
const FORMATS: { value: ExportFormat; label: string; hint: string; icon: typeof ExportIcon }[] = [
  {
    value: 'JSON',
    label: 'JSON data export',
    hint: 'Items, contacts & loans only — not a full backup. For everything, use Sync → Backup & restore.',
    icon: ExportIcon,
  },
  { value: 'CSV', label: 'Items CSV', hint: 'Spreadsheet of the selected items.', icon: PackageIcon },
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

const SCOPES: { value: ExportScope; label: string }[] = [
  { value: 'ALL', label: 'Whole inventory' },
  { value: 'ITEM', label: 'A single item' },
  { value: 'PROJECT', label: 'A project / BOM' },
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

export function ExportWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    format,
    scope,
    scopeTargetId,
    includeInactive,
    reportKind,
    setFormat,
    setScope,
    setScopeTargetId,
    setIncludeInactive,
    setReportKind,
  } = useExportStore();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isReport = format === 'REPORTS';
  // CATALOG_CSV always exports the whole catalogue — no scope picker needed.
  const isCatalogCsv = format === 'CATALOG_CSV';
  const hasScope = !isReport && !isCatalogCsv;

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
      });
      setDone(filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export failed.');
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
            <label
              htmlFor="export-report-kind"
              className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Report
            </label>
            <select
              id="export-report-kind"
              value={reportKind}
              onChange={(e) => setReportKind(e.target.value as ReportExportKind)}
              data-testid="export-report-kind"
              className="w-full rounded-lg border border-border bg-background p-2 text-sm"
            >
              {REPORT_KINDS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {/* §4.5 scope (item/project/whole-inventory exports only; not shown for report or catalog CSV) */}
        {hasScope ? (
          <div className="space-y-2">
            <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Scope
            </label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as ExportScope)}
              data-testid="export-scope"
              className="w-full rounded-lg border border-border bg-background p-2 text-sm"
            >
              {SCOPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>

            {scope === 'ITEM' ? (
              <select
                value={scopeTargetId ?? ''}
                onChange={(e) => setScopeTargetId(e.target.value || null)}
                data-testid="export-target-item"
                className="w-full rounded-lg border border-border bg-background p-2 text-sm"
              >
                <option value="">Choose an item…</option>
                {(itemList.data?.rows ?? []).map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name}
                  </option>
                ))}
              </select>
            ) : null}

            {scope === 'PROJECT' ? (
              <select
                value={scopeTargetId ?? ''}
                onChange={(e) => setScopeTargetId(e.target.value || null)}
                data-testid="export-target-project"
                className="w-full rounded-lg border border-border bg-background p-2 text-sm"
              >
                <option value="">Choose a project…</option>
                {(projectList.data?.rows ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
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
