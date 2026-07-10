/**
 * Pure wishlist seam (feature-gap G8 — manual "to-buy" / wishlist).
 *
 * A manual list of **wanted-but-not-owned** things to buy — distinct from the
 * *stock-driven* reorder / shopping list (`reorder-plan.ts`), which is derived from items
 * that have fallen below their reorder point. A wishlist entry is free-standing: a name plus
 * an optional note, link, target price and priority. It is *not* an item and references no
 * item — it is the "I'd like one of these one day" list an inventory app otherwise has no home
 * for.
 *
 * This module owns the entry vocabulary and *all* of the non-trivial logic — priority
 * normalisation + ordering, link sanitisation, the write-validation choke-point, the display
 * sort and the summary aggregation — and nothing else: no React, no repository, no SQL, no DOM.
 * That keeps it exhaustively unit-testable in isolation, the same "logic out of glue" seam as
 * `reorder-plan.ts` / `item-relations.ts` / `valuation.ts`.
 */

/**
 * The priority vocabulary (SSOT), most-urgent first — the order is also the display sort rank.
 * Stored verbatim in `wishlist.priority` (free TEXT, no DB CHECK — app-enforced by
 * {@link normaliseWishlistPriority}, exactly like `item_relations.kind`), so a future priority
 * added by a newer peer syncs forward without a schema change or a rejected INSERT.
 */
export const WISHLIST_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW', 'NONE'] as const;

export type WishlistPriority = (typeof WISHLIST_PRIORITIES)[number];

/** The priority a new entry takes when none is chosen. */
export const DEFAULT_WISHLIST_PRIORITY: WishlistPriority = 'NONE';

/** Human labels for each priority (the `NONE` sentinel reads as "No priority"). */
export const WISHLIST_PRIORITY_LABELS: Record<WishlistPriority, string> = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  NONE: 'No priority',
};

/** Display sort rank for each priority (derived from {@link WISHLIST_PRIORITIES} order). */
export const WISHLIST_PRIORITY_RANK: Record<WishlistPriority, number> = WISHLIST_PRIORITIES.reduce(
  (acc, priority, index) => {
    acc[priority] = index;
    return acc;
  },
  {} as Record<WishlistPriority, number>,
);

/** Options for the priority `Select`, in urgency order. */
export const WISHLIST_PRIORITY_OPTIONS: readonly {
  readonly value: WishlistPriority;
  readonly label: string;
}[] = WISHLIST_PRIORITIES.map((priority) => ({ value: priority, label: WISHLIST_PRIORITY_LABELS[priority] }));

/** Type guard: is `value` one of the known priorities? */
export function isWishlistPriority(value: unknown): value is WishlistPriority {
  return typeof value === 'string' && (WISHLIST_PRIORITIES as readonly string[]).includes(value);
}

/**
 * Coerce arbitrary text to a known {@link WishlistPriority}, falling back to
 * {@link DEFAULT_WISHLIST_PRIORITY}. Trims + upper-cases so casing/whitespace from an import or a
 * stale peer row is forgiving; anything unrecognised (or absent) becomes `NONE` rather than
 * throwing — a priority is a soft hint, never a reason to reject a write.
 */
export function normaliseWishlistPriority(raw: string | null | undefined): WishlistPriority {
  if (raw == null) return DEFAULT_WISHLIST_PRIORITY;
  const key = raw.trim().toUpperCase();
  return isWishlistPriority(key) ? key : DEFAULT_WISHLIST_PRIORITY;
}

