import { cn } from '@/lib/utils';
import { Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { RarityIcon } from '@/components/icons';
import { RARITY_LABELS, type Rarity } from '../rarity';

/** Rich-Markdown help explaining what a collector card / rarity actually means. */
function rarityTooltip(rarity: Rarity): string {
  return (
    `**${RARITY_LABELS[rarity]} — a collector card.** Just for fun, about **1 in 20** of your items ` +
    'turn out to be “collector cards” with a decorative **rarity** — Common → Uncommon → Rare → Epic ' +
    '→ Legendary, the showier tiers being the rarer finds.\n\n' +
    'Which items are collectors (and their tier) is decided by the item’s **name**, so it’s stable. ' +
    'It’s **purely cosmetic** — it never affects the item’s value, stock, or anything else.'
  );
}

/**
 * A small rarity gem pill for the "Collector cards" gamification (Appearance flair), shown in the
 * top-right of the item's detail dialog. It carries its own `data-rarity`, from which the
 * `[data-rarity]` block in `styles/index.css` sets the `--rarity` colour it tints itself with — so
 * it is self-contained and needs no `.gubbins-rarity` ancestor.
 *
 * A {@link Tooltip} explains what the rarity means (it is purely cosmetic). The gem is
 * `aria-hidden`; the tier word carries the meaning, so colour is never the sole signal (WCAG 1.4.1).
 * The caller (the detail dialog) decides *when* to show it — only for a collector item, and only
 * when the "Collector cards" toggle is on at the maximal animation level.
 */
export function RarityBadge({ rarity, className }: { rarity: Rarity; className?: string }) {
  return (
    <Tooltip content={rarityTooltip(rarity)} size="md" openDelayMs={INFO_OPEN_DELAY_MS} placement="bottom">
      <span
        data-rarity={rarity}
        className={cn(
          'gubbins-rarity-badge inline-flex cursor-help items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium [&_svg]:size-3',
          className,
        )}
        data-testid="rarity-badge"
      >
        <RarityIcon aria-hidden />
        {RARITY_LABELS[rarity]}
      </span>
    </Tooltip>
  );
}
