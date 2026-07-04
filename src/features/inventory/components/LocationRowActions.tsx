import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/foundry';
import { ArchiveIcon, ArchiveRestoreIcon, EditIcon, QrCodeIcon } from '@/components/icons';

interface LocationRowActionsProps {
  readonly onPrintLabel?: () => void;
  readonly printLabelLabel?: string;
  readonly onEdit?: () => void;
  readonly editLabel?: string;
  readonly onArchive?: () => void;
  readonly archiveLabel?: string;
  readonly onRestore?: () => void;
  readonly restoreLabel?: string;
}

/**
 * The per-row Print / Edit / Archive affordances of a {@link LocationTreeItem}. They reserve
 * *no* layout space until the row is hovered or holds keyboard focus — so a long location name
 * is never truncated by buttons that aren't even visible. On reveal, the container eases its
 * width (and fades) open with the house cubic-bezier; the reduced-motion catch-all in index.css
 * neutralises this transition for users who ask for minimal motion. Every button is
 * `tabindex={-1}` (mouse / keyboard-key driven) so the treeitem itself stays the only tab stop,
 * and each carries a Foundry {@link Tooltip} so the icon-only control's purpose is discoverable
 * on hover (its `aria-label` already names it for assistive tech).
 *
 * Deletion is deliberately **not** here: it is a destructive action, out of place in a cramped
 * hover row, so it lives in the Edit-location dialog's footer (a considered, spacious context)
 * and on the keyboard `Delete` key. See {@link EditLocationDialog}.
 */
export function LocationRowActions({
  onPrintLabel,
  printLabelLabel,
  onEdit,
  editLabel,
  onArchive,
  archiveLabel,
  onRestore,
  restoreLabel,
}: LocationRowActionsProps) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center overflow-hidden opacity-0 max-w-0',
        'transition-[max-width,opacity] duration-300 ease-emphasized',
        'group-hover:max-w-[7.5rem] group-hover:opacity-100',
        'group-focus-within:max-w-[7.5rem] group-focus-within:opacity-100',
      )}
    >
      {onPrintLabel ? (
        <Tooltip content="Print a label for this location" triggerTabIndex={-1}>
          <button
            type="button"
            tabIndex={-1}
            aria-label={printLabelLabel}
            onClick={(e) => {
              e.stopPropagation();
              onPrintLabel();
            }}
            className="grid size-6 shrink-0 place-items-center rounded transition-colors hover:bg-secondary [&_svg]:size-3.5"
          >
            <QrCodeIcon className="text-glyph-scan" />
          </button>
        </Tooltip>
      ) : null}
      {onEdit ? (
        <Tooltip
          content="Edit this location — rename it, move it, change its type, colour or capacity"
          triggerTabIndex={-1}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label={editLabel}
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="grid size-6 shrink-0 place-items-center rounded transition-colors hover:bg-secondary [&_svg]:size-3.5"
          >
            <EditIcon className="text-glyph-edit" />
          </button>
        </Tooltip>
      ) : null}
      {onRestore ? (
        <Tooltip content="Restore this archived location" triggerTabIndex={-1}>
          <button
            type="button"
            tabIndex={-1}
            aria-label={restoreLabel}
            onClick={(e) => {
              e.stopPropagation();
              onRestore();
            }}
            className="grid size-6 shrink-0 place-items-center rounded transition-colors hover:bg-secondary [&_svg]:size-3.5"
          >
            <ArchiveRestoreIcon className="text-glyph-success" />
          </button>
        </Tooltip>
      ) : null}
      {onArchive ? (
        <Tooltip content="Archive this location — hides it without deleting" triggerTabIndex={-1}>
          <button
            type="button"
            tabIndex={-1}
            aria-label={archiveLabel}
            onClick={(e) => {
              e.stopPropagation();
              onArchive();
            }}
            className="grid size-6 shrink-0 place-items-center rounded transition-colors hover:bg-secondary [&_svg]:size-3.5"
          >
            <ArchiveIcon className="text-glyph-neutral" />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}
