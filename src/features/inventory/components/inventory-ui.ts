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
import type { WarrantyStatus } from '../asset-lifecycle';

/**
 * Multi-select model for the inventory list (spec §6 batch QR labels, Phase 49).
 * When present on a row/card, a selection checkbox is shown; its *presence* means
 * select mode is active and `undefined` means it is off. Selection lives as
 * ephemeral Tier-3 screen state and survives the bounded virtualised-list window
 * because it is keyed by id, independent of which page is currently resident.
 *
 * Deliberately holds only the stable `onToggle` callback — the per-row checked
 * state is passed to each memoised row as a plain `selected` boolean instead, so a
 * toggle re-renders only the one row whose state changed rather than every visible
 * row (which a fresh `selectedIds` Set on this object would otherwise force).
 */
export interface ItemSelection {
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

/** The stroke-dash geometry of a ring gauge (`GaugeRing`), resolved from its value and size. */
export interface RingGeometry {
  /** The remaining percentage, clamped to `[0, 100]` — the single source for both dash + tone. */
  readonly pct: number;
  /** Ring radius (px) — the circle's `r`, inset by half the stroke width. */
  readonly radius: number;
  /** Full stroke length (px) = the `stroke-dasharray`, and the "empty ring" dash offset. */
  readonly circumference: number;
  /** The `stroke-dashoffset` for the current value: `circumference` at 0%, `0` at 100%. */
  readonly offset: number;
}

/**
 * Pure stroke-dash geometry for the ring gauge (visual-flair F8), kept here beside {@link gaugeTone}
 * so it can be unit-tested without a DOM (happy-dom has no real SVG geometry). `percentageRemaining`
 * is clamped to `[0, 100]` — so a stale/out-of-range value can never produce a negative or
 * over-long dash — and the offset runs from the whole `circumference` (empty ring, the draw-on's
 * `from`) down to `0` (a full ring). The clamped `pct` is returned so the caller can drive the
 * colour tone off the same single clamp.
 */
export function ringGeometry(percentageRemaining: number, size: number, stroke: number): RingGeometry {
  const pct = Math.max(0, Math.min(100, percentageRemaining));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return { pct, radius, circumference, offset: circumference * (1 - pct / 100) };
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
  LONG_TEXT: 'Long text',
  URL: 'URL / Link',
  NUMBER: 'Number',
  RATING: 'Rating (1–5)',
  BOOLEAN: 'Yes / No',
  ON_OFF: 'On / Off',
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
 * Concise British-English label for each warranty state — for a badge/table cell where the
 * surrounding context ("Warranty") is already clear. The verbose AssetEditor badge keeps its
 * own sentence-style copy; this is the reusable short form (insurance schedule, lists).
 */
export const WARRANTY_STATUS_LABEL: Record<WarrantyStatus, string> = {
  none: '—',
  active: 'Active',
  'expiring-soon': 'Expiring soon',
  expired: 'Expired',
};

/**
 * Token text-colour class for each warranty state (mirrors {@link CONDITION_COLOR_CLASS}):
 * green for active down to red for expired, muted for "no date set". Static token literals
 * (never raw colours) so Tailwind emits the utilities and the tints stay themed / dark-mode
 * correct. Colour is never the sole signal — {@link WARRANTY_STATUS_LABEL} always reads —
 * keeping this within WCAG 1.4.1.
 */
export const WARRANTY_STATUS_COLOR_CLASS: Record<WarrantyStatus, string> = {
  none: 'text-muted-foreground',
  active: 'text-success',
  'expiring-soon': 'text-warning',
  expired: 'text-destructive',
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
