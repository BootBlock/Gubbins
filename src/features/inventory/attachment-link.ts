/**
 * Resolve how a datasheet attachment should be presented on *this* device (spec §4
 * "Attachments & Datasheets", graceful degradation; Phase 53).
 *
 * An external `URL` is valid on every device. A `LOCAL_POINTER` path, however, is only
 * meaningful on the device that linked it (§4 Strict Sync Isolation — only the path
 * string syncs, never the blob). When such a pointer is synced to a secondary device the
 * spec requires the UI to "gracefully degrade to display an 'Unlinked Local File'
 * placeholder, prompting the user to either supply a new local path for that device or an
 * external URL" — and to "never attempt to upload or download the heavy file blob".
 *
 * A `URL` is presented as a link only when its value is an `http(s)` address; anything else is
 * shown as text (`unopenable`), because a synced row can hold a scheme no page can navigate to.
 *
 * This pure seam decides which of those four states applies by comparing the pointer's
 * stored origin device (v18 `origin_device_id`, supplied by `lib/env/device-id`) with the
 * current device. A NULL origin is a legacy (pre-v18) pointer that cannot be attributed —
 * it is treated as `local` so a pre-existing pointer never spuriously degrades. Mirrors the
 * small-pure-mapping seams (`resolveMode` / `liveRegionAttrs` / `describeHistoryEntry`).
 */
import type { AttachmentKind } from '@/db/repositories';
import { isExternalHref } from '@/lib/external-href';
import { isForeignOrigin } from './device-origin';

export type AttachmentLinkState =
  /** External `http(s)` URL — open directly; valid on any device. */
  | 'url'
  /**
   * A `URL` attachment whose stored value is not an `http(s)` address — show it, but never as
   * a link. The repository refuses such a value at write time, so this state exists for the row
   * that never met it: the sync/restore path applies remote rows column by column, so
   * `item_attachments.value` can hold anything the peer that sent it chose.
   */
  | 'unopenable'
  /** Local pointer owned by this device (or a legacy NULL-origin pointer). */
  | 'local'
  /** Local pointer synced from another device — show the "Unlinked Local File" placeholder. */
  | 'unlinked';

export interface AttachmentLink {
  readonly state: AttachmentLinkState;
  /**
   * For `url`, the href (trimmed, so what opens is exactly what was checked); for
   * `unopenable`, the stored value as text; for `local`/`unlinked`, the literal file path.
   */
  readonly value: string;
}

/** Minimal shape needed to resolve a link (decoupled from the full `ItemAttachment`). */
export interface ResolvableAttachment {
  readonly kind: AttachmentKind;
  readonly value: string;
  readonly originDeviceId: string | null;
}

export function resolveAttachmentLink(
  attachment: ResolvableAttachment,
  currentDeviceId: string,
): AttachmentLink {
  if (attachment.kind === 'URL') {
    // Re-check the scheme here rather than trust the column: an anchor is the one place a
    // `javascript:`/`data:` value would be acted on, and a synced row never met the write-time
    // validator. The trimmed form is what the gate judged, so it is what the anchor gets.
    const trimmed = attachment.value.trim();
    if (!isExternalHref(trimmed)) return { state: 'unopenable', value: attachment.value };
    return { state: 'url', value: trimmed };
  }
  // LOCAL_POINTER: a NULL origin (legacy) or a match to this device is shown as local;
  // anything attributed to a *different* device is the foreign, unlinked case (§4). The
  // comparison itself is shared with the custom-field `FILE` surface (W1g) so the two cannot
  // come to disagree about what an unattributed row means — see {@link isForeignOrigin}.
  const foreign = isForeignOrigin(attachment.originDeviceId, currentDeviceId);
  return { state: foreign ? 'unlinked' : 'local', value: attachment.value };
}
