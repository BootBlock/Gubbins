/**
 * Tier-1 hooks for freeform tags (spec §2.1, §4, §5). The dictionary is paginated
 * (it can grow large); a single item's tags and prefix suggestions are bounded.
 * Assigning tags auto-creates unknown ones (low-friction, §4), so writes refresh
 * both the item's tags and the global dictionary.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getTagRepository } from '@/db/repositories';
import { inventoryKeys } from './queries';

/** Paginated tag dictionary with live item counts. */
export function useTagDictionary() {
  return useQuery({
    queryKey: inventoryKeys.tagList(),
    queryFn: () => getTagRepository().list({ limit: 100 }),
  });
}

export function useItemTags(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemTags(itemId ?? ''),
    queryFn: () => getTagRepository().getForItem(itemId!),
    enabled: Boolean(itemId),
  });
}

/** Prefix autocomplete; disabled until the user has typed something. */
export function useTagSuggestions(prefix: string) {
  const term = prefix.trim();
  return useQuery({
    queryKey: [...inventoryKeys.tags(), 'suggest', term] as const,
    queryFn: () => getTagRepository().suggest(term),
    enabled: term.length > 0,
  });
}

export function useSetItemTags(itemId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (names: string[]) => getTagRepository().setForItem(itemId, names),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemTags(itemId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.tags() });
    },
  });
}
