import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { CheckIcon, ChevronRightIcon } from '@/components/icons';
import { Button, type ButtonProps } from './button';
import { useReducedMotion } from './useReducedMotion';

/**
 * Foundry Menu (spec §2.4.1 / §3) — an accessible pop-up menu: a trigger button
 * plus a portaled panel of `role="menuitem"` rows. It is the one primitive behind
 * both the global navigation ({@link AppNav}) and any per-screen "More" overflow, so
 * a dense header can show a couple of primary actions and tuck the rest behind a
 * single button instead of overflowing.
 *
 * Behaviour (WAI-ARIA menu button): the trigger carries `aria-haspopup="menu"` /
 * `aria-expanded`; opening moves focus into the panel; ArrowUp/Down (with wrap),
 * Home/End roam the items; Escape or a click outside closes and returns focus to the
 * trigger; activating an item closes the menu. The panel is portaled to `<body>` and
 * viewport-clamped so it is never clipped by an overflow container.
 */
const GAP = 6;

/**
 * The rows keyboard roaming steps through: command rows (`menuitem`) plus the selectable
 * rows a {@link MenuAction} can adopt (`menuitemradio` / `menuitemcheckbox`), each minus any
 * disabled row. A plain `[role="menuitem"]` selector would silently skip the radio/checkbox
 * rows, stranding them from ArrowUp/Down — so both the root panel and every submenu roam on
 * all three roles.
 */
const ROAMABLE_ITEMS_SELECTOR =
  '[role="menuitem"]:not([aria-disabled="true"]),' +
  '[role="menuitemradio"]:not([aria-disabled="true"]),' +
  '[role="menuitemcheckbox"]:not([aria-disabled="true"])';

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
const MenuContext = createContext<MenuContextValue | null>(null);

export interface MenuProps {
  /** Accessible name for the panel — and the trigger, when it has no text label. */
  readonly label: string;
  /** Trigger button inner content (an icon, or an icon + text). */
  readonly trigger: ReactNode;
  /** Menu rows — compose from {@link MenuLink}, {@link MenuAction}, {@link MenuSeparator}. */
  readonly children: ReactNode;
  readonly triggerVariant?: ButtonProps['variant'];
  readonly triggerSize?: ButtonProps['size'];
  readonly triggerClassName?: string;
  /** Horizontal edge the panel aligns to relative to the trigger. Defaults to `end`. */
  readonly align?: 'start' | 'end';
  /** Extra attributes for the trigger button (e.g. `data-testid`). */
  readonly triggerProps?: ButtonHTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string>;
}

