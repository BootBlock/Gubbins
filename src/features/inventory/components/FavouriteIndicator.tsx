import { cn } from '@/lib/utils';
import { FavouriteIcon } from '@/components/icons';
import { useT } from '@/features/i18n';

/**
 * Visual flair marking a favourited item (issue #23). Favourites sort ahead of the rest of the
 * list; these give each density its own at-a-glance signal that an item is starred:
 *
 * - {@link FavouriteStar} — a small inline gold star for the dense Data row and the Table view,
 *   sitting beside the item name. Informational (carries an accessible "Favourite" label), not
 *   decorative, since it is the only favourite cue in those compact layouts.
 * - {@link FavouriteCardWatermark} — the large, faint corner watermark for the Visual card,
 *   hung 50% off the bottom-right corner and clipped to the card. Purely decorative (`aria-hidden`);
 *   the card pairs it with an `sr-only` label so assistive tech still hears "Favourite".
 *
 * The gold tint is the `glyph-favourite` design token (themeable, dark-mode-correct) rather than a
 * raw colour.
 */

/** A small inline "Favourite" star for the Data row / Table view, beside the item name. */
export function FavouriteStar({ className }: { className?: string }) {
  const t = useT();
  const label = t('inventory.favourite.badge');
  return (
    <FavouriteIcon
      role="img"
      aria-label={label}
      className={cn('size-3.5 shrink-0 fill-current text-glyph-favourite', className)}
    />
  );
}

/**
 * The Visual-card favourite watermark: a large gold star anchored to the card's bottom-right
 * corner and translated so half of it hangs off both the bottom and the right edge, clipped back
 * to the card by an `overflow-hidden` layer that matches the card's rounding. Painted behind the
 * card's content (a negative-z layer within the card's stacking context) at 25% opacity, so it
 * reads as a faint watermark rather than competing with the item's details. Decoration only —
 * `aria-hidden`; the card supplies the accessible "Favourite" label separately.
 */
export function FavouriteCardWatermark() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-2xl">
      <FavouriteIcon className="absolute bottom-0 right-0 size-32 translate-x-1/2 translate-y-1/2 fill-current text-glyph-favourite opacity-25" />
    </div>
  );
}
