import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { ChevronDownIcon } from '@/components/icons';
import { Menu, type MenuProps } from './menu';

/**
 * Foundry Button — the internal primitive every feature imports instead of a raw
 * shadcn/lib control (spec §2.4.1). Hand-built for Phase 1's minimal surface;
 * may be transparently swapped for the shadcn primitive later without touching
 * call sites.
 *
 * It plays **three** roles from one API so a plain button and the split "primary + dropdown"
 * pill are the same control rather than two divergent primitives:
 *
 * - **Plain button** — `<Button onClick={…}>Save</Button>`.
 * - **A styled non-button** (`asChild`) — style a router `Link` (or any single element) with the
 *   button variants while it stays its own element: `<Button asChild><Link to="…">Open</Link></Button>`.
 * - **Split button** (`menu`) — the styled primary sits on the left and an attached chevron opens a
 *   {@link Menu} of related actions on the right (spec §2.4.1). When `menu` is omitted the chevron
 *   never renders and the control is an ordinary button. Combine with `asChild` for a `Link` primary.
 */
const buttonVariants = cva(
  // The trailing `[&_svg]` rules give every button's glyph a subtle come-alive nudge on
  // hover (a 10% grow) — a small, universal micro-interaction (spec §3). The reduced-motion
  // catch-all freezes the transform, so those users see the icon at rest.
  //
  // The transition names its properties rather than saying `all` (issue #419). The list is
  // complete for the variants below — background and text colour, the border and ring the focus
  // state paints (a ring is a box-shadow in Tailwind, as is every variant's drop shadow), the
  // `active:` scale, and the disabled fade — and a button is not a rare element: an item card
  // carries half a dozen, so `all` had the browser re-checking every animatable property on each
  // of them for every style change.
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-150 ease-emphasized select-none outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:transition-transform [&_svg]:duration-150 hover:[&_svg]:scale-110',
  {
    variants: {
      variant: {
        // `gubbins-cta-sheen`: a specular highlight glides across the solid CTAs on hover
        // (glassmorphism, spec §1.1) — decorative only, and the reduced-motion catch-all
        // freezes it. Applied to the two solid, filled variants where it reads.
        primary:
          'gubbins-cta-sheen bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90 hover:shadow-primary/30',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-border bg-transparent hover:bg-secondary/60',
        ghost: 'hover:bg-secondary/60',
        destructive:
          'gubbins-cta-sheen bg-destructive text-destructive-foreground shadow-lg shadow-destructive/20 hover:bg-destructive/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        default: 'h-10 px-4',
        lg: 'h-11 px-6 text-base',
        icon: 'size-10',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  },
);

/** Divider colour between the two halves of a split button, keyed off the shared variant so it
 *  stays legible on both filled and outline pills — always a theme token, never a raw value. */
const DIVIDER_BY_VARIANT: Record<NonNullable<VariantProps<typeof buttonVariants>['variant']>, string> = {
  primary: 'border-primary-foreground/25',
  destructive: 'border-destructive-foreground/25',
  secondary: 'border-border',
  outline: 'border-border',
  ghost: 'border-border',
  link: 'border-border',
};

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /**
   * Render the single child element *as* the button, merging in the variant classes (a minimal
   * Slot). Use it to wear the button styling on something that must stay its own element — most
   * often a router `Link` that has to remain an `<a>` for navigation while looking like a button.
   */
  readonly asChild?: boolean;
  /**
   * When provided, the control becomes a **split button**: the styled primary sits on the left and
   * an attached chevron opens a {@link Menu} of these rows on the right. Compose the rows from
   * `MenuAction` / `MenuLink` / `MenuSeparator`. Omit for an ordinary button (no chevron).
   */
  readonly menu?: ReactNode;
  /** Accessible name for the split-button dropdown trigger and its menu panel. Required when `menu` is set. */
  readonly menuLabel?: string;
  /** Horizontal edge the split-button menu panel aligns to relative to the chevron. Defaults to `end`. */
  readonly menuAlign?: MenuProps['align'];
  /** Extra attributes for the split-button dropdown trigger (e.g. `data-testid`). */
  readonly menuTriggerProps?: MenuProps['triggerProps'];
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    type = 'button',
    asChild = false,
    menu,
    menuLabel,
    menuAlign = 'end',
    menuTriggerProps,
    children,
    ...props
  },
  ref,
) {
  const isSplit = menu !== undefined && menu !== null && menu !== false;
  const resolvedVariant = variant ?? 'primary';

  // The primary (or, for a plain button, the whole control): the caller's element when `asChild`,
  // otherwise a native `<button>`. `extra` squares off the inner edge when it's a split half.
  const renderPrimary = (extra?: string): ReactElement => {
    const classes = cn(buttonVariants({ variant, size }), extra, className);
    if (asChild) {
      if (!isValidElement(children)) {
        throw new Error('Button `asChild` expects a single React element child.');
      }
      const child = children as ReactElement<{ className?: string }>;
      // Child props win over any stray Button-level props; the className is merged, and the ref
      // is forwarded onto the child element (an anchor, in the common Link case).
      return cloneElement(child, {
        ...props,
        ...child.props,
        className: cn(classes, child.props.className),
        ref,
      } as Record<string, unknown>);
    }
    return (
      <button ref={ref} type={type} className={classes} {...props}>
        {children}
      </button>
    );
  };

  if (!isSplit) return renderPrimary();

  // Split button — the styled primary fused to a chevron `Menu` in one rounded pill: the primary's
  // inner (right) edge and the trigger's outer (left) edge are squared off, with a hairline divider
  // drawn between the two same-coloured halves. Composing `Menu` brings keyboard/focus/ARIA for free.
  return (
    <div className="inline-flex items-stretch">
      {renderPrimary('rounded-r-none')}
      <Menu
        label={menuLabel ?? ''}
        triggerVariant={resolvedVariant}
        triggerSize={size}
        triggerClassName={cn('rounded-l-none border-l px-2', DIVIDER_BY_VARIANT[resolvedVariant])}
        trigger={<ChevronDownIcon />}
        align={menuAlign}
        triggerProps={menuTriggerProps}
      >
        {menu}
      </Menu>
    </div>
  );
});
Button.displayName = 'Button';

export { buttonVariants };
