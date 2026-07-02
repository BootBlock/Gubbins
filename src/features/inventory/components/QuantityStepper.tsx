import { useState, type KeyboardEvent } from 'react';
import { Button, Tooltip } from '@/components/foundry';
import { AddIcon, SubtractIcon } from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import { useAdjustQuantity } from '../mutations';
import { ChangeFlash } from './ChangeFlash';

/**
 * Inline ± quantity stepper for DISCRETE items. Each ± tap fires an optimistic
 * `adjustQuantity` mutation (instant UI, rollback on error) so rapid presses feel
 * immediate without waiting on the OPFS write queue (spec §2.1).
 *
 * The number itself is also click-to-edit: click (or focus + Enter) the value to type an
 * exact quantity rather than tapping ± repeatedly to reach it. Committing computes the
 * delta to the typed target and routes through the same `adjustQuantity` mutation, so the
 * existing {@link ChangeFlash} "value changed" glow replays on accept — the same flair as
 * a ± tap.
 */
export function QuantityStepper({ id, quantity }: { id: string; quantity: number }) {
  const adjust = useAdjustQuantity();
  const fmt = useFormatters();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const bump = (delta: number) => {
    if (quantity + delta < 0) return;
    adjust.mutate({ id, delta });
  };

  const startEdit = () => {
    setDraft(String(quantity));
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const target = Number(draft);
    // Ignore a blank/invalid/negative entry — leave the quantity untouched.
    if (draft.trim() === '' || !Number.isFinite(target) || target < 0) return;
    const next = Math.floor(target);
    const delta = next - quantity;
    // A no-op (same value) is skipped, so the flash only plays on a real change — exactly
    // like a ± tap that would take it below zero.
    if (delta !== 0) adjust.mutate({ id, delta });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
    }
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      <Tooltip
        content="Remove one from stock. The change is saved instantly and logged."
        triggerTabIndex={-1}
      >
        <span>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="Decrease quantity"
            disabled={quantity <= 0}
            onClick={() => bump(-1)}
          >
            <SubtractIcon className="text-glyph-neutral" />
          </Button>
        </span>
      </Tooltip>

      {editing ? (
        <input
          type="number"
          min={0}
          step={1}
          autoFocus
          aria-label="Set quantity"
          data-testid="quantity-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
          onFocus={(e) => e.target.select()}
          className="h-8 w-16 rounded-md border border-border bg-input/40 px-2 text-center text-sm font-semibold tabular-nums text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
      ) : (
        <Tooltip
          content="Click to type an exact quantity. The change is saved instantly and logged."
          triggerTabIndex={-1}
        >
          <button
            type="button"
            onClick={startEdit}
            data-testid="quantity-edit"
            aria-label={`Quantity ${fmt.quantity(quantity)}. Click to enter an exact amount.`}
            className="rounded outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ChangeFlash
              flashKey={quantity}
              className="min-w-12 text-center text-sm font-semibold tabular-nums transition-colors hover:text-primary"
            >
              {fmt.quantity(quantity)}
            </ChangeFlash>
          </button>
        </Tooltip>
      )}

      <Tooltip content="Add one to stock. The change is saved instantly and logged." triggerTabIndex={-1}>
        <span>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="Increase quantity"
            onClick={() => bump(1)}
          >
            <AddIcon className="text-glyph-success" />
          </Button>
        </span>
      </Tooltip>
    </div>
  );
}
