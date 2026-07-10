import { cn } from '@/lib/utils';
import { RarityIcon } from '@/components/icons';
import { RARITY_LABELS, type Rarity } from '../rarity';

/**
 * A small rarity gem pill for the "Collector cards" gamification (Appearance flair). Sits beside
 * the {@link TrackingBadge} pills and reuses their shape, tinted with the item's rarity tier via
 * the inherited `--rarity` custom property (set by the `.gubbins-rarity[data-rarity]` block on the
 * card root in `styles/index.css`).
 *
 * Purely decorative: it is `display:none` by default and only revealed by CSS when the "Collector
 * cards" toggle is on *and* the maximal "I have a headache" animation level is active — so it never
 * enters the accessibility tree unless the feature is on. The gem is `aria-hidden`; the tier word
 * carries the meaning, so colour is never the sole signal (WCAG 1.4.1).
 */
export function RarityBadge({ rarity, className }: { rarity: Rarity; className?: string }) {
  return (
    <span
      className={cn(
        'gubbins-rarity-badge inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium [&_svg]:size-3',
        className,
      )}
      data-testid="rarity-badge"
    >
      <RarityIcon aria-hidden />
      {RARITY_LABELS[rarity]}
    </span>
  );
}
