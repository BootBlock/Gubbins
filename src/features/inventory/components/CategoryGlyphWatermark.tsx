/**
 * The category glyph, drawn two ways.
 *
 * A category carries an optional Unicode glyph (e.g. 🔋). Both drawings below share one rule
 * (issue #83): the glyph is always **greyscale**, so it reads as a shape rather than a splash of
 * colour, and it is always decoration — `aria-hidden`, because the category name already reaches
 * assistive tech through the card's field list.
 */

/**
 * How a category glyph is painted, wherever it appears: greyscale (a hard requirement of issue
 * #83) and never selectable. Inline rather than a utility class so it can't be dropped as an
 * unknown Tailwind utility — a silent no-op would turn the watermark back into colour.
 */
const GREYSCALE = { filter: 'grayscale(1)' } as const;

/**
 * The Visual-card watermark (issue #83): the glyph large and faint in the bottom-right corner of
 * the card background, mirroring the favourite star watermark but driven by the category.
 *
 * Clipped to the card by an `overflow-hidden` rounded layer matching the card's corners, and
 * painted on a negative-z layer within the card's stacking context so it sits behind the content.
 */
export function CategoryGlyphWatermark({ glyph }: { glyph: string }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-2xl">
      <span
        className="absolute bottom-0 right-1 select-none text-[7rem] leading-none opacity-25"
        // Paired with a small downward nudge so the glyph hangs slightly off the bottom edge,
        // like the favourite watermark.
        style={{ ...GREYSCALE, transform: 'translateY(22%)' }}
      >
        {glyph}
      </span>
    </div>
  );
}

/**
 * The Gallery tile's stand-in for a missing photo (issue #444).
 *
 * A photo wall of empty placeholder boxes is worse than a list, so a tile with no image falls
 * back to the item's category glyph filling the picture box. Unlike the card watermark this is
 * the tile's *subject* rather than a texture behind one, so it is centred and near-opaque —
 * still greyscale, so a wall of fallbacks stays quieter than a wall of photographs and never
 * competes with the real pictures beside it.
 *
 * Deliberately **not** gated on the "Category watermarks" setting: that setting governs a
 * decoration on the card, and honouring it here would empty the box the mode exists to fill.
 */
export function CategoryGlyphFallback({ glyph }: { glyph: string }) {
  return (
    <span
      aria-hidden
      className="grid size-full select-none place-items-center text-5xl leading-none opacity-70"
      style={GREYSCALE}
    >
      {glyph}
    </span>
  );
}
