import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/foundry';
import { EditIcon, QrCodeIcon } from '@/components/icons';

interface LocationRowActionsProps {
  readonly onEdit?: () => void;
  readonly editLabel?: string;
  readonly onPrintLabel?: () => void;
  readonly printLabelLabel?: string;
}

/**
 * The per-row Edit / Print affordances of a {@link LocationTreeItem}. They reserve
 * *no* layout space until the row is hovered or holds keyboard focus — so a long location name
 * is never truncated by buttons that aren't even visible. On reveal, the container eases its
 * width (and fades) open with the house cubic-bezier; the reduced-motion catch-all in index.css
 * neutralises this transition for users who ask for minimal motion. On a device that cannot
 * hover, the `touch:` variant pins the cluster open instead — a collapsed, transparent container
 * offers a touch user no reveal *and* no hit target, which put these actions out of reach
 * altogether on a tablet or phone; the name simply truncates a little sooner there. Every button is
 * `tabindex={-1}` (mouse / keyboard-key driven) so the treeitem itself stays the only tab stop,
 * and each carries a Foundry {@link Tooltip} so the icon-only control's purpose is discoverable
 * on hover (its `aria-label` already names it for assistive tech).
 *
 * Print sits **last**, after Edit (issue #613). A system row (Unassigned, In Transit) can only be
 * printed, not edited, so it shows a single button; ordering Print last is what keeps that lone
 * button in the same column as the Print button of every editable row below it, rather than
 * landing under their Edit pencils.
 *
 * Deletion and archiving are deliberately **not** here: they act on the location's lifecycle
 * rather than its everyday use, out of place in a cramped hover row, so they live in the
 * Edit-location dialog's footer (a considered, spacious context) — delete alongside the single
 * Archive / Restore toggle, plus the keyboard `Delete` key for deletion. See
 * {@link EditLocationDialog}.
 */
export function LocationRowActions({
  onEdit,
  editLabel,
  onPrintLabel,
  printLabelLabel,
}: LocationRowActionsProps) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center overflow-hidden opacity-0 max-w-0',
        'transition-[max-width,opacity] duration-300 ease-emphasized',
        'group-hover:max-w-[7.5rem] group-hover:opacity-100',
        'group-focus-within:max-w-[7.5rem] group-focus-within:opacity-100',
        // No hover means no reveal and no hit target, so a touch device gets them pinned open.
        'touch:max-w-[7.5rem] touch:opacity-100',
      )}
    >
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
    </div>
  );
}
