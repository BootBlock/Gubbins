import { useEffect, useRef, useState } from 'react';
import { ColourIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { COLOUR_FORMATS, contrastingInk, formatColour, parseColour, type ColourFormat } from '@/lib/colour';
import { cn } from '@/lib/utils';
import { Input } from './input';
import { Menu } from './menu';
import { MenuAction } from './menu-action';
import type { MessageKey } from '@/features/i18n';

/** The translated name of each notation, for the "Show as" menu. */
const FORMAT_LABEL: Record<ColourFormat, MessageKey> = {
  HEX: 'field.colour.format.hex',
  RGB: 'field.colour.format.rgb',
  HSL: 'field.colour.format.hsl',
  HSB: 'field.colour.format.hsb',
  NAME: 'field.colour.format.name',
};

/**
 * What the box is showing, and — when the control wrote that text itself — the exact colour it
 * was rendered *from*.
 *
 * The pairing is what keeps a colour from drifting. `hsl()` and `hsb()` are rendered at the
 * whole degrees and percent a person reads, so they cannot name every 8-bit colour: showing
 * `#4ab66a` as `hsl(138, 43%, 50%)` and then reading that text back gives `#49b66a`. Without
 * `from`, merely looking at a colour in another notation and clicking away would re-enter a
 * neighbouring colour as if the user had typed it. `from` is `null` once the user types,
 * because from then on the text genuinely is the source of truth.
 */
interface Shown {
  readonly text: string;
  readonly from: string | null;
}

/** How a stored value should read in the box, paired with the colour it renders. */
function show(value: string, format: ColourFormat): Shown {
  if (value === '') return { text: '', from: null };
  const canonical = parseColour(value);
  // A value that is not a colour is shown exactly as stored. It happens — a field retyped from
  // TEXT keeps its old text, and so does an import or a peer on an older build — and running
  // such a string through the formatter would print a mangling of it (`office` → `OFFICE`)
  // rather than the thing the user has to correct.
  return canonical === null
    ? { text: value, from: null }
    : { text: formatColour(canonical, format), from: canonical };
}

export interface ColourInputProps {
  /** The current value: a canonical `#rrggbb` / `#rrggbbaa`, whatever the user has typed so far, or `''`. */
  readonly value: string;
  /** Fired with the raw text as it is typed, and with the canonical colour on a pick or once the edit settles. */
  readonly onChange: (value: string) => void;
  readonly onBlur?: () => void;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-invalid'?: true;
  readonly 'aria-describedby'?: string;
}

/**
 * The Foundry colour control: a text box that accepts **any** colour notation, a native
 * swatch for picking one, and a menu that re-renders the value in another notation.
 *
 * The design follows from one decision made in `src/lib/colour.ts`: a colour is *stored* in
 * exactly one spelling (canonical `#rrggbb`), and every other notation is a way of reading or
 * writing it. So the box takes whatever the user has to hand — a hex from a vendor page, an
 * `rgb()` from a design tool, an `hsb()` from a colour picker, or just `chocolate` — and
 * canonicalises it when the edit finishes.
 *
 * **It reports the raw text as it is typed**, exactly like every other free-text control in
 * `TypedFieldControl`, and that is load-bearing rather than incidental. Reporting only fully
 * parsed colours would be wrong twice over: a partly-typed hex is frequently a valid colour of
 * its own (`#ff0` is yellow, `#ff00` is transparent yellow), so a user backspacing through
 * `#ff0000` would silently store two colours they never chose; and text that is *not* a colour
 * would never reach `validateFieldValue`, leaving the field marked invalid with nothing saying
 * why. Sending the draft up means what the box shows and what the field validates are the same
 * string. (On an item that message is rendered beside the field; a location's field editor has
 * no per-field error surface yet, so there the write is simply refused — issue #389.)
 *
 * The "Show as" menu changes only what the box *displays*; it never changes what is stored,
 * and it is not persisted, because which notation a user thinks in is a property of the
 * moment, not of the field.
 *
 * The text box comes first in the DOM on purpose. A caller may wrap this whole control in its
 * own `<label>` (FormField does), and an implicit label binds to the first form control inside
 * it — which must be the box carrying the field's name, not the swatch.
 */
export function ColourInput({
  value,
  onChange,
  onBlur,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: ColourInputProps) {
  const t = useT();
  const [format, setFormat] = useState<ColourFormat>('HEX');
  const [shown, setShown] = useState<Shown>(() => show(value, 'HEX'));

  // What the box was last rendered *for*, so a change to `value` from outside (a reset, a
  // lookup filling the field, switching to another item) rewrites it, while the value this
  // control itself just reported leaves the user's own text alone.
  const shownFor = useRef(value);
  useEffect(() => {
    if (shownFor.current === value) return;
    shownFor.current = value;
    setShown(show(value, format));
  }, [value, format]);

  /** Put `canonical` in the box in the current notation, and report it as the value. */
  const adopt = (canonical: string) => {
    setShown(show(canonical, format));
    shownFor.current = canonical;
    if (canonical !== value) onChange(canonical);
  };

  /** Re-render the box in `next`, so the user reads (and can copy) the other notation. */
  const showAs = (next: ColourFormat) => {
    setFormat(next);
    const canonical = parseColour(value);
    if (canonical === null) return;
    // The stored value is untouched — only its spelling in the box changes. `from` records
    // which colour that spelling stands for, so settling later re-adopts *this* colour rather
    // than whatever re-parsing a rounded notation would land on.
    shownFor.current = value;
    setShown(show(canonical, next));
  };

  /**
   * Canonicalise on the way out, so `RED` becomes `#FF0000` and the user sees what will
   * actually be stored. Text the control rendered itself settles back to the colour it was
   * rendered from, never to a re-parse of it. Text that is not a colour is left exactly as
   * typed — the field's validation names the problem, and rewriting or clearing it would hide
   * the text the message is about.
   */
  const settle = () => {
    const canonical = shown.from ?? parseColour(shown.text);
    if (canonical !== null) adopt(canonical);
    onBlur?.();
  };

  const unreadable = shown.text.trim() !== '' && shown.from === null && parseColour(shown.text) === null;
  // `<input type="color">` only accepts a six-digit hex, so a half-typed or translucent value
  // is previewed at the nearest thing it can show, and anything unreadable shows black. The
  // alpha is put back on the way out of the picker below, which has no channel for it.
  const previewed = shown.from ?? parseColour(shown.text) ?? parseColour(value);
  const swatch = previewed === null ? '#000000' : previewed.slice(0, 7);

  return (
    <span className="flex w-full items-center gap-2">
      <Input
        value={shown.text}
        onChange={(e) => {
          // Typed text is the source of truth from here on, so it carries no `from`.
          setShown({ text: e.target.value, from: null });
          shownFor.current = e.target.value;
          onChange(e.target.value);
        }}
        onBlur={settle}
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
        // The swatch paints the *user's* colour, so this is one of the two places a raw colour
        // value belongs in this file — no design token could stand in for a fact the user
        // recorded about their own belongings.
        value={swatch}
        onChange={(e) => {
          const picked = parseColour(e.target.value);
          if (picked === null) return;
          // Keep any alpha the value carried: the native picker has no alpha channel, so
          // letting it drop one would quietly change a value the user only meant to re-hue.
          const current = previewed;
          const alpha = current !== null && current.length === 9 ? current.slice(7) : '';
          // The picked colour is reported exactly, whatever notation the box happens to show.
          adopt(`${picked.slice(0, 7)}${alpha}`);
        }}
        // The picker is the other half of the same edit, so it settles the same way the box
        // does. Without this a caller that commits on blur (a location's field value) would
        // hear nothing until the box itself was focused and left.
        onBlur={settle}
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
        {COLOUR_FORMATS.map((option) => {
          const canonical = parseColour(value);
          return (
            <MenuAction
              key={option}
              selected={option === format}
              selectionRole="radio"
              onSelect={() => showAs(option)}
              trailing={
                canonical === null ? undefined : (
                  <span data-testid="colour-preview" className="font-mono text-xs text-muted-foreground">
                    {formatColour(canonical, option)}
                  </span>
                )
              }
            >
              {t(FORMAT_LABEL[option])}
            </MenuAction>
          );
        })}
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
