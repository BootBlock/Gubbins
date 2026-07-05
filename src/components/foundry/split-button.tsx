import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDownIcon } from '@/components/icons';
import { Menu, type MenuProps } from './menu';
import type { ButtonProps } from './button';

/**
 * Foundry SplitButton — a primary action fused to a dropdown of related actions in one
 * rounded pill (spec §2.4.1). The left half performs the default action; the attached
 * chevron opens a {@link Menu} of secondary actions (e.g. "Add item" with an "Import…"
 * alternative). It composes the existing `Button`/`Link` (as the primary) and `Menu`
 * primitives, so keyboard, focus and ARIA wiring come for free.
 *
 * The primary is passed as an element rather than props so callers keep full control of
 * it — a `Button` with an `onClick`, or a router `Link` styled with `buttonVariants`.
 * The primitive rounds off the primary's inner (right) edge and the trigger's outer
 * (left) edge, then draws a hairline divider between the two same-coloured halves.
 */

/** Divider colour between the two halves, keyed off the shared variant so it stays
 *  legible on both filled and outline pills — always a theme token, never a raw value. */
const DIVIDER_BY_VARIANT: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'border-primary-foreground/25',
  destructive: 'border-destructive-foreground/25',
  secondary: 'border-border',
  outline: 'border-border',
  ghost: 'border-border',
  link: 'border-border',
};

export interface SplitButtonProps {
  /** Accessible name for the dropdown trigger button and its menu panel. */
  readonly menuLabel: string;
  /**
   * The primary action — a Foundry `Button`, or a router `Link` styled with
   * `buttonVariants`. Rendered as the left half; its inner (right) edge is squared off
   * so it butts cleanly against the trigger. Must accept a `className`.
   */
  readonly primary: ReactElement<{ className?: string }>;
  /** Visual variant shared by both halves (drives the trigger + divider). Default `primary`. */
  readonly variant?: NonNullable<ButtonProps['variant']>;
  /** Menu rows — compose from `MenuAction` / `MenuLink` / `MenuSeparator`. */
  readonly children: ReactNode;
  /** Horizontal edge the panel aligns to relative to the trigger. Defaults to `end`. */
  readonly align?: MenuProps['align'];
  /** Extra attributes for the dropdown trigger button (e.g. `data-testid`). */
  readonly triggerProps?: MenuProps['triggerProps'];
}

export function SplitButton({
  menuLabel,
  primary,
  variant = 'primary',
  children,
  align = 'end',
  triggerProps,
}: SplitButtonProps) {
  // Square off the primary's inner edge so the two halves read as one rounded pill.
  const primaryHalf = cloneElement(primary, {
    className: cn(primary.props.className, 'rounded-r-none'),
  });
  return (
    <div className="inline-flex items-stretch">
      {primaryHalf}
      <Menu
        label={menuLabel}
        triggerVariant={variant}
        triggerClassName={cn('rounded-l-none border-l px-2', DIVIDER_BY_VARIANT[variant])}
        trigger={<ChevronDownIcon />}
        align={align}
        triggerProps={triggerProps}
      >
        {children}
      </Menu>
    </div>
  );
}
