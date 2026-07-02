/**
 * Shared presentational helpers for the inventory feature (spec §3, §4.1.3).
 * Pure functions — no React — for gauge colour bands, enum labels and date-input
 * conversions. Locale-aware number/measure/date *display* lives in the
 * `makeFormatters` factory (`@/lib/format`) via the `useFormatters()` hook so it
 * honours the user's chosen locale (§3); these helpers are locale-independent.
 */
import {
  CONDITIONS,
  type AttachmentKind,
  type Condition,
  type FieldType,
  type Item,
  type MaintenanceBasis,
  type TrackingMode,
} from '@/db/repositories';
import type { SelectOption } from '@/components/foundry';
import type { AttachmentMode } from '@/state/stores/usePreferencesStore';

/**
 * Multi-select model for the inventory list (spec §6 batch QR labels, Phase 49).
 * When present on a row/card, a selection checkbox is shown; selection lives as
 * ephemeral Tier-3 screen state and survives the bounded virtualised-list window
 * because it is keyed by id, independent of which page is currently resident.
 */
export interface ItemSelection {
  readonly selectedIds: ReadonlySet<string>;
  readonly onToggle: (item: Item) => void;
}

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

export const TRACKING_MODE_LABELS: Record<TrackingMode, string> = {
  DISCRETE: 'Bulk',
  SERIALISED: 'Serialised',
  CONSUMABLE_GAUGE: 'Consumable',
  UNTRACKED: 'Untracked',
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

/**
 * Token text-colour class tinting a Condition label wherever it appears in a picker,
 * so an item's state reads at a glance (spec §4): green for Mint down to red for Needs
 * repair. Static token literals (never raw colours) so Tailwind's scanner emits the
 * utilities and the tints stay themed/dark-mode-correct — Mint / Out-for-calibration /
 * Needs-repair reuse the semantic success / warning / destructive tokens, and Good uses
 * the dedicated `cond-good` lime (see styles/index.css). Colour is never the sole signal
 * (the label always reads), keeping this within WCAG 1.4.1.
 */
export const CONDITION_COLOR_CLASS: Record<Condition, string> = {
  MINT: 'text-success',
  GOOD: 'text-cond-good',
  NEEDS_REPAIR: 'text-destructive',
  OUT_FOR_CALIBRATION: 'text-warning',
};

/**
 * Options for a Condition {@link Select} combobox: a leading "untracked" blank row plus
 * every condition, each tinted with its {@link CONDITION_COLOR_CLASS}. The blank row's
 * label differs by context — "— Untracked —" when creating, "— None —" when editing — so
 * it is a parameter.
 */
export function conditionSelectOptions(untrackedLabel = '— Untracked —'): SelectOption[] {
  return [
    { value: '', label: untrackedLabel },
    ...CONDITIONS.map((c) => ({
      value: c,
      label: CONDITION_LABELS[c],
      colorClass: CONDITION_COLOR_CLASS[c],
    })),
  ];
}

/** Labels for the §4.3 maintenance schedule basis (Phase 9). */
export const MAINTENANCE_BASIS_LABELS: Record<MaintenanceBasis, string> = {
  TIME: 'Time-based',
  USAGE: 'Usage-based',
};

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
