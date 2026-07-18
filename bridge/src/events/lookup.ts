/**
 * Lookup events (A2) — `lookup.resolved`, the one **read-triggered** event class.
 *
 * Every other bridge event derives from a new row in the immutable `item_history` ledger: an
 * inventory *change* happened, and the event describes it. This one is different by design — it
 * fires when somebody **asks where something is** (`GET /where`, `GET /api/v1/where`, the voice
 * intent behind them). Nothing was written; the event exists so an automation can react to the
 * *question*: light the shelf the answer names, wake a display, log the request.
 *
 * That difference has three consequences, all handled here:
 *
 *   1. **Its own opt-in flag, off by default** (`GUBBINS_BRIDGE_LOOKUP_EVENTS`). A lookup event
 *      publishes *what someone searched for*, which is a privacy step beyond publishing inventory
 *      state — so it is never implied by `GUBBINS_BRIDGE_EVENTS` and must be chosen explicitly.
 *   2. **A different deterministic `id` derivation.** The published contract is "the id is
 *      deterministic so every sink can dedupe"; ledger events satisfy it by using the ledger row's
 *      id. There is no ledger row here, so the id is derived from the *resolved answer* plus the
 *      debounce window — see {@link lookupEventId}.
 *   3. **A debounce.** A voice assistant retries and a user rephrases; the same question resolving
 *      three times must not fire an automation three times. See {@link createLookupObserver}.
 *
 * The shaping ({@link buildLookupEvent}, {@link lookupEventId}) is **pure** — no clock, no I/O —
 * so it unit-tests directly; the observer holds the only state (a bounded debounce map) and takes
 * an injectable clock.
 */
import { createHash } from 'node:crypto';
import type { WhereIsResult } from '../query.ts';
import type { BridgeEventBase } from './model.ts';

/** The stable dotted type of the read-triggered lookup event. */
export const LOOKUP_RESOLVED_TYPE = 'lookup.resolved';

/** Default debounce window (ms): repeated equivalent lookups inside it emit once. */
export const DEFAULT_LOOKUP_DEBOUNCE_MS = 3000;
/**
 * Upper clamp on the debounce window (10 minutes). A window longer than this stops being a
 * retry guard and starts silently swallowing genuine repeat questions.
 */
export const MAX_LOOKUP_DEBOUNCE_MS = 600_000;
/**
 * Soft cap on remembered debounce keys. Past it, expired entries are dropped (they can no longer
 * suppress anything, so forgetting them changes no decision); if that is not enough, the oldest
 * are evicted. This is what keeps the state bounded under a spray of distinct queries.
 */
export const DEFAULT_LOOKUP_DEBOUNCE_KEYS = 500;

/** One location an answer resolved to — the id is what an automation actually acts on. */
export interface LookupPlacement {
  readonly locationId: string;
  readonly locationName: string;
  readonly quantity: number;
}

/** One matched item within a resolved lookup. */
export interface LookupMatch {
  readonly itemId: string;
  readonly itemName: string;
  readonly placements: readonly LookupPlacement[];
}

/**
 * The payload of a `lookup.resolved` event. `itemIds` / `locationIds` are the **flattened,
 * de-duplicated unions** across every match — an automation triggers on those (and downstream
 * consumers read them cheaply) without walking `matches`.
 */
export interface LookupEventData {
  /** The query as asked (trimmed), verbatim — not the normalised form used for the id. */
  readonly query: string;
  /** Every matched item id, in match order, de-duplicated. */
  readonly itemIds: readonly string[];
  /** Every resolved location id across all matches, in encounter order, de-duplicated. */
  readonly locationIds: readonly string[];
  readonly matches: readonly LookupMatch[];
}

/** A read-triggered lookup event. Shares the `{ id, type, occurredAt, data }` envelope. */
export interface LookupEvent extends BridgeEventBase<LookupEventData> {
  readonly type: typeof LOOKUP_RESOLVED_TYPE;
}

/**
 * The **id derivation** for a lookup event (documented in `bridge/README.md` too, because it
 * departs from the ledger-derived contract):
 *
 * ```
 * lookup:<first 16 hex chars of sha256(normalisedQuery + '|' + itemIds + '|' + locationIds)>:<windowStart>
 * ```
 *
 * where `normalisedQuery` is the query trimmed, whitespace-collapsed and lower-cased; the two id
 * lists are comma-joined in payload order; and `windowStart` is the epoch-millisecond start of the
 * debounce window this event opened.
 *
 * The properties that matter to a sink: it is a pure function of the resolved answer and the
 * window, so the *same* question resolving the *same* way inside one window always yields the
 * *same* id — which is exactly what makes it dedupe-friendly, and is also the suppression key the
 * debounce uses (identical id ⇒ suppressed, never delivered twice).
 */
export function lookupEventId(
  query: string,
  itemIds: readonly string[],
  locationIds: readonly string[],
  windowStartMs: number,
): string {
  return `lookup:${lookupDigest(query, itemIds, locationIds)}:${windowStartMs}`;
}

