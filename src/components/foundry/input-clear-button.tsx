import { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { CloseIcon } from '@/components/icons';

/**
 * Foundry InputClearButton — the small "✕" adornment that clears a text control from
 * inside its right edge (spec §2.4.1). One definition of the in-input clear affordance
 * so every clearable search box shares the same hit area, glyph tint and focus ring
 * instead of hand-rolling a bare `<button>` per call site.
 *
 * Positioning: flows inline — the caller anchors it inside the control's right edge
 * (an absolutely-positioned wrapper in the input's `relative` container, e.g. a
 * {@link Tooltip} trigger) and gives the input enough right padding (`pr-9`) for it
 * to sit over. Render it only while the control has text.
 */
export interface InputClearButtonProps {
  /** Accessible name for the icon-only control (e.g. "Clear search"). */
  readonly label: string;
  readonly onClick: () => void;
  /** Extra classes merged onto the button (e.g. a different `right-*` offset). */
  readonly className?: string;
}

export const InputClearButton = forwardRef<HTMLButtonElement, InputClearButtonProps>(
  ({ label, onClick, className }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'grid size-7 place-items-center rounded-md',
        'text-muted-foreground outline-none transition-colors hover:bg-secondary/60 hover:text-foreground',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4',
        className,
      )}
    >
      <CloseIcon aria-hidden />
    </button>
  ),
);
InputClearButton.displayName = 'InputClearButton';
