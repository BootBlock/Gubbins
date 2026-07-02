/**
 * ImportDataDialog — a generalised, tabbed bulk-import Modal (Phase: generalised
 * import dialog). Supersedes the single-purpose four-step catalogue-CSV wizard by
 * folding it into a wider dialog with a left-hand tab rail:
 *
 *   - "Import text" — paste or type items; the extraction is previewed live as
 *     items (auto-detecting CSV / TSV / free-form line lists) so the user can see
 *     exactly how their text will land before committing.
 *   - "Import file" — choose a `.csv` / `.tsv` / `.txt` file; its contents flow
 *     through the *same* engine and preview.
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
import { Button, LiveRegion, Modal, Select, Spinner, Surface, Textarea } from '@/components/foundry';
import { cn } from '@/lib/utils';
import { DatasheetIcon, ImportIcon, UploadIcon } from '@/components/icons';
import { getCategoryRepository, getItemRepository, type CategoryField, type Item } from '@/db/repositories';
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
  buildImportPlan,
  buildPreviewRows,
  extractImport,
  isDelimitedFormat,
  type ImportFormat,
  type ImportPreviewRow,
} from '../text-import';
import { inventoryKeys } from '../queries';

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

interface Catalogue {
  readonly items: readonly Item[];
  readonly customFields: readonly CategoryField[];
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
                <select
                  value={
                    isCustomFieldTarget(mapping[i] ?? null) ? '' : ((mapping[i] as CatalogField | null) ?? '')
                  }
                  onChange={(e) => onChange(i, (e.target.value || null) as CatalogField | null)}
                  className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
                  aria-label={`Field for column ${header || i + 1}`}
                >
                  <option value="">(ignore)</option>
                  {CATALOG_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {CATALOG_FIELD_LABELS[f]}
                    </option>
                  ))}
                </select>
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

function PreviewTable({ rows }: { rows: readonly ImportPreviewRow[] }) {
  const shown = rows.slice(0, MAX_PREVIEW_ROWS);
  const hidden = rows.length - shown.length;
  return (
    <div>
      <div className="max-h-56 overflow-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-secondary/40 backdrop-blur">
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">#</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Name</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Qty</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">SKU</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.sourceRow} className="border-b border-border last:border-0 align-top">
                <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{row.sourceRow}</td>
                <td className="px-3 py-1.5 text-foreground">
                  {row.name || <span className="text-muted-foreground">(none)</span>}
                  {row.message ? <span className="block text-xs text-destructive">{row.message}</span> : null}
                </td>
                <td className="px-3 py-1.5 tabular-nums text-foreground">{row.quantity || '—'}</td>
                <td className="px-3 py-1.5 font-mono text-xs text-foreground">{row.sku || '—'}</td>
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
  const matchKeyId = useId();
  const headerId = useId();
  const [formatOverride, setFormatOverride] = useState<ImportFormat | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [matchKey, setMatchKey] = useState<MatchKey>('name');
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [result, setResult] = useState<CatalogApplyResult | null>(null);

  const extraction = useMemo(
    () =>
      extractImport(text, {
        ...(formatOverride ? { format: formatOverride } : {}),
        customFields: catalogue.customFields,
        hasHeader,
      }),
    [text, formatOverride, catalogue.customFields, hasHeader],
  );
  const autoDetected = formatOverride === null;

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
      }),
    [extraction, mapping, catalogue.items, catalogue.customFields, matchKey],
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
      const res = await applyCatalogImportPlan(plan, getItemRepository(), getCategoryRepository());
      setResult(res);
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'The import failed unexpectedly.');
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
      {/* Format + match-key controls */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label
            htmlFor={formatId}
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Interpret as
          </label>
          <Select
            id={formatId}
            value={formatOverride ?? 'auto'}
            onChange={(e) =>
              setFormatOverride(e.target.value === 'auto' ? null : (e.target.value as ImportFormat))
            }
            className="h-9"
          >
            <option value="auto">Auto-detect</option>
            {IMPORT_FORMATS.map((f) => (
              <option key={f} value={f}>
                {IMPORT_FORMAT_LABELS[f]}
              </option>
            ))}
          </Select>
          {autoDetected ? (
            <p className="text-xs text-muted-foreground">
              Detected: {IMPORT_FORMAT_LABELS[extraction.format]}
            </p>
          ) : null}
        </div>
        <div className="space-y-1">
          <label
            htmlFor={matchKeyId}
            className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Match existing items by
          </label>
          <Select
            id={matchKeyId}
            value={matchKey}
            onChange={(e) => setMatchKey(e.target.value as MatchKey)}
            className="h-9"
            data-testid="catalog-import-match-key"
          >
            <option value="name">Name</option>
            <option value="sku">SKU / MPN</option>
          </Select>
        </div>
      </div>

      {/* Header-row toggle (delimited formats only) */}
      {isDelimitedFormat(extraction.format) ? (
        <label htmlFor={headerId} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input
            id={headerId}
            type="checkbox"
            checked={hasHeader}
            onChange={(e) => setHasHeader(e.target.checked)}
            className="size-4 rounded border-border"
          />
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
              Import {actionable} row{actionable === 1 ? '' : 's'}
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
        Paste tabular data from a spreadsheet, CSV/TSV, JSON, a Markdown table, or just one item per line with
        shorthand like <span className="font-mono text-xs">Resistor 10k x50</span>. The format is detected
        automatically — override it with “Interpret as” below.
      </p>
      <Textarea
        id={inputId}
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        rows={6}
        className="font-mono text-xs"
        placeholder={'Resistor 10k x50\nCapacitor 100nF\n3x Arduino Uno, sku: ARD-UNO'}
        data-testid="import-text-input"
        spellCheck={false}
      />
    </div>
  );
}

