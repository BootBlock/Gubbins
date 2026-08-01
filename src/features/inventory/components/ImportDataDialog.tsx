/**
 * ImportDataDialog — a generalised, tabbed bulk-import Modal (Phase: generalised
 * import dialog). Supersedes the single-purpose four-step catalogue-CSV wizard by
 * folding it into a wider dialog with a left-hand tab rail:
 *
 *   - "Import text" — paste or type items; the extraction is previewed live as
 *     items (auto-detecting CSV / TSV / free-form line lists) so the user can see
 *     exactly how their text will land before committing.
 *   - "Import file" — choose a `.csv` / `.tsv` / `.json` / `.md` / `.html` / `.txt`
 *     file; its contents flow through the *same* engine and preview.
 *
 * Both tabs feed one shared "workbench": detect format → (for tabular input) map
 * columns → preview the extracted items with per-row create/update/error status →
 * apply. The apply path reuses the existing {@link applyCatalogImportPlan} — the
 * same {@link ItemRepository} create/update methods and the sole custom-field write
 * path — so there is no new SQL and the §hard-stop write guard still applies.
 *
 * Accessibility: the Foundry Modal traps focus; the tab rail is an ARIA tablist;
 * validation lists carry `role="alert"`; the completion summary announces via the
 * polite `LiveRegion`. British English throughout.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  LiveRegion,
  Modal,
  Select,
  Spinner,
  Surface,
  Textarea,
  useReportDialogBusy,
} from '@/components/foundry';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import { decimalSeparatorForLocale } from '@/lib/format';
import { DatasheetIcon, ImportIcon, UploadIcon } from '@/components/icons';
import {
  getCategoryRepository,
  getItemRepository,
  getLocationRepository,
  getTagRepository,
  type CategoryField,
  type Item,
} from '@/db/repositories';
import { TRACKING_MODES, type TrackingMode } from '@/db/repositories/constants';
import { TRACKING_MODE_LABELS } from './inventory-ui';
import {
  CATALOG_FIELD_LABELS,
  CATALOG_FIELDS,
  applyCatalogImportPlan,
  isCustomFieldTarget,
  type CatalogApplyResult,
  type CatalogField,
  type ColumnMapping,
  type MatchKey,
} from '../catalog-import';
import {
  IMPORT_FORMATS,
  IMPORT_FORMAT_LABELS,
  applyMigration,
  buildImportPlan,
  buildPreviewRows,
  extractImport,
  isDelimitedFormat,
  type ImportFormat,
  type ImportPreviewRow,
} from '../text-import';
import { useFormatters } from '@/lib/useFormatters';
import { MAX_IMPORT_FILE_BYTES, readImportFile, type ImportFileRead } from '@/features/import/file-source';
import { ImportFileBanner } from '@/features/import/components/ImportFileBanner';
import {
  MIGRATION_SOURCE_HINTS,
  MIGRATION_SOURCE_IDS,
  MIGRATION_SOURCE_LABELS,
  detectMigrationSource,
  type MigrationSourceId,
} from '../importers/migrations';
import { inventoryKeys } from '../queries';
import { invalidateItems } from '../invalidate';
import { useErrorMessage } from '@/features/errors';

// ---------------------------------------------------------------------------
// Catalogue loaders — read the whole item + custom-field set once per open, so
// both create-vs-update matching and custom-field auto-mapping work.
// ---------------------------------------------------------------------------

async function loadAllItems(): Promise<Item[]> {
  const repo = getItemRepository();
  const all: Item[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await repo.list({ limit: 100, offset, includeInactive: true });
    all.push(...page.rows);
    if (!page.hasMore) break;
  }
  return all;
}

async function loadAllCustomFields(): Promise<CategoryField[]> {
  const categoryRepo = getCategoryRepository();
  const fields: CategoryField[] = [];
  for (let offset = 0; ; offset += 100) {
    const cats = await categoryRepo.list({ limit: 100, offset });
    for (const cat of cats.rows) fields.push(...(await categoryRepo.listFields(cat.id)));
    if (!cats.hasMore) break;
  }
  return fields;
}

/** Minimal location shape the importer needs: id + name for the picker and resolution. */
interface ImportLocation {
  readonly id: string;
  readonly name: string;
}

