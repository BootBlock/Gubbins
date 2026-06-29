import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, Select } from '@/components/foundry';
import { CheckoutIcon } from '@/components/icons';
import type { Item, ItemBatchPlacement } from '@/db/repositories';
import { isDefaultBatch } from '@/features/inventory/batches';
import { useItemBatches, useItemStock } from '@/features/lifecycle/hooks';
import { useContacts, useCheckoutItem } from '../contacts';
import { MS_PER_DAY } from '@/features/scanner/due-date';

/** Sentinel for "lend whatever FEFO picks" — distinct from the untracked default key (''). */
const ANY_LOT = ' any';

/** A human label for a tracked lot: its batch/lot number, else a bare "Untracked". */
function lotLabel(b: ItemBatchPlacement): string {
  if (b.batchNumber && b.lotNumber) return `Batch ${b.batchNumber} · Lot ${b.lotNumber}`;
  if (b.batchNumber) return `Batch ${b.batchNumber}`;
  if (b.lotNumber) return `Lot ${b.lotNumber}`;
  return 'Untracked';
}

/**
 * Check an item out to a contact (spec §4 Borrowing & Checking Out, Phase 6).
 *
 * Low-friction contacts (§4 Ergonomics): the name box is a free-text field backed
 * by a `<datalist>` of existing contacts — typing a brand-new name auto-creates the
 * contact on submit (the repository resolves-or-creates). Discrete items can lend
 * several units; serialised/gauge are pinned. A due date is optional (§4 Due Dates),
 * set via quick presets or a date picker.
 */
