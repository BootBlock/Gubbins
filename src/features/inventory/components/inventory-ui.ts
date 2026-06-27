/**
 * Shared presentational helpers for the inventory feature (spec §3, §4.1.3).
 * Pure functions — no React — for gauge colour bands and en-GB number formatting.
 */
import type {
  AttachmentKind,
  Condition,
  FieldType,
  MaintenanceBasis,
  TrackingMode,
} from '@/db/repositories';
import type { AttachmentMode } from '@/state/stores/usePreferencesStore';

export interface GaugeTone {
  /** Filled bar / arc colour. */
  readonly fill: string;
  /** Matching text colour for the percentage label. */
  readonly text: string;
  /** Soft track tint behind the fill. */
  readonly track: string;
}

/**
 * Dynamic gauge colours by remaining percentage (spec §4.1.3):
 * vibrant green > 50%, amber < 50%, crimson < 15%.
 */
export function gaugeTone(percentage: number): GaugeTone {
  if (percentage < 15) {
    return { fill: 'bg-destructive', text: 'text-destructive', track: 'bg-destructive/15' };
  }
  if (percentage < 50) {
    return { fill: 'bg-warning', text: 'text-warning', track: 'bg-warning/15' };
  }
  return { fill: 'bg-success', text: 'text-success', track: 'bg-success/15' };
}

const numberFormat = new Intl.NumberFormat('en-GB');

/** Format an integer quantity with en-GB grouping (spec §1.2.1, §2.4.3). */
export function formatQuantity(value: number): string {
  return numberFormat.format(value);
}

/** Format a gauge value, trimming needless decimals, with its unit. */
export function formatMeasure(value: number, unit: string): string {
  const rounded = Math.round(value * 100) / 100;
  return `${numberFormat.format(rounded)}${unit}`;
}

export const TRACKING_MODE_LABELS: Record<TrackingMode, string> = {
  DISCRETE: 'Bulk',
  SERIALISED: 'Serialised',
  CONSUMABLE_GAUGE: 'Consumable',
};

/** British-English labels for category custom-field types (spec §4). */
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  TEXT: 'Text',
  NUMBER: 'Number',
  BOOLEAN: 'Yes / No',
  DATE: 'Date',
  SELECT: 'Choice',
};

/** Labels for the datasheet-linking configuration (spec §4 Attachments). */
export const ATTACHMENT_MODE_LABELS: Record<AttachmentMode, string> = {
  URL_ONLY: 'External URLs only',
  HYBRID: 'URLs + local file pointers',
};

export const ATTACHMENT_KIND_LABELS: Record<AttachmentKind, string> = {
  URL: 'External URL',
  LOCAL_POINTER: 'Local file',
};

/** British-English labels for the §4 Condition enum (Phase 9). */
export const CONDITION_LABELS: Record<Condition, string> = {
  MINT: 'Mint',
  GOOD: 'Good',
  NEEDS_REPAIR: 'Needs repair',
  OUT_FOR_CALIBRATION: 'Out for calibration',
};

/** Labels for the §4.3 maintenance schedule basis (Phase 9). */
export const MAINTENANCE_BASIS_LABELS: Record<MaintenanceBasis, string> = {
  TIME: 'Time-based',
  USAGE: 'Usage-based',
};

/** Format a UNIX-ms instant as an en-GB date (no time) for expiry/maintenance display. */
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
export function formatDate(ms: number): string {
  return dateFormat.format(new Date(ms));
}

/** Convert a UNIX-ms instant to the `yyyy-MM-dd` string an `<input type="date">` wants. */
export function toDateInputValue(ms: number | null): string {
  if (ms === null) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/** Parse a `yyyy-MM-dd` date-input value to a UNIX-ms instant (midnight UTC), or null. */
export function fromDateInputValue(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}
