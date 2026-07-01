import { cn } from '@/lib/utils';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  DeleteIcon,
  EditIcon,
  QrCodeIcon,
} from '@/components/icons';

interface LocationRowActionsProps {
  readonly onPrintLabel?: () => void;
  readonly printLabelLabel?: string;
  readonly onEdit?: () => void;
  readonly editLabel?: string;
  readonly onArchive?: () => void;
  readonly archiveLabel?: string;
  readonly onRestore?: () => void;
  readonly restoreLabel?: string;
  readonly onDelete?: () => void;
  readonly deleteLabel?: string;
}

/**
 * The per-row Edit / Delete affordances of a {@link LocationTreeItem}. They reserve
 * *no* layout space until the row is hovered or holds keyboard focus — so a long
 * location name is never truncated by buttons that aren't even visible. On reveal,
 * the container eases its width (and fades) open with the house cubic-bezier; the
 * reduced-motion catch-all in index.css neutralises this transition for users who
 * ask for minimal motion. Both buttons are `tabindex={-1}` (mouse / keyboard-key
 * driven) so the treeitem itself stays the only tab stop.
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
  onDelete,
  deleteLabel,
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
      ) : null}
      {onEdit ? (
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
      ) : null}
      {onRestore ? (
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
      ) : null}
      {onArchive ? (
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
      ) : null}
      {onDelete ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={deleteLabel}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="grid size-6 shrink-0 place-items-center rounded transition-colors hover:bg-secondary [&_svg]:size-3.5"
        >
          <DeleteIcon className="text-glyph-danger" />
        </button>
      ) : null}
    </div>
  );
}