function FileInputPanel({
  filename,
  onFileLoaded,
}: {
  filename: string | null;
  onFileLoaded: (text: string, name: string) => void;
}) {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      onFileLoaded(reader.result as string, file.name);
      setBusy(false);
    };
    reader.onerror = () => {
      setBusy(false);
      setError('Could not read the file — please try again.');
    };
    reader.readAsText(file, 'utf-8');
  };

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
        Choose a file
      </label>
      <p className="text-sm text-muted-foreground">
        A <span className="font-mono text-xs">.csv</span>, <span className="font-mono text-xs">.tsv</span>,{' '}
        <span className="font-mono text-xs">.json</span>, <span className="font-mono text-xs">.md</span>, or
        plain <span className="font-mono text-xs">.txt</span> file — the format is detected from the contents.
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
          {filename ? 'Choose another file to replace it' : 'CSV, TSV, JSON, Markdown or text (UTF-8)'}
        </span>
        <input
          id={inputId}
          type="file"
          accept=".csv,.tsv,.tab,.txt,.json,.md,.markdown,text/csv,text/tab-separated-values,text/plain,application/json,text/markdown"
          className="sr-only"
          onChange={handleChange}
          data-testid="catalog-import-file"
        />
      </label>
      {busy ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Reading file…
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
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

export function ImportDataDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const panelId = useId();
  const [tab, setTab] = useState<ImportTab>('text');
  const [text, setText] = useState('');
  const [filename, setFilename] = useState<string | null>(null);
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
        const [items, customFields] = await Promise.all([loadAllItems(), loadAllCustomFields()]);
        if (!cancelled) setCatalogue({ items, customFields });
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
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Import items"
      description="Bring items in from pasted text or a file."
      className="w-full max-w-4xl max-h-[85vh] overflow-y-auto"
    >
      <div className="flex flex-col gap-5 sm:flex-row">
        <nav
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
        </nav>

        <div id={panelId} role="tabpanel" className="min-w-0 flex-1 space-y-5">
          {tab === 'text' ? (
            <TextInputPanel
              text={text}
              onTextChange={(t) => {
                setText(t);
                setFilename(null);
              }}
            />
          ) : (
            <FileInputPanel
              filename={filename}
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
