/**
 * The sample event the template editor previews against (webhooks plan `W7`; see §5.3).
 *
 * The editor renders its preview through the **real** `renderWebhookTemplate` over a real
 * {@link WebhookEventView} — never a second, editor-only interpolator. That matters more than it
 * sounds: a preview computed by different code is not a preview, it is a guess that happens to
 * agree most of the time, and the one time it disagrees is the time the user needed it.
 *
 * So the only thing this module supplies is the *event*. It is deliberately synthetic and
 * obviously so (`example.com`-flavoured, invented names), both because the app has no real event
 * to hand — the bridge derives events, not the app (§3) — and because a preview seeded from the
 * user's actual inventory would be a privacy surprise in a screenshot.
 */
import type { WebhookEventView } from './event-view';
import { ITEM_CHANGED_TYPE } from '@/features/events/event-types';

/**
 * A representative ledger-derived event: an item that exists, sits somewhere, has a category and
 * tags, and carries a change. Every field the allow-list exposes is populated, so a template
 * author sees what each placeholder actually resolves to rather than an empty string.
 */
export const WEBHOOK_PREVIEW_EVENT: WebhookEventView = Object.freeze({
  id: 'preview-0001',
  type: ITEM_CHANGED_TYPE,
  occurredAt: '2026-07-18T09:30:00.000Z',
  item: Object.freeze({
    id: 'item-preview',
    name: 'Brass hinge, 40mm',
    quantity: 12,
    locationId: 'loc-workshop-shelf',
    locationName: 'Workshop — Shelf B',
    locationPath: Object.freeze(['loc-workshop', 'loc-workshop-shelf']),
    categoryId: 'cat-fixings',
    categoryName: 'Fixings',
    tagIds: Object.freeze(['tag-restock', 'tag-brass']),
  }),
  change: Object.freeze({
    action: 'ATTRIBUTES_CHANGED',
    kind: 'update',
    label: 'Details changed',
    detail: 'Changed unit cost, barcode.',
    delta: null,
    quantityDelta: null,
    netValueDelta: null,
  }),
}) as WebhookEventView;
