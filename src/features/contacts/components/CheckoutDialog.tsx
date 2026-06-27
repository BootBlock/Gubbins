import { useMemo, useState } from 'react';
import { Button, Input, Modal } from '@/components/foundry';
import { CheckoutIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useContacts, useCheckoutItem } from '../contacts';
import { MS_PER_DAY } from '@/features/scanner/due-date';

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
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [dueDate, setDueDate] = useState(''); // yyyy-mm-dd, '' = none
  const [error, setError] = useState<string | null>(null);

  const isDiscrete = item.trackingMode === 'DISCRETE';
  const maxQty = isDiscrete ? item.quantity : 1;

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
      },
      {
        onSuccess: () => {
          setName('');
          setQuantity(1);
          setDueDate('');
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
          <span className="mb-1.5 block text-sm font-medium">Borrower</span>
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

        {isDiscrete ? (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Quantity</span>
            <Input
              type="number"
              min={1}
              max={maxQty}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Math.min(maxQty, Number(e.target.value) || 1)))}
            />
            <span className="mt-1 block text-xs text-muted-foreground">{item.quantity} on hand</span>
          </label>
        ) : null}

        <div>
          <span className="mb-1.5 block text-sm font-medium">Due back (optional)</span>
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

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

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
