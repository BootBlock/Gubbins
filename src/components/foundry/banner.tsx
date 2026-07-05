import { type HTMLAttributes, type ReactNode, forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { CloseIcon } from '@/components/icons';
import { Button } from './button';
import { Tooltip } from './tooltip';

/**
 * Foundry Banner — semantic, glassy notice strip used for the storage-persistence,
 * quota-degradation and mobile-eviction warnings of §2 / §7.6. The icon is passed
 * in (from the central icon registry) so this primitive stays icon-library-agnostic.
 *
 * The single control for every dismissible notice in the app (spec §2.4.1): pass
 * {@link BannerProps.onDismiss} rather than hand-rolling a close `Button` inside
 * `action`. Banner then owns the button's position (always its own last flex child,
 * flush with the padded corner) and its hover tint (derived from `tone`), so every
 * dismissible banner gets pixel-identical placement and a correctly tone-matched
 * hover with zero per-call-site styling — the two things that drift when each
 * feature hand-rolls its own close button.
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

/**
 * The close button's hover tint per tone: the banner's own background is `bg-{tone}/10`
 * (see {@link bannerVariants}); the hover deepens that same tone by +15 points to `/25` —
 * a visible-but-gentle reaction that reads as "the banner's own surface, hovered" rather
 * than a neutral grey-blue that looks borrowed from an unrelated surface.
 */
const BANNER_DISMISS_HOVER = {
  info: 'hover:bg-primary/25',
  success: 'hover:bg-success/25',
  warning: 'hover:bg-warning/25',
  danger: 'hover:bg-destructive/25',
} as const satisfies Record<NonNullable<VariantProps<typeof bannerVariants>['tone']>, string>;

export interface BannerProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof bannerVariants> {
  icon?: ReactNode;
  /** Optional bold heading rendered above the message (named `heading`, not `title`, to avoid the native tooltip attribute). */
  heading?: ReactNode;
  action?: ReactNode;
  /**
   * Renders Banner's own tone-matched close button and calls this on click. Banner has no
   * opinion on what "dismiss" *means* — forever, until a condition changes, or a snoozed
   * window — real call sites already need different persistence semantics, so that logic
   * stays with the caller; this prop is purely the shared button + placement + hover tint.
   */
  onDismiss?: () => void;
  /** Accessible name for the close button rendered by {@link onDismiss}. */
  dismissLabel?: string;
  /** `data-testid` for the close button rendered by {@link onDismiss} (must be unique per screen). */
  dismissTestId?: string;
  /**
   * Optional rich-Markdown {@link Tooltip} content on the close button rendered by
   * {@link onDismiss} — for a dismissal that isn't self-explanatory from `dismissLabel`
   * alone (e.g. "hidden until storage fills further"). Ignored when `onDismiss` is omitted.
   */
  dismissTooltip?: string;
}

export const Banner = forwardRef<HTMLDivElement, BannerProps>(
  (
    {
      className,
      tone,
      icon,
      heading,
      action,
      onDismiss,
      dismissLabel = 'Dismiss',
      dismissTestId,
      dismissTooltip,
      children,
      role = 'status',
      ...props
    },
    ref,
  ) => {
    const dismissButton = onDismiss ? (
      <Button
        size="icon"
        variant="ghost"
        onClick={onDismiss}
        aria-label={dismissLabel}
        data-testid={dismissTestId}
        className={cn('-mr-1 -mt-1 shrink-0', BANNER_DISMISS_HOVER[tone ?? 'info'])}
      >
        <CloseIcon className="text-glyph-neutral" />
      </Button>
    ) : null;

    return (
      <div ref={ref} role={role} className={cn(bannerVariants({ tone }), className)} {...props}>
        {icon ? <span className="mt-0.5 shrink-0 [&_svg]:size-5">{icon}</span> : null}
        <div className="min-w-0 flex-1">
          {heading ? <p className="leading-tight font-semibold">{heading}</p> : null}
          {children ? <div className={cn('text-muted-foreground', heading && 'mt-1')}>{children}</div> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
        {dismissButton ? (
          dismissTooltip ? (
            // `triggerTabIndex={-1}`: the Button itself is already a tab stop, so the
            // Tooltip's own wrapping trigger must not add a second one. `shrink-0` on the
            // trigger span matches the icon/action slots either side of it, since Tooltip's
            // own wrapper doesn't carry that by default.
            <Tooltip content={dismissTooltip} triggerTabIndex={-1} className="shrink-0">
              {dismissButton}
            </Tooltip>
          ) : (
            dismissButton
          )
        ) : null}
      </div>
    );
  },
);
Banner.displayName = 'Banner';

export { bannerVariants };
