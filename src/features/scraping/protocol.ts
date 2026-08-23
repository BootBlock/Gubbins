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
// A relative path, not the `@/` alias: this module is bundled into the extension too, whose
// build runs Vite with no alias config (see the sibling parsers, which import `lib/` the same way).
import { compareVersions } from '../../lib/version-compare';

/** Mandatory message signature (§9.2). A message without it is not ours. */
export const EXTENSION_SOURCE = 'HARDWARE_TRACKER_EXT' as const;

/**
 * The message kinds exchanged across the Content Script Bridge (§9.2). The `SCRAPE_*`
 * trio is the original supplier-URL scrape; the `PRODUCT_LOOKUP_*` trio is the keyless
 * barcode → product-database enrichment (recommendation point 2), which shares the same
 * secure bridge, correlation-id and error taxonomy but is keyed by a GTIN rather than a URL.
 *
 * The `ACTIVE_TAB_*` pair is the **Amazon active-tab enrichment** (Path A2): unlike a
 * scrape, it is *not* requested by the PWA — the user triggers it from the browser chrome
 * (toolbar button / "Add to Gubbins" context menu) while on their live Amazon tab, so it
 * arrives at the PWA **unsolicited**. It carries the same strict {@link scrapeResultPayloadSchema}
 * a scrape does (the §9 parser is reused verbatim), with an *extension-generated* `requestId`
 * so the PWA can dedupe re-delivery. There is no `ACTIVE_TAB_REQUEST`: the request originates
 * outside the page, in the extension, on an explicit user gesture.
 *
 * `APP_READY` is the PWA's mirror of `EXTENSION_READY` (issue #664): the app announces the wire
 * generation *it* speaks, so the extension can tell an app that would understand a payload from
 * one that would drop it in silence, and hold the payload back instead of losing it.
 *
 * The `DATA_FETCH_*` trio is the **category data lookup** (issue #616): the extension fetches an
 * open database's JSON on the PWA's behalf, returning the **raw body** for the PWA's own pure
 * provider parser to read. Deliberately *not* a `PRODUCT_LOOKUP`-shaped message that names a
 * provider and a search term: the URL builders and parsers live in the PWA's provider registry,
 * so adding a provider must not require shipping a new extension build — and duplicating them
 * into the extension would guarantee the two drifted. It carries a page-supplied URL exactly as
 * `SCRAPE_REQUEST` does, and is gated by the same kind of allow-list check in the privileged
 * worker (`isAllowedDataLookupUrl`), which is what keeps it from being a general fetch proxy.
 */
export const EXTENSION_MESSAGE_TYPES = [
  'EXTENSION_READY',
  'APP_READY',
  'SCRAPE_REQUEST',
  'SCRAPE_RESULT',
  'SCRAPE_ERROR',
  'PRODUCT_LOOKUP_REQUEST',
  'PRODUCT_LOOKUP_RESULT',
  'PRODUCT_LOOKUP_ERROR',
  'ACTIVE_TAB_RESULT',
  'ACTIVE_TAB_ERROR',
  'DATA_FETCH_REQUEST',
  'DATA_FETCH_RESULT',
  'DATA_FETCH_ERROR',
] as const;
export type ExtensionMessageType = (typeof EXTENSION_MESSAGE_TYPES)[number];

/**
 * The wire generation **this build** speaks (issue #664).
 *
 * The PWA and the companion extension are updated independently — the app refreshes itself from
 * its own host through the service worker, while the extension is a `Load unpacked` build that
 * only changes when the user rebuilds it and reloads it in `chrome://extensions`. So the two are
 * routinely a generation apart, and §9.1 has the receiving side drop an unknown message in
 * silence (anti-injection), which makes drift indistinguishable from a hostile page: a control
 * spins, or a click does nothing, and neither side can say why.
 *
 * A single integer fixes that. Each peer announces the generation it speaks in its own hello
 * ({@link extensionMessageSchema}'s `EXTENSION_READY` / `APP_READY`), and each capability is
 * gated on the peer's number rather than on "a peer exists" — see {@link peerSupports}.
 *
 * **Bump this whenever a message kind is added**, and add the capability it belongs to in
 * {@link PROTOCOL_CAPABILITY_VERSIONS}. The generations so far:
 *
 * | Gen | Added |
 * | --- | --- |
 * | 1 | the original `SCRAPE_*` trio |
 * | 2 | `PRODUCT_LOOKUP_*` (keyless barcode lookup) |
 * | 3 | `ACTIVE_TAB_*` (Amazon active-tab enrichment, Path A2) |
 * | 4 | `DATA_FETCH_*` (category data lookup, issue #616) |
 * | 5 | version negotiation itself — `protocol` on the hello, plus `APP_READY` |
 */
