import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDownIcon, ChevronUpIcon, DragHandleIcon, HideIcon, ShowIcon } from '@/components/icons';

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
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      data-testid={testId}
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
 */
export function ReorderList({
  items,
  onMove,
  onToggleVisible,
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: ReorderListProps) {
  return (
    <ul aria-label={ariaLabel} data-testid={testId} className={cn('space-y-2', className)}>
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
                label={`Move ${item.name} up`}
                onClick={() => onMove(item.id, 'up')}
                disabled={isFirst}
                testId={`reorder-up-${item.id}`}
              >
                <ChevronUpIcon />
              </IconButton>
              <IconButton
                label={`Move ${item.name} down`}
                onClick={() => onMove(item.id, 'down')}
                disabled={isLast}
                testId={`reorder-down-${item.id}`}
              >
                <ChevronDownIcon />
              </IconButton>
              {onToggleVisible && item.visible !== undefined ? (
                <IconButton
                  label={`${item.visible ? 'Hide' : 'Show'} ${item.name}`}
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
  );
}
