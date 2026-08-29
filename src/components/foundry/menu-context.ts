import { createContext } from 'react';

/**
 * The internals every Menu part shares — the context a row uses to close the menu, the
 * geometry constant both panels position against, the roaming selector both panels roam
 * with, and the row class every row wears. They live here, rather than in one part's
 * module, so no part has to import another just to reach them.
 */

/** Gap kept between a panel and its trigger, and between a panel and the viewport edge. */
export const GAP = 6;

/**
 * The rows keyboard roaming steps through: command rows (`menuitem`) plus the selectable
 * rows a {@link MenuAction} can adopt (`menuitemradio` / `menuitemcheckbox`), each minus any
 * disabled row. A plain `[role="menuitem"]` selector would silently skip the radio/checkbox
 * rows, stranding them from ArrowUp/Down — so both the root panel and every submenu roam on
 * all three roles.
 */
export const ROAMABLE_ITEMS_SELECTOR =
  '[role="menuitem"]:not([aria-disabled="true"]),' +
  '[role="menuitemradio"]:not([aria-disabled="true"]),' +
  '[role="menuitemcheckbox"]:not([aria-disabled="true"])';

/** The shared chrome of a menu row — every row type wears it, so it is defined once. */
export const MENU_ITEM_CLASS =
  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:bg-secondary/60 focus-visible:text-foreground aria-[current=page]:bg-secondary aria-[current=page]:text-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0';

interface MenuContextValue {
  /** Close the whole menu (root panel and any open submenu), returning focus to the trigger. */
  readonly close: () => void;
  /**
   * Submenu coordination (see {@link MenuSub}). The root owns the single open flyout so that
   * only one shows at a time, an outside-click doesn't dismiss the whole menu when it lands
   * inside a portaled submenu panel, and Escape peels off the open submenu before the root.
   * A {@link MenuSub} rendered outside a {@link Menu} is inert (`null` context).
   *
   * A submenu announces it has opened with `escapeClose` (peels it off, restoring focus — for
   * Escape) and `collapse` (closes it without stealing focus — used to fold a sibling when a
   * new flyout opens). Doing the fold imperatively here, rather than via each submenu observing
   * shared "which is open" state, avoids a stale-closure race on the opening commit.
   */
  readonly onSubmenuOpen: (id: string, escapeClose: () => void, collapse: () => void) => void;
  readonly onSubmenuClose: (id: string) => void;
  /** Register a portaled submenu panel so an inside-click isn't treated as an outside dismissal. */
  readonly addSubPanel: (el: HTMLElement) => void;
  readonly removeSubPanel: (el: HTMLElement) => void;
}

export const MenuContext = createContext<MenuContextValue | null>(null);
