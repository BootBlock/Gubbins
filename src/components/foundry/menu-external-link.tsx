import { useContext, type ReactNode } from 'react';
import { MENU_ITEM_CLASS, MenuContext } from './menu-context';

export interface MenuExternalLinkProps {
  readonly href: string;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  /** Optional trailing adornment (e.g. an external-link glyph). */
  readonly trailing?: ReactNode;
  readonly 'data-testid'?: string;
}

/**
 * An external-link menu row — a real anchor that opens in a new tab. Use this (not
 * {@link MenuLink}, which is a router `<Link>`) for destinations outside the app, such
 * as a documentation wiki. Closes the menu on activation.
 */
export function MenuExternalLink({ href, icon, children, trailing, ...rest }: MenuExternalLinkProps) {
  const ctx = useContext(MenuContext);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      role="menuitem"
      tabIndex={-1}
      className={MENU_ITEM_CLASS}
      onClick={() => ctx?.close()}
      {...rest}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </a>
  );
}
