import { type HTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Add a tactile hover response — the panel lifts a touch and warms its shadow to the
   * primary tint on hover (spec §3 "Micro-interactions & Delight"). Use for a panel the
   * user can click/drag (an item card, a pinned tile); leave off for static compositions
   * (Safe Mode, the multi-tab guard). The lift is a compositor-only transform and the
   * reduced-motion catch-all freezes it. A caller can still override the lift distance via
   * `className` (twMerge keeps the last utility).
   */
  readonly interactive?: boolean;
}

/**
 * Foundry Surface — a glassmorphic panel (backdrop blur, soft border, deep
 * shadow) used for elevated compositions such as the multi-tab guard overlay and
 * the Safe Mode screen (spec §2.2.7, §3). Premium aesthetic per §1.1 / §2.4.1.
 */
export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(
  ({ className, interactive = false, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-2xl border border-border bg-card/80 shadow-2xl shadow-black/40 backdrop-blur-xl',
        interactive &&
          'transition-all duration-200 ease-emphasized hover:-translate-y-0.5 hover:shadow-primary/10',
        className,
      )}
      {...props}
    />
  ),
);
Surface.displayName = 'Surface';
