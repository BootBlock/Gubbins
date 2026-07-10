import { Suspense, lazy, useState, type ComponentType } from 'react';
import { cn } from '@/lib/utils';
import { CloseIcon, type LucideProps } from '@/components/icons';
import { Glyph } from './Glyph';
import { humanizeGlyphName } from './glyph-name';

// The picker carries the full icon catalogue, so it is code-split behind a dynamic
// import and only fetched the first time a user opens it.
const GlyphPicker = lazy(() => import('./GlyphPicker').then((m) => ({ default: m.GlyphPicker })));

export interface GlyphPickerButtonProps {
  /** Current glyph (canonical Lucide name), or null/undefined for none chosen. */
  readonly value: string | null | undefined;
  /** Called with the chosen glyph, or `null` when cleared (only if `clearable`). */
  readonly onChange: (glyph: string | null) => void;
  /** Glyph shown in the trigger when nothing is chosen (e.g. the domain's default icon). */
  readonly fallback?: ComponentType<LucideProps>;
  /** Text shown in the trigger when nothing is chosen. */
  readonly placeholder?: string;
  /** Accessible name for the trigger button (e.g. "Choose project icon"). */
  readonly 'aria-label'?: string;
  /** Title of the picker dialog. */
  readonly title?: string;
  /** When set, show a control to clear the chosen glyph back to none. */
  readonly clearable?: boolean;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
}

/**
 * A labelled trigger that opens the app-wide {@link GlyphPicker} and previews the current
 * glyph — the drop-in control any form uses to let a user pick an optional icon. It seeds
 * the picker with the current `value` so re-opening it lands on the existing choice, and
 * lazy-loads the picker (and its icon catalogue) only on first open.
 */
export function GlyphPickerButton({
  value,
  onChange,
  fallback,
  placeholder = 'Choose an icon',
  'aria-label': ariaLabel,
  title,
  clearable = false,
  disabled = false,
  id,
  className,
}: GlyphPickerButtonProps) {
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
        <Glyph
          name={value}
          fallback={fallback}
          className="size-5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className={cn('min-w-0 truncate', !value && 'text-muted-foreground')}>
          {value ? humanizeGlyphName(value) : placeholder}
        </span>
      </button>

      {clearable && value ? (
        <button
          type="button"
          disabled={disabled}
          aria-label="Remove icon"
          onClick={() => onChange(null)}
          className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CloseIcon className="size-4" aria-hidden />
        </button>
      ) : null}

      {open ? (
        <Suspense fallback={null}>
          <GlyphPicker
            open
            title={title}
            initialGlyph={value ?? null}
            onClose={() => setOpen(false)}
            onSelect={(glyph) => {
              onChange(glyph);
              setOpen(false);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