export function CheckoutDialog({
  open,
  onClose,
  item,
}: {
  open: boolean;
  onClose: () => void;
  item: Item;
}) {
  const contacts = useContacts();
  const checkout = useCheckoutItem();
  const stock = useItemStock(item.id);
  const itemBatches = useItemBatches(item.id);
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [dueDate, setDueDate] = useState(''); // yyyy-mm-dd, '' = none
  const [fromLocationId, setFromLocationId] = useState<string>(item.locationId);
  const [fromBatchKey, setFromBatchKey] = useState(ANY_LOT);
  const [error, setError] = useState<string | null>(null);

  const isDiscrete = item.trackingMode === 'DISCRETE';
  // Per-location source (Phase 26): only when the item's stock is genuinely split across
  // more than one location is a lend-from choice meaningful; otherwise the single
  // placement is used silently. The available quantity follows the chosen placement.
  const placements = stock.data ?? [];
  const isSplit = isDiscrete && placements.length > 1;
  // Per-lot source (Phase 29): the lots sitting at the *resolved* source placement (the chosen
  // location when split, else the item's primary). When any is a tracked lot, the user may lend
  // a specific one rather than the FEFO default; the available figure then follows that lot.
  const sourceLocId = isSplit ? fromLocationId : item.locationId;
  const lotsHere = (itemBatches.data ?? []).filter(
    (b) => b.locationId === sourceLocId && b.quantity > 0,
  );
  const canPickLot = isDiscrete && lotsHere.some((b) => !isDefaultBatch(b.batchKey));
  const selectedLot = fromBatchKey !== ANY_LOT ? lotsHere.find((b) => b.batchKey === fromBatchKey) : undefined;
  const placementHere = isSplit
    ? (placements.find((p) => p.locationId === fromLocationId)?.quantity ?? 0)
    : item.quantity;
  const availableHere = selectedLot ? selectedLot.quantity : placementHere;
  const maxQty = isDiscrete ? availableHere : 1;

  // Default the source to the busiest placement once the breakdown loads.
  useEffect(() => {
    if (isSplit && !placements.some((p) => p.locationId === fromLocationId)) {
      setFromLocationId(placements[0]!.locationId);
    }
  }, [isSplit, placements, fromLocationId]);

  // Keep the requested quantity within what the chosen placement holds.
  useEffect(() => {
    setQuantity((q) => Math.max(1, Math.min(maxQty || 1, q)));
  }, [maxQty]);

  const presets = useMemo(
    () => [
      { label: '1 week', days: 7 },
      { label: '2 weeks', days: 14 },
      { label: '1 month', days: 30 },
    ],
    [],
  );

  const setPreset = (days: number) => {
    const d = new Date(Date.now() + days * MS_PER_DAY);
    setDueDate(d.toISOString().slice(0, 10));
  };

  const submit = () => {
    setError(null);
    if (name.trim().length === 0) {
      setError('Enter who is borrowing this.');
      return;
    }
    const dueMs = dueDate ? new Date(`${dueDate}T23:59:59`).getTime() : null;
    checkout.mutate(
      {
        itemId: item.id,
        contactName: name.trim(),
        quantity: isDiscrete ? quantity : 1,
        dueDate: dueMs,
        // Only send a source when the stock is split; otherwise the repository defaults
        // to the item's primary placement (Phase 26).
        fromLocationId: isSplit ? fromLocationId : undefined,
        // A specific lot to lend (Phase 29); omitted lets the repository draw FEFO.
        fromBatchKey: selectedLot ? selectedLot.batchKey : undefined,
      },
      {
        onSuccess: () => {
          setName('');
          setQuantity(1);
          setDueDate('');
          setFromBatchKey(ANY_LOT);
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not check the item out.'),
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Check out" description={item.name}>
      <div className="space-y-4">
        <label className="block">
          <span className="mb-field-gap block text-sm font-medium">Borrower</span>
          <Input
            autoFocus
            list="contact-suggestions"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Type a name — new names are added automatically"
          />
          <datalist id="contact-suggestions">
            {contacts.data?.rows.map((c) => <option key={c.id} value={c.name} />)}
          </datalist>
        </label>

        {isSplit ? (
          <label className="block">
            <span className="mb-field-gap block text-sm font-medium">Lend from</span>
            <Select
              value={fromLocationId}
              onChange={(e) => {
                setFromLocationId(e.target.value);
                setFromBatchKey(ANY_LOT); // the lot list belongs to the placement — reset on change
              }}
              data-testid="checkout-from-location"
            >
              {placements.map((p) => (
                <option key={p.locationId} value={p.locationId}>
                  {p.locationName} ({p.quantity})
                </option>
              ))}
            </Select>
            <span className="mt-1 block text-xs text-muted-foreground">
              Returned stock goes back to this location.
            </span>
          </label>
        ) : null}

        {canPickLot ? (
          <label className="block">
            <span className="mb-field-gap block text-sm font-medium">Lend from lot</span>
            <Select
              value={fromBatchKey}
              onChange={(e) => setFromBatchKey(e.target.value)}
              data-testid="checkout-from-lot"
            >
              <option value={ANY_LOT}>Any (soonest expiry)</option>
              {lotsHere.map((b) => (
                <option key={b.batchKey} value={b.batchKey}>
                  {lotLabel(b)} ({b.quantity})
                </option>
              ))}
            </Select>
            <span className="mt-1 block text-xs text-muted-foreground">
              A returned unit goes back to this exact lot.
            </span>
          </label>
        ) : null}

        {isDiscrete ? (
          <label className="block">
            <span className="mb-field-gap block text-sm font-medium">Quantity</span>
            <Input
              type="number"
              min={1}
              max={maxQty}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Math.min(maxQty, Number(e.target.value) || 1)))}
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              {availableHere} {isSplit ? 'available here' : 'on hand'}
            </span>
          </label>
        ) : null}

        <div>
          <span className="mb-field-gap block text-sm font-medium">Due back (optional)</span>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-44"
            />
            {presets.map((p) => (
              <Button key={p.days} variant="ghost" size="sm" onClick={() => setPreset(p.days)}>
                {p.label}
              </Button>
            ))}
            {dueDate ? (
              <Button variant="ghost" size="sm" onClick={() => setDueDate('')}>
                Clear
              </Button>
            ) : null}
          </div>
        </div>

        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={checkout.isPending || name.trim().length === 0}>
            <CheckoutIcon />
            Check out
          </Button>
        </div>
      </div>
    </Modal>
  );
}
