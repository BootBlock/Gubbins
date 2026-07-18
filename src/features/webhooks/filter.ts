/**
 * The declarative webhook **filter** — vocabulary, parser and pure evaluator (webhooks plan `W3`;
 * see `docs/todo/webhooks_2026-07-18.md` §5.2).
 *
 * A subscription narrows beyond its event types with a filter: only this location's subtree, only
 * these categories, only when the quantity drops below five. `W1` deliberately left
 * `WebhookFilter` opaque (`Record<string, unknown>`) so storage would not fossilise a shape the
 * matcher had not yet agreed; this module is that agreement, and narrows the type.
 *
 * ## It is data, never an expression
 *
 * The filter is a JSON-serialisable tree evaluated by {@link evaluateWebhookFilter}, following the
 * search AST discipline (`parseTextQuery` → AST → evaluate; memory note `phase-47-scope-decisions`)
 * rather than inventing a second query language. There is **no user-supplied expression string**,
 * nothing is `eval`'d or interpreted, and the evaluator's entire vocabulary is the union below —
 * so the worst a hostile filter synced from a peer can do is match, or not match.
 *
 * ## Two rules that decide the safe direction
 *
 * Both matter because getting them backwards means firing webhooks the user did not ask for.
 *
 * - **An unconfirmable fact does not match.** A filter is a *narrowing*, so when the event carries
 *   no item at all (`lookup.resolved`, `events.truncated`) every item-scoped test is `false`, not
 *   "unknown, allow it". `not` still inverts that, which is the honest reading: "not in the shed"
 *   is true of an event with no shed.
 * - **A filter that cannot be understood matches nothing**, via {@link WEBHOOK_FILTER_NONE}. These
 *   rows arrive over sync from peers on other builds, so a filter using a node this build has never
 *   heard of is not a reason to fall back to "no filter" — that would silently *widen* the
 *   subscription to every event of its types. It is inert instead, matching the mapper's existing
 *   "a corrupt row is inert rather than over-firing" doctrine. Note this has to hold **under
 *   negation** too, which is subtler than it looks and is why {@link parseNode} distinguishes
 *   "failed to parse" from "parsed to the inert node" — see its doc comment.
 *
 * Pure by construction: no DB, no clock, no I/O, no React. Imported by the bridge, so it must
 * survive Node's **strip-only** loader: no `enum`, no `namespace`, no TS parameter properties.
 */
import type { WebhookEventView } from './event-view.ts';

/** Comparison operators a quantity threshold may use. */
export const WEBHOOK_FILTER_OPS = ['lt', 'lte', 'gt', 'gte', 'eq', 'neq'] as const;
export type WebhookFilterOp = (typeof WEBHOOK_FILTER_OPS)[number];

/** Every leaf/branch node kind, as the discriminator that appears in stored JSON. */
export const WEBHOOK_FILTER_KINDS = [
  'all',
  'any',
  'not',
  'none',
  'location',
  'category',
  'tag',
  'item',
  'quantity',
] as const;
export type WebhookFilterKind = (typeof WEBHOOK_FILTER_KINDS)[number];

/** Every event of the subscribed types passes only if **all** children pass (an empty list passes). */
export interface WebhookFilterAll {
  readonly kind: 'all';
  readonly of: readonly WebhookFilter[];
}

/** Passes if **any** child passes. An empty list passes nothing — there is no disjunct to satisfy. */
export interface WebhookFilterAny {
  readonly kind: 'any';
  readonly of: readonly WebhookFilter[];
}

/** Inverts its child. */
export interface WebhookFilterNot {
  readonly kind: 'not';
  readonly of: WebhookFilter;
}

/**
 * Matches nothing. Reachable two ways: a user explicitly pausing a subscription's delivery without
 * disabling it, and — far more importantly — the parser's landing place for anything it cannot
 * understand (see the module note).
 */
export interface WebhookFilterNone {
  readonly kind: 'none';
}

/**
 * The item's location. With {@link includeDescendants} (the default) this matches anywhere in the
 * subtree, tested against the view's pre-resolved `locationPath`; without it, only the exact
 * location.
 */
