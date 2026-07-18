import { useRef, useState } from 'react';
import { Button, Input, Modal, Money } from '@/components/foundry';
import { SaleIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useSellItem } from '../sales';
import { OutboundSourceFields, useOutboundSource } from './OutboundSourceFields';
import { useErrorMessage } from '@/features/errors';

/**
 * Sell one or more units of a DISCRETE item (Sales & disposals capability). Records a `SOLD`
 * ledger entry carrying the realised sale price, which feeds the sales & margin report. The
 * quantity is clamped to the chosen placement/lot, mirroring `CheckoutDialog`; a free-text buyer
 * is optional. Serialised assets are retired via "Remove from inventory" instead.
 */
export function SellDialog({ open, onClose, item }: { open: boolean; onClose: () => void; item: Item }) {
  const sell = useSellItem();
  const source = useOutboundSource(item);
  const [unitPrice, setUnitPrice] = useState('');
  const [buyer, setBuyer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();
  const priceRef = useRef<HTMLInputElement>(null);

  const parsedPrice = Number(unitPrice);
  const validPrice = unitPrice.trim() !== '' && Number.isFinite(parsedPrice) && parsedPrice >= 0;
  const proceeds = validPrice ? parsedPrice * source.quantity : 0;

  const submit = () => {
    setError(null);
    if (!validPrice) {
      setError('Enter a sale price (0 or more).');
      return;
    }
    sell.mutate(
      {
        itemId: item.id,
        quantity: source.quantity,
        unitSalePrice: parsedPrice,
        counterparty: buyer.trim() || undefined,
        fromLocationId: source.resolved.fromLocationId,
        fromBatchKey: source.resolved.fromBatchKey,
      },
      {
        onSuccess: () => {
          setUnitPrice('');
          setBuyer('');
          source.reset();
          onClose();
        },
        onError: (e) => setError(describeError(e, 'Could not record the sale.')),
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Sell" description={item.name} initialFocusRef={priceRef}>
      <div className="space-y-4">
        <OutboundSourceFields source={source} verb="Sell" />

        <label className="block">
          <span className="mb-field-gap block text-sm font-medium">Sale price (per unit)</span>
          <Input
            ref={priceRef}
            type="number"
            min={0}
            step="0.01"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="0.00"
          />
          <span className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
            {item.unitCost != null ? (
              <span>
                Cost <Money value={item.unitCost} />
                /unit
              </span>
            ) : (
              <span>No cost recorded</span>
            )}
            {validPrice ? (
              <span>
                Total <Money value={proceeds} />
              </span>
            ) : null}
          </span>
        </label>

        <label className="block">
          <span className="mb-field-gap block text-sm font-medium">Buyer (optional)</span>
          <Input value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="Who bought it" />
        </label>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={sell.isPending || !validPrice}>
            <SaleIcon />
            Sell
          </Button>
        </div>
      </div>
    </Modal>
  );
}