async function loadAllLocations(): Promise<ImportLocation[]> {
  const repo = getLocationRepository();
  const all: ImportLocation[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await repo.list({ limit: 100, offset });
    for (const loc of page.rows) all.push({ id: loc.id, name: loc.name });
    if (!page.hasMore) break;
  }
  return all;
}

interface Catalogue {
  readonly items: readonly Item[];
  readonly customFields: readonly CategoryField[];
  readonly locations: readonly ImportLocation[];
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

/** Status pill for a previewed row, coloured via semantic tokens. */
function StatusBadge({ status }: { status: ImportPreviewRow['status'] }) {
  const style =
    status === 'create'
      ? 'bg-glyph-success/10 text-glyph-success'
      : status === 'update'
        ? 'bg-primary/10 text-primary'
        : 'bg-destructive/10 text-destructive';
  const label = status === 'create' ? 'Create' : status === 'update' ? 'Update' : 'Error';
  return <span className={cn('rounded px-1.5 py-0.5 text-[0.6875rem] font-medium', style)}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Column mapping table (tabular formats only)
// ---------------------------------------------------------------------------

function MappingTable({
  columns,
  mapping,
  onChange,
}: {
  columns: readonly string[];
  mapping: ColumnMapping;
  onChange: (index: number, field: CatalogField | null) => void;
}) {
  return (
    <div className="max-h-44 overflow-y-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-secondary/30">
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Column</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Maps to field</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((header, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              <td className="px-3 py-2 font-mono text-xs text-foreground">{header || '(empty)'}</td>
              <td className="px-3 py-2">
                <Select
                  value={
                    isCustomFieldTarget(mapping[i] ?? null) ? '' : ((mapping[i] as CatalogField | null) ?? '')
                  }
                  onChange={(value) => onChange(i, (value || null) as CatalogField | null)}
                  className="h-8 text-xs"
                  aria-label={`Field for column ${header || i + 1}`}
                  options={[
                    { value: '', label: '(ignore)' },
                    ...CATALOG_FIELDS.map((f) => ({ value: f, label: CATALOG_FIELD_LABELS[f] })),
                  ]}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extracted-items preview table
// ---------------------------------------------------------------------------

const MAX_PREVIEW_ROWS = 100;

/**
 * A sticky preview-table header cell. The background is a *solid* token (not a
 * translucent tint) and it is raised with `z-10`, so rows scroll cleanly behind the
 * header instead of bleeding through it. The bottom border lives on the cell because
 * the table uses `border-separate` (required for `position: sticky` to paint borders).
 */
function HeaderCell({ children }: { children: React.ReactNode }) {
  return (
    <th className="sticky top-0 z-10 border-b border-border bg-secondary px-3 py-2 text-left font-medium text-muted-foreground">
      {children}
    </th>
  );
}

function PreviewTable({ rows }: { rows: readonly ImportPreviewRow[] }) {
  const shown = rows.slice(0, MAX_PREVIEW_ROWS);
  const hidden = rows.length - shown.length;
  return (
    <div>
      <div className="max-h-56 overflow-auto rounded-lg border border-border">
        <table className="w-full border-separate border-spacing-0 text-sm">
          {/* Sticky header: each cell carries its own solid background + z-index so
              scrolled rows pass cleanly *behind* it (a translucent `<thead>` let the
              rows show through). */}
          <thead>
            <tr>
              <HeaderCell>#</HeaderCell>
              <HeaderCell>Name</HeaderCell>
              <HeaderCell>Qty</HeaderCell>
              <HeaderCell>SKU</HeaderCell>
              <HeaderCell>Manufacturer</HeaderCell>
              <HeaderCell>Status</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.sourceRow} className="align-top [&>td]:border-b [&>td]:border-border">
                <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{row.sourceRow}</td>
                <td className="px-3 py-1.5 text-foreground">
                  {row.name || <span className="text-muted-foreground">(none)</span>}
                  {row.message ? <span className="block text-xs text-destructive">{row.message}</span> : null}
                </td>
                <td className="px-3 py-1.5 tabular-nums text-foreground">{row.quantity || '—'}</td>
                <td className="px-3 py-1.5 font-mono text-xs text-foreground">{row.sku || '—'}</td>
                <td className="px-3 py-1.5 text-foreground">{row.manufacturer || '—'}</td>
                <td className="px-3 py-1.5">
                  <StatusBadge status={row.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 ? <p className="mt-1 text-xs text-muted-foreground">…and {hidden} more row(s).</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result summary
// ---------------------------------------------------------------------------

function ResultView({ result, onClose }: { result: CatalogApplyResult; onClose: () => void }) {
  const hasSkipped = result.skipped > 0;
  return (
    <div className="space-y-4">
      <SectionHeading>Import complete</SectionHeading>
      <div className="grid grid-cols-3 gap-3">
        <Surface className="p-3 text-center">
          <p className="text-2xl font-bold text-foreground">{result.created}</p>
          <p className="text-xs text-muted-foreground">created</p>
        </Surface>
        <Surface className="p-3 text-center">
          <p className="text-2xl font-bold text-foreground">{result.updated}</p>
          <p className="text-xs text-muted-foreground">updated</p>
        </Surface>
        <Surface className="p-3 text-center">
          <p className={cn('text-2xl font-bold', hasSkipped ? 'text-destructive' : 'text-foreground')}>
            {result.skipped}
          </p>
          <p className="text-xs text-muted-foreground">skipped</p>
        </Surface>
      </div>

      {hasSkipped ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-destructive">
            Rows skipped during import
          </p>
          <ul className="max-h-36 space-y-1 overflow-y-auto">
            {result.rows
              .filter((r) => r.kind === 'skipped')
              .map((r) => (
                <li key={r.sourceRow} className="text-xs text-destructive">
                  <span className="font-medium">Row {r.sourceRow}:</span> {r.error}
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <LiveRegion visuallyHidden data-testid="catalog-import-live-result">
        <p>
          Import complete: {result.created} created, {result.updated} updated
          {result.skipped > 0 ? `, ${result.skipped} skipped` : ''}.
        </p>
      </LiveRegion>

      <div className="flex justify-end">
        <Button onClick={onClose} data-testid="catalog-import-done">
          Done
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared workbench — the engine UI used by both tabs
// ---------------------------------------------------------------------------

function ImportWorkbench({
  text,
  catalogue,
  client,
  onClose,
}: {
  text: string;
  catalogue: Catalogue;
  client: QueryClient;
  onClose: () => void;
}) {
  const formatId = useId();
  const sourceId = useId();
  const matchKeyId = useId();
  const headerId = useId();
  const locationId = useId();
  const trackingId = useId();
  const [formatOverride, setFormatOverride] = useState<ImportFormat | null>(null);
  // 'auto' → detect a known tool from the headers; 'generic' → skip migration mapping
  // and use the plain synonym inference; a source id → force that tool's mapper.
  const [sourceOverride, setSourceOverride] = useState<'auto' | 'generic' | MigrationSourceId>('auto');
  const [hasHeader, setHasHeader] = useState(true);
  const [matchKey, setMatchKey] = useState<MatchKey>('name');
  // Batch defaults, applied to every row that does not specify its own value inline.
  // Empty string means "leave to each row / the catalogue default".
  const [defaultLocationId, setDefaultLocationId] = useState('');
  const [defaultTrackingMode, setDefaultTrackingMode] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const describeError = useErrorMessage();
  const [result, setResult] = useState<CatalogApplyResult | null>(null);

  // Hold the dialog open until the rows have landed (issue #654). The apply never throws for a
  // per-row failure — it returns a report partitioning every row into created / updated /
  // skipped, with the reason for each skip — and this dialog is the only place that report is
  // ever shown. Dismissing part-way through leaves the writes running and discards it, so an
  // import that skipped sixty rows looks exactly like one that landed cleanly.
  useReportDialogBusy(applying);

  // Read a currency price the way the user's own browser locale writes numbers, so a
  // eurozone `€5,99` parses as 5.99 rather than 5. Fixed per session (the locale does not
  // change while the dialog is open).
  const decimalSeparator = useMemo(
    () => decimalSeparatorForLocale(typeof navigator !== 'undefined' ? navigator.language : undefined),
    [],
  );

  const rawExtraction = useMemo(
    () =>
      extractImport(text, {
        ...(formatOverride ? { format: formatOverride } : {}),
        customFields: catalogue.customFields,
        hasHeader,
        decimalSeparator,
      }),
    [text, formatOverride, catalogue.customFields, hasHeader, decimalSeparator],
  );
  const autoDetected = formatOverride === null;

  // Recognise a known tool's export from its headers and, unless the user has forced a
  // "generic" import, reshape the columns through that tool's migration mapper *before*
  // the (unchanged) plan builder sees them.
  const detectedSource = useMemo(
    () =>
      rawExtraction.isTabular && rawExtraction.headerRow.length > 0
        ? detectMigrationSource(rawExtraction.headerRow)
        : null,
    [rawExtraction],
  );
  const activeSource: MigrationSourceId | null =
    sourceOverride === 'generic' ? null : sourceOverride === 'auto' ? detectedSource : sourceOverride;
  const extraction = useMemo(
    () => (activeSource ? applyMigration(rawExtraction, activeSource) : rawExtraction),
    [rawExtraction, activeSource],
  );

  // The mapping is re-seeded from the extraction whenever the tabular structure
  // (format + column set) changes, but preserved while the user tweaks it. The column
  // set is serialised with JSON so distinct sets can never collide into one key
  // (['ab'] vs ['a','b']), which a plain join could.
  const structureKey = `${extraction.format}|${JSON.stringify(extraction.columns)}`;
  const [mappingState, setMappingState] = useState(() => ({
    key: structureKey,
    mapping: extraction.mapping,
  }));
  const mapping = mappingState.key === structureKey ? mappingState.mapping : extraction.mapping;
  useEffect(() => {
    if (mappingState.key !== structureKey) {
      setMappingState({ key: structureKey, mapping: extraction.mapping });
    }
  }, [structureKey, extraction.mapping, mappingState.key]);

  const plan = useMemo(
    () =>
      buildImportPlan(extraction, mapping, catalogue.items, {
        matchKey,
        customFields: catalogue.customFields,
        locations: catalogue.locations,
        ...(defaultLocationId ? { defaultLocationId } : {}),
        ...(defaultTrackingMode ? { defaultTrackingMode: defaultTrackingMode as TrackingMode } : {}),
      }),
    [
      extraction,
      mapping,
      catalogue.items,
      catalogue.customFields,
      catalogue.locations,
      matchKey,
      defaultLocationId,
      defaultTrackingMode,
    ],
  );
  const previewRows = useMemo(
    () => buildPreviewRows(extraction.dataRows, mapping, plan),
    [extraction.dataRows, mapping, plan],
  );

  const actionable = plan.create.length + plan.update.length;
  const hasInput = extraction.dataRows.length > 0;
  const hasText = text.trim().length > 0;

  const updateMapping = (index: number, field: CatalogField | null) => {
    const next = [...mapping];
    next[index] = field;
    setMappingState({ key: structureKey, mapping: next });
  };

  const handleApply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const res = await applyCatalogImportPlan(
        plan,
        getItemRepository(),
        getCategoryRepository(),
        getTagRepository(),
      );
      setResult(res);
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
      // A mapped tag column can auto-create tags, so the dictionary itself has moved — the
      // per-item tag reads already sit under the items() prefix `invalidateItems` covers.
      void client.invalidateQueries({ queryKey: inventoryKeys.tags() });
    } catch (err) {
      setApplyError(describeError(err, 'The import failed unexpectedly.'));
    } finally {
      setApplying(false);
    }
  };

  if (result) return <ResultView result={result} onClose={onClose} />;

  if (applying) {
    return (
      <div className="flex items-center gap-3 py-8 text-muted-foreground">
        <Spinner />
        Importing…
      </div>
    );
  }

  if (!hasText) {
    return (
      <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        Nothing to import yet — add some data and a live preview will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* Migration source — reshape another tool's export before the shared pipeline */}
      <div className="space-y-1">
        <span
          id={`${sourceId}-label`}
          className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Import source
        </span>
        <Select
          id={sourceId}
          aria-labelledby={`${sourceId}-label`}
          value={sourceOverride}
          onChange={(value) => setSourceOverride(value as 'auto' | 'generic' | MigrationSourceId)}
          className="h-9"
          data-testid="import-source"
          options={[
            { value: 'auto', label: 'Auto-detect' },
            { value: 'generic', label: 'Generic (spreadsheet / CSV)' },
            ...MIGRATION_SOURCE_IDS.map((id) => ({ value: id, label: MIGRATION_SOURCE_LABELS[id] })),
          ]}
        />
        {activeSource ? (
          <p className="text-xs text-muted-foreground" data-testid="import-source-note">
            {sourceOverride === 'auto'
              ? // Phrased as "an export from X" so the sentence stays grammatical for every
                // source label — "a LCSC" / "a InvenTree" would both take the wrong article.
                `Recognised an export from ${MIGRATION_SOURCE_LABELS[activeSource]} — `
              : ''}
            columns mapped to Gubbins fields; anything unrecognised is kept in each item’s notes.{' '}
            {MIGRATION_SOURCE_HINTS[activeSource]}
          </p>
        ) : sourceOverride === 'auto' ? (
          <p className="text-xs text-muted-foreground">
            No known tool detected — import as generic spreadsheet data. Supported migrations:{' '}
            {MIGRATION_SOURCE_IDS.map((id) => MIGRATION_SOURCE_LABELS[id]).join(', ')}.
          </p>
        ) : null}
      </div>

      {/* Format + match-key controls */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-field-gap-compact">
          <span
            id={`${formatId}-label`}
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Interpret as
          </span>
          <Select
            id={formatId}
            aria-labelledby={`${formatId}-label`}
            value={formatOverride ?? 'auto'}
            onChange={(value) => setFormatOverride(value === 'auto' ? null : (value as ImportFormat))}
            className="h-9"
            options={[
              { value: 'auto', label: 'Auto-detect' },
              ...IMPORT_FORMATS.map((f) => ({ value: f, label: IMPORT_FORMAT_LABELS[f] })),
            ]}
          />
          {autoDetected ? (
            <p className="text-xs text-muted-foreground">
              Detected: {IMPORT_FORMAT_LABELS[extraction.format]}
            </p>
          ) : null}
        </div>
        <div className="space-y-field-gap-compact">
          <span
            id={`${matchKeyId}-label`}
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Match existing items by
          </span>
          <Select
            id={matchKeyId}
            aria-labelledby={`${matchKeyId}-label`}
            value={matchKey}
            onChange={(value) => setMatchKey(value as MatchKey)}
            className="h-9"
            data-testid="catalog-import-match-key"
            options={[
              { value: 'name', label: 'Name' },
              { value: 'sku', label: 'SKU / MPN' },
            ]}
          />
        </div>
      </div>

      {/* Batch location + tracking defaults (applied to rows that don't specify their own) */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <span
            id={`${locationId}-label`}
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Location for imported items
          </span>
          <Select
            id={locationId}
            aria-labelledby={`${locationId}-label`}
            value={defaultLocationId}
            onChange={setDefaultLocationId}
            className="h-9"
            data-testid="import-default-location"
            options={[
              { value: '', label: 'Unassigned (or inline “loc:”)' },
              ...catalogue.locations.map((loc) => ({ value: loc.id, label: loc.name })),
            ]}
          />
        </div>
        <div className="space-y-1">
          <span
            id={`${trackingId}-label`}
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Tracking for new items
          </span>
          <Select
            id={trackingId}
            aria-labelledby={`${trackingId}-label`}
            value={defaultTrackingMode}
            onChange={setDefaultTrackingMode}
            className="h-9"
            data-testid="import-default-tracking"
            options={[
              { value: '', label: 'Bulk (or inline “track:”)' },
              ...TRACKING_MODES.map((mode) => ({ value: mode, label: TRACKING_MODE_LABELS[mode] })),
            ]}
          />
        </div>
      </div>

      {/* Header-row toggle (delimited formats only) */}
      {isDelimitedFormat(extraction.format) ? (
        <label htmlFor={headerId} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <Checkbox id={headerId} checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
          The first row is a header row
        </label>
      ) : null}

      {/* Non-fatal parse note (e.g. malformed JSON) */}
      {extraction.note ? (
        <p
          role="status"
          className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning"
        >
          {extraction.note}
        </p>
      ) : null}

      {hasInput ? (
        <>
          {/* Column mapping (tabular formats only) */}
          {extraction.isTabular ? (
            <div className="space-y-2">
              <SectionHeading>Map columns</SectionHeading>
              <MappingTable columns={extraction.columns} mapping={mapping} onChange={updateMapping} />
            </div>
          ) : null}

          {/* Extracted-items preview */}
          <div className="space-y-2">
            <SectionHeading>Preview — extracted items</SectionHeading>
            <PreviewTable rows={previewRows} />
          </div>

          {/* Counts */}
          <div className="grid grid-cols-3 gap-3">
            <Surface className="p-3 text-center">
              <p className="text-2xl font-bold text-foreground">{plan.create.length}</p>
              <p className="text-xs text-muted-foreground">to create</p>
            </Surface>
            <Surface className="p-3 text-center">
              <p className="text-2xl font-bold text-foreground">{plan.update.length}</p>
              <p className="text-xs text-muted-foreground">to update</p>
            </Surface>
            <Surface className="p-3 text-center">
              <p
                className={cn(
                  'text-2xl font-bold',
                  plan.errors.length > 0 ? 'text-destructive' : 'text-foreground',
                )}
              >
                {plan.errors.length}
              </p>
              <p className="text-xs text-muted-foreground">errors (skipped)</p>
            </Surface>
          </div>

          {plan.errors.length > 0 ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
              data-testid="catalog-import-errors"
            >
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-destructive">
                Rows with errors — these will be skipped
              </p>
              <ul className="max-h-28 space-y-1 overflow-y-auto">
                {plan.errors.map((err) => (
                  <li key={err.sourceRow} className="text-xs text-destructive">
                    <span className="font-medium">Row {err.sourceRow}:</span> {err.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {applyError ? (
            <p role="alert" className="text-sm text-destructive">
              {applyError}
            </p>
          ) : null}

          <div className="flex justify-end">
            <Button
              onClick={() => void handleApply()}
              disabled={actionable === 0}
              data-testid="catalog-import-apply"
            >
              <ImportIcon />
              Import {actionable} {plural(actionable, 'row')}
            </Button>
          </div>
        </>
      ) : extraction.note ? null : (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No items found in this data. Try a different format above, or adjust your input.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab inputs
// ---------------------------------------------------------------------------

function TextInputPanel({ text, onTextChange }: { text: string; onTextChange: (text: string) => void }) {
  const inputId = useId();
  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
        Paste or type your items
      </label>
      <p className="text-sm text-muted-foreground">
        Paste tabular data from a spreadsheet, CSV/TSV, JSON, a Markdown or HTML table, or just one item per
        line with shorthand like <span className="font-mono text-xs">Resistor 10k x50</span>. Per line you can
        label extra details: <span className="font-mono text-xs">sku:</span>,{' '}
        <span className="font-mono text-xs">manu:</span>, <span className="font-mono text-xs">q:</span>,{' '}
        <span className="font-mono text-xs">loc:</span> and <span className="font-mono text-xs">track:</span>{' '}
        (e.g. <span className="font-mono text-xs">Multimeter manu: Fluke loc: Bench track: serialised</span>).
        An <span className="font-mono text-xs">Amazon ASIN</span> or listing URL is read as the SKU and a
        currency price as the unit cost, so you can paste an Amazon invoice (e.g.{' '}
        <span className="font-mono text-xs">USB-C cable B0F3XF5ZKF £9.99 x2</span>). The format is detected
        automatically — override it with “Interpret as” below.
      </p>
      <Textarea
        sizeKey="import.items"
        id={inputId}
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        rows={6}
        className="font-mono text-xs"
        placeholder={'Resistor 10k x50\nCapacitor 100nF, sku: C-100\n3x Arduino Uno manu: Arduino'}
        data-testid="import-text-input"
        spellCheck={false}
      />
    </div>
  );
}

function FileInputPanel({
  filename,
  read,
  onRead,
  onFileLoaded,
}: {
  filename: string | null;
  /** The last file-read outcome — held by the dialog so it survives a tab switch. */
  read: ImportFileRead | null;
  onRead: (read: ImportFileRead | null) => void;
  onFileLoaded: (text: string, name: string) => void;
}) {
  const inputId = useId();
  const f = useFormatters();
  const [busy, setBusy] = useState(false);

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    onRead(null);
    setBusy(true);
    // Every exit from the read — success, refusal, or a throw out of the consumer — must clear
    // `busy`, or the panel is stuck on "Reading file…" until the dialog is reopened.
    try {
      // The size cap, binary sniff and strict decode all live in the shared seam, so every
      // importer refuses the same files for the same stated reasons (issue #347).
      const result = await readImportFile(file);
      onRead(result);
      if (result.ok) onFileLoaded(result.text, file.name);
    } catch {
      onRead({ ok: false, rejection: { reason: 'unreadable' } });
    } finally {
      setBusy(false);
      // Clear the input so picking the *same* path again still fires a change event — otherwise
      // fixing a refused file in place and re-choosing it looks like a dead control.
      input.value = '';
    }
  };

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
        Choose a file
      </label>
      <p className="text-sm text-muted-foreground">
        A <span className="font-mono text-xs">.csv</span>, <span className="font-mono text-xs">.tsv</span>,{' '}
        <span className="font-mono text-xs">.json</span>, <span className="font-mono text-xs">.md</span>,{' '}
        <span className="font-mono text-xs">.html</span>, or plain{' '}
        <span className="font-mono text-xs">.txt</span> file — the format is detected from the contents.
      </p>
      <label
        htmlFor={inputId}
        className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border p-8 text-center transition-colors hover:border-primary hover:bg-primary/5"
      >
        <UploadIcon className="size-8 text-muted-foreground" />
        <span className="text-sm font-medium">
          {filename ? `Loaded: ${filename}` : 'Click to choose a file'}
        </span>
        <span className="text-xs text-muted-foreground">
          {filename
            ? 'Choose another file to replace it'
            : // The cap is stated up front rather than only on refusal, and read from the seam so
              // the two can never disagree.
              `CSV, TSV, JSON, Markdown, HTML or text — up to ${f.bytes(MAX_IMPORT_FILE_BYTES)}`}
        </span>
        <input
          id={inputId}
          type="file"
          accept=".csv,.tsv,.tab,.txt,.json,.md,.markdown,.html,.htm,text/csv,text/tab-separated-values,text/plain,application/json,text/markdown,text/html"
          className="sr-only"
          onChange={(e) => void handleChange(e)}
          data-testid="catalog-import-file"
        />
      </label>
      {busy ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Reading file…
        </div>
      ) : null}
      <ImportFileBanner read={read} data-testid="catalog-import-file-notice" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab rail
// ---------------------------------------------------------------------------

type ImportTab = 'text' | 'file';

function TabButton({
  active,
  onClick,
  icon,
  children,
  testid,
  controls,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  testid: string;
  controls: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      data-testid={testid}
      className={cn(
        'flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Dialog shell
// ---------------------------------------------------------------------------

export function ImportDataDialog({
  open,
  onClose,
  initialText,
  initialFilename,
  initialFileRead,
}: {
  open: boolean;
  onClose: () => void;
  /** Seed the workbench with file contents — e.g. a file opened via the OS (plan EI-4). */
  initialText?: string;
  /** The name of the seeded file, shown on the File tab. */
  initialFilename?: string;
  /**
   * The read outcome of that launched file, when there is one. A refused launch file seeds no
   * text, so this is what lets the File tab say *why* instead of showing an unexplained blank
   * workbench (issue #347).
   */
  initialFileRead?: ImportFileRead;
}) {
  const client = useQueryClient();
  const panelId = useId();
  // When opened with a File Handling launch, land on the File tab so the provenance (filename, or
  // why the file was refused) is visible; otherwise the Text tab is the default entry point.
  const [tab, setTab] = useState<ImportTab>(initialText != null || initialFileRead != null ? 'file' : 'text');
  const [text, setText] = useState(initialText ?? '');
  const [filename, setFilename] = useState<string | null>(initialFilename ?? null);
  const [fileRead, setFileRead] = useState<ImportFileRead | null>(initialFileRead ?? null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load the catalogue once each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCatalogue(null);
    setLoadError(null);
    void (async () => {
      try {
        const [items, customFields, locations] = await Promise.all([
          loadAllItems(),
          loadAllCustomFields(),
          loadAllLocations(),
        ]);
        if (!cancelled) setCatalogue({ items, customFields, locations });
      } catch {
        if (!cancelled) setLoadError('Could not load the existing catalogue — please try again.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleClose = () => {
    setTab('text');
    setText('');
    setFilename(null);
    setFileRead(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Import items"
      description="Bring items in from pasted text or a file."
      className="w-full max-w-4xl"
    >
      <div className="flex flex-col gap-5 sm:flex-row">
        <div
          role="tablist"
          aria-label="Import method"
          aria-orientation="vertical"
          className="flex shrink-0 flex-row gap-1 sm:w-44 sm:flex-col"
        >
          <TabButton
            active={tab === 'text'}
            onClick={() => setTab('text')}
            icon={<DatasheetIcon className="size-4" />}
            testid="import-tab-text"
            controls={panelId}
          >
            Import text
          </TabButton>
          <TabButton
            active={tab === 'file'}
            onClick={() => setTab('file')}
            icon={<UploadIcon className="size-4" />}
            testid="import-tab-file"
            controls={panelId}
          >
            Import file
          </TabButton>
        </div>

        <div id={panelId} role="tabpanel" className="min-w-0 flex-1 space-y-5">
          {tab === 'text' ? (
            <TextInputPanel
              text={text}
              onTextChange={(t) => {
                setText(t);
                setFilename(null);
                setFileRead(null);
              }}
            />
          ) : (
            <FileInputPanel
              filename={filename}
              read={fileRead}
              onRead={setFileRead}
              onFileLoaded={(t, name) => {
                setText(t);
                setFilename(name);
              }}
            />
          )}

          <div className="border-t border-border pt-4">
            {loadError ? (
              <p role="alert" className="text-sm text-destructive">
                {loadError}
              </p>
            ) : catalogue ? (
              <ImportWorkbench text={text} catalogue={catalogue} client={client} onClose={handleClose} />
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                Loading your catalogue…
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
