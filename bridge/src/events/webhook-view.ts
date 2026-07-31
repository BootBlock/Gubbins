/**
 * The `BridgeEvent` → `WebhookEventView` adapter (webhooks plan `W5`; see
 * `docs/todo/done/webhooks_2026-07-18.md` §7).
 *
 * `W3` shipped the matcher, the filter evaluator and the template engine as pure modules in `src/`,
 * all written against one closed projection — {@link WebhookEventView}. This module is the seam
 * that produces it, and it is the *only* new coupling `W5` adds between the bridge's event model
 * and the app's webhook logic: build the view here, and every `W3` module applies unchanged.
 *
 * ## What has to be resolved, and why it is not already in the event
 *
 * A {@link LedgerEvent} carries an `ItemSummaryDto`, which covers most of the view. Three facts it
 * does **not** carry are needed by the filter vocabulary, and each costs a read:
 *
 *   - **`locationPath`** — the ancestor chain, so a "location subtree" filter is a pure set test in
 *     the evaluator rather than a tree walk (see `event-view.ts`). Resolved by walking `parentId`
 *     through {@link LocationRepository}, memoised per generation.
 *   - **`tagIds`** — a tag filter needs them, and the summary DTO has no tags.
 *   - **`categoryName`** — the summary carries `categoryId` only, and templates offer
 *     `{{item.categoryName}}`.
 *
 * All three go through the app's own repositories — never bespoke SQL — and every one is cached on
 * the {@link WebhookViewContext} for the life of a generation, so a burst of fifty events touching
 * the same location resolves that chain once.
 *
 * ## Absent facts are `null`, never invented
 *
 * An event that is not about an item — `lookup.resolved`, `events.truncated`, or a ledger event
 * whose item was hard-deleted before the read — projects `item: null`. `W3` then has one documented
 * rule for that: a narrowing filter refuses to match what it cannot confirm, and a template
 * placeholder renders empty. Nothing here fabricates a partial item to keep a filter happy.
 *
 * Likewise a read that *fails* degrades to the empty/`null` value rather than throwing: a webhook
 * that does not fire because a tag lookup errored is a worse outcome than one delivered with an
 * empty tag list, and the failure is bounded to the fact that could not be read.
 *
 * Imported by the bridge, so it must survive Node's **strip-only** loader: no `enum`, no
 * `namespace`, no TS parameter properties.
 */
import { CategoryRepository } from '@/db/repositories/CategoryRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { TagRepository } from '@/db/repositories/TagRepository.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { WebhookEventView } from '@/features/webhooks/event-view.ts';
import { isLookupEvent } from './lookup.ts';
import { isLocationEvent, type BridgeEvent, type LedgerEvent } from './model.ts';

/**
 * Per-generation resolution context: the repositories plus the caches.
 *
 * Created once per hydration generation and discarded with it, which is what makes the caches
 * safe — a location's parent or an item's tags can change between generations, and a context that
 * outlived one would happily serve the stale answer.
 */
export interface WebhookViewContext {
  readonly locations: LocationRepository;
  readonly categories: CategoryRepository;
  readonly tags: TagRepository;
  /** locationId → root-first ancestor chain including the location itself. */
  readonly locationPaths: Map<string, readonly string[]>;
  /** categoryId → name (`null` when the category could not be read). */
  readonly categoryNames: Map<string, string | null>;
  /** itemId → its tag ids. */
  readonly itemTagIds: Map<string, readonly string[]>;
}

/** Create a fresh resolution context bound to one generation's driver. */
export function createWebhookViewContext(driver: IDatabaseDriver): WebhookViewContext {
  return {
    locations: new LocationRepository(driver),
    categories: new CategoryRepository(driver),
    tags: new TagRepository(driver),
    locationPaths: new Map(),
    categoryNames: new Map(),
    itemTagIds: new Map(),
  };
}

/**
 * The maximum number of ancestor hops walked when resolving a location path.
 *
 * A location tree is nowhere near this deep, so the bound is not about legitimate data — it is a
 * cycle guard. `parentId` cycles are prevented on write (`LocationRepository` refuses a move that
 * would create one), but this code runs over a **synced snapshot** assembled from several peers,
 * and a defensive bound is cheaper than trusting that invariant held on every device that ever
 * wrote the file. Hitting it yields the partial chain rather than throwing.
 */
const MAX_LOCATION_DEPTH = 64;

/**
 * Resolve a location's ancestor chain, **root-first and including the location itself** — the exact
 * shape `event-view.ts` documents, because the evaluator does a plain `includes` against it.
 *
 * Walks `parentId` upward through the repository and reverses, memoising the whole chain per
 * location id. The walk stops at the first level that cannot be read, so the item's **own**
 * location id is always present even when its ancestry is not: a subtree filter naming that
 * location still matches, while one naming an ancestor we could not confirm does not. Narrowing on
 * an unconfirmable fact is the safe direction, and matches how `W3` treats a missing item.
 *
 * Only a `null` `locationId` yields a genuinely empty chain, which the evaluator treats as "no
 * hierarchy known" and falls back to comparing `locationId` alone.
 */
