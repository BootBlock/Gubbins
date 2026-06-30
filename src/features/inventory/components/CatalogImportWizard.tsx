/**
 * CatalogImportWizard — a four-step Modal for bulk CSV catalog import (Phase 67).
 *
 * Steps:
 *   1. Upload   — file input; reads the CSV text.
 *   2. Map      — per-column select to assign each header to a logical field.
 *   3. Preview  — create / update counts + per-row error list (role="alert").
 *   4. Apply    — progress + outcome summary.
 *
 * Accessibility: the Foundry Modal traps focus; the error list carries
 * `role="alert"` so screen readers announce validation issues immediately;
 * result counts use the polite `LiveRegion`. The `<main id={MAIN_CONTENT_ID}>`
 * skip target on the Inventory screen is unaffected (this is rendered in a portal
 * by Modal, not inside main). British English throughout.
 */
import { useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, LiveRegion, Modal, Surface, Spinner } from '@/components/foundry';
import { ImportIcon } from '@/components/icons';
import { getItemRepository, type Item } from '@/db/repositories';
import {
  CATALOG_FIELD_LABELS,
  CATALOG_FIELDS,
  buildCatalogImportPlan,
  applyCatalogImportPlan,
  inferColumnMapping,
  parseCsv,
  type CatalogField,
  type CatalogImportPlan,
  type CatalogApplyResult,
  type ColumnMapping,
  type MatchKey,
} from '../catalog-import';
import { inventoryKeys } from '../queries';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StepHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Upload
// ---------------------------------------------------------------------------

