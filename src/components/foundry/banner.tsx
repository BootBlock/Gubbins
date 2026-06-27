import { type HTMLAttributes, type ReactNode, forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Foundry Banner — semantic, glassy notice strip used for the storage-persistence,
 * quota-degradation and mobile-eviction warnings of §2 / §7.6. The icon is passed
 * in (from the central icon registry) so this primitive stays icon-library-agnostic.
 */
const bannerVariants = cva(
  'relative flex items-start gap-3 rounded-xl border px-4 py-3 text-sm backdrop-blur-sm',
  {
    variants: {
      tone: {
        info: 'border-primary/30 bg-primary/10',
        success: 'border-success/30 bg-success/10',
        warning: 'border-warning/40 bg-warning/10',
        danger: 'border-destructive/40 bg-destructive/10',
      },
    },
    defaultVariants: {
      tone: 'info',
    },
  },
);

export interface BannerProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof bannerVariants> {
  icon?: ReactNode;
  /** Optional bold heading rendered above the message (named `heading`, not `title`, to avoid the native tooltip attribute). */
  heading?: ReactNode;
  action?: ReactNode;
}

export const Banner = forwardRef<HTMLDivElement, BannerProps>(
  ({ className, tone, icon, heading, action, children, role = 'status', ...props }, ref) => (
    <div ref={ref} role={role} className={cn(bannerVariants({ tone }), className)} {...props}>
      {icon ? <span className="mt-0.5 shrink-0 [&_svg]:size-5">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        {heading ? <p className="leading-tight font-semibold">{heading}</p> : null}
        {children ? (
          <div className={cn('text-muted-foreground', heading && 'mt-1')}>{children}</div>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  ),
);
Banner.displayName = 'Banner';

export { bannerVariants };
