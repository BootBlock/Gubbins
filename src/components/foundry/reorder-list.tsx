import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDownIcon, ChevronUpIcon, DragHandleIcon, HideIcon, ShowIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { LiveRegion } from './live-region';

/** One row of a {@link ReorderList}. */
export interface ReorderListItem {
  readonly id: string;
  /** The visible row content (label, chips, …). */
  readonly label: ReactNode;
  /**
   * A short accessible name for this row's controls, woven into their labels — e.g. `name:
   * "Location"` yields "Move Location up" / "Hide Location". Keep it plain text.
   */
  readonly name: string;
  /**
   * Whether the row is currently shown. Omit to render no show/hide toggle (a pure reorder
   * list); provide it (with {@link ReorderListProps.onToggleVisible}) to render one. A hidden
   * row is dimmed but stays in place so it can be reordered and re-shown.
   */
  readonly visible?: boolean;
}

export interface ReorderListProps {
  readonly items: readonly ReorderListItem[];
  /** Move a row one slot up or down. The list itself is controlled — the caller reorders. */
  readonly onMove: (id: string, dir: 'up' | 'down') => void;
  /** Show/hide a row. Provide together with each item's `visible` to render the toggle. */
  readonly onToggleVisible?: (id: string, visible: boolean) => void;
  /** Names the list for assistive tech (spread onto the `<ul>` as `aria-label`). */
  readonly 'aria-label': string;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

/** Small ghost icon-button used for the row's move/visibility controls. */
function IconButton({
  label,
  onClick,
  disabled,
  testId,
  moveKey,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  /** `"<dir>:<id>"` marker on a move button, so focus can re-home to it after a reorder. */
  moveKey?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      data-testid={testId}
      data-reorder-move={moveKey}
      className={cn(
        'rounded-md p-1 text-muted-foreground transition-colors [&_svg]:size-4',
        'hover:bg-muted hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:pointer-events-none disabled:opacity-40',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Foundry ReorderList — a keyboard-operable, accessible ordered list whose rows can be
 * nudged up/down and (optionally) shown/hidden, without a hand-rolled control at each call
 * site. Reordering is via labelled move buttons (disabled at the ends) rather than
 * pointer-only drag, so it is fully keyboard- and assistive-tech-operable — the accessible
 * counterpart to the dashboard board's drag affordance, for a simple one-dimensional list
 * (the item-card field picker, and future tile/column ordering). Controlled: the caller owns
 * the order and applies each `onMove` / `onToggleVisible` (pure ops make this a one-liner).
 *
 * Keyboard focus follows a moved row: after a move re-renders the list, the pressed button may
 * have shifted and/or become disabled (the row reached an end), which would silently drop
 * focus. `handleMove` records the move and, once the new order paints, focus is re-homed onto
 * that row — the same-direction button if it's still live, else the opposite one (guaranteed
 * live at an end) — so a keyboard user can nudge a row repeatedly without re-finding it.
 *
 * The same pass announces the row's new place through a built-in `LiveRegion` ("Location moved
 * to position 2 of 7", WCAG 4.1.3): a sighted user sees the row slide, so a screen-reader user
 * needs the equivalent confirmation rather than silence. It reads the *applied* order, so a
 * caller whose `onMove` declined the move (or clamped it) says nothing.
 */
export function ReorderList({
  items,
  onMove,
  onToggleVisible,
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: ReorderListProps) {
  const t = useT();
  const listRef = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<{ id: string; dir: 'up' | 'down'; from: number } | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const handleMove = (id: string, dir: 'up' | 'down') => {
    pendingFocus.current = { id, dir, from: items.findIndex((item) => item.id === id) };
    onMove(id, dir);
  };

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    pendingFocus.current = null;

    // Nothing to do unless the caller actually applied the move. A declined or clamped press
    // leaves the row where it was, so there is no new position to announce and no re-homing to
    // do — the pressed button hasn't moved and still holds focus. Bailing here also stops a
    // declined press (which may not re-render at all) from firing against a later, unrelated
    // update as a focus jump and an announcement the user never earned.
    const to = items.findIndex((item) => item.id === pending.id);
    if (to === -1 || to === pending.from) return;

    setAnnouncement(
      t('reorderList.moveAnnounce', {
        vars: { name: items[to]!.name, position: to + 1, total: items.length },
      }),
    );

    const root = listRef.current;
    if (root === null) return;
    const button = (dir: 'up' | 'down') =>
      root.querySelector<HTMLButtonElement>(`[data-reorder-move="${dir}:${pending.id}"]`);
    const primary = button(pending.dir);
    // The pressed button if it's still enabled, else the opposite (a row at an end always has
    // one live move button), so focus never lands on a disabled control.
    const target = primary && !primary.disabled ? primary : button(pending.dir === 'up' ? 'down' : 'up');
    target?.focus();
  }, [items, t]);

  return (
    <>
      <ul ref={listRef} aria-label={ariaLabel} data-testid={testId} className={cn('space-y-2', className)}>
        {items.map((item, index) => {
          const isFirst = index === 0;
          const isLast = index === items.length - 1;
          const hidden = item.visible === false;
          return (
            <li
              key={item.id}
              data-testid={`reorder-row-${item.id}`}
              className={cn(
                'flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2',
                hidden && 'opacity-60',
              )}
            >
              <DragHandleIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/70" />
              <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
              <div className="flex shrink-0 items-center gap-0.5">
                <IconButton
                  label={t('reorderList.moveUp', { vars: { name: item.name } })}
                  onClick={() => handleMove(item.id, 'up')}
                  disabled={isFirst}
                  testId={`reorder-up-${item.id}`}
                  moveKey={`up:${item.id}`}
                >
                  <ChevronUpIcon />
                </IconButton>
                <IconButton
                  label={t('reorderList.moveDown', { vars: { name: item.name } })}
                  onClick={() => handleMove(item.id, 'down')}
                  disabled={isLast}
                  testId={`reorder-down-${item.id}`}
                  moveKey={`down:${item.id}`}
                >
                  <ChevronDownIcon />
                </IconButton>
                {onToggleVisible && item.visible !== undefined ? (
                  <IconButton
                    label={t(item.visible ? 'reorderList.hide' : 'reorderList.show', {
                      vars: { name: item.name },
                    })}
                    onClick={() => onToggleVisible(item.id, !item.visible)}
                    testId={`reorder-toggle-${item.id}`}
                  >
                    {item.visible ? <HideIcon /> : <ShowIcon />}
                  </IconButton>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <LiveRegion visuallyHidden>{announcement ? <p>{announcement}</p> : null}</LiveRegion>
    </>
  );
}
