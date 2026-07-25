/**
 * useExportStore — Tier-2 memory for the Granular Export Wizard (spec §3).
 *
 * The wizard "must remember the user's last-used settings to make repetitive
 * exports frictionless" (§3), so the chosen format and scope persist to
 * localStorage and pre-select on the next open.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { adoptUnversioned, normaliseBoolean, normaliseOneOf } from '@/lib/persisted-state';
import type { TabularExportFormat } from './tabular-export';

/**
 * JSON = a versioned data extract (not a restorable backup — issue #153);
 * CSV = items spreadsheet; VAULT = §4.5 Markdown zip;
 * REPORTS = a §3 aggregate report CSV (Phase 61);
 * CATALOG_CSV = a catalog-ready CSV that round-trips through the import wizard (Phase 67).
 */
export const EXPORT_FORMATS = ['JSON', 'CSV', 'VAULT', 'REPORTS', 'CATALOG_CSV'] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/**
 * §4.5 granularity: the whole inventory, a single item, a Project/BOM scope, or a single
 * Location (and everything whose primary location is exactly that one — no sub-location
 * expansion, mirroring the Inventory sidebar's own location filter). The chosen target id
 * (an item, project, or location) lives in {@link ExportStore.scopeTargetId}.
 */
export const EXPORT_SCOPES = ['ALL', 'ITEM', 'PROJECT', 'LOCATION'] as const;

export type ExportScope = (typeof EXPORT_SCOPES)[number];

/** Which §3 aggregate report a `REPORTS`-format export serialises (Phase 61; analytics Phase 74). */
export const REPORT_EXPORT_KINDS = [
  'VALUATION',
  'CONSUMPTION',
  'MOVEMENT',
  'DEAD_STOCK',
  'ABC',
  'TURNOVER',
  'AGING',
  'VALUATION_TREND',
  'DATA_HYGIENE',
  'SPEND',
] as const;

export type ReportExportKind = (typeof REPORT_EXPORT_KINDS)[number];

/**
 * Which file format an `CSV`-format (items) export is written in (issue #132).
 *
 * A separate axis from {@link ExportFormat} rather than five more members of it: the *kind* of
 * export (items, catalogue, vault, report) and the *file format* it is written in are
 * independent choices, and folding them together would multiply the format cards without
 * telling the user anything new.
 */
export const ITEM_FILE_FORMATS = ['csv', 'tsv', 'xlsx', 'json', 'markdown', 'html', 'txt'] as const;

/** The wizard's defaults — also where a stale or unrecognised persisted value lands. */
export const DEFAULT_EXPORT_FORMAT: ExportFormat = 'JSON';
export const DEFAULT_EXPORT_SCOPE: ExportScope = 'ALL';
export const DEFAULT_REPORT_EXPORT_KIND: ReportExportKind = 'VALUATION';
/** CSV stays the default file format — it is what the items export always produced. */
export const DEFAULT_ITEM_FILE_FORMAT: TabularExportFormat = 'csv';

/**
 * Reconcile a persisted/unknown value against the live union. Rehydrated `localStorage` is
 * untyped (see `lib/persisted-state`), so a format retired in an earlier release would
 * otherwise pre-select a step the wizard can no longer run.
 */
export function normaliseExportFormat(value: unknown): ExportFormat {
  return normaliseOneOf(value, EXPORT_FORMATS, DEFAULT_EXPORT_FORMAT);
}

/** Reconcile a persisted/unknown scope — see {@link normaliseExportFormat}. */
export function normaliseExportScope(value: unknown): ExportScope {
  return normaliseOneOf(value, EXPORT_SCOPES, DEFAULT_EXPORT_SCOPE);
}

/** Reconcile a persisted/unknown report kind — see {@link normaliseExportFormat}. */
export function normaliseReportExportKind(value: unknown): ReportExportKind {
  return normaliseOneOf(value, REPORT_EXPORT_KINDS, DEFAULT_REPORT_EXPORT_KIND);
}

/** Reconcile a persisted/unknown item file format — see {@link normaliseExportFormat}. */
export function normaliseItemFileFormat(value: unknown): TabularExportFormat {
  return normaliseOneOf(value, ITEM_FILE_FORMATS, DEFAULT_ITEM_FILE_FORMAT);
}

interface ExportStore {
  readonly format: ExportFormat;
  readonly scope: ExportScope;
  /** Selected item/project/location id (scope `ITEM`/`PROJECT`/`LOCATION`); null for `ALL`. */
  readonly scopeTargetId: string | null;
  readonly includeInactive: boolean;
  /** Last-used report for the `REPORTS` format — remembered like every other setting (§3). */
  readonly reportKind: ReportExportKind;
  /** Last-used file format for the items export (issue #132) — remembered the same way. */
  readonly itemFileFormat: TabularExportFormat;
  setFormat: (format: ExportFormat) => void;
  setScope: (scope: ExportScope) => void;
  setScopeTargetId: (id: string | null) => void;
  setIncludeInactive: (value: boolean) => void;
  setReportKind: (kind: ReportExportKind) => void;
  setItemFileFormat: (format: TabularExportFormat) => void;
}

export const useExportStore = create<ExportStore>()(
  persist(
    (set) => ({
      format: DEFAULT_EXPORT_FORMAT,
      scope: DEFAULT_EXPORT_SCOPE,
      scopeTargetId: null,
      includeInactive: false,
      reportKind: DEFAULT_REPORT_EXPORT_KIND,
      itemFileFormat: DEFAULT_ITEM_FILE_FORMAT,
      setFormat: (format) => set({ format: normaliseExportFormat(format) }),
      // Switching scope drops a now-irrelevant target so a stale id can't leak in.
      setScope: (scope) => set({ scope: normaliseExportScope(scope), scopeTargetId: null }),
      setScopeTargetId: (scopeTargetId) => set({ scopeTargetId }),
      setIncludeInactive: (includeInactive) => set({ includeInactive }),
      setReportKind: (reportKind) => set({ reportKind: normaliseReportExportKind(reportKind) }),
      setItemFileFormat: (itemFileFormat) => set({ itemFileFormat: normaliseItemFileFormat(itemFileFormat) }),
    }),
    {
      name: 'gubbins:export',
      // v1 = the shipped shape, versioned so a later change has somewhere to hang a migration.
      version: 1,
      migrate: adoptUnversioned,
      // Rehydrated JSON is untyped, so reconcile the remembered settings against the live
      // unions rather than pre-selecting a step the wizard can no longer run. A target id is
      // kept only for a scope that has one — `ALL` never carries a target.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Record<keyof ExportStore, unknown>>;
        const scope = normaliseExportScope(p.scope);
        return {
          ...current,
          format: normaliseExportFormat(p.format),
          scope,
          scopeTargetId: scope !== 'ALL' && typeof p.scopeTargetId === 'string' ? p.scopeTargetId : null,
          includeInactive: normaliseBoolean(p.includeInactive, current.includeInactive),
          reportKind: normaliseReportExportKind(p.reportKind),
          itemFileFormat: normaliseItemFileFormat(p.itemFileFormat),
        };
      },
    },
  ),
);