export const PROTOCOL_VERSION = 5;

/**
 * The generation each bridge capability arrived in — the table {@link peerSupports} reads.
 *
 * A capability is a *group* of message kinds that stand or fall together (a request and its two
 * replies), because a peer that cannot answer the request is no more use than one that cannot
 * receive it.
 */
export const PROTOCOL_CAPABILITY_VERSIONS = {
  /** `SCRAPE_REQUEST` → `SCRAPE_RESULT` / `SCRAPE_ERROR`. */
  scrape: 1,
  /** `PRODUCT_LOOKUP_REQUEST` → `PRODUCT_LOOKUP_RESULT` / `PRODUCT_LOOKUP_ERROR`. */
  productLookup: 2,
  /** `ACTIVE_TAB_RESULT` / `ACTIVE_TAB_ERROR`, pushed by the extension unsolicited. */
  activeTab: 3,
  /** `DATA_FETCH_REQUEST` → `DATA_FETCH_RESULT` / `DATA_FETCH_ERROR`. */
  dataFetch: 4,
} as const;
export type ProtocolCapability = keyof typeof PROTOCOL_CAPABILITY_VERSIONS;

/**
 * Which generation each **pre-negotiation** extension build actually spoke, newest first.
 *
 * Those builds announce a `version` but no `protocol`, so the generation has to be recovered from
 * the version string — and it can be, exactly: the message set grew in step with the extension's
 * own version, so the mapping is a record of what shipped rather than a guess. Crediting them all
 * with the newest set instead would hand a 1.2.0 install three capabilities it has never had,
 * which is the silent-drop failure this whole mechanism exists to remove, aimed at the users most
 * likely to hit it — a `Load unpacked` build is exactly the kind that sits un-rebuilt for a year.
 *
 * Nothing needs adding here again: every build from 1.7.0 on states its generation outright.
 */
const LEGACY_BUILD_PROTOCOL: readonly (readonly [from: string, protocol: number])[] = [
  ['1.4.0', 4], // DATA_FETCH_* — category data lookup (issue #616)
  ['1.3.0', 3], // ACTIVE_TAB_* — Amazon active-tab enrichment (Path A2)
  ['1.2.0', 2], // PRODUCT_LOOKUP_* — keyless barcode lookup
  ['1.0.0', 1], // the original SCRAPE_* trio
];

/**
 * The generation a hello announces.
 *
 * A hello is the one message whose payload is optional in both directions, so "said nothing" has
 * to resolve to something definite. The order of preference is: the number the peer stated; the
 * generation its build version is known to have spoken ({@link LEGACY_BUILD_PROTOCOL}); and
 * failing both, generation 1 — the least a peer can be and still be worth talking to. Guessing
 * higher would hand it requests it cannot answer, and every one of those is dropped in silence.
 *
 * A version string that is not dotted-numeric orders below every entry in the table, so it lands
 * on generation 1 without needing a case of its own.
 */
export function peerProtocolVersion(
  payload: { readonly protocol?: number; readonly version?: string } | undefined,
): number {
  if (payload?.protocol !== undefined) return payload.protocol;
  const version = payload?.version ?? '';
  for (const [from, protocol] of LEGACY_BUILD_PROTOCOL) {
    if (compareVersions(version, from) >= 0) return protocol;
  }
  return 1;
}

/**
 * Does a peer speaking `peerVersion` understand `capability`? `null` — no peer has announced
 * itself yet — supports nothing, which is the answer a control needs before one arrives.
 */
