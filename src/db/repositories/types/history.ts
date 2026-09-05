/**
 * Immutable Activity Log row + DTO (spec §4, §4.1.3).
 */
import type { HistoryAction } from '../constants';

export interface ItemHistoryRow {
  readonly id: string;
  readonly item_id: string;
  readonly action: HistoryAction;
  readonly quantity_delta: number | null;
  readonly net_value_delta: number | null;
  readonly note: string | null;
  readonly metadata: string | null;
  /** Who performed the action. NOT NULL in the schema — every entry is attributable. */
  readonly actor_user_id: string;
  readonly created_at: number;
}

/**
 * An `item_history` row with the actor's current display name joined on (issue #774).
 *
 * Every read that maps to a DTO selects this shape, because a bare `actor_user_id` is not an
 * answer to "who?" anywhere the entry travels — least of all in the Storage-Triage cold-storage
 * archive, which leaves the device and is then the only copy.
 *
 * The join is a **LEFT** join and the name is nullable deliberately: an inner join would
 * silently drop any entry whose actor could not be resolved, and losing audit rows is
 * precisely the failure this column was added to end. `ON DELETE SET DEFAULT` re-points a deleted
 * user's entries at System, so a dangling id should not arise — but a restored snapshot or a
 * merge from a peer that has not yet supplied the account can produce one, and the entry must
 * still be read back.
 */
export interface ItemHistoryWithActorRow extends ItemHistoryRow {
  readonly actor_display_name: string | null;
}

export interface ItemHistoryEntry {
  readonly id: string;
  readonly itemId: string;
  readonly action: HistoryAction;
  readonly quantityDelta: number | null;
  readonly netValueDelta: number | null;
  readonly note: string | null;
  readonly metadata: Record<string, unknown> | null;
  /** The id of the account the change is recorded against (issue #774). */
  readonly actorUserId: string;
  /**
   * That account's display name at the time of the read, or `null` when the id resolves to no
   * account — see {@link ItemHistoryWithActorRow} for when that can happen. Carried alongside the
   * id rather than looked up by each consumer so the value survives into an export and into the
   * cold-storage archive, where an id alone would be unresolvable.
   */
  readonly actorDisplayName: string | null;
  readonly createdAt: number;
}

/**
 * A joined `item_history` row carrying the owning item's name + active flag, for the
 * cross-item global activity feed (Phase 80). The base history columns plus the two
 * joined `items` columns.
 */
export interface ActivityFeedRow extends ItemHistoryWithActorRow {
  readonly item_name: string;
  readonly item_is_active: number;
}

/** One global-activity-feed entry: a history entry plus its owning item's name + state. */
export interface ActivityFeedEntry extends ItemHistoryEntry {
  readonly itemName: string;
  readonly itemIsActive: boolean;
}
