/**
 * Per-location stock breakdown + split control (spec §4 per-location ledger, Phase 25).
 *
 * `item_stock` is the SSOT for *where* a DISCRETE item's units sit; `items.quantity` is
 * their sum. This facet shows the breakdown busiest-location-first and lets the user move
 * part of the stock to another location (so the same item can be on a shelf *and* in a
 * drawer at once) via the upstream-trusting `transferStock` — the amount is clamped to the
 * source's available stock. Non-DISCRETE items (serialised instances, gauges) render
 * nothing: they are single-unit / single-location by nature.
 */
import { useId, useState } from 'react';
import {
  Button,
  Input,
  Select,
  Tooltip,
  useToast,
  INFO_OPEN_DELAY_MS,
  type SelectProps,
} from '@/components/foundry';
import { MoveIcon, PackageIcon } from '@/components/icons';
import type { Item, ItemBatchPlacement } from '@/db/repositories';
import { DbError } from '@/db/errors';
import { isDefaultBatch } from '@/features/inventory/batches';
import { useItemSectionVisibility } from '@/features/inventory/useItemSectionVisibility';
import { useLocations } from '@/features/inventory/queries';
import { useFormatters } from '@/lib/useFormatters';
import { useItemBatches, useItemStock, useTransferStock } from '../hooks';

/**
 * A compact stacked label + {@link Select} combobox for the split control. The combobox
 * (a `role="combobox"`, not a labelable control) is named via a sibling label span so the
 * small muted caption above it still associates.
 */
function CompactSelect({ label, ...props }: { label: string } & Omit<SelectProps, 'aria-labelledby'>) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span id={labelId}>{label}</span>
      <Select aria-labelledby={labelId} {...props} />
    </div>
  );
}

/** A human label for a tracked lot: its batch/lot number, else a bare "Untracked". */
function batchLabel(b: ItemBatchPlacement): string {
  if (b.batchNumber && b.lotNumber) return `Batch ${b.batchNumber} · Lot ${b.lotNumber}`;
  if (b.batchNumber) return `Batch ${b.batchNumber}`;
  if (b.lotNumber) return `Lot ${b.lotNumber}`;
  return 'Untracked';
}

/** Sentinel for "move whatever FEFO picks" — distinct from the untracked default key (''). */
const ANY_LOT = ' any';

