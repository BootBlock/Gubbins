/**
 * Which payload editor a stored template implies (webhooks plan §5.3).
 *
 * Pure and separate from the component so the mapping is unit-testable and the editor file exports
 * only components.
 *
 * This is consulted **once**, to seed the editor's mode when the dialog opens — it is deliberately
 * not what the editor reads on every render. Re-deriving the mode looks tidy and is wrong: a
 * freshly-chosen "Custom" starts as an empty template, an empty template is indistinguishable from
 * "no template", and so the mode would snap straight back to the envelope, leaving the custom
 * editor impossible to reach.
 */
import { isWebhookPreset, WEBHOOK_PRESET_PREFIX } from './template';

/** The two modes that are not a preset name. */
export const WEBHOOK_TEMPLATE_MODE_ENVELOPE = 'envelope';
export const WEBHOOK_TEMPLATE_MODE_CUSTOM = 'custom';

export function modeForTemplate(template: string | null | undefined): string {
  const trimmed = template?.trim() ?? '';
  if (trimmed === '') return WEBHOOK_TEMPLATE_MODE_ENVELOPE;
  if (trimmed.startsWith(WEBHOOK_PRESET_PREFIX)) {
    const name = trimmed.slice(WEBHOOK_PRESET_PREFIX.length).trim();
    // An unrecognised preset (a newer peer's) is delivered as the envelope, so the editor says so
    // rather than presenting it as a custom template the user could accidentally overwrite.
    return isWebhookPreset(name) ? name : WEBHOOK_TEMPLATE_MODE_ENVELOPE;
  }
  return WEBHOOK_TEMPLATE_MODE_CUSTOM;
}