/** Trim a name to its canonical form, or `null` when it is blank. */
export function normaliseWishlistName(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/** Trim an optional free-text field (note) to its canonical form, or `null` when blank. */
export function normaliseWishlistNote(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Sanitise a user-supplied link to a safe absolute `http(s)` URL, or `null`.
 *
 * A blank value is `null` (no link). A value with no scheme is treated as a bare host/path and
 * defaulted to `https://`. Anything that parses to a non-`http(s)` scheme — `javascript:`,
 * `data:`, `file:`, … — is **rejected** (returns `undefined`), because the link is later rendered
 * as an anchor the user can click, so a `javascript:` URL would be an XSS vector. The three
 * outcomes are distinct so the caller can tell "no link" (`null`) from "bad link" (`undefined`).
 *
 * A scheme-less `host:port` (e.g. `localhost:3000`) is ambiguous with a real scheme
 * (`javascript:…`) and so is rejected — the user should paste the full `http(s)://` URL. We do
 * **not** retry a scheme-like string with an `https://` prefix, because that would smuggle
 * `javascript:…` through as `https://javascript:…` (host `javascript`) and defeat the XSS guard.
 */
export function sanitiseWishlistUrl(raw: string | null | undefined): string | null | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  // Add a default scheme when the user typed a bare host ("example.test/thing"). A leading
  // scheme-like prefix ("javascript:…") is left intact so it is caught + rejected below.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined; // unparseable → bad link
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined; // non-web scheme → bad link
  return parsed.href;
}

/**
 * Normalise an optional target price to a non-negative number, `null` (no target) or `undefined`
 * (a value was supplied but is not a valid price — negative or non-finite). Distinguishing the
 * last two lets {@link planWishlistEntry} surface a helpful error instead of silently dropping a
 * fat-fingered figure.
 */
export function normaliseTargetPrice(raw: number | null | undefined): number | null | undefined {
  if (raw == null) return null;
  if (!Number.isFinite(raw) || raw < 0) return undefined; // supplied but invalid
  return raw;
}

/** A validated, ready-to-persist wishlist entry (the shape a create/update writes). */
export interface NormalisedWishlistEntry {
  readonly name: string;
  readonly note: string | null;
  readonly url: string | null;
  readonly targetPrice: number | null;
  readonly priority: WishlistPriority;
}

/** Raw create input, before validation/normalisation. */
export interface WishlistEntryDraft {
  readonly name: string;
  readonly note?: string | null;
  readonly url?: string | null;
  readonly targetPrice?: number | null;
  readonly priority?: string | null;
}

/** Why a proposed wishlist entry was rejected (see {@link planWishlistEntry}). */
export type WishlistPlanError = 'EMPTY_NAME' | 'INVALID_URL' | 'INVALID_PRICE';

export type WishlistPlan =
  | { readonly ok: true; readonly entry: NormalisedWishlistEntry }
  | { readonly ok: false; readonly reason: WishlistPlanError };

/**
 * Validate + normalise a proposed wishlist entry — the single choke-point every create goes
 * through, so the invariants live in one tested place. A blank name is rejected; a supplied but
 * un-parseable/non-web link or a negative/non-finite price is rejected with a specific reason; an
 * unknown priority softens to `NONE`. On success the returned {@link NormalisedWishlistEntry} is
 * trimmed and safe to persist verbatim.
 */
export function planWishlistEntry(draft: WishlistEntryDraft): WishlistPlan {
  const name = normaliseWishlistName(draft.name);
  if (name === null) return { ok: false, reason: 'EMPTY_NAME' };

  const url = sanitiseWishlistUrl(draft.url);
  if (url === undefined) return { ok: false, reason: 'INVALID_URL' };

  const targetPrice = normaliseTargetPrice(draft.targetPrice);
  if (targetPrice === undefined) return { ok: false, reason: 'INVALID_PRICE' };

  return {
    ok: true,
    entry: {
      name,
      note: normaliseWishlistNote(draft.note),
      url,
      targetPrice,
      priority: normaliseWishlistPriority(draft.priority),
    },
  };
}

/** The minimal shape {@link sortWishlist} orders by (a superset of a stored row). */
export interface SortableWishlistEntry {
  readonly id: string;
  readonly name: string;
  readonly priority: WishlistPriority;
  readonly createdAt: number;
}

/**
 * Deterministically order a wishlist for display: by priority (High → None), then name
 * (case-insensitive), then oldest-first, then id as a final tie-break so the order is total and
 * stable across devices. Pure + total, so the repository's SQL ordering and the UI agree and can
 * be asserted equivalent.
 */
export function sortWishlist<T extends SortableWishlistEntry>(entries: readonly T[]): T[] {
  return [...entries].sort(
    (a, b) =>
      WISHLIST_PRIORITY_RANK[a.priority] - WISHLIST_PRIORITY_RANK[b.priority] ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' }) ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id),
  );
}

/** A summary of a wishlist for the tab header. */
export interface WishlistSummary {
  /** Total number of entries. */
  readonly count: number;
  /** Sum of every entry's target price (entries with no target contribute nothing). */
  readonly totalTargetPrice: number;
  /** How many entries carry a target price (so the UI can caveat the total). */
  readonly pricedCount: number;
  /** Count of entries per priority. */
  readonly byPriority: Record<WishlistPriority, number>;
}

/** Aggregate a wishlist into its {@link WishlistSummary} — count, estimated spend, priority mix. */
export function summariseWishlist(
  entries: readonly { readonly priority: WishlistPriority; readonly targetPrice: number | null }[],
): WishlistSummary {
  const byPriority = WISHLIST_PRIORITIES.reduce(
    (acc, priority) => {
      acc[priority] = 0;
      return acc;
    },
    {} as Record<WishlistPriority, number>,
  );

  let totalTargetPrice = 0;
  let pricedCount = 0;
  for (const entry of entries) {
    byPriority[entry.priority] += 1;
    if (entry.targetPrice != null) {
      totalTargetPrice += entry.targetPrice;
      pricedCount += 1;
    }
  }

  return { count: entries.length, totalTargetPrice, pricedCount, byPriority };
}
