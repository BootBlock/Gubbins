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
/**
 * §4.5 granularity: the whole inventory, a single item, or a Project/BOM scope. The chosen
 * target id (an item or project) lives in {@link ExportStore.scopeTargetId}.
 */
export type ExportScope = 'ALL' | 'ITEM' | 'PROJECT';

interface ExportStore {
  readonly format: ExportFormat;
  readonly scope: ExportScope;
  /** Selected item id (scope `ITEM`) or project id (scope `PROJECT`); null for `ALL`. */
  readonly scopeTargetId: string | null;
  readonly includeInactive: boolean;
  setFormat: (format: ExportFormat) => void;
  setScope: (scope: ExportScope) => void;
  setScopeTargetId: (id: string | null) => void;
  setIncludeInactive: (value: boolean) => void;
}

export const useExportStore = create<ExportStore>()(
  persist(
    (set) => ({
      format: 'JSON',
      scope: 'ALL',
      scopeTargetId: null,
      includeInactive: false,
      setFormat: (format) => set({ format }),
      // Switching scope drops a now-irrelevant target so a stale id can't leak in.
      setScope: (scope) => set({ scope, scopeTargetId: scope === 'ALL' ? null : null }),
      setScopeTargetId: (scopeTargetId) => set({ scopeTargetId }),
      setIncludeInactive: (includeInactive) => set({ includeInactive }),
    }),
    { name: 'gubbins:export' },
  ),
);
