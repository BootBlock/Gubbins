/**
 * Location activity-record row + DTO (issue #691).
 *
 * The sibling of `types/history.ts`, for the `location_history` ledger. Deliberately narrower
 * than an item's entry: a location has no quantity and no value, so there is no delta to carry —
 * only what changed, said in words.
 */
import type { LocationHistoryAction } from '../constants';

export interface LocationHistoryRow {
  readonly id: string;
  /** The location the entry is about. A historical coordinate, not a foreign key — it outlives
   *  the location, so an entry about a deleted place still names which one. */
  readonly location_id: string;
  /** The name the location carried when the entry was written — never back-filled. */
  readonly location_name: string;
  readonly action: LocationHistoryAction;
  readonly note: string | null;
  readonly metadata: string | null;
  readonly actor_user_id: string;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * A `location_history` row with the actor's current display name joined on (issue #774) — the
 * sibling of {@link import('./history').ItemHistoryWithActorRow}, and a LEFT join for the same
 * reason: an entry whose actor cannot be resolved must still be read back, not dropped.
 */
export interface LocationHistoryWithActorRow extends LocationHistoryRow {
  readonly actor_display_name: string | null;
}

export interface LocationHistoryEntry {
  readonly id: string;
  /**
   * The location the entry is about. It stays set after the location is deleted — the entry is
   * kept rather than erased, so a deletion is still a fact the ledger, a backup and a sync all
   * carry, and still names its subject. See the table's schema note.
   */
  readonly locationId: string;
  /** The name the location carried when the entry was written. */
  readonly locationName: string;
  readonly action: LocationHistoryAction;
  readonly note: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly actorUserId: string;
  /**
   * That account's display name at the time of the read, or `null` when the id resolves to no
   * account. Carried beside the id so an exported entry still answers "who?" away from this
   * database — see {@link import('./history').ItemHistoryEntry.actorDisplayName}.
   */
  readonly actorDisplayName: string | null;
  readonly createdAt: number;
}