function UploadStep({
  onFileLoaded,
}: {
  onFileLoaded: (text: string, filename: string) => void;
}) {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Please choose a CSV file (.csv).');
      return;
    }
    setError(null);
    setBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      setBusy(false);
      onFileLoaded(reader.result as string, file.name);
    };
    reader.onerror = () => {
      setBusy(false);
      setError('Could not read the file — please try again.');
    };
    reader.readAsText(file, 'utf-8');
  };

  return (
    <div className="space-y-4">
      <StepHeading>Step 1 of 4 — Upload CSV</StepHeading>
      <p className="text-sm text-muted-foreground">
        Choose a CSV file exported from a spreadsheet or another inventory system. The first
        row must be a header row; subsequent rows are your items.
      </p>
      <label
        htmlFor={inputId}
        className="flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border p-8 text-center transition-colors hover:border-primary hover:bg-primary/5"
      >
        <ImportIcon className="size-8 text-muted-foreground" />
        <span className="text-sm font-medium">Click to choose a CSV file</span>
        <span className="text-xs text-muted-foreground">UTF-8 encoded, comma-separated</span>
        <input
          id={inputId}
          type="file"
          accept=".csv,text/csv"
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
// Step 2 — Map columns
// ---------------------------------------------------------------------------

function MapStep({
  headers,
  mapping,
  matchKey,
  onMappingChange,
  onMatchKeyChange,
  onNext,
  onBack,
}: {
  headers: readonly string[];
  mapping: ColumnMapping;
  matchKey: MatchKey;
  onMappingChange: (index: number, field: CatalogField | null) => void;
  onMatchKeyChange: (key: MatchKey) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const matchKeyId = useId();

  return (
    <div className="space-y-4">
      <StepHeading>Step 2 of 4 — Map columns</StepHeading>
      <p className="text-sm text-muted-foreground">
        Assign each CSV column to an item field. Unmapped columns are ignored.
      </p>

      <div className="max-h-60 overflow-y-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/30">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">CSV column</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Maps to field</th>
            </tr>
          </thead>
          <tbody>
            {headers.map((header, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                <td className="px-3 py-2 font-mono text-xs text-foreground">{header || '(empty)'}</td>
                <td className="px-3 py-2">
                  <select
                    value={mapping[i] ?? ''}
                    onChange={(e) =>
                      onMappingChange(i, (e.target.value || null) as CatalogField | null)
                    }
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

      <div className="space-y-2">
        <label
          htmlFor={matchKeyId}
          className="block text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Match existing items by
        </label>
        <select
          id={matchKeyId}
          value={matchKey}
          onChange={(e) => onMatchKeyChange(e.target.value as MatchKey)}
          className="w-full rounded-lg border border-border bg-background p-2 text-sm"
          data-testid="catalog-import-match-key"
        >
          <option value="name">Name — match rows to existing items by their name</option>
          <option value="sku">SKU / MPN — match rows to existing items by their MPN</option>
        </select>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext} data-testid="catalog-import-preview">
          Preview →
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Preview
// ---------------------------------------------------------------------------

function PreviewStep({
  plan,
  csvText,
  mapping,
  matchKey,
  existingItems,
  onApply,
  onBack,
}: {
  plan: CatalogImportPlan;
  csvText: string;
  mapping: ColumnMapping;
  matchKey: MatchKey;
  existingItems: readonly Item[];
  onApply: () => void;
  onBack: () => void;
}) {
  const hasErrors = plan.errors.length > 0;
  const canApply = plan.create.length > 0 || plan.update.length > 0;

  // Rebuild a fresh plan whenever needed (e.g. if the user tweaked mapping).
  // The plan passed in is already fresh from the parent, so we just display it.
  void csvText; void mapping; void matchKey; void existingItems; // consumed upstream

  return (
    <div className="space-y-4">
      <StepHeading>Step 3 of 4 — Preview</StepHeading>

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
          <p className={`text-2xl font-bold ${hasErrors ? 'text-destructive' : 'text-foreground'}`}>
            {plan.errors.length}
          </p>
          <p className="text-xs text-muted-foreground">errors (skipped)</p>
        </Surface>
      </div>

      {hasErrors ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
          data-testid="catalog-import-errors"
        >
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-destructive">
            Rows with errors — these will be skipped
          </p>
          <ul className="max-h-36 overflow-y-auto space-y-1">
            {plan.errors.map((err) => (
              <li key={err.sourceRow} className="text-xs text-destructive">
                <span className="font-medium">Row {err.sourceRow}:</span> {err.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!canApply && !hasErrors ? (
        <p className="text-sm text-muted-foreground">
          No actionable rows found. Check your column mapping and try again.
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          onClick={onApply}
          disabled={!canApply}
          data-testid="catalog-import-apply"
        >
          <ImportIcon />
          Import {plan.create.length + plan.update.length} rows
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Result
// ---------------------------------------------------------------------------

function ResultStep({
  result,
  onClose,
}: {
  result: CatalogApplyResult;
  onClose: () => void;
}) {
  const hasSkipped = result.skipped > 0;

  return (
    <div className="space-y-4">
      <StepHeading>Step 4 of 4 — Done</StepHeading>

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
          <p className={`text-2xl font-bold ${hasSkipped ? 'text-destructive' : 'text-foreground'}`}>
            {result.skipped}
          </p>
          <p className="text-xs text-muted-foreground">skipped</p>
        </Surface>
      </div>

      {hasSkipped ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
        >
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-destructive">
            Rows skipped during apply
          </p>
          <ul className="max-h-36 overflow-y-auto space-y-1">
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
// Wizard state machine
// ---------------------------------------------------------------------------

type WizardStep = 'upload' | 'map' | 'preview' | 'result';

/**
 * The four-step CSV catalog import wizard (Phase 67). Launched from the Inventory
 * screen toolbar as a Foundry Modal. Does not add a new route.
 */
export function CatalogImportWizard({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();

  const [step, setStep] = useState<WizardStep>('upload');
  const [csvText, setCsvText] = useState('');
  const [filename, setFilename] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  const [matchKey, setMatchKey] = useState<MatchKey>('name');
  const [plan, setPlan] = useState<CatalogImportPlan | null>(null);
  const [applyResult, setApplyResult] = useState<CatalogApplyResult | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  // Existing items snapshot loaded when the user reaches the map step.
  const existingItemsRef = useRef<Item[]>([]);

  const reset = () => {
    setStep('upload');
    setCsvText('');
    setFilename('');
    setHeaders([]);
    setMapping([]);
    setMatchKey('name');
    setPlan(null);
    setApplyResult(null);
    setApplying(false);
    setApplyError(null);
    existingItemsRef.current = [];
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // Step 1 → 2: file loaded.
  const handleFileLoaded = async (text: string, name: string) => {
    setCsvText(text);
    setFilename(name);

    const allRows = parseCsv(text).filter((r) => r.some((c) => c.trim().length > 0));
    const headerRow: string[] = allRows[0] ?? [];
    setHeaders(headerRow);
    const auto = inferColumnMapping(headerRow);
    setMapping(auto);

    // Load existing items for create-vs-update matching.
    const repo = getItemRepository();
    const all: Item[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await repo.list({ limit: 100, offset, includeInactive: true });
      all.push(...page.rows);
      if (!page.hasMore) break;
    }
    existingItemsRef.current = all;

    setStep('map');
  };

  // Step 2: mapping changed.
  const handleMappingChange = (index: number, field: CatalogField | null) => {
    setMapping((prev) => {
      const next = [...prev];
      next[index] = field;
      return next;
    });
  };

  // Step 2 → 3: build the plan.
  const handlePreview = () => {
    const p = buildCatalogImportPlan(csvText, mapping, existingItemsRef.current, { matchKey });
    setPlan(p);
    setStep('preview');
  };

  // Step 3 → 4: apply the plan.
  const handleApply = async () => {
    if (!plan) return;
    setApplying(true);
    setApplyError(null);
    try {
      const repo = getItemRepository();
      const result = await applyCatalogImportPlan(plan, repo);
      setApplyResult(result);
      setStep('result');
      // Invalidate the inventory list so new items appear immediately.
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'The import failed unexpectedly.');
    } finally {
      setApplying(false);
    }
  };

  const stepTitle: Record<WizardStep, string> = {
    upload: 'Import catalogue CSV',
    map: 'Import catalogue CSV',
    preview: 'Import catalogue CSV',
    result: 'Import catalogue CSV',
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={stepTitle[step]}
      description={filename ? `File: ${filename}` : 'Import items from a spreadsheet.'}
    >
      {step === 'upload' ? (
        <UploadStep onFileLoaded={(t, n) => void handleFileLoaded(t, n)} />
      ) : step === 'map' ? (
        <MapStep
          headers={headers}
          mapping={mapping}
          matchKey={matchKey}
          onMappingChange={handleMappingChange}
          onMatchKeyChange={setMatchKey}
          onNext={handlePreview}
          onBack={() => setStep('upload')}
        />
      ) : step === 'preview' && plan ? (
        <>
          {applying ? (
            <div className="flex items-center gap-3 py-8 text-muted-foreground">
              <Spinner />
              Importing…
            </div>
          ) : (
            <PreviewStep
              plan={plan}
              csvText={csvText}
              mapping={mapping}
              matchKey={matchKey}
              existingItems={existingItemsRef.current}
              onApply={() => void handleApply()}
              onBack={() => setStep('map')}
            />
          )}
          {applyError ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {applyError}
            </p>
          ) : null}
        </>
      ) : step === 'result' && applyResult ? (
        <ResultStep result={applyResult} onClose={handleClose} />
      ) : null}
    </Modal>
  );
}
