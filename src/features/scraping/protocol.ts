/**
 * The PWA ⇄ Extension communication protocol (spec §9.1, §9.2, §2.4.4).
 *
 * Both the PWA bridge and the companion extension's content script import these
 * Zod schemas so the wire contract has a single source of truth. Every inbound
 * `window.postMessage` is validated here: origin-verified, signature-checked
 * (`source: 'HARDWARE_TRACKER_EXT'`) and schema-validated. **Invalid messages are
 * silently dropped** (anti-injection, §9.1) — {@link parseExtensionMessage} returns
 * `null` rather than throwing or logging, so a hostile page script learns nothing.
 *
 * Pure and framework-free (Zod only) so it is exhaustively unit-tested against the
 * `:memory:`-style fixtures (§8.2) and safely bundled into the extension.
 */
import { z } from 'zod';

/** Mandatory message signature (§9.2). A message without it is not ours. */
export const EXTENSION_SOURCE = 'HARDWARE_TRACKER_EXT' as const;

/** The four message kinds exchanged across the Content Script Bridge (§9.2). */
export const EXTENSION_MESSAGE_TYPES = [
  'EXTENSION_READY',
  'SCRAPE_REQUEST',
  'SCRAPE_RESULT',
  'SCRAPE_ERROR',
] as const;
export type ExtensionMessageType = (typeof EXTENSION_MESSAGE_TYPES)[number];

/**
 * The strictly-typed payload an extension returns for a successful scrape (§9.2).
 * `scraped_pricing` is nullable — a parser that cannot find a price returns `null`
 * for *that field only* (it must never marshal `NaN`; an unparseable price is a
 * §9.4.2 `DOM_DRIFT` error instead).
 */
export const scrapeResultPayloadSchema = z.object({
  mpn: z.string(),
  manufacturer: z.string(),
  description: z.string(),
  distributor_url: z.string().url(),
  scraped_pricing: z
    .object({
      currency: z.string().min(1),
      value: z.number().finite().nonnegative(),
    })
    .nullable(),
});
export type ScrapeResultPayload = z.infer<typeof scrapeResultPayloadSchema>;

/**
 * The categories of scrape failure the extension marshals back (§9.4.2).
 *
 * The first three are the spec's named examples; the latter three deepen the taxonomy
 * so a *received* HTTP failure is no longer mis-reported as a transport timeout (the
 * pre-Phase-35 behaviour collapsed every non-429 status into `NETWORK_TIMEOUT`). The
 * HTTP-status → type mapping is the pure {@link classifyHttpStatus} in `scrape-errors.ts`:
 * - `DOM_DRIFT` — a parser selector/price failure (the page loaded but no longer matches).
 * - `NETWORK_TIMEOUT` — a transport-level failure: abort/timeout/DNS, **no** HTTP response.
 * - `RATE_LIMITED` — HTTP 429 (back off and retry).
 * - `BLOCKED` — HTTP 401/403/other-4xx (the supplier refused the request: anti-bot, auth).
 * - `NOT_FOUND` — HTTP 404/410 (a dead/wrong product URL — actionable: check the link).
 * - `SERVER_ERROR` — HTTP 5xx (a supplier-side outage — actionable: try again later).
 * - `CHALLENGE` — a **200-OK** anti-bot interstitial (Cloudflare/Incapsula/PerimeterX/
 *   DataDome): the page loaded successfully but its body is a challenge, not the product.
 *   Detected from the fetched body by the pure {@link detectChallengePage} (Phase 36), so
 *   it is reported precisely rather than mis-marshalled as a `DOM_DRIFT` parse failure.
 *
 * Adding a member is a §9 wire change: the extension must be rebuilt (`build:extension`).
 */
export const SCRAPE_ERROR_TYPES = [
  'DOM_DRIFT',
  'NETWORK_TIMEOUT',
  'RATE_LIMITED',
  'BLOCKED',
  'NOT_FOUND',
  'SERVER_ERROR',
  'CHALLENGE',
] as const;
export type ScrapeErrorType = (typeof SCRAPE_ERROR_TYPES)[number];

/** Explicit error marshalling (§9.4.2): the targeted domain + the failure reason. */
export const scrapeErrorPayloadSchema = z.object({
  domain: z.string(),
  error_type: z.enum(SCRAPE_ERROR_TYPES),
  reason: z.string(),
});
export type ScrapeErrorPayload = z.infer<typeof scrapeErrorPayloadSchema>;

