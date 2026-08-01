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
 *
 * The two numeric fields parse through the shared `measure-draft` seam, so an entry the
 * repository would refuse (`-250`, `1,250`, a zero-month term) is reported on the field and
 * blocks the save, keeping what is stored. Deriving the value to save from a
 * "usable ? parse : null" guard instead erases the column — the same defect this dialog's
 * other half was fixed for in issue #345, and this half in issue #675.
 */
import { useEffect, useState } from 'react';
import { Button, FormField, Input, Money, MoneyInput, useReportUnsavedChanges } from '@/components/foundry';
import { CostIcon, SecureIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { cn } from '@/lib/utils';
import { useFormatters } from '@/lib/useFormatters';
import { nowMs } from '@/lib/clock';
import { warrantyStatus, currentValue, type WarrantyStatus } from '../asset-lifecycle';
import { WARRANTY_STATUS_COLOR_CLASS } from './inventory-ui';
import { measureIssueText, parseOptionalNumber, parseOptionalPositiveInt } from './measure-draft';
import { useUpdateItem } from '../mutations';
import { RevaluationEditor } from './RevaluationEditor';

/** Verbose, sentence-style badge copy for each warranty state (this editor's own phrasing). */
const WARRANTY_LABEL: Record<WarrantyStatus, string> = {
  none: 'No warranty date set',
  active: 'Under warranty',
  'expiring-soon': 'Warranty expiring soon',
  expired: 'Warranty expired',
};

export function AssetEditor({ item }: { item: Item }) {
  const t = useT();
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

  const now = nowMs();

  // Derive warranty status and current value from the *persisted* item (not draft),
  // so the badge and value display always match what is stored in the DB.
  const status = warrantyStatus(item, now);
  const bookValue = currentValue(item, now);

  // Parse the price/months drafts, keeping *why* an entry is unusable rather than collapsing it
  // into the same `null` that means "clear this column" (issue #675).
  const priceEntry = parseOptionalNumber(purchasePrice);
  const monthsEntry = parseOptionalPositiveInt(depreciationMonths);
  // What a save would write: the parsed entry, or — while it is unusable — whatever is already
  // stored, so a blocked save can never be the thing that erases the figure.
  const nextPrice = priceEntry.issue === null ? priceEntry.value : (item.purchasePrice ?? null);
  const nextMonths = monthsEntry.issue === null ? monthsEntry.value : (item.depreciationMonths ?? null);

  // Convert date-input values back to ISO strings (or null to clear).
  const nextAcquiredAt = acquiredAt.trim() || null;
  const nextWarrantyExpiresAt = warrantyExpiresAt.trim() || null;

  // An unusable entry is uncommitted work too — it counts as dirty (so closing the dialog asks
  // first) even though `nextPrice`/`nextMonths` deliberately still hold the stored value.
  const dirty =
    nextAcquiredAt !== (item.acquiredAt ?? null) ||
    nextWarrantyExpiresAt !== (item.warrantyExpiresAt ?? null) ||
    nextPrice !== (item.purchasePrice ?? null) ||
    nextMonths !== (item.depreciationMonths ?? null) ||
    priceEntry.issue !== null ||
    monthsEntry.issue !== null;
  // Let the dialog frame ask before discarding the draft on a dismissal (issue #576).
  useReportUnsavedChanges(dirty);

  const valid = priceEntry.issue === null && monthsEntry.issue === null;

  const save = () => {
    // The save is wholesale, so one unusable field has to block the lot: writing the dates
    // through would carry the fallback price with them and re-save a figure the user is
    // mid-way through changing. Guarded here as well as on the button, so the rule doesn't
    // depend on the two staying in step.
    if (!valid) return;
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
            WARRANTY_STATUS_COLOR_CLASS[status],
          )}
          aria-live="polite"
        >
          <SecureIcon />
          {WARRANTY_LABEL[status]}
          {item.warrantyExpiresAt ? (
            <span className="font-normal text-muted-foreground">
              · expires {fmt.calendarDate(Date.parse(item.warrantyExpiresAt))}
            </span>
          ) : null}
        </p>
      ) : null}

      {/* Depreciated book value (only shown when a purchase price is set). Distinct from the
          manual current / market value below (RevaluationEditor), which can appreciate. */}
      {bookValue !== null ? (
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground [&_svg]:size-4">
          <CostIcon />
          Book value: <Money value={bookValue} formatters={fmt} />
          {item.purchasePrice != null && item.purchasePrice !== bookValue ? (
            <span className="font-normal text-muted-foreground">
              · purchased at <Money value={item.purchasePrice} formatters={fmt} />
            </span>
          ) : null}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <FormField
          compact
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
        </FormField>

        <FormField
          compact
          label="Warranty expires"
          hint={
            'The date on which the manufacturer or supplier warranty expires. Once set, the ' +
            'badge above shows **Under warranty**, **Expiring soon** (within 30 days), ' +
            "or **Expired** depending on today's date."
          }
        >
          <Input
            type="date"
            value={warrantyExpiresAt}
            onChange={(e) => setWarrantyExpiresAt(e.target.value)}
            data-testid="asset-warranty-expires-at"
          />
        </FormField>

        <FormField
          compact
          label="Purchase price"
          error={measureIssueText(priceEntry.issue, t)}
          hint={
            "The original acquisition cost in the base currency. Shown as the item's current " +
            '**book value** (decreasing over time when a depreciation term is set).\n\nEnter it ' +
            'as plain digits — `1250`, not `1,250` — with a full stop for any decimals.'
          }
        >
          <MoneyInput
            value={purchasePrice}
            onValueChange={setPurchasePrice}
            placeholder="—"
            data-testid="asset-purchase-price"
          />
        </FormField>

        <FormField
          compact
          label="Depreciation term (months)"
          error={measureIssueText(monthsEntry.issue, t)}
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
            data-testid="asset-depreciation-months"
          />
        </FormField>
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || !valid || update.isPending}
          data-testid="save-asset"
        >
          {dirty ? 'Save asset details' : 'Saved'}
        </Button>
      </div>

      {/* Manual current / market value + revaluation log (feature-gap G9). */}
      <RevaluationEditor item={item} />
    </div>
  );
}
