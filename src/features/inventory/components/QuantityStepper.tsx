import { Button, Tooltip } from '@/components/foundry';
import { AddIcon, SubtractIcon } from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import { useAdjustQuantity } from '../mutations';
import { ChangeFlash } from './ChangeFlash';

/**
 * Inline ± quantity stepper for DISCRETE items. Each tap fires an optimistic
 * `adjustQuantity` mutation (instant UI, rollback on error) so rapid presses feel
 * immediate without waiting on the OPFS write queue (spec §2.1).
 */
export function QuantityStepper({ id, quantity }: { id: string; quantity: number }) {
  const adjust = useAdjustQuantity();
  const fmt = useFormatters();

  const bump = (delta: number) => {
    if (quantity + delta < 0) return;
    adjust.mutate({ id, delta });
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      <Tooltip content="Remove one from stock. The change is saved instantly and logged." triggerTabIndex={-1}>
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
      <ChangeFlash flashKey={quantity} className="min-w-12 text-center text-sm font-semibold tabular-nums">
        {fmt.quantity(quantity)}
      </ChangeFlash>
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
