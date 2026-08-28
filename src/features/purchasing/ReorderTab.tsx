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
import { Button, Input, Surface, Spinner, LiveRegion } from '@/components/foundry';
import { LowStockIcon, TruckIcon, WarningIcon } from '@/components/icons';
import { TabularExportMenu } from '@/features/export/TabularExportMenu';
import { useT } from '@/features/i18n';
import { plural } from '@/lib/plural';
import { useFormatters } from '@/lib/useFormatters';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { buildReorderExport } from './reorder-export';
import type { ReorderPlanGroup, ReorderPlanLine } from './reorder-plan';
import { useCreateDraftFromReorderPlan, useReorderPlan } from './queries';

/** Clamp a user-entered order quantity to a sensible range. */
function clampQty(value: number): number {
  return Math.max(1, Math.round(value));
}

export function ReorderTab() {
  const planQuery = useReorderPlan();
  const createDraft = useCreateDraftFromReorderPlan();
  const f = useFormatters();
  const t = useT();
  // What a line quoting no currency of its own is priced in, so the export can state one on
  // every row rather than leaving the reader to guess (issue #569).
  const baseCurrency = usePreferencesStore((s) => s.baseCurrency);

  /** Per-line quantity overrides (key = `${groupKey}::${itemId}`). */
  const [qtyOverrides, setQtyOverrides] = useState<Map<string, number>>(new Map());

  const plan = useMemo(() => planQuery.data ?? [], [planQuery.data]);
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
            : `${totalLines} ${plural(totalLines, 'item')} need${totalLines === 1 ? 's' : ''} reordering.`}
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
              {totalLines} {plural(totalLines, 'item')} need{totalLines === 1 ? 's' : ''} reordering
            </p>
            <TabularExportMenu
              build={(format) => buildReorderExport(effectivePlan, format, baseCurrency)}
              filename={(extension) =>
                `reorder-shopping-list-${new Date().toISOString().slice(0, 10)}.${extension}`
              }
              triggerLabel="Export"
              menuLabel="Export reorder list"
              toastHeading="Reorder list exported"
              testIdPrefix="reorder-export"
            />
          </div>

          {effectivePlan.map((group) => (
            <ReorderGroup
              key={group.supplierKey}
              group={group}
              currency={f.currency}
              mixedCurrencyLabel={t('purchasing.reorder.mixedCurrency')}
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
  mixedCurrencyLabel,
  onQtyChange,
  onCreateDraft,
  isCreating,
}: {
  group: ReorderPlanGroup;
  currency: (value: number, currencyOverride?: string) => string;
  mixedCurrencyLabel: string;
  onQtyChange: (itemId: string, qty: number) => void;
  onCreateDraft: () => void;
  isCreating: boolean;
}) {
  // Identity, not spelling: a real supplier could legitimately be *named* "Unassigned", so the
  // ungrouped bucket is the one with no supplier at all.
  const isUnassigned = group.supplierId === null;
  // A supplier quoting in two currencies has no total: Gubbins holds no exchange rates, so the
  // only honest sum is none at all (issue #569). The lines still show their own prices.
  const estimatedTotal = group.hasMixedCurrency
    ? null
    : group.lines.reduce((sum, l) => sum + (l.unitCost != null ? l.orderQty * l.unitCost : 0), 0);

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
            {group.lines.length} {plural(group.lines.length, 'line')}
          </span>
          {group.hasMixedCurrency ? (
            <span className="text-xs text-muted-foreground" data-testid="reorder-group-mixed-currency">
              · {mixedCurrencyLabel}
            </span>
          ) : estimatedTotal !== null && estimatedTotal > 0 ? (
            <span className="text-xs text-muted-foreground">
              · est. {currency(estimatedTotal, group.currency ?? undefined)}
            </span>
          ) : null}
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
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- the flex layout drops the <ul>'s implicit list semantics in Safari/VoiceOver, so role="list" is restored deliberately. */}
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
  currency: (value: number, currencyOverride?: string) => string;
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
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {/* Under the supplier's own symbol, never the base one — a €12.00 quote shown as
              £12.00 misstates the price by the exchange rate (issue #569). */}
          {line.unitCost != null && <span>{currency(line.unitCost, line.currency ?? undefined)} each</span>}
          {line.onOrder > 0 && (
            <span
              className="inline-flex items-center gap-1 [&_svg]:size-3"
              data-testid="reorder-line-on-order"
            >
              <TruckIcon aria-hidden />
              {line.onOrder} on order
            </span>
          )}
        </span>
      </div>
      <label className="flex items-center gap-1.5 text-sm">
        <span className="text-xs text-muted-foreground">Qty</span>
        <Input
          type="number"
          min={1}
          step={1}
          value={editQty}
          onChange={(e) => setEditQty(e.target.value)}
          onBlur={commitQty}
          onKeyDown={(e) => e.key === 'Enter' && commitQty()}
          aria-label={`Order quantity for ${line.itemName}`}
          className="h-8 w-20"
          data-testid="reorder-line-qty"
        />
      </label>
      {line.unitCost != null && (
        <span className="w-24 text-right text-sm tabular-nums text-muted-foreground">
          {currency(line.unitCost * Number(editQty || line.orderQty), line.currency ?? undefined)}
        </span>
      )}
    </li>
  );
}