/** The stable content digest of a resolved lookup (the id's window-independent half). */
export function lookupDigest(
  query: string,
  itemIds: readonly string[],
  locationIds: readonly string[],
): string {
  const payload = `${normaliseQuery(query)}|${itemIds.join(',')}|${locationIds.join(',')}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

/** Trim, collapse internal whitespace and lower-case — so "  M3   Screws " ≡ "m3 screws". */
export function normaliseQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Shape a resolved `whereIs` answer into its event. **Pure**: the caller supplies both the window
 * start (which seeds the id) and the occurrence instant, so this is fully deterministic.
 */
export function buildLookupEvent(
  result: WhereIsResult,
  windowStartMs: number,
  occurredAtMs: number,
): LookupEvent {
  const matches: LookupMatch[] = result.matches.map((match) => ({
    itemId: match.id,
    itemName: match.name,
    placements: match.placements.map((placement) => ({
      locationId: placement.locationId,
      locationName: placement.locationName,
      quantity: placement.quantity,
    })),
  }));

  const itemIds = dedupe(matches.map((m) => m.itemId));
  const locationIds = dedupe(matches.flatMap((m) => m.placements.map((p) => p.locationId)));

  return {
    id: lookupEventId(result.query, itemIds, locationIds, windowStartMs),
    type: LOOKUP_RESOLVED_TYPE,
    occurredAt: new Date(occurredAtMs).toISOString(),
    data: { query: result.query, itemIds, locationIds, matches },
  };
}

/**
 * The seam `query.ts` calls when a lookup resolves. Structural on purpose: the query core knows
 * only this one-method shape, never the event model or any sink, so it stays free of I/O.
 */
export interface LookupObserver {
  onLookupResolved(result: WhereIsResult): void;
}

export interface LookupObserverOptions {
  /** Where a (non-suppressed) event goes. Must not throw; failures are the sink's problem. */
  readonly deliver: (event: LookupEvent) => void;
  /** Debounce window in ms; clamped to `[0, {@link MAX_LOOKUP_DEBOUNCE_MS}]`. `0` disables it. */
  readonly debounceMs?: number;
  /** Injectable clock (ms) so the debounce and the id are deterministic in tests. */
  readonly now?: () => number;
  /** Soft cap on remembered debounce keys (default {@link DEFAULT_LOOKUP_DEBOUNCE_KEYS}). */
  readonly maxKeys?: number;
  /** Optional error reporter (defaults to `console.error`) for a throwing sink. */
  readonly onError?: (error: Error) => void;
}

/**
 * Create the stateful lookup observer: shape → debounce → deliver.
 *
 * The debounce is keyed on the same content digest the id is built from, so "equivalent lookup"
 * means exactly "would produce the same id": the same normalised query resolving to the same items
 * in the same locations. A repeat inside the window is dropped silently; the window is anchored at
 * the emission that opened it, so a stream of retries can never keep re-arming it. A genuinely
 * different question — different wording that normalises differently, or the same wording now
 * resolving elsewhere — has a different digest and emits immediately.
 *
 * Defensive like the event pipeline: a throwing sink is reported and swallowed, because answering
 * "where is X?" must never fail because an automation hook did.
 */
export function createLookupObserver(options: LookupObserverOptions): LookupObserver {
  const debounceMs = Math.min(
    MAX_LOOKUP_DEBOUNCE_MS,
    Math.max(0, options.debounceMs ?? DEFAULT_LOOKUP_DEBOUNCE_MS),
  );
  const now = options.now ?? Date.now;
  const maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_LOOKUP_DEBOUNCE_KEYS);

  /** digest → the epoch-ms start of the window that digest's last emission opened. */
  const windows = new Map<string, number>();

  function suppressed(digest: string, at: number): boolean {
    if (debounceMs === 0) return false;
    const openedAt = windows.get(digest);
    return openedAt !== undefined && at - openedAt < debounceMs;
  }

  /** Drop windows that have already closed; if still over the cap, evict oldest-first. */
  function prune(at: number): void {
    if (windows.size < maxKeys) return;
    for (const [digest, openedAt] of windows) {
      if (at - openedAt >= debounceMs) windows.delete(digest);
    }
    // Insertion order is emission order, so the head is the oldest still-open window.
    while (windows.size >= maxKeys) {
      const oldest = windows.keys().next();
      if (oldest.done === true) break;
      windows.delete(oldest.value);
    }
  }

  return {
    onLookupResolved(result: WhereIsResult): void {
      try {
        const at = now();
        // Shape first: the digest is a function of the *resolved answer*, not just the query, so
        // the same words resolving somewhere new are not mistaken for a retry.
        const event = buildLookupEvent(result, at, at);
        const digest = lookupDigest(event.data.query, event.data.itemIds, event.data.locationIds);
        if (suppressed(digest, at)) return;
        prune(at);
        windows.set(digest, at);
        options.deliver(event);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (options.onError) options.onError(error);
        else console.error(`Lookup event error: ${error.message}`);
      }
    },
  };
}

/** Preserve first-encounter order while removing duplicates. */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
