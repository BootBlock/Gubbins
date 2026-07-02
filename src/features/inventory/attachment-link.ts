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
 * This pure seam decides which of those three states applies by comparing the pointer's
 * stored origin device (v18 `origin_device_id`, supplied by `lib/env/device-id`) with the
 * current device. A NULL origin is a legacy (pre-v18) pointer that cannot be attributed —
 * it is treated as `local` so a pre-existing pointer never spuriously degrades. Mirrors the
 * small-pure-mapping seams (`resolveTheme` / `liveRegionAttrs` / `describeHistoryEntry`).
 */
import type { AttachmentKind } from '@/db/repositories';

export type AttachmentLinkState =
  /** External URL — open directly; valid on any device. */
  | 'url'
  /** Local pointer owned by this device (or a legacy NULL-origin pointer). */
  | 'local'
  /** Local pointer synced from another device — show the "Unlinked Local File" placeholder. */
  | 'unlinked';

export interface AttachmentLink {
  readonly state: AttachmentLinkState;
  /** For `url`, the href; for `local`/`unlinked`, the literal local file path. */
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
    return { state: 'url', value: attachment.value };
  }
  // LOCAL_POINTER: a NULL origin (legacy) or a match to this device is shown as local;
  // anything attributed to a *different* device is the foreign, unlinked case (§4).
  const foreign = attachment.originDeviceId !== null && attachment.originDeviceId !== currentDeviceId;
  return { state: foreign ? 'unlinked' : 'local', value: attachment.value };
}
