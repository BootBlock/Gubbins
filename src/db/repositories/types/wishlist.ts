/**
 * Wishlist row + DTO types (feature-gap G8 — manual "to-buy" / wishlist).
 *
 * A free-standing entry on the manual wishlist: a `name` plus an optional note, `http(s)` link,
 * target price and priority. It references no item (you don't own it yet) and has no natural
 * business key, so its `id` is a random UUID like `contacts` / `projects`. The small priority
 * vocabulary is app-enforced by the pure `wishlist.ts` seam (`priority` is free TEXT in the DB).
 */
import type { WishlistPriority } from '@/features/purchasing/wishlist';

export interface WishlistRow {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly url: string | null;
  readonly target_price: number | null;
  readonly priority: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/** A stored wishlist entry. */
export interface WishlistEntry {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  /** A sanitised absolute `http(s)` link, or null. */
  readonly url: string | null;
  /** Optional target/budget price in the base currency (≥ 0), or null. */
  readonly targetPrice: number | null;
  readonly priority: WishlistPriority;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Parameters for creating a wishlist entry — normalised/validated by `planWishlistEntry`. */
export interface CreateWishlistInput {
  readonly name: string;
  readonly note?: string | null;
  readonly url?: string | null;
  readonly targetPrice?: number | null;
  /** One of the {@link WishlistPriority} values; anything unknown softens to `NONE`. */
  readonly priority?: string | null;
}

/**
 * Parameters for updating a wishlist entry. Each field is optional; only the provided fields are
 * changed (a provided `null` clears the optional field). `name` cannot be cleared to blank.
 */
export interface UpdateWishlistInput {
  readonly name?: string;
  readonly note?: string | null;
  readonly url?: string | null;
  readonly targetPrice?: number | null;
  readonly priority?: string | null;
}