async function resolveLocationPath(
  context: WebhookViewContext,
  locationId: string | null,
): Promise<readonly string[]> {
  if (locationId === null) return [];
  const cached = context.locationPaths.get(locationId);
  if (cached !== undefined) return cached;

  const chain: string[] = [];
  try {
    let current: string | null = locationId;
    const seen = new Set<string>();
    for (let depth = 0; current !== null && depth < MAX_LOCATION_DEPTH; depth++) {
      if (seen.has(current)) break; // cycle in a synced snapshot — stop rather than loop
      seen.add(current);
      chain.push(current);
      const location = await context.locations.getById(current);
      if (location === undefined) break;
      current = location.parentId ?? null;
    }
  } catch {
    // A failed read leaves whatever chain we already walked; see the module note on degradation.
  }
  const path: readonly string[] = chain.reverse();
  context.locationPaths.set(locationId, path);
  return path;
}

/** Resolve a category's display name, memoised. `null` when absent or unreadable. */
async function resolveCategoryName(
  context: WebhookViewContext,
  categoryId: string | null,
): Promise<string | null> {
  if (categoryId === null) return null;
  const cached = context.categoryNames.get(categoryId);
  if (cached !== undefined) return cached;

  let name: string | null = null;
  try {
    name = (await context.categories.getById(categoryId))?.name ?? null;
  } catch {
    name = null;
  }
  context.categoryNames.set(categoryId, name);
  return name;
}

/**
 * Resolve an item's tag ids, memoised per generation.
 *
 * Cached for the same reason the location path is: the fan-out case is precisely a burst of events
 * about **one** item — a stock-take or a bulk adjustment writes many ledger rows against the same
 * id — and every one of those reads would otherwise repeat inside the awaited window that holds the
 * watcher off the next hydration.
 */
async function resolveTagIds(context: WebhookViewContext, itemId: string): Promise<readonly string[]> {
  const cached = context.itemTagIds.get(itemId);
  if (cached !== undefined) return cached;

  let tagIds: readonly string[] = [];
  try {
    tagIds = (await context.tags.getForItem(itemId)).map((tag) => tag.id);
  } catch {
    tagIds = [];
  }
  context.itemTagIds.set(itemId, tagIds);
  return tagIds;
}

/**
 * Is this an *item* ledger-derived event — as opposed to the read-triggered `lookup.resolved` or a
 * location activity event (issue #691)?
 *
 * Defined by elimination against the two predicates their own modules own, rather than by sniffing
 * `data` here: the ledger arm types its `type` as an open `string`, so the union cannot be
 * discriminated on `type` directly, and each of the other arms already has the one narrowing that
 * is sound for it.
 */
function isLedgerEvent(event: BridgeEvent): event is LedgerEvent {
  return !isLookupEvent(event) && !isLocationEvent(event);
}

/**
 * Project a {@link BridgeEvent} into the closed {@link WebhookEventView} the `W3` modules consume.
 *
 * `context` is optional so a caller with no live driver — the file/env-configured targets path,
 * where nothing needs a DB read — still gets a usable view. Without it the three resolved facts
 * degrade to their absent values (`locationPath: []`, `tagIds: []`, `categoryName: null`), which
 * means a *subtree* filter narrows to a direct location match and a *tag* filter matches nothing.
 * That is the safe direction, and it is why the DB-sourced path always passes a context.
 */
export async function buildWebhookEventView(
  event: BridgeEvent,
  context?: WebhookViewContext,
): Promise<WebhookEventView> {
  const envelope = {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
  };

  if (!isLedgerEvent(event)) {
    // A lookup event concerns a *query*, and a location activity event concerns a *place*. Neither
    // is about one item, and the view has deliberately no shape for either: `W3` treats "no item"
    // as unconfirmable rather than pretending the first match is "the" item, which would let an
    // item-scoped filter match on a coincidence. So an item-narrowing filter does not match one of
    // these, and an `{{item.*}}` template placeholder renders empty — while `{{event.type}}` and
    // the delivered payload still carry everything the event actually says.
    return { ...envelope, item: null, change: null };
  }

  const { data } = event;
  const change = {
    action: data.action,
    kind: data.kind,
    label: data.label,
    detail: data.detail,
    delta: data.delta,
    quantityDelta: data.quantityDelta,
    netValueDelta: data.netValueDelta,
  };

  const summary = data.item;
  if (summary === null) {
    // A ledger event whose item could not be read (hard-deleted between generations) or the
    // synthetic truncation event. The change is real and still worth delivering; the item is not.
    return { ...envelope, item: null, change };
  }

  const locationId = summary.locationId;
  const categoryId = summary.categoryId;
  return {
    ...envelope,
    item: {
      id: summary.id,
      name: summary.name,
      quantity: summary.quantity,
      locationId,
      locationName: summary.locationName,
      locationPath: context ? await resolveLocationPath(context, locationId) : [],
      categoryId,
      categoryName: context ? await resolveCategoryName(context, categoryId) : null,
      tagIds: context ? await resolveTagIds(context, summary.id) : [],
    },
    change,
  };
}