export interface WebhookFilterLocation {
  readonly kind: 'location';
  readonly locationIds: readonly string[];
  /** Defaults to `true` — "the shed" almost always means "and everything in it". */
  readonly includeDescendants?: boolean;
}

/** The item's category is one of these. */
export interface WebhookFilterCategory {
  readonly kind: 'category';
  readonly categoryIds: readonly string[];
}

/** The item carries at least one of these tags. */
export interface WebhookFilterTag {
  readonly kind: 'tag';
  readonly tagIds: readonly string[];
}

/** The event is about one of these specific items. */
export interface WebhookFilterItem {
  readonly kind: 'item';
  readonly itemIds: readonly string[];
}

/**
 * A threshold on the item's on-hand quantity *after* the change.
 *
 * An item with a `null` quantity — an unlimited-supply source, or an event whose item could not be
 * resolved — never satisfies a threshold, in either direction: there is no number to compare, and
 * treating "unlimited" as a very large or very small value would make one of `gt` / `lt` fire on
 * every mains-water event.
 */
export interface WebhookFilterQuantity {
  readonly kind: 'quantity';
  readonly op: WebhookFilterOp;
  readonly value: number;
}

/** The filter tree: a JSON-serialisable data structure, never an expression string. */
export type WebhookFilter =
  | WebhookFilterAll
  | WebhookFilterAny
  | WebhookFilterNot
  | WebhookFilterNone
  | WebhookFilterLocation
  | WebhookFilterCategory
  | WebhookFilterTag
  | WebhookFilterItem
  | WebhookFilterQuantity;

/** The inert filter every unparseable input becomes. Frozen: it is shared by every bad parse. */
export const WEBHOOK_FILTER_NONE: WebhookFilterNone = Object.freeze({ kind: 'none' });

/**
 * How deep a stored filter may nest before the parser refuses it.
 *
 * A filter is user-authored in this build but *arrives* from sync, so it is untrusted input: the
 * bound stops a deeply nested tree from turning the recursive parse or evaluation into a stack
 * overflow on the bridge. Ten is far past any tree a person builds in the `W7` UI.
 */
export const MAX_WEBHOOK_FILTER_DEPTH = 10;

/**
 * Parse an untrusted value (a `JSON.parse`d filter column, or an object from the editor) into a
 * validated {@link WebhookFilter}.
 *
 * Returns `null` for `null`/`undefined` — genuinely "no filter", the common case — and
 * {@link WEBHOOK_FILTER_NONE} for anything present but not understood, so "no filter" and "broken
 * filter" stay distinguishable. That distinction is the whole point: they mean opposite things.
 */
export function parseWebhookFilter(raw: unknown): WebhookFilter | null {
  if (raw == null) return null;
  // A failure anywhere in the tree lands here as the inert node, never as "no filter".
  return parseNode(raw, 0) ?? WEBHOOK_FILTER_NONE;
}

/**
 * Parse one node, returning `null` when it **cannot be understood** — distinct from successfully
 * parsing to the inert {@link WEBHOOK_FILTER_NONE}, which is a filter that deliberately matches
 * nothing.
 *
 * The distinction exists entirely for `not`. Substituting the inert node for an unparseable child
 * is safe under every *non-inverting* parent — inside `all` it forces the branch false, inside
 * `any` it simply contributes nothing — but under `not` it inverts to **true**, which would widen
 * the subscription to every event of its types. That is the one direction this module must never
 * fail in, so a `not` whose child failed propagates the failure instead of negating a guess.
 */
