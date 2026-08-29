import { useContext, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { MENU_ITEM_CLASS, MenuContext } from './menu-context';

export interface MenuLinkProps {
  readonly to: string;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  /** Marks the row as the current location (`aria-current="page"` + active styling). */
  readonly current?: boolean;
  /** Optional trailing adornment (e.g. a count badge). */
  readonly trailing?: ReactNode;
  /**
   * Optional side-effect fired on activation, before the menu closes — for a
   * navigation row that must also record intent (e.g. seeding a one-shot request the
   * destination screen consumes on arrival). Navigation still happens via the `Link`.
   */
  readonly onSelect?: () => void;
  readonly 'data-testid'?: string;
}

/** A router-link menu row. Closes the menu on activation. */
export function MenuLink({ to, icon, children, current, trailing, onSelect, ...rest }: MenuLinkProps) {
  const ctx = useContext(MenuContext);
  return (
    <Link
      to={to}
      role="menuitem"
      tabIndex={-1}
      aria-current={current ? 'page' : undefined}
      className={MENU_ITEM_CLASS}
      onClick={() => {
        onSelect?.();
        ctx?.close();
      }}
      {...rest}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </Link>
  );
}
