import { useRef, useState } from 'react';
import { Button, Input, Modal, Money } from '@/components/foundry';
import { DeleteIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useWriteOffItem } from '../sales';
import { OutboundSourceFields, useOutboundSource } from './OutboundSourceFields';

/**
 * Write off one or more units of a DISCRETE item (Sales & disposals capability) — lost, damaged,
 * expired or binned. Records a `WRITTEN_OFF` ledger entry with an optional reason and a cost
 * snapshot (→ the sales report's write-off total); no proceeds. Draws stock exactly like a sale.
 */
export function WriteOffDialog({ open, onClose, item }: { open: boolean; onClose: () => void; item: Item }) {
  const writeOff = useWriteOffItem();
  const source = useOutboundSource(item);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  const lostValue = item.unitCost != null ? item.unitCost * source.quantity : null;

  const submit = () => {
    setError(null);
    writeOff.mutate(
      {
        itemId: item.id,
        quantity: source.quantity,
        reason: reason.trim() || undefined,
        fromLocationId: source.resolved.fromLocationId,
        fromBatchKey: source.resolved.fromBatchKey,
      },
      {
        onSuccess: () => {
          setReason('');
          source.reset();
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not write the stock off.'),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Write off"
      description={item.name}
      initialFocusRef={reasonRef}
    >
      <div className="space-y-4">
        <OutboundSourceFields source={source} verb="Write off" />

        <label className="block">
          <span className="mb-field-gap block text-sm font-medium">Reason (optional)</span>
          <Input
            ref={reasonRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="e.g. Damaged, expired, lost"
          />
          {lostValue != null ? (
            <span className="mt-1 block text-xs text-muted-foreground">
              Writing off <Money value={lostValue} /> of stock at cost.
            </span>
          ) : null}
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
          <Button variant="destructive" onClick={submit} disabled={writeOff.isPending}>
            <DeleteIcon />
            Write off
          </Button>
        </div>
      </div>
    </Modal>
  );
}
