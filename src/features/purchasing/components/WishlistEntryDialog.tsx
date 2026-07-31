import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, FormField, Input, Modal, MoneyInput, SelectField, Textarea } from '@/components/foundry';
import {
  WISHLIST_PRIORITY_OPTIONS,
  planWishlistEntry,
  type WishlistPlanError,
} from '@/features/purchasing/wishlist';
import type { CreateWishlistInput, WishlistEntry } from '@/db/repositories';

/**
 * Create / edit a wishlist entry (feature-gap G8). A single dialog serves both: pass `entry` to
 * edit, omit it to add. Local controlled state; only the name is required. The pure
 * `planWishlistEntry` seam validates before submit so a bad link / price is caught inline with a
 * field-anchored message (the repository re-validates through the same seam). Design tokens +
 * Foundry primitives only, British copy.
 */
export interface WishlistEntryDialogProps {
  readonly open: boolean;
  /** The entry being edited, or null/undefined to create a new one. */
  readonly entry?: WishlistEntry | null;
  readonly isSaving: boolean;
  readonly onSubmit: (input: CreateWishlistInput) => void;
  readonly onClose: () => void;
}

/** Which field each validation error should anchor its message to. */
const ERROR_FIELD: Record<WishlistPlanError, 'name' | 'url' | 'targetPrice'> = {
  EMPTY_NAME: 'name',
  INVALID_URL: 'url',
  INVALID_PRICE: 'targetPrice',
};

const ERROR_MESSAGE: Record<WishlistPlanError, string> = {
  EMPTY_NAME: 'A name is required.',
  INVALID_URL: 'Enter a valid web link (http:// or https://), or leave it blank.',
  INVALID_PRICE: 'Enter a non-negative amount, or leave it blank.',
};

export function WishlistEntryDialog({ open, entry, isSaving, onSubmit, onClose }: WishlistEntryDialogProps) {
  const isEdit = entry != null;
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [url, setUrl] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [priority, setPriority] = useState<string>('NONE');
  const [error, setError] = useState<WishlistPlanError | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Re-seed the form whenever it opens (for a fresh add) or targets a different entry (edit).
  useEffect(() => {
    if (!open) return;
    setName(entry?.name ?? '');
    setNote(entry?.note ?? '');
    setUrl(entry?.url ?? '');
    setTargetPrice(entry?.targetPrice != null ? String(entry.targetPrice) : '');
    setPriority(entry?.priority ?? 'NONE');
    setError(null);
  }, [open, entry]);

  const parsedTargetPrice = (() => {
    const trimmed = targetPrice.trim();
    if (trimmed === '') return null;
    // A non-numeric entry becomes NaN, which the seam rejects with the INVALID_PRICE message.
    return Number(trimmed);
  })();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const draft: CreateWishlistInput = {
      name,
      note,
      url,
      targetPrice: parsedTargetPrice,
      priority,
    };
    const plan = planWishlistEntry(draft);
    if (!plan.ok) {
      setError(plan.reason);
      return;
    }
    setError(null);
    onSubmit(draft);
  };

  const fieldError = (field: 'name' | 'url' | 'targetPrice'): string | undefined =>
    error != null && ERROR_FIELD[error] === field ? ERROR_MESSAGE[error] : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit wish' : 'Add to wishlist'}
      description="Something you'd like to buy but don't own yet. Only a name is required."
      initialFocusRef={nameRef}
    >
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="wishlist-form">
        <FormField label="Name" error={fieldError('name')}>
          <Input
            ref={nameRef}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error === 'EMPTY_NAME') setError(null);
            }}
            placeholder="e.g. Cordless impact driver"
            data-testid="wishlist-name"
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Target price"
            hint="An optional budget/price you're aiming for, in your base currency."
            error={fieldError('targetPrice')}
          >
            <MoneyInput
              value={targetPrice}
              onValueChange={(value) => {
                setTargetPrice(value);
                if (error === 'INVALID_PRICE') setError(null);
              }}
              placeholder="0.00"
              data-testid="wishlist-target-price"
            />
          </FormField>

          <SelectField
            label="Priority"
            options={WISHLIST_PRIORITY_OPTIONS}
            value={priority}
            onChange={setPriority}
            data-testid="wishlist-priority"
          />
        </div>

        <FormField
          label="Link"
          hint="An optional web link to the product or listing."
          error={fieldError('url')}
        >
          <Input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (error === 'INVALID_URL') setError(null);
            }}
            placeholder="https://…"
            data-testid="wishlist-url"
          />
        </FormField>

        <FormField label="Note" hint="Anything worth remembering — a colour, a model, or when to buy.">
          <Textarea
            sizeKey="wishlist.note"
            autoGrow
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Optional"
            data-testid="wishlist-note"
          />
        </FormField>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={isSaving} data-testid="wishlist-save">
            {isEdit ? 'Save changes' : 'Add to wishlist'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
