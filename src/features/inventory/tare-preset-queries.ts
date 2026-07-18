/**
 * TanStack Query hooks + write mutations for saved container weights (issue #94).
 *
 * Every read/write funnels through `TarePresetRepository` (never raw SQL in a component).
 * Mutations invalidate the single list cache so every open tare picker refreshes. Saved
 * containers have no cross-entity effects — a preset is copied *into* a tare field as a plain
 * number, never referenced by it — so there is nothing else to invalidate.
 */
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getTarePresetRepository,
  type CreateTarePresetInput,
  type UpdateTarePresetInput,
} from '@/db/repositories';
import { BUILT_IN_TARE_PRESETS, type TarePreset } from './tare-presets';

export const tarePresetKeys = {
  all: ['tare-presets'] as const,
  list: () => [...tarePresetKeys.all, 'list'] as const,
};

/** The containers the user saved, ordered for display (name → oldest). */
export function useSavedTarePresets() {
  return useQuery({
    queryKey: tarePresetKeys.list(),
    queryFn: () => getTarePresetRepository().list({ limit: 100 }),
  });
}

/**
 * Everything a tare picker offers: the user's own saved containers first, then the built-in
 * catalogue. Saved entries lead because a container the user weighed themselves is exact,
 * while a built-in is a published figure that may not match the spool in their hand.
 */
export function useTarePresets(): { presets: readonly TarePreset[]; isLoading: boolean } {
  const { data, isLoading } = useSavedTarePresets();
  const saved = data?.rows;
  const presets = useMemo(
    () => [
      ...(saved ?? []).map((row): TarePreset => ({
        id: row.id,
        name: row.name,
        brand: row.brand ?? undefined,
        kind: row.kind,
        tareGrams: row.tareGrams,
        note: row.note ?? undefined,
        saved: true,
      })),
      ...BUILT_IN_TARE_PRESETS,
    ],
    [saved],
  );
  return { presets, isLoading };
}

export function useCreateTarePreset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTarePresetInput) => getTarePresetRepository().create(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: tarePresetKeys.list() });
    },
  });
}

export function useUpdateTarePreset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTarePresetInput }) =>
      getTarePresetRepository().update(id, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: tarePresetKeys.list() });
    },
  });
}

export function useDeleteTarePreset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getTarePresetRepository().delete(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: tarePresetKeys.list() });
    },
  });
}
