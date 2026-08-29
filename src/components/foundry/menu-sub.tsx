import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { CheckIcon, ChevronRightIcon } from '@/components/icons';
import { GAP, MENU_ITEM_CLASS, MenuContext, ROAMABLE_ITEMS_SELECTOR } from './menu-context';
import { useReducedMotion } from './useReducedMotion';

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
