import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { ChevronDownIcon, ChevronRightIcon } from '@/components/icons';
import { LocationInlineRename } from './LocationInlineRename';
import { LocationRowActions } from './LocationRowActions';

export interface TreeItemProps {
  readonly id: string;
  readonly level: number;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  /** Tailwind text-colour class tinting the name (the location's swatch), if any. */
  readonly colorClass?: string;
  /** Optional free-text description, surfaced as a hover/focus tooltip on the row. */
  readonly description?: string | null;
  readonly count: number;
  /** `undefined` when the node has no children (no `aria-expanded`). */
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
  readonly onSelect: () => void;
  readonly onFocus: () => void;
  /** When true, the label is replaced by an inline rename input (F2). */
  readonly editing?: boolean;
  readonly onRename?: (name: string) => void;
  readonly onRenameCancel?: () => void;
  readonly onEdit?: () => void;
  readonly editLabel?: string;
  readonly onDelete?: () => void;
  readonly deleteLabel?: string;
  readonly onPrintLabel?: () => void;
  readonly printLabelLabel?: string;
  readonly ref: (el: HTMLDivElement | null) => void;
}

/**
 * One row of the location tree, rendered as a focusable `role="treeitem"`. Hierarchy
 * is conveyed by `aria-level` (a flat ARIA tree — no nested `role="group"` wrappers),
 * indentation by padding. The expand chevron and delete control are `tabindex={-1}`
 * (and mouse/keyboard-key driven) so the treeitem itself is the only tab stop.
 */
export function LocationTreeItem({
  id,
  level,
  selected,
  focused,
  icon,
  label,
  colorClass,
  description,
  count,
  expanded,
  onToggle,
  onSelect,
  onFocus,
  editing,
  onRename,
  onRenameCancel,
  onEdit,
  editLabel,
  onDelete,
  deleteLabel,
  onPrintLabel,
  printLabelLabel,
  ref,
}: TreeItemProps) {
  return (
    <div
      ref={ref}
      role="treeitem"
      aria-level={level}
      aria-selected={selected}
      aria-expanded={expanded}
      aria-label={label}
      tabIndex={focused ? 0 : -1}
      data-tree-id={id}
      onFocus={onFocus}
      onClick={onSelect}
      className={cn(
        'group flex cursor-pointer items-center gap-1 rounded-lg pr-1 outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-primary/60',
        selected ? 'bg-primary/15' : 'hover:bg-secondary/60',
      )}
      style={{ paddingLeft: `${(level - 1) * 12}px` }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={
          onToggle
            ? (e) => {
                e.stopPropagation();
                onToggle();
              }
            : undefined
        }
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded text-muted-foreground [&_svg]:size-3.5',
          !onToggle && 'invisible',
        )}
      >
        {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
      </button>
      <span
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 py-1.5 text-sm [&_svg]:size-4',
          selected ? 'font-medium text-primary' : 'text-foreground',
        )}
      >
        {icon}
        {editing && onRename && onRenameCancel ? (
          <LocationInlineRename initial={label} onCommit={onRename} onCancel={onRenameCancel} />
        ) : (
          <>
            {description ? (
              // The description rides as a hover/focus tooltip on the name. The wrapper
              // takes the flex role so the name still truncates within the row.
              <Tooltip
                content={description}
                placement="right"
                triggerTabIndex={-1}
                openDelayMs={INFO_OPEN_DELAY_MS}
                className="min-w-0 flex-1"
              >
                <span className={cn('block truncate text-left', colorClass)}>{label}</span>
              </Tooltip>
            ) : (
              <span className={cn('min-w-0 flex-1 truncate text-left', colorClass)}>{label}</span>
            )}
            <span className="ml-auto pl-1 text-xs tabular-nums text-muted-foreground">{count}</span>
          </>
        )}
      </span>
      {!editing && (onEdit || onDelete || onPrintLabel) ? (
        <LocationRowActions
          onPrintLabel={onPrintLabel}
          printLabelLabel={printLabelLabel}
          onEdit={onEdit}
          editLabel={editLabel}
          onDelete={onDelete}
          deleteLabel={deleteLabel}
        />
      ) : null}
    </div>
  );
}
