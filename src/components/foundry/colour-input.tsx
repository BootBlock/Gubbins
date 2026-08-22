import { useEffect, useRef, useState } from 'react';
import { ColourIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { COLOUR_FORMATS, contrastingInk, formatColour, parseColour, type ColourFormat } from '@/lib/colour';
import { cn } from '@/lib/utils';
import { Input } from './input';
import { Menu, MenuAction } from './menu';
import type { MessageKey } from '@/features/i18n';

/** The translated name of each notation, for the "Show as" menu. */
const FORMAT_LABEL: Record<ColourFormat, MessageKey> = {
  HEX: 'field.colour.format.hex',
  RGB: 'field.colour.format.rgb',
  HSL: 'field.colour.format.hsl',
  HSB: 'field.colour.format.hsb',
  NAME: 'field.colour.format.name',
};

export interface ColourInputProps {
  /** The canonical `#rrggbb` / `#rrggbbaa` value, or `''` when the field is empty. */
  readonly value: string;
  /** Fired with the new canonical value, or `''` when the box is cleared. */
  readonly onChange: (value: string) => void;
  readonly onBlur?: () => void;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-invalid'?: true;
  readonly 'aria-describedby'?: string;
  readonly className?: string;
}

/**
 * The Foundry colour control: a text box that accepts **any** colour notation, a native
 * swatch for picking one, and a menu that re-renders the value in another notation.
 *
 * The design follows from one decision made in `src/lib/colour.ts`: a colour is *stored* in
 * exactly one spelling (canonical `#rrggbb`), and every other notation is a way of reading
 * or writing it. So the text box parses whatever the user has to hand — a hex from a vendor
 * page, an `rgb()` from a design tool, an `hsb()` from a colour picker, or just `chocolate` —
 * and reports the canonical form upward. The "Show as" menu changes only what the box
 * *displays*; it never changes what is stored, and it is not persisted, because which
 * notation a user thinks in is a property of the moment, not of the field.
 *
 * The text box comes first in the DOM on purpose. A caller may wrap this whole control in
 * its own `<label>` (FormField does), and an implicit label binds to the first form control
 * inside it — which must be the box carrying the field's name, not the swatch.
 */
export function ColourInput({
  value,
  onChange,
  onBlur,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: ColourInputProps) {
  const t = useT();
  const [format, setFormat] = useState<ColourFormat>('HEX');
  const [draft, setDraft] = useState(() => (value === '' ? '' : formatColour(value, 'HEX')));

  // What `draft` was last rendered *from*, so an outside change to `value` (a reset, a
  // lookup filling the field, switching to another item) rewrites the box, while the user's
  // own half-typed text is left alone — re-rendering on every keystroke would fight typing.
  const shownFor = useRef(value);
  useEffect(() => {
    if (shownFor.current === value) return;
    shownFor.current = value;
    setDraft(value === '' ? '' : formatColour(value, format));
  }, [value, format]);

  const commit = (next: string) => {
    setDraft(next);
    const trimmed = next.trim();
    if (trimmed === '') {
      shownFor.current = '';
      onChange('');
      return;
    }
    const canonical = parseColour(trimmed);
    // An unreadable draft is left in the box untouched: the user is mid-word, and blanking
    // the stored value under them would silently discard a colour they had already set.
    if (canonical === null) return;
    shownFor.current = canonical;
    onChange(canonical);
  };

  /** Re-render the box in `next`, so the user reads (and can copy) the other notation. */
  const showAs = (next: ColourFormat) => {
    setFormat(next);
    if (value !== '') {
      shownFor.current = value;
      setDraft(formatColour(value, next));
    }
  };

  /**
   * Tidy the box on the way out: a value that parsed is re-rendered in the chosen notation,
   * so `RED` becomes `#FF0000` and the user can see what was actually stored. A value that
   * did not parse is left exactly as typed — the field's own validation names the problem,
   * and rewriting or clearing it would hide the text the message is about.
   */
  const handleBlur = () => {
    if (value !== '' && parseColour(draft) === value) setDraft(formatColour(value, format));
    onBlur?.();
  };

  const unreadable = draft.trim() !== '' && parseColour(draft) === null;
  // The swatch shows the six-digit form; `<input type="color">` cannot express alpha, so a
  // translucent value is previewed at full strength and its alpha is preserved on pick below.
  const swatch = value === '' ? '#000000' : value.slice(0, 7);

  return (
    <span className={cn('flex w-full items-center gap-2', className)}>
      <Input
        value={draft}
        onChange={(e) => commit(e.target.value)}
        onBlur={handleBlur}
        placeholder={t('field.colour.placeholder')}
        spellCheck={false}
        autoComplete="off"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-invalid={ariaInvalid ?? (unreadable ? true : undefined)}
        aria-describedby={ariaDescribedBy}
      />
      <input
        type="color"
        // The swatch paints the *user's* colour, so this is the one place a raw colour value
        // belongs in a style attribute — no design token could stand in for a fact the user
        // recorded about their own belongings.
        value={swatch}
        onChange={(e) => {
          const picked = parseColour(e.target.value);
          if (picked === null) return;
          // Keep any alpha the stored value carried: the native picker has no alpha channel,
          // so letting it drop one would quietly change a value the user only meant to re-hue.
          const alpha = value.length === 9 ? value.slice(7) : '';
          const next = `${picked.slice(0, 7)}${alpha}`;
          shownFor.current = next;
          setDraft(formatColour(next, format));
          onChange(next);
        }}
        aria-label={t('field.colour.pick')}
        className={cn(
          'size-10 shrink-0 cursor-pointer rounded-lg border border-border bg-input/40 p-1',
          'outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
          // Strip the browser chrome around the swatch so it fills the control.
          '[&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-md',
          '[&::-webkit-color-swatch]:border-0 [&::-moz-color-swatch]:rounded-md [&::-moz-color-swatch]:border-0',
        )}
      />
      <Menu
        label={t('field.colour.showAs')}
        triggerVariant="ghost"
        triggerSize="icon"
        trigger={<ColourIcon className="size-4" aria-hidden />}
        align="end"
      >
        {COLOUR_FORMATS.map((option) => (
          <MenuAction
            key={option}
            selected={option === format}
            selectionRole="radio"
            onSelect={() => showAs(option)}
            trailing={
              value === '' ? undefined : (
                <span className="font-mono text-xs text-muted-foreground">{formatColour(value, option)}</span>
              )
            }
          >
            {t(FORMAT_LABEL[option])}
          </MenuAction>
        ))}
      </Menu>
    </span>
  );
}

/**
 * A read-only swatch plus the colour's canonical hex — the display half of a `COLOUR`
 * field, on a card, in the table, and on a location's detail panel.
 *
 * The hex always reads beside the swatch rather than only inside its tooltip, because
 * colour alone is never allowed to be the whole message (WCAG 1.4.1): a reader who cannot
 * distinguish two similar swatches still gets the value, and so does a screen reader.
 */
export function ColourSwatch({ value, className }: { readonly value: string; readonly className?: string }) {
  const canonical = parseColour(value);
  if (canonical === null) return <span className={className}>{value}</span>;
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span
        // Same reasoning as the picker above: this is the user's recorded colour, not a
        // themed surface, so it is painted from the value and given a border that stays
        // legible whichever end of the range the colour sits at.
        style={{ backgroundColor: canonical, borderColor: contrastingInk(canonical) }}
        className="size-4 shrink-0 rounded border"
        aria-hidden
      />
      <span className="font-mono">{formatColour(canonical, 'HEX')}</span>
    </span>
  );
}
