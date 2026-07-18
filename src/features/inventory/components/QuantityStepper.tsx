import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Tooltip, evaluateExpression, hasCalcExpression, useToast } from '@/components/foundry';
import { AddIcon, ErrorIcon, SubtractIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
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
  const t = useT();
  const { show } = useToast();

  /**
   * Both entry points share this: the optimistic number rolls back on failure, which on its own
   * looks like the tap simply did nothing. The commonest failure is a lost race — an overlapping
   * decrement took the last unit first (#302) — so say what happened rather than silently
   * reverting.
   */
  const submit = (delta: number) => {
    adjust.mutate(
      { id, delta },
      {
        onError: (error) =>
          show({
            tone: 'danger',
            icon: <ErrorIcon aria-hidden />,
            heading: t('inventory.quantity.updateFailed'),
            message: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Focus the field when it appears (managed here rather than via the discouraged
  // `autoFocus` attribute); its own onFocus then selects the text for quick overtyping.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const bump = (delta: number) => {
    if (quantity + delta < 0) return;
    submit(delta);
  };

  const startEdit = () => {
    setDraft(String(quantity));
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === '') return;
    // Accept a typed calculation (e.g. "24/2", "12+3") as well as a plain number — the same
    // micro-calculator every number field offers (issue #93). An invalid sum is ignored.
    let target: number;
    if (hasCalcExpression(trimmed)) {
      const result = evaluateExpression(trimmed);
      if (!result.ok) return;
      target = result.value;
    } else {
      target = Number(trimmed);
    }
    // Ignore an invalid/negative entry — leave the quantity untouched.
    if (!Number.isFinite(target) || target < 0) return;
    const next = Math.floor(target);
    const delta = next - quantity;
    // A no-op (same value) is skipped, so the flash only plays on a real change — exactly
    // like a ± tap that would take it below zero.
    if (delta !== 0) submit(delta);
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
          ref={inputRef}
          type="text"
          inputMode="decimal"
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
