/**
 * The achievement registry (issue #412) — the single source of truth for every achievement
 * Gubbins can award, in display order.
 *
 * Gubbins already celebrated a couple of moments with the milestone burst (visual-flair F4), but
 * nothing kept a record: the firework played once and the moment was gone. This registry names
 * those moments, gives each a stable id, and lets {@link useAchievementsStore} keep the record the
 * Achievements screen renders.
 *
 * Two kinds of achievement live here, and the difference is one optional field:
 *  - **Threshold** achievements carry an {@link Achievement.itemCount}. `AchievementWatcher`
 *    derives them from the live item count, so no call site has to remember to award one — adding
 *    a row here is the whole change.
 *  - **Event** achievements have no `itemCount` and are awarded where the thing happens (a
 *    completed stock-take, an authorised location count).
 *
 * Copy lives in the message catalogs rather than beside the id, so the screen, the unlock toast
 * and any future surface all read the one translated string (see `features/i18n`).
 */
import type { LucideIcon } from '@/components/icons';
import {
  AchievementIcon,
  BatchIcon,
  CollectionIcon,
  CycleCountIcon,
  PackageIcon,
  SelectIcon,
} from '@/components/icons';
import type { MessageKey } from '@/features/i18n';

/** Every achievement's stable id. Persisted, so a value here must never be renamed. */
export type AchievementId =
  'first-item' | 'ten-items' | 'hundred-items' | 'thousand-items' | 'stock-take' | 'location-count';

export interface Achievement {
  readonly id: AchievementId;
  /** The glyph shown on the achievement's card, and in its unlock toast. */
  readonly Icon: LucideIcon;
  readonly titleKey: MessageKey;
  /**
   * What earns it, phrased so the one string reads correctly in both states — as the requirement
   * on a locked card, and as the record of what happened on an unlocked one.
   */
  readonly descriptionKey: MessageKey;
  /**
   * Awarded once the inventory holds this many items (counting archived and inactive ones, so the
   * total matches "everything you have ever added"). Omitted for an achievement awarded by an
   * event instead.
   */
  readonly itemCount?: number;
}

export const ACHIEVEMENTS: readonly Achievement[] = [
  {
    id: 'first-item',
    Icon: PackageIcon,
    titleKey: 'achievements.firstItem.title',
    descriptionKey: 'achievements.firstItem.description',
    itemCount: 1,
  },
  {
    id: 'ten-items',
    Icon: BatchIcon,
    titleKey: 'achievements.tenItems.title',
    descriptionKey: 'achievements.tenItems.description',
    itemCount: 10,
  },
  {
    id: 'hundred-items',
    Icon: CollectionIcon,
    titleKey: 'achievements.hundredItems.title',
    descriptionKey: 'achievements.hundredItems.description',
    itemCount: 100,
  },
  {
    id: 'thousand-items',
    Icon: AchievementIcon,
    titleKey: 'achievements.thousandItems.title',
    descriptionKey: 'achievements.thousandItems.description',
    itemCount: 1000,
  },
  {
    id: 'stock-take',
    Icon: SelectIcon,
    titleKey: 'achievements.stockTake.title',
    descriptionKey: 'achievements.stockTake.description',
  },
  {
    id: 'location-count',
    Icon: CycleCountIcon,
    titleKey: 'achievements.locationCount.title',
    descriptionKey: 'achievements.locationCount.description',
  },
];

/** Every registered id, for reconciling a rehydrated record against the achievements that exist. */
export const ACHIEVEMENT_IDS: readonly AchievementId[] = ACHIEVEMENTS.map((a) => a.id);

/** An achievement awarded from the item count, narrowed so `itemCount` is known to be present. */
export type CountAchievement = Achievement & { readonly itemCount: number };

/**
 * The threshold achievements, in registry order. Derived from {@link ACHIEVEMENTS} rather than
 * listed a second time, so the watcher cannot fall behind the registry.
 *
 * Order carries no meaning to the watcher — it awards every threshold the count has reached, in
 * whatever order it finds them — so this deliberately does not re-sort. The registry lists them
 * smallest first because that is the order the screen shows them in.
 */
export const COUNT_ACHIEVEMENTS: readonly CountAchievement[] = ACHIEVEMENTS.filter(
  (a): a is CountAchievement => a.itemCount !== undefined,
);
