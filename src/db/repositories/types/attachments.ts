/**
 * Item attachment / datasheet row + DTO types (spec §4).
 */
import type { AttachmentKind } from '../constants';

export interface ItemAttachmentRow {
  readonly id: string;
  readonly item_id: string;
  readonly kind: AttachmentKind;
  readonly value: string;
  readonly label: string | null;
  readonly position: number;
  readonly origin_device_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ItemAttachment {
  readonly id: string;
  readonly itemId: string;
  readonly kind: AttachmentKind;
  /** The external URL, or the literal local file-path pointer (sync-safe). */
  readonly value: string;
  readonly label: string | null;
  readonly position: number;
  /**
   * The device that created/last-relinked a `LOCAL_POINTER` (v18, §4 degradation). NULL for
   * a `URL` and for legacy pre-v18 pointers. Feeds the pure `resolveAttachmentLink` seam.
   */
  readonly originDeviceId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateAttachmentInput {
  readonly itemId: string;
  readonly kind: AttachmentKind;
  readonly value: string;
  readonly label?: string | null;
  readonly position?: number;
  /** The current device id for a `LOCAL_POINTER` (§4 degradation); omit/null for a `URL`. */
  readonly originDeviceId?: string | null;
}
