/**
 * Item-detail facet for Phase 9 lifecycle data (spec §4): perishable expiry +
 * batch/lot, the Condition enum, and Parent/Child variants. Perishable/condition
 * edits go through `useUpdateItem` (logging `CONDITION_CHANGED` when it changes);
 * variants are managed via the abstract single-level model — only a non-variant
 * item may gain child variants, enforced both here (UI) and in the repository.
 */
import { useState } from 'react';
import { Button, Input, Select } from '@/components/foundry';
import { DueDateIcon, WarningIcon, AddIcon, PackageIcon } from '@/components/icons';
import { CONDITIONS, type Item } from '@/db/repositories';
import { cn } from '@/lib/utils';
import { useUpdateItem } from '@/features/inventory/mutations';
import {
  CONDITION_LABELS,
  formatDate,
  fromDateInputValue,
  toDateInputValue,
} from '@/features/inventory/components/inventory-ui';
import { expiryStatus, daysUntilExpiry, type ExpiryStatus } from '../expiry';
import { useCreateVariant, useItemVariants } from '../hooks';

const EXPIRY_TONE: Record<ExpiryStatus, string> = {
  NONE: 'text-muted-foreground',
  FRESH: 'text-success',
  EXPIRING_SOON: 'text-warning',
  EXPIRED: 'text-destructive',
};

export function LifecycleEditor({ item }: { item: Item }) {
  const update = useUpdateItem();
  const [expiry, setExpiry] = useState(toDateInputValue(item.expiryDate));
  const [batch, setBatch] = useState(item.batchNumber ?? '');
  const [lot, setLot] = useState(item.lotNumber ?? '');
  const [condition, setCondition] = useState(item.condition ?? '');

  const status = expiryStatus(item.expiryDate, Date.now());
  const days = daysUntilExpiry(item.expiryDate, Date.now());

  const save = () => {
    update.mutate({
      id: item.id,
      input: {
        expiryDate: fromDateInputValue(expiry),
        batchNumber: batch.trim() || null,
        lotNumber: lot.trim() || null,
        condition: (condition || null) as Item['condition'],
      },
    });
  };

  return (
    <div className="space-y-4">
      {item.expiryDate !== null ? (
        <p className={cn('flex items-center gap-1.5 text-sm font-medium [&_svg]:size-4', EXPIRY_TONE[status])}>
          {status === 'EXPIRED' ? <WarningIcon /> : <DueDateIcon />}
          {status === 'EXPIRED'
            ? `Expired ${formatDate(item.expiryDate)}`
            : `Expires ${formatDate(item.expiryDate)}${days !== null ? ` (${days} day${days === 1 ? '' : 's'})` : ''}`}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <LField label="Expiry date">
          <Input type="date" data-testid="detail-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </LField>
        <LField label="Condition">
          <Select value={condition} onChange={(e) => setCondition(e.target.value)}>
            <option value="">— Untracked —</option>
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {CONDITION_LABELS[c]}
              </option>
            ))}
          </Select>
        </LField>
        <LField label="Batch no.">
          <Input value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="—" />
        </LField>
        <LField label="Lot no.">
          <Input value={lot} onChange={(e) => setLot(e.target.value)} placeholder="—" />
        </LField>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={update.isPending} data-testid="save-lifecycle">
          Save lifecycle
        </Button>
      </div>

      <VariantsSection item={item} />
    </div>
  );
}

function VariantsSection({ item }: { item: Item }) {
  const createVariant = useCreateVariant();
  // Only a top-level item (not itself a variant) can hold variants (single-level, §4).
  const isParentEligible = item.parentId === null;
  const { data: variants } = useItemVariants(isParentEligible ? item.id : undefined);
  const [name, setName] = useState('');
  const [qty, setQty] = useState('0');
  const [error, setError] = useState<string | null>(null);

  if (item.parentId !== null) {
    return (
      <p className="rounded-lg border border-border bg-secondary/20 px-3 py-2 text-xs text-muted-foreground">
        This item is a variant of a parent item.
      </p>
    );
  }

  const add = () => {
    if (name.trim().length === 0) return;
    setError(null);
    createVariant.mutate(
      { parentId: item.id, input: { name: name.trim(), quantity: Math.max(0, Math.floor(Number(qty) || 0)) } },
      {
        onSuccess: () => {
          setName('');
          setQty('0');
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not add the variant.'),
      },
    );
  };

  return (
    <div className="rounded-xl border border-border p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
        <PackageIcon />
        Variants
      </p>
      {variants && variants.rows.length > 0 ? (
        <ul className="mb-3 space-y-1" data-testid="variant-list">
          {variants.rows.map((v) => (
            <li key={v.id} className="flex items-center justify-between rounded-lg bg-secondary/30 px-2.5 py-1.5 text-sm">
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
          <span className="mb-1 block text-xs text-muted-foreground">Variant name</span>
          <Input
            data-testid="variant-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. 10kΩ"
          />
        </label>
        <label className="w-20">
          <span className="mb-1 block text-xs text-muted-foreground">Qty</span>
          <Input type="number" min={0} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <Button size="sm" onClick={add} disabled={createVariant.isPending} data-testid="add-variant">
          <AddIcon />
          Add
        </Button>
      </div>
      {error ? <p className="mt-1.5 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function LField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
