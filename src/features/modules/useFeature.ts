/**
 * Read API for the Modular UI (modular-ui-plan §2.4).
 *
 * Thin React hooks over the pure `resolveEnabled` engine and the `useModulesStore`
 * intent. Components ask "is this feature on?" without ever touching the dependency
 * maths: the effective enabled set is resolved from stored intent and memoised so it only
 * recomputes when the intent object changes (the store replaces it immutably on every
 * edit). An imperative non-React escape hatch is provided for the rare caller outside the
 * render tree.
 */
import { useMemo } from 'react';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { FEATURE_REGISTRY, type FeatureId } from './feature-registry';
import { resolveEnabled } from './modules-graph';

/** The full effective-enabled set, memoised against the current intent. */
export function useEnabledFeatures(): ReadonlySet<FeatureId> {
  const intent = useModulesStore((state) => state.intent);
  return useMemo(() => resolveEnabled(intent, FEATURE_REGISTRY), [intent]);
}

/** Whether a single feature is effectively enabled (subscribes to the store). */
export function useFeature(id: FeatureId): boolean {
  return useEnabledFeatures().has(id);
}

/**
 * Non-React read of a feature's effective-enabled state, for the rare imperative caller
 * (e.g. a router `beforeLoad` guard). Reads the current store snapshot directly.
 */
export function isFeatureEnabled(id: FeatureId): boolean {
  return resolveEnabled(useModulesStore.getState().intent, FEATURE_REGISTRY).has(id);
}