export function StockBreakdown({ item }: { item: Item }) {
  const { data: placements } = useItemStock(item.id);
  const { data: batches } = useItemBatches(item.id);
  const { data: locationsPage } = useLocations();
  // The batch/lot detail (per-location lot lists + the lot picker on the transfer control)
  // is the `batches` capability (modular-ui-plan §4, Phase 6). With it off, the per-location
  // stock breakdown and the transfer stay — only the lot-level facets disappear; a move
  // then simply uses the FEFO default. Stock and batch data underneath are untouched.
  // Both axes decide this: the device's `batches` module, and the item's category, which can
  // declare that its items are not batch-tracked (issue #618). Any lot actually recorded still
  // shows — hence the presence test over the batches already loaded above.
  const isVisible = useItemSectionVisibility(item);
  const batchesEnabled = isVisible(
    'batches',
    (batches ?? []).some((b) => !isDefaultBatch(b.batchKey)),
  );
  const transfer = useTransferStock();
  const toast = useToast();
  const fmt = useFormatters();

  const [fromId, setFromId] = useState(item.locationId);
  const [toId, setToId] = useState('');
  const [qty, setQty] = useState('1');
  const [batchKey, setBatchKey] = useState(ANY_LOT);

  if (item.trackingMode !== 'DISCRETE') return null;

  const rows = placements ?? [];
  const locations = locationsPage?.rows ?? [];
  const allBatches = batches ?? [];
  // Batch detail is only worth showing where a lot is actually tracked (a non-default
  // batch, or more than one batch at a placement). The repository already returns these
  // FEFO-ordered within each location (soonest expiry first, untracked remainder last).
  const batchesByLocation = new Map<string, ItemBatchPlacement[]>();
  for (const b of allBatches) {
    const list = batchesByLocation.get(b.locationId) ?? [];
    list.push(b);
    batchesByLocation.set(b.locationId, list);
  }
  const showBatches = (locationId: string): ItemBatchPlacement[] => {
    if (!batchesEnabled) return [];
    const list = batchesByLocation.get(locationId) ?? [];
    const tracked = list.some((b) => !isDefaultBatch(b.batchKey));
    return tracked ? list : [];
  };
  // You can only move stock *out of* a location that holds some.
  const sourceOptions = rows.filter((p) => p.quantity > 0);
  // Explicit per-lot selection (Phase 29): when the source placement holds tracked lots, the
  // user may move one specific lot instead of the FEFO default. The available figure (and the
  // quantity ceiling) then follows the chosen lot rather than the whole placement.
  const lotsAtSource = (batchesByLocation.get(fromId) ?? []).filter((b) => b.quantity > 0);
  const canPickLot = batchesEnabled && lotsAtSource.some((b) => !isDefaultBatch(b.batchKey));
  const selectedLot = batchKey !== ANY_LOT ? lotsAtSource.find((b) => b.batchKey === batchKey) : undefined;
  const placementQty = sourceOptions.find((p) => p.locationId === fromId)?.quantity ?? 0;
  const available = selectedLot ? selectedLot.quantity : placementQty;
  const amount = Math.floor(Number(qty));
  const canSubmit =
    sourceOptions.length > 0 &&
    Boolean(toId) &&
    toId !== fromId &&
    Number.isFinite(amount) &&
    amount > 0 &&
    available > 0 &&
    !transfer.isPending;

  const submit = () => {
    transfer.mutate(
      {
        itemId: item.id,
        fromLocationId: fromId,
        toLocationId: toId,
        quantity: amount,
        batchKey: selectedLot ? selectedLot.batchKey : undefined,
      },
      {
        onSuccess: () => {
          toast.show({ tone: 'success', message: `Moved ${Math.min(amount, available)} to a new location.` });
          setQty('1');
        },
        onError: (e) =>
          toast.show({ tone: 'danger', message: e instanceof DbError ? e.message : 'Transfer failed.' }),
      },
    );
  };

  return (
    <div className="space-y-2" data-testid="stock-breakdown">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
        <PackageIcon />
        <span>Stock by location</span>
        <Tooltip
          content="Where this item's on-hand units physically sit. The same item can hold stock in more than one location at once; the total on hand is the sum of these placements."
          openDelayMs={INFO_OPEN_DELAY_MS}
        >
          <span className="cursor-help text-muted-foreground/70">(?)</span>
        </Tooltip>
      </div>

      <ul className="space-y-1" data-testid="stock-placements">
        {rows.length === 0 ? (
          <li className="text-sm text-muted-foreground">No stock on hand.</li>
        ) : (
          rows.map((p) => {
            const lots = showBatches(p.locationId);
            return (
              <li key={p.locationId} data-testid={`stock-placement-${p.locationId}`}>
                <div className="flex items-center justify-between rounded-md bg-muted/40 px-2.5 py-1 text-sm">
                  <span className="truncate">{p.locationName}</span>
                  <span
                    className="font-mono font-medium tabular-nums"
                    data-testid={`stock-qty-${p.locationId}`}
                  >
                    {p.quantity}
                  </span>
                </div>
                {lots.length > 0 ? (
                  <ul className="mt-0.5 space-y-0.5 pl-3" data-testid={`stock-batches-${p.locationId}`}>
                    {lots.map((b) => (
                      <li
                        key={b.batchKey}
                        data-testid={`stock-batch-${p.locationId}-${b.batchKey || 'untracked'}`}
                        className="flex items-center justify-between border-l border-border/60 px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        <span className="truncate">
                          {batchLabel(b)}
                          {b.expiryDate ? (
                            <span className="ml-1.5 text-muted-foreground/70">
                              · exp {fmt.calendarDate(b.expiryDate)}
                            </span>
                          ) : null}
                        </span>
                        <span className="font-mono tabular-nums">{b.quantity}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })
        )}
      </ul>

      {sourceOptions.length > 0 && locations.length > 1 ? (
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <CompactSelect
            label="From"
            data-testid="stock-from"
            className="h-8 w-32"
            value={fromId}
            onChange={(value) => {
              setFromId(value);
              setBatchKey(ANY_LOT); // the lot list belongs to the source — reset on change
            }}
            options={sourceOptions.map((p) => ({
              value: p.locationId,
              label: `${p.locationName} (${p.quantity})`,
            }))}
          />
          {canPickLot ? (
            <CompactSelect
              label="Lot"
              data-testid="stock-lot"
              className="h-8 w-40"
              value={batchKey}
              onChange={setBatchKey}
              options={[
                { value: ANY_LOT, label: 'Any (soonest expiry)' },
                ...lotsAtSource.map((b) => ({
                  value: b.batchKey,
                  label: `${batchLabel(b)} (${b.quantity})`,
                })),
              ]}
            />
          ) : null}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Qty
            <Input
              type="number"
              min={1}
              max={available}
              aria-label="Quantity to transfer"
              data-testid="stock-transfer-qty"
              className="h-8 w-20"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </label>
          <CompactSelect
            label="To"
            data-testid="stock-to"
            className="h-8 w-32"
            value={toId}
            onChange={setToId}
            options={[
              { value: '', label: '— Choose —' },
              ...locations
                .filter((loc) => loc.id !== fromId)
                .map((loc) => ({ value: loc.id, label: loc.name })),
            ]}
          />
          <Tooltip
            content="Move the chosen quantity from the source location to the target, splitting this item's stock across both. A specific lot moves with its batch identity intact; otherwise FEFO picks the soonest-expiry units."
            triggerTabIndex={-1}
          >
            <span>
              <Button
                size="sm"
                className="h-8 [&_svg]:size-3.5"
                data-testid="stock-transfer-submit"
                disabled={!canSubmit}
                onClick={submit}
              >
                <MoveIcon /> Move
              </Button>
            </span>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
