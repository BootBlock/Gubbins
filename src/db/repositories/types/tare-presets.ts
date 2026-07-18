/**
 * Saved tare-preset row + DTO types (issue #94 — reusable empty-container weights).
 *
 * A container the user measured on their own scale and kept, so its tare can be pulled into
 * any tare field instead of retyped. It references no item — the same jar is reused across
 * many — so, like `wishlist` / `contacts` / `projects`, its `id` is a random UUID and the
 * table is an independent synced LWW leaf.
 *
 * `tareGrams` is canonical **grams**, matching `items.weight` and the weigh-count seam. The
 * small `kind` vocabulary is app-enforced by the pure `tare-presets.ts` seam (`kind` is free
 * TEXT in the DB, so a value minted by a newer peer round-trips rather than failing a CHECK).
 */
import type { TarePresetKind } from '@/features/inventory/tare-presets';

export interface TarePresetRow {
  readonly id: string;
  readonly name: string;
  readonly brand: string | null;
  readonly kind: string;
  readonly tare_grams: number;
  readonly note: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** A container weight the user saved. */
export interface SavedTarePreset {
  readonly id: string;
  readonly name: string;
  readonly brand: string | null;
  readonly kind: TarePresetKind;
  /** The empty weight in canonical grams (≥ 0). */
  readonly tareGrams: number;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Parameters for saving a container weight. */
export interface CreateTarePresetInput {
  readonly name: string;
  readonly brand?: string | null;
  /** One of the {@link TarePresetKind} values; anything unknown softens to `OTHER`. */
  readonly kind?: string | null;
  /** The empty weight in canonical grams; must be finite and ≥ 0. */
  readonly tareGrams: number;
  readonly note?: string | null;
}

/**
 * Parameters for updating a saved container weight. Each field is optional; only the provided
 * fields change (a provided `null` clears the optional field). `name` cannot be cleared to
 * blank, and `tareGrams` must stay finite and non-negative.
 */
export interface UpdateTarePresetInput {
  readonly name?: string;
  readonly brand?: string | null;
  readonly kind?: string | null;
  readonly tareGrams?: number;
  readonly note?: string | null;
}
