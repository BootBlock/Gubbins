/**
 * What the template editor shows under "Preview" (webhooks plan `W7`; see §5.3).
 *
 * Pure, so the interesting decisions are unit-testable and the editor component stays a renderer.
 * Everything here runs through the **real** `resolveWebhookPayload` / `renderWebhookTemplate` /
 * `webhookQueryParams` over a real {@link WebhookEventView} — there is deliberately no second
 * interpolator in this codebase.
 *
 * ## The one thing this cannot preview, and why it says so instead of guessing
 *
 * The default payload is the bridge's own `BridgeEvent` envelope, and the app cannot build one:
 * the bridge derives events, and `src/` cannot import `bridge/` (§1, `W0`). `resolveWebhookPayload`
 * reflects that honestly by returning an `envelope` *marker* rather than a body, leaving `W5` to
 * serialise the event it already holds.
 *
 * So the envelope case returns {@link WEBHOOK_PREVIEW_ENVELOPE} and the editor explains the shape
 * in words. The alternative — rendering a plausible-looking JSON body assembled app-side — would
 * be worse than no preview: it would be a fabricated contract, agreeing with the real payload
 * right up until the moment someone depended on the difference.
 */
import { WEBHOOK_PREVIEW_EVENT } from './preview-event';
import type { WebhookEventView } from './event-view';
import { resolveWebhookPayload, unknownTemplatePaths, webhookQueryParams } from './template';
import type { WebhookMethod } from '@/db/repositories/constants';

/**
 * A method that sends a body. `GET` is the odd one out — its payload flattens into query
 * parameters, and it carries no HMAC signature at all (§5.3, §6.1).
 */
function sendsBody(method: WebhookMethod): boolean {
  return method !== 'GET';
}

/** The marker for "the default envelope, which only the bridge can render". */
export const WEBHOOK_PREVIEW_ENVELOPE = 'envelope' as const;

export type WebhookPreview =
  /** The default bridge event envelope — described in the UI, not rendered here. */
  | { readonly kind: typeof WEBHOOK_PREVIEW_ENVELOPE; readonly unknownPaths: readonly [] }
  /** A concrete body or query string, ready to show verbatim. */
  | {
      readonly kind: 'body' | 'query';
      readonly text: string;
      /**
       * Placeholders the template used that the allow-list does not define. These render empty
       * rather than failing, so the editor must surface them — a silently-empty field is the most
       * common way a template goes wrong.
       */
      readonly unknownPaths: readonly string[];
    };

/**
 * Build the preview for a template + method pair.
 *
 * @param template The stored template string: `null`/blank for the default envelope, `preset:<name>`
 *   for a preset, or free text with `{{event.type}}`-style placeholders.
 * @param method Decides whether the payload is shown as a body or flattened to a query string.
 * @param view The event to render against; defaults to the shared synthetic sample.
 */
export function previewWebhookPayload(
  template: string | null | undefined,
  method: WebhookMethod,
  view: WebhookEventView = WEBHOOK_PREVIEW_EVENT,
): WebhookPreview {
  const payload = resolveWebhookPayload(template, view);

  // Only a free-text template can carry placeholders, so only it can carry unknown ones. A preset
  // is built by code, and the envelope has no template at all.
  const unknownPaths =
    payload.kind === 'text' && typeof template === 'string' ? unknownTemplatePaths(template) : [];

  if (!sendsBody(method)) {
    const params = webhookQueryParams(payload, view);
    return {
      kind: 'query',
      text: params.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('\n'),
      unknownPaths,
    };
  }

  if (payload.kind === 'envelope') {
    return { kind: WEBHOOK_PREVIEW_ENVELOPE, unknownPaths: [] };
  }

  return {
    kind: 'body',
    text: payload.kind === 'json' ? JSON.stringify(payload.body, null, 2) : payload.body,
    unknownPaths,
  };
}