export function peerSupports(peerVersion: number | null, capability: ProtocolCapability): boolean {
  if (peerVersion === null) return false;
  return peerVersion >= PROTOCOL_CAPABILITY_VERSIONS[capability];
}

/**
 * Is this peer a generation behind the build it is talking to?
 *
 * Not an error — a peer one generation back keeps every capability it already had, and the app
 * simply offers it nothing newer. It is worth saying out loud all the same, because the silence
 * is otherwise total: this is what turns "the button does nothing" into "your extension is old".
 */
export function isPeerBehind(peerVersion: number | null): boolean {
  return peerVersion !== null && peerVersion < PROTOCOL_VERSION;
}

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
 * - `UNSUPPORTED_SITE` — **our own** allow-list refused the target, so nothing was ever
 *   requested (issue #667). Previously folded into `BLOCKED`, which told the user the
 *   supplier had refused them and to retry after opening the page in a tab — untrue, and
 *   unachievable: no number of tabs makes an unregistered site fetchable. It is the one
 *   failure with no remote cause at all, so it earns its own member rather than borrowing
 *   the wording of a real HTTP 403.
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
  'UNSUPPORTED_SITE',
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

/**
 * The PWA→extension request for a keyless product lookup (recommendation point 2): a
 * retail barcode (GTIN) the extension resolves against an open product database. The
 * GTIN is a bare digit string; the extension re-validates and refuses anything else.
 */
export const productLookupRequestPayloadSchema = z.object({
  gtin: z.string().min(1),
});
export type ProductLookupRequestPayload = z.infer<typeof productLookupRequestPayloadSchema>;

/**
 * The strictly-typed payload the extension returns for a resolved product (point 2).
 * Only `name` is guaranteed; `brand`/`description`/`quantity` are nullable because the
 * open database may not carry them. A barcode the database does not know is a
 * `PRODUCT_LOOKUP_ERROR` with `NOT_FOUND`, never an empty result.
 */
export const productLookupResultPayloadSchema = z.object({
  gtin: z.string().min(1),
  name: z.string().min(1),
  brand: z.string().nullable(),
  description: z.string().nullable(),
  quantity: z.string().nullable(),
});
export type ProductLookupResultPayload = z.infer<typeof productLookupResultPayloadSchema>;

/**
 * The PWA→extension request for a **category data lookup** fetch (issue #616): the absolute URL
 * of an open database endpoint, built by the PWA's own provider descriptor. The extension
 * re-validates it against its data-lookup host allow-list and refuses anything else, so this is
 * a request to fetch *one of a known set of hosts*, never an arbitrary origin.
 */
export const dataFetchRequestPayloadSchema = z.object({
  url: z.string().url(),
});
export type DataFetchRequestPayload = z.infer<typeof dataFetchRequestPayloadSchema>;

/**
 * The raw body the extension fetched, echoed with the URL it came from.
 *
 * Deliberately **unparsed**: the provider that built the URL is the only thing that knows how to
 * read the answer, and it lives in the PWA. The URL is echoed so the PWA can confirm the reply
 * belongs to the request it made, on top of the correlation id.
 */
export const dataFetchResultPayloadSchema = z.object({
  url: z.string().url(),
  body: z.string(),
});
export type DataFetchResultPayload = z.infer<typeof dataFetchResultPayloadSchema>;

const sourceLiteral = z.literal(EXTENSION_SOURCE);

/**
 * Correlation id carried by every scrape message (§9 multi-scrape). A `SCRAPE_REQUEST`
 * stamps a fresh id and the extension echoes it back on the matching `SCRAPE_RESULT`/
 * `SCRAPE_ERROR`, so the PWA can run several scrapes concurrently and route each
 * outcome to the request that started it. Non-empty so a blank id can never alias.
 */
const requestIdSchema = z.string().min(1);

/**
 * The payload both hellos carry: the peer's own build version (for diagnostics) and the wire
 * generation it speaks (for capability gating — see {@link PROTOCOL_VERSION}).
 *
 * Every field stays optional, and the payload itself stays optional, so a hello from a peer that
 * predates negotiation still validates rather than being dropped as malformed — which would turn
 * an out-of-date peer into an invisible one, the exact failure this is here to remove. A missing
 * `protocol` is recovered from the build `version` by {@link peerProtocolVersion}.
 */
const helloPayloadSchema = z
  .object({ version: z.string(), protocol: z.number().int().positive() })
  .partial()
  .optional();

/** The payload of either hello — `EXTENSION_READY` or `APP_READY`. */
export type HelloPayload = z.infer<typeof helloPayloadSchema>;

/**
 * The `ExtensionMessage<T>` union (§9.2). A discriminated union on `type` keeps the
 * payload strongly typed per kind. The two hellos (`EXTENSION_READY` from the extension,
 * `APP_READY` from the PWA) carry an optional version/generation payload; the correlated
 * request kinds carry a `requestId`.
 */
export const extensionMessageSchema = z.discriminatedUnion('type', [
  z.object({
    source: sourceLiteral,
    type: z.literal('EXTENSION_READY'),
    payload: helloPayloadSchema,
  }),
  z.object({
    source: sourceLiteral,
    type: z.literal('APP_READY'),
    payload: helloPayloadSchema,
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
  z.object({
    source: sourceLiteral,
    type: z.literal('PRODUCT_LOOKUP_REQUEST'),
    requestId: requestIdSchema,
    payload: productLookupRequestPayloadSchema,
  }),
  z.object({
    source: sourceLiteral,
    type: z.literal('PRODUCT_LOOKUP_RESULT'),
    requestId: requestIdSchema,
    payload: productLookupResultPayloadSchema,
  }),
  z.object({
    source: sourceLiteral,
    type: z.literal('PRODUCT_LOOKUP_ERROR'),
    requestId: requestIdSchema,
    // Reuses the §9.4.2 error taxonomy — NOT_FOUND covers "no product for this barcode".
    payload: scrapeErrorPayloadSchema,
  }),
  z.object({
    source: sourceLiteral,
    type: z.literal('ACTIVE_TAB_RESULT'),
    // Extension-generated correlation id (the PWA never sent a request) — lets the PWA
    // dedupe a re-delivered payload when several PWA tabs are open.
    requestId: requestIdSchema,
    payload: scrapeResultPayloadSchema,
  }),
  z.object({
    source: sourceLiteral,
    type: z.literal('ACTIVE_TAB_ERROR'),
    requestId: requestIdSchema,
    payload: scrapeErrorPayloadSchema,
  }),
  z.object({
    source: sourceLiteral,
    type: z.literal('DATA_FETCH_REQUEST'),
    requestId: requestIdSchema,
    payload: dataFetchRequestPayloadSchema,
  }),
  z.object({
    source: sourceLiteral,
    type: z.literal('DATA_FETCH_RESULT'),
    requestId: requestIdSchema,
    payload: dataFetchResultPayloadSchema,
  }),
  z.object({
    source: sourceLiteral,
    type: z.literal('DATA_FETCH_ERROR'),
    requestId: requestIdSchema,
    // Reuses the §9.4.2 error taxonomy — BLOCKED covers "not an allowed data-lookup host".
    payload: scrapeErrorPayloadSchema,
  }),
]);

export type ExtensionMessage = z.infer<typeof extensionMessageSchema>;
export type ScrapeRequestMessage = Extract<ExtensionMessage, { type: 'SCRAPE_REQUEST' }>;
export type ProductLookupRequestMessage = Extract<ExtensionMessage, { type: 'PRODUCT_LOOKUP_REQUEST' }>;
export type DataFetchRequestMessage = Extract<ExtensionMessage, { type: 'DATA_FETCH_REQUEST' }>;

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
 * The constructor args for a given message kind: a hello takes only an optional
 * payload; every correlated kind requires `(payload, requestId)` so the correlation
 * id can never be forgotten at a call site (the type enforces it).
 */
type MessageArgs<T extends ExtensionMessage['type']> = T extends 'EXTENSION_READY' | 'APP_READY'
  ? [payload?: HelloPayload]
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
