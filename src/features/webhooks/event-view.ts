/**
 * The **event view** — the allow-list itself (webhooks plan `W3`; see
 * `docs/todo/done/webhooks_2026-07-18.md` §5.2/§5.3).
 *
 * The matcher and the template engine both need to read facts out of an event: "which location
 * is this item in?", "what goes in `{{item.name}}`?". Two constraints shape how they get them.
 *
 * 1. **`src/` cannot import from `bridge/`.** `tsconfig.app.json` is `"include": ["src"]` and the
 *    `@/*` alias runs bridge → app only, so `BridgeEvent` / `BridgeEventData` / `ItemSummaryDto`
 *    are all out of reach. Structural typing against them would also be fragile: `LookupEvent`'s
 *    payload shares no field with the ledger payload, so a "weak" all-optional interface covering
 *    both would be rejected by TypeScript's weak-type detection at the bridge call site.
 * 2. **A template must never surface something the event did not already contain** (§5.3), which
 *    means an explicit allow-list rather than arbitrary property traversal.
 *
 * Both are answered by the same move: the deliverer projects whatever event it holds into this
 * flat, closed {@link WebhookEventView}, and the pure modules read *only* the view. The view **is**
 * the allow-list — there is no traversal to restrict, because there is nothing else in scope. A
 * field the projection does not set cannot be filtered on, interpolated, or leaked, and adding one
 * is a deliberate edit here rather than an emergent consequence of some other payload growing.
 *
 * Absent facts are `null` rather than missing: an event that is not about an item at all
 * (`lookup.resolved`, `events.truncated`) has `item: null`, and both consumers have one documented
 * rule for that case — a narrowing filter refuses to match what it cannot confirm, and a template
 * placeholder renders empty.
 *
 * This module is imported by the bridge, so it must survive Node's **strip-only** loader: no
 * `enum`, no `namespace`, no TS parameter properties.
 */

/** The item an event is about, as far as a filter or a template may see it. */
export interface WebhookEventItemView {
  readonly id: string;
  readonly name: string;
  /** On-hand total, or `null` for an unlimited-supply item (and when it is not known). */
  readonly quantity: number | null;
  readonly locationId: string | null;
  readonly locationName: string | null;
  /**
   * The location's ancestor chain, **root-first and including the item's own location id**.
   * This is what makes "location subtree" filtering a pure set test rather than a tree walk: the
   * evaluator asks whether the filter's location id appears in the path, so the deliverer resolves
   * the hierarchy once (where it has the DB) instead of the matcher needing one.
   *
   * Empty when the hierarchy could not be resolved — in which case a subtree filter falls back to
   * comparing {@link locationId} alone, and so still matches a direct hit.
   */
  readonly locationPath: readonly string[];
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  /** Every tag on the item, in whatever order the deliverer read them. */
  readonly tagIds: readonly string[];
}

/** The change an event describes, for the ledger-derived events that have one. */
export interface WebhookEventChangeView {
  /** The raw ledger action (e.g. `QUANTITY_CHANGE`). */
  readonly action: string;
  /** The semantic activity kind the action folds into. */
  readonly kind: string;
  /** Short British-English action title (e.g. "Quantity changed"). */
  readonly label: string;
  readonly detail: string | null;
  /** The signed delta badge ("+3" / "−45.5"), or `null` when nothing moved. */
  readonly delta: string | null;
  readonly quantityDelta: number | null;
  readonly netValueDelta: number | null;
}

/**
 * The complete, closed projection of an event that the pure webhook modules may read.
 *
 * The envelope fields mirror the bridge's event envelope exactly (`id` / `type` / `occurredAt`),
 * so a template that echoes them produces the same values the default payload carries.
 */
export interface WebhookEventView {
  readonly id: string;
  readonly type: string;
  /** ISO-8601, exactly as the envelope carries it. */
  readonly occurredAt: string;
  /** The item this event concerns, or `null` when it does not concern one. */
  readonly item: WebhookEventItemView | null;
  /** The change this event describes, or `null` for a non-ledger event. */
  readonly change: WebhookEventChangeView | null;
}
