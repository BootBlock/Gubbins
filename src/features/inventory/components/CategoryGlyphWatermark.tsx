/**
 * The Visual-card category-glyph watermark (issue #83). When an item's category carries an
 * optional Unicode glyph (e.g. 🔋), its card shows that glyph large and faint in the
 * bottom-right corner of the card background — mirroring the favourite star watermark, but
 * driven by the category rather than the favourite flag.
 *
 * Always rendered **greyscale** (a `grayscale` filter strips the emoji's colour) and at a low
 * opacity so it reads as a background texture rather than competing with the item's details.
 * Clipped to the card by an `overflow-hidden` rounded layer that matches the card's corners,
 * and painted on a negative-z layer within the card's stacking context so it sits behind the
 * content. Decoration only — `aria-hidden`; the category name is already carried by the card's
 * field list for assistive tech.
 */
export function CategoryGlyphWatermark({ glyph }: { glyph: string }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-2xl">
      <span
        className="absolute bottom-0 right-1 select-none text-[7rem] leading-none opacity-25"
        // Greyscale is a hard requirement (issue #83): keep the emoji a neutral background
        // texture rather than a splash of colour. Inline so it can never be dropped as an
        // unknown utility, and paired with a small downward nudge so the glyph hangs slightly
        // off the bottom edge like the favourite watermark.
        style={{ filter: 'grayscale(1)', transform: 'translateY(22%)' }}
      >
        {glyph}
      </span>
    </div>
  );
}
