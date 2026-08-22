import { Glyph } from '@/components/foundry';
import { FolderIcon, FolderOpenIcon } from '@/components/icons';

/**
 * Renders a location's chosen icon — a canonical Lucide glyph name picked with the app-wide
 * glyph picker (issue #434). A location with no icon (or one naming a glyph the catalogue
 * doesn't know) falls back to the generic folder glyph — open when it has expanded children,
 * matching the tree's long-standing behaviour.
 */
export function LocationIcon({
  icon,
  expanded,
  className,
}: {
  readonly icon: string | null | undefined;
  /** For the folder fallback only: show the open folder when the node is expanded. */
  readonly expanded?: boolean;
  readonly className?: string;
}) {
  return (
    <Glyph name={icon} fallback={expanded ? FolderOpenIcon : FolderIcon} className={className} aria-hidden />
  );
}
