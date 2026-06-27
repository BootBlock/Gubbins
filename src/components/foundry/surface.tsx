import { type HTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Foundry Surface — a glassmorphic panel (backdrop blur, soft border, deep
 * shadow) used for elevated compositions such as the multi-tab guard overlay and
 * the Safe Mode screen (spec §2.2.7, §3). Premium aesthetic per §1.1 / §2.4.1.
 */
export const Surface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-2xl border border-border bg-card/80 shadow-2xl shadow-black/40 backdrop-blur-xl',
        className,
      )}
      {...props}
    />
  ),
);
Surface.displayName = 'Surface';
