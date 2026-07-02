import { cn } from '@/lib/utils';
import type { BudgetStatus } from '../budget';
import { BUDGET_STATUS_FILL } from './projects-ui';

/**
 * A token-driven budget progress bar (spec §4 budgeting). The fill colour comes from a
 * semantic status token (success / warning / destructive — never a raw colour, CLAUDE.md);
 * the bar fills to the spent fraction, capped at 100% width so an over-budget project shows
 * a full destructive bar rather than overflowing. A second, lighter marker shows the
 * *projected* fraction when the forecast runs past what is already spent.
 */
export function BudgetMeter({
  fraction,
  status,
  projectedFraction,
  className,
}: {
  /** Spent ÷ budget; values > 1 cap the visible bar at full width. */
  fraction: number | null;
  status: BudgetStatus;
  /** Projected ÷ budget — drawn as a faint tick ahead of the fill when it exceeds it. */
  projectedFraction?: number | null;
  className?: string;
}) {
  const pct = fraction == null ? 0 : Math.min(100, Math.max(0, fraction * 100));
  const projectedPct = projectedFraction == null ? null : Math.min(100, Math.max(0, projectedFraction * 100));
  const showProjected = projectedPct != null && projectedPct > pct;

  return (
    <div
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', BUDGET_STATUS_FILL[status])}
        style={{ width: `${pct}%` }}
      />
      {showProjected ? (
        <span
          className="absolute top-0 h-full w-px bg-foreground/50"
          style={{ left: `${projectedPct}%` }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
