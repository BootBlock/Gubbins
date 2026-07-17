import { useEffect, useMemo, useState } from 'react';
import { Input, SelectField } from '@/components/foundry';
import type { Item, ItemBatchPlacement } from '@/db/repositories';
import { isDefaultBatch } from '@/features/inventory/batches';
import { useItemBatches, useItemStock } from '@/features/lifecycle/hooks';

/** Sentinel for "draw whatever FEFO picks" — distinct from the untracked default key (''). */
const ANY_LOT = ' any';

/** A human label for a tracked lot: its batch/lot number, else a bare "Untracked". */
function lotLabel(b: ItemBatchPlacement): string {
  if (b.batchNumber && b.lotNumber) return `Batch ${b.batchNumber} · Lot ${b.lotNumber}`;
  if (b.batchNumber) return `Batch ${b.batchNumber}`;
  if (b.lotNumber) return `Lot ${b.lotNumber}`;
  return 'Untracked';
}

/**
 * Shared state for a permanent outbound draw (sale / write-off): the quantity clamped to the
 * chosen placement/lot, and the resolved source location + lot the repository should draw from.
 * Mirrors the source-picking logic in `CheckoutDialog` so a sale and a write-off pick their stock
 * exactly as a checkout does, without the two dialogs duplicating it.
 */
export function useOutboundSource(item: Item) {
  const stock = useItemStock(item.id);
  const itemBatches = useItemBatches(item.id);
  const [quantity, setQuantity] = useState(1);
  const [fromLocationId, setFromLocationId] = useState<string>(item.locationId);
  const [fromBatchKey, setFromBatchKey] = useState(ANY_LOT);

  const placements = useMemo(() => stock.data ?? [], [stock.data]);
  const isSplit = placements.length > 1;
  const sourceLocId = isSplit ? fromLocationId : item.locationId;
  const lotsHere = (itemBatches.data ?? []).filter((b) => b.locationId === sourceLocId && b.quantity > 0);
  const canPickLot = lotsHere.some((b) => !isDefaultBatch(b.batchKey));
  const selectedLot =
    fromBatchKey !== ANY_LOT ? lotsHere.find((b) => b.batchKey === fromBatchKey) : undefined;
  const placementHere = isSplit
    ? (placements.find((p) => p.locationId === fromLocationId)?.quantity ?? 0)
    : item.quantity;
  const availableHere = selectedLot ? selectedLot.quantity : placementHere;
  const maxQty = Math.max(1, availableHere);

  // Default the source to the busiest placement once the breakdown loads.
  useEffect(() => {
    if (isSplit && !placements.some((p) => p.locationId === fromLocationId)) {
      setFromLocationId(placements[0]!.locationId);
    }
  }, [isSplit, placements, fromLocationId]);

  // Keep the requested quantity within what the chosen placement/lot holds.
  useEffect(() => {
    setQuantity((q) => Math.max(1, Math.min(maxQty, q)));
  }, [maxQty]);

  const reset = () => {
    setQuantity(1);
    setFromBatchKey(ANY_LOT);
  };

  return {
    quantity,
    setQuantity,
    maxQty,
    availableHere,
    isSplit,
    placements,
    fromLocationId,
    setFromLocationId,
    canPickLot,
    lotsHere,
    fromBatchKey,
    setFromBatchKey,
    selectedLot,
    reset,
    /** The source args to pass to the repository: a location only when split, a lot only when picked. */
    resolved: {
      fromLocationId: isSplit ? fromLocationId : undefined,
      fromBatchKey: selectedLot ? selectedLot.batchKey : undefined,
    },
  };
}

type OutboundSource = ReturnType<typeof useOutboundSource>;

/**
 * The shared location + lot + quantity fields for a sale / write-off dialog, driven by
 * {@link useOutboundSource}. The location and lot selects only appear when the stock is genuinely
 * split / lot-tracked, mirroring `CheckoutDialog`.
 */
export function OutboundSourceFields({ source, verb }: { source: OutboundSource; verb: string }) {
  const {
    quantity,
    setQuantity,
    maxQty,
    availableHere,
    isSplit,
    placements,
    fromLocationId,
    setFromLocationId,
    canPickLot,
    lotsHere,
    fromBatchKey,
    setFromBatchKey,
  } = source;

  return (
    <>
      {isSplit ? (
        <SelectField
          label={`${verb} from`}
          value={fromLocationId}
          onChange={(value) => {
            setFromLocationId(value);
            setFromBatchKey(' any'); // the lot list belongs to the placement — reset on change
          }}
          data-testid="outbound-from-location"
          options={placements.map((p) => ({
            value: p.locationId,
            label: `${p.locationName} (${p.quantity})`,
          }))}
        />
      ) : null}

      {canPickLot ? (
        <SelectField
          label={`${verb} from lot`}
          value={fromBatchKey}
          onChange={setFromBatchKey}
          data-testid="outbound-from-lot"
          options={[
            { value: ' any', label: 'Any (soonest expiry)' },
            ...lotsHere.map((b) => ({ value: b.batchKey, label: `${lotLabel(b)} (${b.quantity})` })),
          ]}
        />
      ) : null}

      <label className="block">
        <span className="mb-field-gap block text-sm font-medium">Quantity</span>
        <Input
          type="number"
          // Clamped-on-keystroke controlled field — opt out of the calculator (issue #93).
          calc={false}
          min={1}
          max={maxQty}
          value={quantity}
          onChange={(e) => setQuantity(Math.max(1, Math.min(maxQty, Number(e.target.value) || 1)))}
          data-testid="outbound-qty"
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          {availableHere} {isSplit ? 'available here' : 'on hand'}
        </span>
      </label>
    </>
  );
}
