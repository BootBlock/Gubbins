/**
 * Shared presentational helpers for the inventory feature (spec §3, §4.1.3).
 * Pure functions — no React — for gauge colour bands and en-GB number formatting.
 */
import type { TrackingMode } from '@/db/repositories';

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
