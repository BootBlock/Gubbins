/**
 * Reorder / Shopping-list tab (Phase 65).
 *
 * Shows items currently below their reorder point, grouped by preferred supplier, with
 * editable order quantities per line and a "Create draft PO" button per supplier group.
 * The "Unassigned" group (items with no preferred supplier) is shown but not draftable,
 * with a brief explanation. Mirrors the design-token and accessibility conventions of the
 * rest of the Purchase Orders screen (CLAUDE.md, WCAG 4.1.3).
 */
import { useState, useMemo } from 'react';
import { Button, Surface, Spinner, LiveRegion } from '@/components/foundry';
import { DownloadIcon, LowStockIcon, TruckIcon, WarningIcon } from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import { buildReorderCsv } from './reorder-csv';
import { UNASSIGNED_SUPPLIER_NAME, type ReorderPlanGroup, type ReorderPlanLine } from './reorder-plan';
import { useCreateDraftFromReorderPlan, useReorderPlan } from './queries';

/** Clamp a user-entered order quantity to a sensible range. */
function clampQty(value: number): number {
  return Math.max(1, Math.round(value));
}

/**
 * Download a CSV string as a file without a server round-trip. Uses the same pattern as
 * the existing Export Wizard (`src/features/export/export-data.ts`).
 */
