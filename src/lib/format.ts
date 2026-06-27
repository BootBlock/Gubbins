/**
 * Locale-aware formatting via native Intl (spec §2.4.3 — no third-party libs).
 * Defaults to en-GB (spec §1.2.1); a user-configurable locale arrives with
 * usePreferencesStore in Phase 2.
 */
const LOCALE = 'en-GB';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function formatPercent(ratio: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits }).format(
    clamp01(ratio),
  );
}

/** Human-readable byte size using decimal (SI) units, matching StorageManager estimates. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'] as const;
  const index = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  const value = bytes / 1000 ** index;
  const formatted = new Intl.NumberFormat(LOCALE, {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value);
  return `${formatted} ${units[index] ?? 'B'}`;
}