/** The PWA→extension request: a supplier URL to scrape (§9.3 request loop). */
export const scrapeRequestPayloadSchema = z.object({
  url: z.string().url(),
});
export type ScrapeRequestPayload = z.infer<typeof scrapeRequestPayloadSchema>;

const sourceLiteral = z.literal(EXTENSION_SOURCE);

/**
 * Correlation id carried by every scrape message (§9 multi-scrape). A `SCRAPE_REQUEST`
 * stamps a fresh id and the extension echoes it back on the matching `SCRAPE_RESULT`/
 * `SCRAPE_ERROR`, so the PWA can run several scrapes concurrently and route each
 * outcome to the request that started it. Non-empty so a blank id can never alias.
 */
const requestIdSchema = z.string().min(1);

/**
 * The `ExtensionMessage<T>` union (§9.2). A discriminated union on `type` keeps the
 * payload strongly typed per kind. `EXTENSION_READY` carries an optional version
 * string and is otherwise payload-free; the three scrape kinds carry a `requestId`.
 */
export const extensionMessageSchema = z.discriminatedUnion('type', [
  z.object({
    source: sourceLiteral,
    type: z.literal('EXTENSION_READY'),
    payload: z.object({ version: z.string() }).partial().optional(),
  }),
  z.object({
    source: sourceLiteral,
    type: z.literal('SCRAPE_REQUEST'),
    requestId: requestIdSchema,
    payload: scrapeRequestPayloadSchema,
  }),
  z.object({
    source: sourceLiteral,
    type: z.literal('SCRAPE_RESULT'),
    requestId: requestIdSchema,
    payload: scrapeResultPayloadSchema,
  }),
  z.object({
    source: sourceLiteral,
    type: z.literal('SCRAPE_ERROR'),
    requestId: requestIdSchema,
    payload: scrapeErrorPayloadSchema,
  }),
]);

export type ExtensionMessage = z.infer<typeof extensionMessageSchema>;
export type ReadyMessage = Extract<ExtensionMessage, { type: 'EXTENSION_READY' }>;
export type ScrapeRequestMessage = Extract<ExtensionMessage, { type: 'SCRAPE_REQUEST' }>;
export type ScrapeResultMessage = Extract<ExtensionMessage, { type: 'SCRAPE_RESULT' }>;
export type ScrapeErrorMessage = Extract<ExtensionMessage, { type: 'SCRAPE_ERROR' }>;

/** Context for validating an inbound message: the event origin + the trusted set. */
export interface MessageOriginContext {
  /** `MessageEvent.origin` of the received message. */
  readonly origin: string;
  /**
   * Origins the PWA trusts. A content script's `postMessage` runs in the *page's*
   * own origin, so this is normally `[window.location.origin]`; tests inject their
   * own. An empty set trusts nothing.
   */
  readonly trustedOrigins: readonly string[];
}

/**
 * The §9.1 Secure Bridge Handshake validator. Returns the typed message only when
 * it (1) arrives from a trusted origin and (2) satisfies the strict union schema —
 * otherwise returns `null` so the caller silently drops it. Never throws; never
 * logs; this is the sole entry point the PWA listener should use.
 */
export function parseExtensionMessage(raw: unknown, context: MessageOriginContext): ExtensionMessage | null {
  // (1) Origin verification (§9.1.1) — drop anything from an untrusted frame.
  if (!context.trustedOrigins.includes(context.origin)) return null;
  // (2) Strict schema validation (§9.1.2) — drop anything malformed.
  const result = extensionMessageSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * The constructor args for a given message kind: `EXTENSION_READY` takes only an
 * optional payload; the three scrape kinds require `(payload, requestId)` so the
 * correlation id can never be forgotten at a call site (the type enforces it).
 */
type MessageArgs<T extends ExtensionMessage['type']> = T extends 'EXTENSION_READY'
  ? [payload?: Extract<ExtensionMessage, { type: 'EXTENSION_READY' }>['payload']]
  : [payload: Extract<ExtensionMessage, { type: T }>['payload'], requestId: string];

/** Build a well-formed envelope for the extension/content script to post. */
export function makeMessage<T extends ExtensionMessage['type']>(
  type: T,
  ...[payload, requestId]: MessageArgs<T>
): Extract<ExtensionMessage, { type: T }> {
  const msg: Record<string, unknown> = { source: EXTENSION_SOURCE, type };
  if (payload !== undefined) msg.payload = payload;
  if (requestId !== undefined) msg.requestId = requestId;
  return msg as Extract<ExtensionMessage, { type: T }>;
}
