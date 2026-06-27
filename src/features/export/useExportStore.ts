/**
 * useExportStore — Tier-2 memory for the Granular Export Wizard (spec §3).
 *
 * The wizard "must remember the user's last-used settings to make repetitive
 * exports frictionless" (§3), so the chosen format and scope persist to
 * localStorage and pre-select on the next open.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** JSON = §2 versioned backup; CSV = items spreadsheet; VAULT = §4.5 Markdown zip. */
export type ExportFormat = 'JSON' | 'CSV' | 'VAULT';
/** What to include — Phase 6 ships the full-database scope; per-item/project later. */
export type ExportScope = 'ALL';

interface ExportStore {
  readonly format: ExportFormat;
  readonly scope: ExportScope;
  readonly includeInactive: boolean;
  setFormat: (format: ExportFormat) => void;
  setScope: (scope: ExportScope) => void;
  setIncludeInactive: (value: boolean) => void;
}

export const useExportStore = create<ExportStore>()(
  persist(
    (set) => ({
      format: 'JSON',
      scope: 'ALL',
      includeInactive: false,
      setFormat: (format) => set({ format }),
      setScope: (scope) => set({ scope }),
      setIncludeInactive: (includeInactive) => set({ includeInactive }),
    }),
    { name: 'gubbins:export' },
  ),
);
