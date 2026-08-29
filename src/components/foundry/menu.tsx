import {
  useCallback,
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
import { cn } from '@/lib/utils';
import { Button, type ButtonProps } from './button';
import { GAP, MenuContext, ROAMABLE_ITEMS_SELECTOR } from './menu-context';
import { useReducedMotion } from './useReducedMotion';

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