function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReorderTab() {
  const planQuery = useReorderPlan();
  const createDraft = useCreateDraftFromReorderPlan();
  const f = useFormatters();

  /** Per-line quantity overrides (key = `${groupKey}::${itemId}`). */
  const [qtyOverrides, setQtyOverrides] = useState<Map<string, number>>(new Map());

  const plan = planQuery.data ?? [];
  const totalLines = plan.reduce((n, g) => n + g.lines.length, 0);

  /** Build a modified copy of the plan with the user's quantity overrides applied. */
  const effectivePlan = useMemo<readonly ReorderPlanGroup[]>(() => {
    return plan.map((group) => ({
      ...group,
      lines: group.lines.map((line) => {
        const key = `${group.supplierKey}::${line.itemId}`;
        const override = qtyOverrides.get(key);
        return override !== undefined ? { ...line, orderQty: clampQty(override) } : line;
      }),
    }));
  }, [plan, qtyOverrides]);

  function setLineQty(groupKey: string, itemId: string, value: number): void {
    setQtyOverrides((prev) => {
      const next = new Map(prev);
      next.set(`${groupKey}::${itemId}`, value);
      return next;
    });
  }

  function handleExportCsv(): void {
    const csv = buildReorderCsv(effectivePlan);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(csv, `reorder-shopping-list-${stamp}.csv`);
  }

  function handleCreateDraft(group: ReorderPlanGroup): void {
    // Build the plan subset for just this supplier group, applying any qty overrides.
    const effectiveGroup = effectivePlan.find((g) => g.supplierKey === group.supplierKey);
    if (!effectiveGroup) return;
    void createDraft.mutate([effectiveGroup]);
  }

  return (
    <div className="flex flex-col gap-4">
      {/*
       * WCAG 4.1.3 — always-mounted polite status region for the reorder list count.
       * The region must stay in the DOM across loading → loaded → empty so screen
       * readers pick up the text mutation; never early-return before it (the spinner
       * renders as a branch beneath it, not in place of it).
       */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="reorder-list-count-live">
        {planQuery.isLoading
          ? 'Loading reorder list…'
          : totalLines === 0
            ? 'No items below their reorder point.'
            : `${totalLines} item${totalLines === 1 ? '' : 's'} need${totalLines === 1 ? 's' : ''} reordering.`}
      </p>

      {planQuery.isLoading ? (
        <Surface className="flex items-center justify-center p-8">
          <Spinner />
        </Surface>
      ) : plan.length === 0 ? (
        <Surface
          className="flex flex-col items-center gap-3 p-8 text-center text-muted-foreground"
          data-testid="reorder-empty"
        >
          <LowStockIcon className="size-8 opacity-40" />
          <p className="text-sm">No items are currently below their reorder point.</p>
          <p className="text-xs opacity-70">
            Items appear here when on-hand quantity falls at or below their reorder point. Set a reorder point
            on each item in the inventory.
          </p>
        </Surface>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {totalLines} item{totalLines === 1 ? '' : 's'} need{totalLines === 1 ? 's' : ''} reordering
            </p>
            <Button variant="outline" onClick={handleExportCsv} data-testid="reorder-export-csv">
              <DownloadIcon />
              Export CSV
            </Button>
          </div>

          {effectivePlan.map((group) => (
            <ReorderGroup
              key={group.supplierKey}
              group={group}
              currency={f.currency}
              onQtyChange={(itemId, qty) => setLineQty(group.supplierKey, itemId, qty)}
              onCreateDraft={() => handleCreateDraft(group)}
              isCreating={createDraft.isPending}
            />
          ))}

          {/* Announce when drafts are being created */}
          <LiveRegion visuallyHidden data-testid="reorder-draft-live">
            {createDraft.isSuccess ? <p>Draft purchase order(s) created.</p> : null}
            {createDraft.isError ? <p>Failed to create draft purchase order.</p> : null}
          </LiveRegion>
        </>
      )}
    </div>
  );
}

function ReorderGroup({
  group,
  currency,
  onQtyChange,
  onCreateDraft,
  isCreating,
}: {
  group: ReorderPlanGroup;
  currency: (v: number) => string;
  onQtyChange: (itemId: string, qty: number) => void;
  onCreateDraft: () => void;
  isCreating: boolean;
}) {
  const isUnassigned = group.supplierName === UNASSIGNED_SUPPLIER_NAME;
  const estimatedTotal = group.lines.reduce(
    (sum, l) => sum + (l.unitCost != null ? l.orderQty * l.unitCost : 0),
    0,
  );

  return (
    <Surface className="flex flex-col gap-0 overflow-hidden p-0" data-testid="reorder-group">
      {/* Group header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-secondary/30 px-4 py-2">
        <div className="flex items-center gap-2">
          {isUnassigned && <WarningIcon className="size-4 text-glyph-neutral" aria-hidden="true" />}
          <span className="text-sm font-semibold" data-testid="reorder-group-name">
            {group.supplierName}
          </span>
          <span className="text-xs text-muted-foreground">
            {group.lines.length} line{group.lines.length === 1 ? '' : 's'}
          </span>
          {estimatedTotal > 0 && (
            <span className="text-xs text-muted-foreground">· est. {currency(estimatedTotal)}</span>
          )}
        </div>
        {isUnassigned ? (
          <p className="text-xs text-muted-foreground">
            No preferred supplier — set one on each item to draft a PO automatically.
          </p>
        ) : (
          <Button
            variant="primary"
            onClick={onCreateDraft}
            disabled={isCreating}
            data-testid="reorder-create-draft"
          >
            <TruckIcon />
            Create draft PO
          </Button>
        )}
      </div>

      {/* Lines */}
      <ul className="flex flex-col divide-y divide-border px-4" role="list">
        {group.lines.map((line) => (
          <ReorderLine
            key={line.itemId}
            line={line}
            currency={currency}
            onQtyChange={(qty) => onQtyChange(line.itemId, qty)}
          />
        ))}
      </ul>
    </Surface>
  );
}

function ReorderLine({
  line,
  currency,
  onQtyChange,
}: {
  line: ReorderPlanLine;
  currency: (v: number) => string;
  onQtyChange: (qty: number) => void;
}) {
  const [editQty, setEditQty] = useState(String(line.orderQty));

  function commitQty(): void {
    const parsed = Number(editQty);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setEditQty(String(line.orderQty));
      return;
    }
    onQtyChange(Math.round(parsed));
    setEditQty(String(Math.round(parsed)));
  }

  return (
    <li className="flex flex-wrap items-center gap-3 py-2" data-testid="reorder-line">
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{line.itemName}</span>
        {line.unitCost != null && (
          <span className="text-xs text-muted-foreground">{currency(line.unitCost)} each</span>
        )}
      </div>
      <label className="flex items-center gap-1.5 text-sm">
        <span className="text-xs text-muted-foreground">Qty</span>
        <input
          type="number"
          min={1}
          step={1}
          value={editQty}
          onChange={(e) => setEditQty(e.target.value)}
          onBlur={commitQty}
          onKeyDown={(e) => e.key === 'Enter' && commitQty()}
          aria-label={`Order quantity for ${line.itemName}`}
          className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none ring-ring focus:ring-2"
          data-testid="reorder-line-qty"
        />
      </label>
      {line.unitCost != null && (
        <span className="w-24 text-right text-sm tabular-nums text-muted-foreground">
          {currency(line.unitCost * Number(editQty || line.orderQty))}
        </span>
      )}
    </li>
  );
}
