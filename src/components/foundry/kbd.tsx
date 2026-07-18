/**
 * Kbd — a keyboard-cap glyph for rendering a shortcut (issue #127).
 *
 * Shortcuts are now shown in four unrelated places (the cheat sheet, the navigation menu, the
 * command palette's rows and its help footer), and a keycap drawn slightly differently in each is
 * exactly the drift a primitive exists to prevent.
 *
 * **Sequences render as separate caps.** A binding like `G R` is two key presses in turn, so it
 * draws as two caps with a "then" between them rather than one wide cap — the visual distinction
 * that stops it being read as "hold G and R together". Pass the binding through `displayBinding`
 * first; this renders whatever string it is given, splitting on the space.
 */
import type { ReactNode } from 'react';
import { useT } from '@/features/i18n';
import { cn } from '@/lib/utils';

export interface KbdProps {
  /**
   * A display binding (`Ctrl+/`, `G R`) or arbitrary cap content. A space separates the chords of
   * a sequence and is rendered as a "then" separator.
   */
  readonly children: ReactNode;
  readonly className?: string;
}

/** One cap. Kept private — callers get the sequence-aware {@link Kbd}. */
function Cap({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex min-w-5 items-center justify-center rounded border border-border bg-card px-1 py-0.5 font-mono text-[10px] font-medium leading-none text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Kbd({ children, className }: KbdProps) {
  const t = useT();
  // Only a plain string can be a sequence; anything richer is a single cap by definition.
  if (typeof children !== 'string' || !children.includes(' ')) {
    return <Cap className={className}>{children}</Cap>;
  }
  const chords = children.split(' ');
  return (
    // A single group so screen readers read "G then R" as one shortcut rather than two stray
    // letters; the separator is decorative because that reading already carries it.
    <span className="inline-flex items-center gap-1">
      {chords.map((chord, i) => (
        <span key={`${chord}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 ? (
            <span aria-hidden className="text-[10px] text-muted-foreground/70">
              {t('hotkeys.sequenceSeparator')}
            </span>
          ) : null}
          <Cap className={className}>{chord}</Cap>
        </span>
      ))}
    </span>
  );
}
