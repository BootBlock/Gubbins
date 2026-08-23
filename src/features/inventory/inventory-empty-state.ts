/**
 * Empty-state copy for the inventory list (spec §3). Pure so the "what does the banner say?"
 * decision is testable in isolation and the same for every renderer.
 *
 * The banner has to describe *why* the list is empty from the user's point of view, which
 * depends on how they are currently viewing items:
 *
 * - **Narrowed with no matches** — a search, a status chip, or a category/tag facet is active
 *   but nothing matches. Saying "add your first item" here is misleading (there may be plenty
 *   of items, just none in this view), so the copy names the narrowing and nudges the user to
 *   adjust or clear it.
 * - **A system location** (In Transit / Unassigned) that is genuinely empty — explain how
 *   stock actually arrives there rather than "add an item".
 * - **A truly empty inventory / location** — the original "add your first item" invitation.
 */
import { IN_TRANSIT_LOCATION_ID, UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';

/**
 * What the two system-locked locations *mean* — shown when one of them is selected and holds
 * nothing, since "add your first item here" doesn't describe how stock actually arrives in
 * these liminal places (spec §4).
 */
export const SYSTEM_LOCATION_HINTS: Record<string, string> = {
  [IN_TRANSIT_LOCATION_ID]:
    'In Transit is where incoming stock waits before it arrives. Items appear here automatically when a bill-of-materials line is marked as ordered, then move to their real location once you receive them.',
  [UNASSIGNED_LOCATION_ID]:
    "Unassigned holds items that don't have a location yet. New or imported items without a location land here, along with any item whose location was later deleted — assign one to move it out.",
};

/** How the user is currently viewing the list — everything that could be narrowing it. */
export interface InventoryEmptyContext {
  /** The active free-text search (trimmed upstream or here); empty/undefined = none. */
  readonly search?: string;
  /** Whether the Visual Builder is driving the list (it supersedes the quick filters). */
  readonly visualSearch?: boolean;
  /**
   * Whether that visual search is scoped to the selected location (issue #626). False when no
   * location is selected, and when the tree names `location` itself — the search then spans the
   * whole inventory, so the copy must not claim otherwise.
   */
  readonly visualSearchScoped?: boolean;
  /** How many status ("attention") chips are active. */
  readonly statusFilterCount?: number;
  /** Whether a category facet is active. */
  readonly categoryFilter?: boolean;
  /** How many tag facets are active. */
  readonly tagFilterCount?: number;
  /** The selected location id, or null/undefined for the "All items" view. */
  readonly locationId?: string | null;
  /** The selected location's display name, when one is selected. */
  readonly locationName?: string;
}

/** The banner's heading and supporting line. */
export interface InventoryEmptyCopy {
  readonly title: string;
  readonly body: string;
}

/** Resolve the empty-state copy for the current view. */
export function inventoryEmptyState(ctx: InventoryEmptyContext): InventoryEmptyCopy {
  const search = ctx.search?.trim() ?? '';
  const hasSearch = search.length > 0;
  const filterCount = (ctx.statusFilterCount ?? 0) + (ctx.categoryFilter ? 1 : 0) + (ctx.tagFilterCount ?? 0);
  const hasFilters = filterCount > 0;

  // The Visual Builder supersedes the quick search/filters, so when it is driving the list its
  // message wins and the (inapplicable) quick-filter scope is not mentioned. The *location* is
  // not superseded — it scopes the search (issue #626) — so name it when it applied, or the
  // banner reads "nothing anywhere" for a query that only looked in one room.
  if (ctx.visualSearch) {
    const scoped = ctx.visualSearchScoped && ctx.locationId && ctx.locationName;
    return {
      title: 'No matching items',
      body: scoped
        ? `No items in ${ctx.locationName} match your visual search. Adjust the builder above, pick another location, or clear the search to see everything.`
        : 'No items match your visual search. Adjust the builder above, or clear it to see everything.',
    };
  }

  if (hasSearch || hasFilters) {
    // A narrowed view with no matches — describe the narrowing rather than inviting a "first
    // item", and scope the sentence to the location when one is also selected.
    const scope = ctx.locationId && ctx.locationName ? ` in ${ctx.locationName}` : '';
    let body: string;
    if (hasSearch && hasFilters) {
      body = `No items${scope} match “${search}” and the selected filters. Try adjusting or clearing them to see more.`;
    } else if (hasSearch) {
      body = `No items${scope} match “${search}”. Try a different search, or clear it to see everything.`;
    } else {
      body = `No items${scope} match the selected filters. Try adjusting or clearing them to see more.`;
    }
    return { title: 'No matching items', body };
  }

  // Not narrowing — an empty system location gets its explainer, otherwise the plain
  // "add your first item" invitation (unchanged from the original banner).
  const systemHint = ctx.locationId ? SYSTEM_LOCATION_HINTS[ctx.locationId] : undefined;
  return { title: 'No items here yet', body: systemHint ?? 'Add your first item to start tracking.' };
}
