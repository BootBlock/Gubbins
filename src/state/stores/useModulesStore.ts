/**
 * useModulesStore — device-local Modular UI state (modular-ui-plan §2.2).
 *
 * Persists the user's per-feature **intent** (an explicit on/off choice) plus whether the
 * first-run chooser has been completed, to localStorage under `gubbins:modules`. Like
 * theme/kiosk/layout it is per-device, never synced — a kiosk tablet can show only
 * Inventory while a desktop shows everything, with no sync-schema work.
 *
 * The store deliberately stores *intent*, not effective state: a feature with no stored
 * key defaults to **on** (so nothing is ever hidden by surprise before the user chooses),
 * and re-enabling a parent restores its children to their own prior intent. The effective
 * enabled set is resolved on read by the pure `resolveEnabled` engine — see
 * `features/modules/modules-graph.ts` and the `useFeature` hooks. This store never applies
 * the dependency cascade itself; it only records raw choices.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { FeatureId } from '@/features/modules/feature-registry';
import { OPTIONAL_FEATURE_IDS } from '@/features/modules/feature-registry';
import { getPreset, type PresetId } from '@/features/modules/presets';
import { adoptUnversioned } from '@/lib/persisted-state';

interface ModulesStore {
  /**
   * Explicit per-feature choice. A missing key means "on" (default everything-on).
   * Core (`alwaysOn`) features are always effectively on regardless of any stored value.
   */
  readonly intent: Readonly<Record<string, boolean>>;
  /** Whether the first-run module chooser has been completed or skipped (§2.2, Phase 8). */
  readonly firstRunComplete: boolean;
  /** Record a single feature's on/off choice. No cascade — resolution happens on read (§2.3). */
  setFeatureIntent: (id: FeatureId, on: boolean) => void;
  /** Apply a preset: its `featureIds` → on, every other optional feature → off (§2.5). */
  applyPreset: (presetId: PresetId) => void;
  /** Clear every override back to the default everything-on state. */
  resetToEverything: () => void;
  /** Mark the first-run chooser done (any choice, or an explicit skip). */
  completeFirstRun: () => void;
}

/** Build an intent record turning the given optional features on and all others off. */
function intentFromEnabled(enabled: readonly FeatureId[]): Record<string, boolean> {
  const on = new Set<FeatureId>(enabled);
  const intent: Record<string, boolean> = {};
  for (const id of OPTIONAL_FEATURE_IDS) {
    intent[id] = on.has(id);
  }
  return intent;
}

export const useModulesStore = create<ModulesStore>()(
  persist(
    (set) => ({
      // Default: no overrides — every feature reads as on until the user chooses.
      intent: {},
      firstRunComplete: false,
      setFeatureIntent: (id, on) => set((state) => ({ intent: { ...state.intent, [id]: on } })),
      applyPreset: (presetId) => {
        const preset = getPreset(presetId);
        // Unknown preset id (e.g. a stale link): leave intent untouched rather than wipe it.
        if (!preset) return;
        set({ intent: intentFromEnabled(preset.featureIds) });
      },
      resetToEverything: () => set({ intent: {} }),
      completeFirstRun: () => set({ firstRunComplete: true }),
    }),
    {
      name: 'gubbins:modules',
      // v1 = the shipped shape, versioned so a later change has somewhere to hang a migration.
      version: 1,
      migrate: adoptUnversioned,
    },
  ),
);
