/**
 * Exposes the completed database boot result (diagnostics + migration report) to
 * the route tree once the BootGate has reached the `ready` state. Tier-3 feature
 * state (spec §2.1) — scoped to the booted application.
 */
import { createContext, useContext } from 'react';
import type { DbBootResult } from '@/db/client';

const BootResultContext = createContext<DbBootResult | null>(null);

export const BootResultProvider = BootResultContext.Provider;

export function useBootResult(): DbBootResult {
  const value = useContext(BootResultContext);
  if (value === null) {
    throw new Error('useBootResult must be used inside a ready <BootGate>.');
  }
  return value;
}
