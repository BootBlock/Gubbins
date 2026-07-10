import { Button } from './button';
import { CloseIcon } from '@/components/icons';

/**
 * CloseButton — the canonical top-right “✕” dismissal control (spec §2.4.1).
 *
 * A single definition of the dialog close affordance so every dismissable surface — the Foundry
 * {@link Modal} header, and any panel that can be closed inline (e.g. the inventory Visual-search
 * card) — shares one look, one focus ring and one accessible name. A ghost icon {@link Button}
 * wrapping the central {@link CloseIcon} glyph, tinted with the neutral-glyph token; it never
 * hand-rolls a bare `<button>`, so the variant/sizing/ARIA wiring lives in exactly one place.
 */
export interface CloseButtonProps {
  /** Dismiss handler — closes the surface this button sits on. */
  readonly onClick: () => void;
  /** Accessible name for the icon-only control. Defaults to "Close". */
  readonly label?: string;
  /** Extra classes merged onto the button (e.g. to override the glyph colour on a dark overlay). */
  readonly className?: string;
}

export function CloseButton({ onClick, label = 'Close', className }: CloseButtonProps) {
  return (
    <Button variant="ghost" size="icon" onClick={onClick} aria-label={label} className={className}>
      <CloseIcon className="text-glyph-neutral" />
    </Button>
  );
}
