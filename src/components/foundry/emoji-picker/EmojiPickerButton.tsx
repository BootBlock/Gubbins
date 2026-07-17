import { Suspense, lazy, useState } from 'react';
import { cn } from '@/lib/utils';
import { CloseIcon } from '@/components/icons';

// The picker carries the emoji catalogue, so it is code-split behind a dynamic import and
// only fetched the first time a user opens it. The trigger below deliberately imports
// *nothing* from `emoji-data` / `emoji-search`, so the catalogue never rides into the eager
// bundle this button lands in (the same discipline as the Lucide glyph picker) — the chosen
// emoji character is self-descriptive, so no name lookup is needed to preview it.
const EmojiPicker = lazy(() => import('./EmojiPicker').then((m) => ({ default: m.EmojiPicker })));

export interface EmojiPickerButtonProps {
  /** Current emoji character, or null/undefined for none chosen. */
  readonly value: string | null | undefined;
  /** Called with the chosen emoji, or `null` when cleared (only if `clearable`). */
  readonly onChange: (emoji: string | null) => void;
  /** Placeholder glyph shown in the trigger when nothing is chosen. */
  readonly placeholderGlyph?: string;
  /** Text shown in the trigger when nothing is chosen. */
  readonly placeholder?: string;
  /**
   * Caption shown in the trigger beside the chosen emoji. The emoji itself is the identity,
   * so this is a short affordance rather than the emoji's name (which would need the
   * catalogue). Defaults to "Change glyph".
   */
  readonly selectedLabel?: string;
  /** Accessible name for the trigger button (e.g. "Choose category glyph"). */
  readonly 'aria-label'?: string;
  /** Title of the picker dialog. */
  readonly title?: string;
  /** When set, show a control to clear the chosen emoji back to none. */
  readonly clearable?: boolean;
  /** Accessible name for the clear control (defaults to "Remove glyph"). */
  readonly clearLabel?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
}

/**
 * A labelled trigger that opens the app-wide {@link EmojiPicker} and previews the current
 * emoji — the drop-in control any form uses to let a user pick an optional Unicode glyph. It
 * seeds the picker with the current `value` so re-opening it lands on the existing choice,
 * and lazy-loads the picker (and its catalogue) only on first open.
 */
export function EmojiPickerButton({
  value,
  onChange,
  placeholderGlyph = '🙂',
  placeholder = 'Choose a glyph',
  selectedLabel = 'Change glyph',
  'aria-label': ariaLabel,
  title,
  clearable = false,
  clearLabel = 'Remove glyph',
  disabled = false,
  id,
  className,
}: EmojiPickerButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={() => setOpen(true)}
        className="flex h-10 min-w-0 flex-1 items-center gap-3 rounded-lg border border-border bg-input/40 px-3 text-left text-sm text-foreground shadow-sm outline-none transition-colors hover:bg-secondary/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="grid size-6 shrink-0 place-items-center text-xl leading-none" aria-hidden>
          {value || placeholderGlyph}
        </span>
        <span className={cn('min-w-0 truncate', !value && 'text-muted-foreground')}>
          {value ? selectedLabel : placeholder}
        </span>
      </button>

      {clearable && value ? (
        <button
          type="button"
          disabled={disabled}
          aria-label={clearLabel}
          onClick={() => onChange(null)}
          className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CloseIcon className="size-4" aria-hidden />
        </button>
      ) : null}

      {open ? (
        <Suspense fallback={null}>
          <EmojiPicker
            open
            title={title}
            initialEmoji={value ?? null}
            onClose={() => setOpen(false)}
            onSelect={(emoji) => {
              onChange(emoji);
              setOpen(false);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