function parseNode(raw: unknown, depth: number): WebhookFilter | null {
  if (depth > MAX_WEBHOOK_FILTER_DEPTH) return null;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const node = raw as Record<string, unknown>;
  switch (node.kind) {
    case 'all':
    case 'any': {
      if (!Array.isArray(node.of)) return null;
      // A child that failed becomes inert rather than failing the whole branch: neither `all` nor
      // `any` inverts, so an inert child can only ever narrow the result.
      const of = node.of.map((child) => parseNode(child, depth + 1) ?? WEBHOOK_FILTER_NONE);
      return node.kind === 'all' ? { kind: 'all', of } : { kind: 'any', of };
    }
    case 'not': {
      const of = parseNode(node.of, depth + 1);
      return of === null ? null : { kind: 'not', of };
    }
    case 'none':
      return WEBHOOK_FILTER_NONE;
    case 'location': {
      const locationIds = parseIdList(node.locationIds);
      if (locationIds === null) return null;
      // Only an explicit `false` turns the subtree off; anything else keeps the default.
      return { kind: 'location', locationIds, includeDescendants: node.includeDescendants !== false };
    }
    case 'category': {
      const categoryIds = parseIdList(node.categoryIds);
      return categoryIds === null ? null : { kind: 'category', categoryIds };
    }
    case 'tag': {
      const tagIds = parseIdList(node.tagIds);
      return tagIds === null ? null : { kind: 'tag', tagIds };
    }
    case 'item': {
      const itemIds = parseIdList(node.itemIds);
      return itemIds === null ? null : { kind: 'item', itemIds };
    }
    case 'quantity': {
      const { op, value } = node;
      if (typeof op !== 'string' || !(WEBHOOK_FILTER_OPS as readonly string[]).includes(op)) {
        return null;
      }
      // `Number.isFinite` also rejects NaN and the infinities, none of which are valid JSON anyway
      // but all of which are reachable from a hand-edited object.
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return { kind: 'quantity', op: op as WebhookFilterOp, value };
    }
    default:
      return null;
  }
}

/**
 * Validate a list of ids: trimmed, non-blank strings, de-duplicated, order preserved. `null` when
 * the value is not a list of usable ids **or is empty** — an id filter matching no id would be a
 * silently inert subscription, so it is a parse failure rather than an empty set.
 */
function parseIdList(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim();
    if (trimmed) ids.add(trimmed);
  }
  return ids.size > 0 ? [...ids] : null;
}

/**
 * Evaluate a parsed filter against an event view. `null` — no filter — passes everything.
 *
 * Pure and total: every branch returns a boolean, so a filter can narrow a subscription but never
 * throw inside the deliverer's hot path.
 */
export function evaluateWebhookFilter(filter: WebhookFilter | null, view: WebhookEventView): boolean {
  if (filter === null) return true;
  switch (filter.kind) {
    case 'all':
      return filter.of.every((child) => evaluateWebhookFilter(child, view));
    case 'any':
      return filter.of.some((child) => evaluateWebhookFilter(child, view));
    case 'not':
      return !evaluateWebhookFilter(filter.of, view);
    case 'none':
      return false;
    case 'location':
      return matchesLocation(filter, view);
    case 'category':
      return view.item !== null && view.item.categoryId !== null
        ? filter.categoryIds.includes(view.item.categoryId)
        : false;
    case 'tag':
      return view.item !== null ? filter.tagIds.some((id) => view.item!.tagIds.includes(id)) : false;
    case 'item':
      return view.item !== null ? filter.itemIds.includes(view.item.id) : false;
    case 'quantity':
      return matchesQuantity(filter, view);
  }
}

function matchesLocation(filter: WebhookFilterLocation, view: WebhookEventView): boolean {
  const item = view.item;
  if (item === null) return false;
  // The path already includes the item's own location, so a subtree test is one set membership
  // check. When the deliverer could not resolve the hierarchy the path is empty; falling back to
  // the direct id keeps an exact hit working rather than failing the filter outright.
  const scope =
    filter.includeDescendants !== false && item.locationPath.length > 0
      ? item.locationPath
      : item.locationId === null
        ? []
        : [item.locationId];
  return filter.locationIds.some((id) => scope.includes(id));
}

function matchesQuantity(filter: WebhookFilterQuantity, view: WebhookEventView): boolean {
  const quantity = view.item?.quantity;
  if (quantity == null) return false;
  switch (filter.op) {
    case 'lt':
      return quantity < filter.value;
    case 'lte':
      return quantity <= filter.value;
    case 'gt':
      return quantity > filter.value;
    case 'gte':
      return quantity >= filter.value;
    case 'eq':
      return quantity === filter.value;
    case 'neq':
      return quantity !== filter.value;
  }
}