export function Menu({
  label,
  trigger,
  children,
  triggerVariant = 'outline',
  triggerSize,
  triggerClassName,
  align = 'end',
  triggerProps,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const reducedMotion = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // How the menu was opened, so the open-effect can land focus on the right end.
  const openIntent = useRef<'first' | 'last'>('first');
  const panelId = useId();

  // Submenu coordination: the single open flyout (its Escape/collapse hooks) and the set of
  // portaled submenu panels (so an inside-click isn't mistaken for an outside dismissal).
  const openSubRef = useRef<{ id: string; escapeClose: () => void; collapse: () => void } | null>(null);
  const subPanels = useRef<Set<HTMLElement>>(new Set());

  const onSubmenuOpen = useCallback((id: string, escapeClose: () => void, collapse: () => void) => {
    // A new flyout opened → fold the previous one (without stealing focus) before recording this.
    if (openSubRef.current && openSubRef.current.id !== id) openSubRef.current.collapse();
    openSubRef.current = { id, escapeClose, collapse };
  }, []);
  const onSubmenuClose = useCallback((id: string) => {
    // Only forget it if it's still the recorded flyout — when folding straight into a sibling,
    // the new one has already claimed the slot.
    if (openSubRef.current?.id === id) openSubRef.current = null;
  }, []);
  const addSubPanel = useCallback((el: HTMLElement) => void subPanels.current.add(el), []);
  const removeSubPanel = useCallback((el: HTMLElement) => void subPanels.current.delete(el), []);

  const close = useCallback(() => {
    setOpen(false);
    openSubRef.current = null;
    triggerRef.current?.focus();
  }, []);

  const menuItems = useCallback(
    () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(ROAMABLE_ITEMS_SELECTOR) ?? []),
    [],
  );

  // Position the panel under the trigger once open, keeping it aligned on
  // scroll/resize and clamped inside the viewport (mirrors the Tooltip approach).
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const position = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!t || !panel) return;
      const top = t.bottom + GAP;
      const left = align === 'end' ? t.right - panel.width : t.left;
      setCoords({
        top: Math.max(GAP, Math.min(top, window.innerHeight - panel.height - GAP)),
        left: Math.max(GAP, Math.min(left, window.innerWidth - panel.width - GAP)),
      });
    };
    position();
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    return () => {
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
    };
  }, [open, align]);

  // On open, move focus to the first (or last, if opened with ArrowUp) item.
  useEffect(() => {
    if (!open) return;
    const items = menuItems();
    if (items.length === 0) return;
    (openIntent.current === 'last' ? items[items.length - 1] : items[0])?.focus();
  }, [open, menuItems]);

  // Escape closes; a pointer-press outside both trigger and panel dismisses it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape is a keyboard dismissal, so focus returns to the trigger (close()). When a
      // submenu is open it peels off first — one Escape per open level — before the root.
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (openSubRef.current) openSubRef.current.escapeClose();
        else close();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      // A press inside an open, portaled submenu panel is *inside* the menu even though the
      // panel lives outside the root panel in the DOM — don't treat it as an outside dismissal.
      for (const el of subPanels.current) if (el.contains(target)) return;
      // Intentionally setOpen(false), not close(): a click outside should let focus
      // follow the pointer to whatever was clicked — pulling it back to the trigger
      // would steal it. (Escape, above, deliberately does restore focus.)
      setOpen(false);
      openSubRef.current = null;
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openIntent.current = 'first';
      setOpen(true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openIntent.current = 'last';
      setOpen(true);
    }
  };

  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = menuItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[current >= items.length - 1 ? 0 : current + 1]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[current <= 0 ? items.length - 1 : current - 1]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      // Tab never lands inside a portaled menu cleanly — close and hand focus back.
      e.preventDefault();
      close();
    }
  };

  return (
    <>
      <Button
        ref={triggerRef}
        variant={triggerVariant}
        size={triggerSize}
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        onClick={() => {
          openIntent.current = 'first';
          setOpen((v) => !v);
        }}
        onKeyDown={onTriggerKeyDown}
        {...triggerProps}
      >
        {trigger}
      </Button>

      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="menu"
              aria-label={label}
              tabIndex={-1}
              onKeyDown={onPanelKeyDown}
              style={{
                position: 'fixed',
                top: coords?.top ?? 0,
                left: coords?.left ?? 0,
                visibility: coords ? 'visible' : 'hidden',
              }}
              className={cn(
                'z-[70] flex min-w-48 max-w-[min(20rem,calc(100vw-1rem))] flex-col gap-0.5 rounded-xl border border-border bg-popover/95 p-1.5 shadow-2xl shadow-black/40 backdrop-blur-xl',
                !reducedMotion && 'animate-fade-in',
              )}
            >
              <MenuContext.Provider
                value={{ close, onSubmenuOpen, onSubmenuClose, addSubPanel, removeSubPanel }}
              >
                {children}
              </MenuContext.Provider>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

const MENU_ITEM_CLASS =
  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:bg-secondary/60 focus-visible:text-foreground aria-[current=page]:bg-secondary aria-[current=page]:text-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0';

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

export interface MenuActionProps {
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /** Renders a leading check, for menu rows that toggle a mode on/off. */
  readonly selected?: boolean;
  /**
   * Promotes the row to a selectable choice so assistive tech is told its state, not just
   * shown a check glyph: `'radio'` for one-of-many (a `menuitemradio` — a view mode, a
   * grouping axis) and `'checkbox'` for an independent on/off (a `menuitemcheckbox`). Either
   * exposes `aria-checked` reflecting {@link selected}. Omit for a plain command row, which
   * stays a bare `menuitem` with no checked state (so existing call sites are unchanged).
   */
  readonly selectionRole?: 'radio' | 'checkbox';
  readonly 'data-testid'?: string;
}

/** A button menu row. Runs `onSelect` then closes the menu. */
export function MenuAction({
  icon,
  children,
  onSelect,
  disabled,
  selected,
  selectionRole,
  ...rest
}: MenuActionProps) {
  const ctx = useContext(MenuContext);
  const role =
    selectionRole === 'radio'
      ? 'menuitemradio'
      : selectionRole === 'checkbox'
        ? 'menuitemcheckbox'
        : 'menuitem';
  return (
    <button
      type="button"
      role={role}
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      aria-checked={selectionRole ? Boolean(selected) : undefined}
      className={MENU_ITEM_CLASS}
      onClick={() => {
        if (disabled) return;
        onSelect();
        ctx?.close();
      }}
      {...rest}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {selected ? <CheckIcon /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

/** A non-interactive divider between groups of menu rows. */
export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />;
}

/** Short delay before a hovered-away submenu closes, so a diagonal mouse path to its
 *  portaled panel (which briefly leaves the trigger) doesn't dismiss it. */
const SUBMENU_CLOSE_DELAY = 140;

export interface MenuSubProps {
  /** Leading glyph for the trigger row (shown when the submenu holds no checked child). */
  readonly icon?: ReactNode;
  /** The trigger row's label. */
  readonly label: ReactNode;
  /** Submenu rows — the same {@link MenuAction} / {@link MenuLink} / {@link MenuSeparator} set. */
  readonly children: ReactNode;
  /**
   * Renders a leading check on the trigger row when the submenu's active choice lives inside it
   * (e.g. the current view mode), so the collapsed row still reflects the selection at a glance.
   */
  readonly selected?: boolean;
  readonly 'data-testid'?: string;
}

/**
 * A nested submenu row: a trigger inside the parent menu that reveals a portaled flyout of
 * its own {@link MenuAction} rows to the side. Used to group a set of related choices (a view
 * mode, a grouping axis) behind one row instead of flattening them all into the parent.
 *
 * Behaviour (WAI-ARIA submenu): the trigger carries `aria-haspopup="menu"` / `aria-expanded`
 * and a trailing chevron. It opens on hover, click, Enter/Space, or ArrowRight (which also
 * moves focus into the flyout); ArrowLeft or Escape peels the flyout back off and returns
 * focus to the trigger; selecting a row closes the whole menu. Only one sibling flyout is
 * open at a time. The panel is portaled to `<body>`, positioned beside the trigger (flipping
 * to the other side when it would overflow) and viewport-clamped, mirroring the root panel.
 */
export function MenuSub({ icon, label, children, selected, ...rest }: MenuSubProps) {
  const ctx = useContext(MenuContext);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const reducedMotion = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const triggerId = useId();
  // Whether the open-effect should land focus on the first item (keyboard/click open) or
  // leave it be (hover open shouldn't yank focus away from a mouse user).
  const focusFirstRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const submenuItems = useCallback(
    () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(ROAMABLE_ITEMS_SELECTOR) ?? []),
    [],
  );

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const closeSelf = useCallback(
    (restoreFocus: boolean) => {
      cancelClose();
      setOpen(false);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [cancelClose],
  );

  const openSelf = useCallback(
    (focusFirst: boolean) => {
      cancelClose();
      focusFirstRef.current = focusFirst;
      setOpen(true);
    },
    [cancelClose],
  );

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), SUBMENU_CLOSE_DELAY);
  }, [cancelClose]);

  // Announce open/close to the root so it can enforce single-flyout exclusivity (folding any
  // sibling that was open), route Escape, and treat clicks inside the portaled panel as inside
  // the menu. `escapeClose` restores focus to the trigger (keyboard dismissal); `collapse`
  // folds this flyout when a sibling opens, without stealing focus.
  useEffect(() => {
    if (!open) return;
    ctx?.onSubmenuOpen(
      id,
      () => closeSelf(true),
      () => closeSelf(false),
    );
    return () => ctx?.onSubmenuClose(id);
  }, [open, id, ctx, closeSelf]);

  useEffect(() => cancelClose, [cancelClose]);

  // Register the portaled panel for the root's outside-click containment check.
  useEffect(() => {
    const el = panelRef.current;
    if (!open || !el || !ctx) return;
    ctx.addSubPanel(el);
    return () => ctx.removeSubPanel(el);
  }, [open, ctx]);

  // Position the flyout beside the trigger, flipping to the other side when it would overflow.
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const position = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!t || !panel) return;
      // Prefer the right edge (with a hair of overlap); flip left if it would spill off-screen.
      let left = t.right - 4;
      if (left + panel.width > window.innerWidth - GAP) left = t.left - panel.width + 4;
      // Nudge up so the first row sits level with the trigger (accounting for panel padding).
      const top = t.top - 6;
      setCoords({
        top: Math.max(GAP, Math.min(top, window.innerHeight - panel.height - GAP)),
        left: Math.max(GAP, Math.min(left, window.innerWidth - panel.width - GAP)),
      });
    };
    position();
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    return () => {
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
    };
  }, [open]);

  // On (keyboard/click) open, land focus on the first flyout item.
  useEffect(() => {
    if (!open || !focusFirstRef.current) return;
    submenuItems()[0]?.focus();
    focusFirstRef.current = false;
  }, [open, submenuItems]);

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      openSelf(true);
    }
    // ArrowUp/ArrowDown/Home/End are left to bubble to the root panel so they roam the
    // parent rows as usual when the flyout is closed.
  };

  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = submenuItems();
    // ArrowLeft peels the flyout back off, returning to the trigger (Escape is handled by the
    // root's capture listener, which routes to this submenu first). Stop these from also
    // reaching the root panel's own key handler (events bubble the React tree, not the DOM).
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      closeSelf(true);
      return;
    }
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      items[current >= items.length - 1 ? 0 : current + 1]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      items[current <= 0 ? items.length - 1 : current - 1]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      items[items.length - 1]?.focus();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={MENU_ITEM_CLASS}
        onClick={() => (open ? closeSelf(true) : openSelf(true))}
        onKeyDown={onTriggerKeyDown}
        onPointerEnter={(e) => {
          // Hover-open for pointers only (a touch tap is a click, handled above).
          if (e.pointerType !== 'touch') openSelf(false);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== 'touch') scheduleClose();
        }}
        {...rest}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {selected ? <CheckIcon /> : icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRightIcon aria-hidden className="ml-1 shrink-0 text-muted-foreground" />
      </button>

      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="menu"
              aria-labelledby={triggerId}
              tabIndex={-1}
              onKeyDown={onPanelKeyDown}
              onPointerEnter={cancelClose}
              onPointerLeave={(e) => {
                if (e.pointerType !== 'touch') scheduleClose();
              }}
              style={{
                position: 'fixed',
                top: coords?.top ?? 0,
                left: coords?.left ?? 0,
                visibility: coords ? 'visible' : 'hidden',
              }}
              className={cn(
                'z-[71] flex min-w-44 max-w-[min(20rem,calc(100vw-1rem))] flex-col gap-0.5 rounded-xl border border-border bg-popover/95 p-1.5 shadow-2xl shadow-black/40 backdrop-blur-xl',
                !reducedMotion && 'animate-fade-in',
              )}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
