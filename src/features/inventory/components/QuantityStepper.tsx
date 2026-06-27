import { Button } from '@/components/foundry';
import { AddIcon, SubtractIcon } from '@/components/icons';
import { useAdjustQuantity } from '../mutations';
import { formatQuantity } from './inventory-ui';

/**
 * Inline ± quantity stepper for DISCRETE items. Each tap fires an optimistic
 * `adjustQuantity` mutation (instant UI, rollback on error) so rapid presses feel
 * immediate without waiting on the OPFS write queue (spec §2.1).
 */
export function QuantityStepper({ id, quantity }: { id: string; quantity: number }) {
  const adjust = useAdjustQuantity();

  const bump = (delta: number) => {
    if (quantity + delta < 0) return;
    adjust.mutate({ id, delta });
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        aria-label="Decrease quantity"
        disabled={quantity <= 0}
        onClick={() => bump(-1)}
      >
        <SubtractIcon />
      </Button>
      <span className="min-w-12 text-center text-sm font-semibold tabular-nums">
        {formatQuantity(quantity)}
      </span>
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        aria-label="Increase quantity"
        onClick={() => bump(1)}
      >
        <AddIcon />
      </Button>
    </div>
  );
}
