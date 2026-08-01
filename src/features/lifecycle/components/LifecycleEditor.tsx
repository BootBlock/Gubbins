/**
 * Item-detail facet for Phase 9 lifecycle data (spec §4): perishable expiry +
 * batch/lot, the Condition enum, and Parent/Child variants. Perishable/condition
 * edits go through `useUpdateItem` (logging `CONDITION_CHANGED` when it changes).
 * Variants nest to any depth (Phase 18 lifted the single-level cap): any item may
 * gain sub-variants; only cycles are rejected, enforced in the repository.
 */
import { useId, useState } from 'react';
import {
  Button,
  InfoHint,
  Input,
  Select,
  Tooltip,
  INFO_OPEN_DELAY_MS,
  useReportUnsavedChanges,
} from '@/components/foundry';
import { DueDateIcon, WarningIcon, AddIcon, PackageIcon, TruckIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import { useItemSectionVisibility } from '@/features/inventory/useItemSectionVisibility';
import { useUpdateItem } from '@/features/inventory/mutations';
import { useFormatters } from '@/lib/useFormatters';
import {
  conditionSelectOptions,
  fromDateInputValue,
  toDateInputValue,
} from '@/features/inventory/components/inventory-ui';
import { expiryStatus, daysUntilExpiry, type ExpiryStatus } from '../expiry';
import { nowMs } from '@/lib/clock';
import { useCreateVariant, useInTransitQty, useItemVariants } from '../hooks';
import { StockBreakdown } from './StockBreakdown';
import { useErrorMessage } from '@/features/errors';

const EXPIRY_TONE: Record<ExpiryStatus, string> = {
  NONE: 'text-muted-foreground',
  FRESH: 'text-success',
  EXPIRING_SOON: 'text-warning',
  EXPIRED: 'text-destructive',
};

export function LifecycleEditor({ item }: { item: Item }) {
  const update = useUpdateItem();
  const fmt = useFormatters();
  // Item-aware, not device-only: the item's category can also declare that its items have
  // no expiry, no batch identity and no variants (issue #618). Each still shows when it
  // actually holds something, so hiding never buries data.
  const isVisible = useItemSectionVisibility(item);
  // Both directions of the link count as data: `hasVariants` means this item has children,
  // but the section also states "this is itself a variant of …" for a child, which is just
  // as real and would otherwise be buried.
  const showVariants = isVisible('variants', item.hasVariants || item.parentId !== null);
  const showExpiry = isVisible('perishables', item.expiryDate !== null);
  const showBatches = isVisible('batches', item.batchNumber !== null || item.lotNumber !== null);
  const [expiry, setExpiry] = useState(toDateInputValue(item.expiryDate));
  const [batch, setBatch] = useState(item.batchNumber ?? '');
  const [lot, setLot] = useState(item.lotNumber ?? '');
  const [condition, setCondition] = useState<string>(item.condition ?? '');
  const conditionLabelId = useId();

  const status = expiryStatus(item.expiryDate, nowMs());
  const days = daysUntilExpiry(item.expiryDate, nowMs());
  // Distinct "incoming" stock (Phase 20, §4): derived from In-Transit BOM lines,
  // shown beside on-hand stock which it never overloads.
  const inTransitQty = useInTransitQty(item.id).data ?? 0;
  const isGauge = item.trackingMode === 'CONSUMABLE_GAUGE';

  // What a Save would write, resolved once so the dirty check below and the save itself can
  // never drift apart.
  const draft = {
    expiryDate: fromDateInputValue(expiry),
    batchNumber: batch.trim() || null,
    lotNumber: lot.trim() || null,
    condition: (condition || null) as Item['condition'],
  };
  // Unlike the other facet editors this one's Save is always enabled, so there was no dirty flag
  // to reuse — but the dialog frame still needs to know a draft is sitting here uncommitted, or
  // Escape would take it away without asking (issue #576).
  useReportUnsavedChanges(
    draft.expiryDate !== item.expiryDate ||
      draft.batchNumber !== item.batchNumber ||
      draft.lotNumber !== item.lotNumber ||
      draft.condition !== item.condition,
  );

  const save = () => {
    update.mutate({ id: item.id, input: draft });
  };

  return (
    <div className="space-y-4">
      {inTransitQty > 0 ? (
        <Tooltip
          content="Incoming procurement stock — units on order and **in transit**, conceptually held in the system-locked *In Transit* location. Counted **separately** from on-hand stock and only added to it once the order is received."
          openDelayMs={INFO_OPEN_DELAY_MS}
        >
          <p
            className="flex items-center gap-1.5 text-sm font-medium text-primary [&_svg]:size-4"
            data-testid="detail-in-transit"
          >
            <TruckIcon />
            <span data-testid="in-transit-qty">{inTransitQty}</span> arriving (In Transit)
            {!isGauge ? (
              <span className="font-normal text-muted-foreground">· {item.quantity} on hand</span>
            ) : null}
          </p>
        </Tooltip>
      ) : null}

      <StockBreakdown item={item} />

      {showExpiry && item.expiryDate !== null ? (
        <p
          className={cn('flex items-center gap-1.5 text-sm font-medium [&_svg]:size-4', EXPIRY_TONE[status])}
        >
          {status === 'EXPIRED' ? <WarningIcon /> : <DueDateIcon />}
          {status === 'EXPIRED'
            ? `Expired ${fmt.calendarDate(item.expiryDate)}`
            : `Expires ${fmt.calendarDate(item.expiryDate)}${days !== null ? ` (${days} ${plural(days, 'day')})` : ''}`}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        {showExpiry ? (
          <LField
            label="Expiry date"
            hint={
              'When this stock expires or is best used by. Items nearing expiry surface on the ' +
              'dashboard **Soon to expire** widget. Changing it re-evaluates the expiry status shown above.'
            }
          >
            <Input
              type="date"
              data-testid="detail-expiry"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </LField>
        ) : null}
        {/* A custom listbox (not a native <select>) so each condition can be tinted by its
            severity — green Mint through to red Needs-repair. A role=combobox isn't a
            labelable control, so it is named via a sibling label span, matching LField. */}
        <div className="relative">
          <span
            id={conditionLabelId}
            className="mb-field-gap-compact block pr-5 text-xs text-muted-foreground"
          >
            Condition
          </span>
          <span className="absolute right-0 top-0">
            <InfoHint
              content={
                'The physical state of this stock (*New*, *Used*, *Damaged*…). Changing it records a ' +
                '`CONDITION_CHANGED` entry in the item’s **Activity log**.'
              }
            />
          </span>
          <Select
            aria-labelledby={conditionLabelId}
            value={condition}
            onChange={setCondition}
            options={conditionSelectOptions('— Untracked —')}
          />
        </div>
        {showBatches ? (
          <>
            <LField
              label="Batch no."
              hint="A maker/supplier **batch** identifier for traceability. Stock from different batches is kept as separate lots and consumed **oldest-first (FEFO)**."
            >
              <Input value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="—" />
            </LField>
            <LField
              label="Lot no."
              hint="A finer **lot** identifier within a batch, when your supplier distinguishes the two."
            >
              <Input value={lot} onChange={(e) => setLot(e.target.value)} placeholder="—" />
            </LField>
          </>
        ) : null}
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={update.isPending} data-testid="save-lifecycle">
          Save lifecycle
        </Button>
      </div>

      {showVariants ? <VariantsSection item={item} /> : null}
    </div>
  );
}

function VariantsSection({ item }: { item: Item }) {
  const createVariant = useCreateVariant();
  // Phase 18 lifts the single-level cap: any item — including one that is itself a
  // variant — may hold its own sub-variants. Cycles are still rejected (repository).
  const { data: variants } = useItemVariants(item.id);
  const [name, setName] = useState('');
  const [qty, setQty] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();

  const add = () => {
    if (name.trim().length === 0) return;
    setError(null);
    createVariant.mutate(
      {
        parentId: item.id,
        input: { name: name.trim(), quantity: Math.max(0, Math.floor(Number(qty) || 0)) },
      },
      {
        onSuccess: () => {
          setName('');
          setQty('0');
        },
        onError: (e) => setError(describeError(e, 'Could not add the variant.')),
      },
    );
  };

  return (
    <div className="rounded-xl border border-border p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
        <PackageIcon />
        Variants
        <InfoHint
          content={
            'Child SKUs of this item that share its identity but differ in one attribute — e.g. a ' +
            '*resistor* parent with `10kΩ`, `4.7kΩ` variants, or a *T-shirt* in `S`/`M`/`L`.\n\n' +
            'Variants **nest to any depth** (a variant can have its own sub-variants); only ' +
            'circular references are rejected.'
          }
        />
      </p>
      {item.parentId !== null ? (
        <p className="mb-2 text-xs text-muted-foreground" data-testid="variant-is-child">
          This item is itself a variant of a parent — sub-variants nest beneath it.
        </p>
      ) : null}
      {variants && variants.rows.length > 0 ? (
        <ul className="mb-3 space-y-1" data-testid="variant-list">
          {variants.rows.map((v) => (
            <li
              key={v.id}
              className="flex items-center justify-between rounded-lg bg-secondary/30 px-2.5 py-1.5 text-sm"
            >
              <span className="font-medium">{v.name}</span>
              <span className="text-xs text-muted-foreground">qty {v.quantity}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-muted-foreground">No variants yet — add child variants below.</p>
      )}
      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="mb-field-gap-compact block text-xs text-muted-foreground">Variant name</span>
          <Input
            data-testid="variant-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. 10kΩ"
          />
        </label>
        <label className="w-20">
          <span className="mb-field-gap-compact block text-xs text-muted-foreground">Qty</span>
          <Input type="number" min={0} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <Button onClick={add} disabled={createVariant.isPending} data-testid="add-variant">
          <AddIcon />
          Add
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function LField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="relative">
      <label className="block">
        <span className={cn('mb-field-gap-compact block text-xs text-muted-foreground', hint && 'pr-5')}>
          {label}
        </span>
        {children}
      </label>
      {hint ? (
        <span className="absolute right-0 top-0">
          <InfoHint content={hint} />
        </span>
      ) : null}
    </div>
  );
}
