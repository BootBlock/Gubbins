/**
 * "Should this item show that?" — the item-aware companion to `useFeature` (issue #618).
 *
 * `useFeature` answers for the *device*: is this capability switched on in Modules? That is
 * the only question most call sites have. But a section or field inside an item's editors has
 * a second gate — the item's **category** can declare capabilities its items simply don't
 * have, so a film stops showing an expiry date and a service schedule.
 *
 * Reach for this instead of `useFeature` anywhere the thing being gated belongs to a specific
 * item. Everything else — a nav entry, a whole screen, a device-level affordance — stays on
 * `useFeature`, because a category has no opinion about those.
 *
 * The rules themselves live in the pure `category-capabilities` seam; this is the hook that
 * feeds it the two sets. In particular, `hasData` is not optional courtesy: hiding must never
 * make existing data invisible, so every caller has to answer "does this actually hold
 * something?" — and answering `true` simply means the field is shown, which is the safe way to
 * be wrong.
 */
import { useCallback } from 'react';
import type { Item } from '@/db/repositories';
import type { FeatureId } from '@/features/modules/feature-registry';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { useCategories } from './categories';
import { isCapabilityVisible, toHiddenCapabilitySet } from './category-capabilities';

/**
 * Whether a capability-gated part of an item's UI should be shown.
 *
 * Returns a predicate rather than a boolean because a single editor usually gates several
 * things — expiry on `perishables`, batch and lot on `batches` — and each has its own answer
 * to "does it hold data?".
 *
 * @param item The item being edited; its category supplies the second axis.
 * @returns `(feature, hasData) => boolean` — true when that part should render.
 */
export function useItemSectionVisibility(item: Item): (feature: FeatureId, hasData: boolean) => boolean {
  return useCategorySectionVisibility(item.categoryId);
}

/**
 * The same predicate keyed on a category id rather than an item — for the create form, where
 * the category is a field the user is still choosing and no item exists yet.
 *
 * A not-yet-created item holds no data, so callers there pass `false` and get the plain
 * answer. Pass `null` for "no category chosen", which hides nothing.
 */
export function useCategorySectionVisibility(
  categoryId: string | null | undefined,
): (feature: FeatureId, hasData: boolean) => boolean {
  const enabled = useEnabledFeatures();
  // The app-wide cached category list every other consumer resolves an id against, so this
  // adds no query of its own.
  const categories = useCategories();
  const category = categories.data?.rows.find((c) => c.id === categoryId);
  // Depend on the stored array itself, not the category object: the identity that matters is
  // the hidden set, and a category refetch that changes nothing else must not churn callers.
  const hidden = category?.hiddenCapabilities;

  return useCallback(
    (feature: FeatureId, hasData: boolean) =>
      isCapabilityVisible(feature, enabled, toHiddenCapabilitySet(hidden), hasData) !== 'hidden',
    [enabled, hidden],
  );
}
