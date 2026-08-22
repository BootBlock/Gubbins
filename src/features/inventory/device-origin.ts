/**
 * The rule deciding whether something recorded on a device belongs to *this* one (W1g).
 *
 * Two things in Gubbins store the device that authored them — a `LOCAL_POINTER` datasheet
 * (`item_attachments.origin_device_id`, v18) and, since W1g, a custom-field value
 * (`item_field_values` / `location_field_values`). Both store it for the same reason: what
 * they hold is a **path**, and a path is only meaningful on a device that can reach it. Both
 * therefore ask the same question of it, and this is the one place that answers.
 *
 * It is its own module rather than an export of `attachment-link.ts` because neither caller
 * owns it: `resolveAttachmentLink` reads a `kind` column a field value does not have, and the
 * field-value side decides openability from the string instead (`@/lib/external-href`). What the
 * two genuinely share is this comparison and its NULL rule — and sharing it is what stops the
 * two surfaces disagreeing about what an unattributed row means.
 *
 * (W1f recorded that `resolveAttachmentLink` could not be reused for a field value at all,
 * because a field value had "neither column". That was true then. The origin column is the
 * half of it W1g adds, so this — the comparison alone, not the whole seam — is now genuinely
 * shared rather than ceremony.)
 */
import type { FieldType } from '@/db/repositories/constants';
import { isExternalHref } from '@/lib/external-href';

/**
 * True when `originDeviceId` names a device other than the one reading it.
 *
 * A **NULL origin is not foreign.** It means unattributed, and it has to read as local for
 * two distinct populations: every row written before the column existed, and every row
 * written by a path that deliberately makes no claim about where its string came from (a
 * clone, a spreadsheet import). Treating either as foreign would put a warning on values
 * nothing is wrong with, which is worse than the silence W1g exists to fix.
 */
export function isForeignOrigin(originDeviceId: string | null, currentDeviceId: string): boolean {
  return originDeviceId !== null && originDeviceId !== currentDeviceId;
}

/**
 * True when a stored custom-field value is a **file path recorded on another device** — the one
 * state W1g exists to name, for a caller holding a raw value it has not classified yet.
 *
 * Three things have to hold, and each excludes a case that would otherwise be warned about
 * wrongly: the definition is a `FILE` (nothing else stores a path), the value is not an
 * `http(s)` address (a `FILE` value may hold one, and an address opens on any device — the same
 * carve-out `resolveAttachmentLink` makes for `kind === 'URL'`), and the origin is foreign.
 *
 * This is the **same rule** `customFieldValue` applies when it builds a `pointer` arm; it is
 * spelled separately here because that function reaches it having already split address from
 * path, and so needs only the last clause. A test pins the two together.
 */
export function isForeignFilePointer(
  fieldType: FieldType,
  value: string | null,
  originDeviceId: string | null,
  currentDeviceId: string,
): boolean {
  if (fieldType !== 'FILE' || value === null) return false;
  const trimmed = value.trim();
  if (trimmed === '' || isExternalHref(trimmed)) return false;
  return isForeignOrigin(originDeviceId, currentDeviceId);
}
