/**
 * Per-item asset lifecycle editor (Phase 66, spec §4 asset facet).
 *
 * Lets any item carry acquisition date, warranty-expiry date, purchase price, and a
 * straight-line depreciation term. All four fields are optional and default to NULL —
 * an item with none set behaves exactly as before (no regression).
 *
 * Warranty status is derived via the pure `warrantyStatus` seam and displayed as a
 * token-styled badge. Current book value is derived via `currentValue` and shown when
 * a purchase price is present.
 */
import { useEffect, useState } from 'react';
import { Button, InfoHint, Input } from '@/components/foundry';
import { CostIcon, SecureIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { cn } from '@/lib/utils';
import { useFormatters } from '@/lib/useFormatters';
import { warrantyStatus, currentValue, type WarrantyStatus } from '../asset-lifecycle';
import { useUpdateItem } from '../mutations';

/** Tailwind token class for each warranty state. */
const WARRANTY_TONE: Record<WarrantyStatus, string> = {
  none: 'text-muted-foreground',
  active: 'text-success',
  'expiring-soon': 'text-warning',
  expired: 'text-destructive',
};

/** Human-readable label for each warranty state. */
const WARRANTY_LABEL: Record<WarrantyStatus, string> = {
  none: 'No warranty date set',
  active: 'Under warranty',
  'expiring-soon': 'Warranty expiring soon',
  expired: 'Warranty expired',
};

export function AssetEditor({ item }: { item: Item }) {
  const update = useUpdateItem();
  const fmt = useFormatters();

  const [acquiredAt, setAcquiredAt] = useState(item.acquiredAt ?? '');
  const [warrantyExpiresAt, setWarrantyExpiresAt] = useState(item.warrantyExpiresAt ?? '');
  const [purchasePrice, setPurchasePrice] = useState(item.purchasePrice?.toString() ?? '');
  const [depreciationMonths, setDepreciationMonths] = useState(item.depreciationMonths?.toString() ?? '');

  // Re-sync the draft whenever the persisted values change (open, after save, or sync).
  useEffect(() => {
    setAcquiredAt(item.acquiredAt ?? '');
    setWarrantyExpiresAt(item.warrantyExpiresAt ?? '');
    setPurchasePrice(item.purchasePrice?.toString() ?? '');
    setDepreciationMonths(item.depreciationMonths?.toString() ?? '');
  }, [item.acquiredAt, item.warrantyExpiresAt, item.purchasePrice, item.depreciationMonths]);

  const now = Date.now();

  // Derive warranty status and current value from the *persisted* item (not draft),
  // so the badge and value display always match what is stored in the DB.
  const status = warrantyStatus(item, now);
  const bookValue = currentValue(item, now);

  // Parse the price/months drafts to their numeric representations.
  const nextPrice = toOptionalFloat(purchasePrice);
  const nextMonths = toOptionalInt(depreciationMonths);

  // Convert date-input values back to ISO strings (or null to clear).
  const nextAcquiredAt = acquiredAt.trim() || null;
  const nextWarrantyExpiresAt = warrantyExpiresAt.trim() || null;

  const dirty =
    nextAcquiredAt !== (item.acquiredAt ?? null) ||
    nextWarrantyExpiresAt !== (item.warrantyExpiresAt ?? null) ||
    (nextPrice ?? null) !== (item.purchasePrice ?? null) ||
    (nextMonths ?? null) !== (item.depreciationMonths ?? null);

  const save = () => {
    update.mutate({
      id: item.id,
      input: {
        acquiredAt: nextAcquiredAt,
        warrantyExpiresAt: nextWarrantyExpiresAt,
        purchasePrice: nextPrice,
        depreciationMonths: nextMonths,
      },
    });
  };

  return (
    <div className="space-y-4">
      {/* Warranty status badge (only shown when a date is set) */}
      {status !== 'none' ? (
        <p
          className={cn(
            'flex items-center gap-1.5 text-sm font-medium [&_svg]:size-4',
            WARRANTY_TONE[status],
          )}
          aria-live="polite"
        >
          <SecureIcon />
          {WARRANTY_LABEL[status]}
          {item.warrantyExpiresAt ? (
            <span className="font-normal text-muted-foreground">
              · expires {fmt.date(Date.parse(item.warrantyExpiresAt))}
            </span>
          ) : null}
        </p>
      ) : null}

      {/* Current book value (only shown when a purchase price is set) */}
      {bookValue !== null ? (
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground [&_svg]:size-4">
          <CostIcon />
          Current value: {fmt.currency(bookValue)}
          {item.purchasePrice != null && item.purchasePrice !== bookValue ? (
            <span className="font-normal text-muted-foreground">
              · purchased at {fmt.currency(item.purchasePrice)}
            </span>
          ) : null}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <LField
          label="Acquired on"
          hint={
            'The date this item was purchased or otherwise acquired. Used as the start date ' +
            'for straight-line depreciation when a **Depreciation term** is also set.'
          }
        >
          <Input
            type="date"
            value={acquiredAt}
            onChange={(e) => setAcquiredAt(e.target.value)}
            data-testid="asset-acquired-at"
          />
        </LField>

        <LField
          label="Warranty expires"
          hint={
            'The date on which the manufacturer or supplier warranty expires. Once set, the ' +
            'badge above shows **Under warranty**, **Expiring soon** (within 30 days), ' +
            'or **Expired** depending on today\'s date.'
          }
        >
          <Input
            type="date"
            value={warrantyExpiresAt}
            onChange={(e) => setWarrantyExpiresAt(e.target.value)}
            data-testid="asset-warranty-expires-at"
          />
        </LField>

        <LField
          label="Purchase price"
          hint={
            'The original acquisition cost in the base currency. Shown as the item\'s current ' +
            '**book value** (decreasing over time when a depreciation term is set).'
          }
        >
          <Input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            value={purchasePrice}
            onChange={(e) => setPurchasePrice(e.target.value)}
            placeholder="—"
            aria-label="Purchase price"
            data-testid="asset-purchase-price"
          />
        </LField>

        <LField
          label="Depreciation term (months)"
          hint={
            'Useful life in whole months for **straight-line depreciation**: the book value ' +
            'decreases linearly from the purchase price to zero over this period, starting from ' +
            'the *Acquired on* date. Leave blank to keep the value flat (no depreciation).'
          }
        >
          <Input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={depreciationMonths}
            onChange={(e) => setDepreciationMonths(e.target.value)}
            placeholder="—"
            aria-label="Depreciation term in months"
            data-testid="asset-depreciation-months"
          />
        </LField>
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || update.isPending}
          data-testid="save-asset"
        >
          {dirty ? 'Save asset details' : 'Saved'}
        </Button>
      </div>
    </div>
  );
}

/** Parse a string to an optional float: blank → null, else parse. */
function toOptionalFloat(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Parse a string to an optional positive integer: blank → null, else truncate. */
function toOptionalInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/**
 * Compact labelled-field wrapper that mirrors the {@link LField} in LifecycleEditor —
 * a label with an optional inline {@link InfoHint} positioned at the top-right.
 */
function LField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
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

