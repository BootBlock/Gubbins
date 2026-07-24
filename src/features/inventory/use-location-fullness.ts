/**
 * React seam over the pure {@link resolveLocationFullness} ladder (issue #457): resolves a
 * location's fullness — volumetric when it has a measured internal size, else the count gauge —
 * binding the global `defaultPackingFactor` preference so a component doesn't re-read it.
 *
 * The pure resolver stays free of React and of the preferences store; this hook is the single
 * place the preference is wired in, mirroring how `useFormatters` binds the unit preferences.
 */
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import type { LocationWithCount } from '@/db/repositories';
import { EMPTY_VOLUME_TOTALS, resolveLocationFullness, type Fullness } from './location-fullness';

/** Resolve one location's fullness (volume mode when measured, else count mode, else null). */
export function useLocationFullness(location: LocationWithCount | null | undefined): Fullness | null {
  const packingFactor = usePreferencesStore((s) => s.defaultPackingFactor);
  if (!location) return null;
  return resolveLocationFullness(location, location.volumeTotals ?? EMPTY_VOLUME_TOTALS, packingFactor);
}
