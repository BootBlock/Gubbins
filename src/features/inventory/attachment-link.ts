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
 * small-pure-mapping seams (`resolveMode` / `liveRegionAttrs` / `describeHistoryEntry`).
 *
 * It is also the home of {@link isExternalHref} — the "may this string be an `href`?" half of
 * the same judgement, shared with the `URL`/`FILE` custom-field link arm (W1f) so a datasheet
 * recorded as an attachment and one recorded as a field value are decided by one rule.
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

/**
 * Is this stored string safe — and useful — to hand to an `<a href>`?
 *
 * Exactly the judgement the `URL` attachment *kind* stands for, extracted so the one answer
 * serves both mechanisms (W1f). An attachment carries its answer in a column, validated as
 * http(s) on the way in ({@link import('@/db/repositories').AttachmentRepository}); a `URL` /
 * `FILE` **custom-field value** carries it only in the string, because `FILE` is defined as
 * *"a local path, a UNC share, or a `file://` / `http(s)` URI"* — one type covering both of
 * the attachment kinds — so the value's own shape has to decide.
 *
 * Only `http:` and `https:` qualify. That is not merely a usefulness test: a browser refuses
 * to navigate from an http(s) page to `file://` or a bare Windows path, so linking one would
 * be a dead control that *looks* live — and it is the gate that stops a stored `javascript:`
 * string ever reaching an `href`, the same defence `isImageDataUrl` gives the IMAGE arm.
 */
export function isExternalHref(value: string): boolean {
  try {
    const { protocol } = new URL(value.trim());
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false; // not an absolute URI at all — a path, a UNC share, or free text
  }
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
