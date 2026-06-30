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
  readonly created_at: number;
}

export interface ItemHistoryEntry {
  readonly id: string;
  readonly itemId: string;
  readonly action: HistoryAction;
  readonly quantityDelta: number | null;
  readonly netValueDelta: number | null;
  readonly note: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: number;
}

/**
 * A joined `item_history` row carrying the owning item's name + active flag, for the
 * cross-item global activity feed (Phase 80). The base history columns plus the two
 * joined `items` columns.
 */
export interface ActivityFeedRow extends ItemHistoryRow {
  readonly item_name: string;
  readonly item_is_active: number;
}

/** One global-activity-feed entry: a history entry plus its owning item's name + state. */
export interface ActivityFeedEntry extends ItemHistoryEntry {
  readonly itemName: string;
  readonly itemIsActive: boolean;
}
