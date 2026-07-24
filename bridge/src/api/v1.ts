/**
 * Versioned read-only REST API (`/api/v1`) — the generic, third-party-facing surface that
 * the Home Assistant integration is now just one consumer of.
 *
 * It is **purely additive**: the legacy `/health`, `/search`, `/where` paths (the shipped
 * contract HA depends on) keep their exact behaviour and are documented as permanent aliases
 * of their `/api/v1` twins. Everything here is GET-only and strictly read-only — every read
 * flows through the app's own repositories and the single parameterised `parseASTtoSQL`,
 * never bespoke SQL. Auth and the per-IP rate limit are applied by the caller (`server.ts`)
 * before routing here, so this module only handles routing, validation, 404/503, and the
 * `{ error: { code, message } }` envelope.
 */
import type { ServerResponse } from 'node:http';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { CategoryRepository } from '@/db/repositories/CategoryRepository.ts';
import { emptyAst } from '@/db/search/ast.ts';
import type { LocationTreeNode } from '@/db/repositories/types';
import { searchItems, searchItemRows, whereIs, type LookupObserver } from '../query.ts';
import { openapiDocument } from '../openapi.ts';
import type {
  BridgeServerState,
  ParsedBody,
  PushCapability,
  ScaleCapability,
  WebhookTestCapability,
  WriteCapability,
} from '../server.ts';
import { healthBody, type SnapshotHealthReport } from '../snapshot-health.ts';
import { WebhookRepository } from '@/db/repositories/WebhookRepository.ts';
import { subscriptionToDeliveryTarget } from '../events/webhook-targets.ts';
import { buildWebhookTestEvent } from '../events/webhook-test.ts';
import { redactUrl } from '../events/webhook.ts';
import { BRIDGE_VERSION, BRIDGE_SCHEMA_VERSION } from '../version.ts';
import { HaError } from '../homeassistant/client.ts';
import type { ScaleReadingIssue } from '../homeassistant/scale.ts';
import { WriteError, type WriteOperation } from '../write.ts';
import {
  sendError,
  sendJson,
  sendText,
  sendXml,
  sendCsv,
  sendCalendar,
  sendFeed,
  type ApiErrorCode,
} from './respond.ts';
import { buildCalendar, isCalendarSourceType, type CalendarSourceType } from '../ical/feed.ts';
import { buildActivityFeed } from '../feeds/feed.ts';
import { emitRss, emitAtom, emitJsonFeed, type FeedChannel } from '../feeds/emitters.ts';
import { readPage, readQueryParam, readResultLimit, type PageRequest } from './params.ts';
import {
  MAX_DELIVERY_LOG_PAGE,
  type WebhookDeliveryLog,
  type WebhookDeliveryRecord,
} from '../events/webhook-log.ts';
import { MAX_CSV_ROWS, MAX_PAGE_LIMIT } from './limits.ts';
import { odataMetadataXml } from './odata-metadata.ts';
import { buildItemsCsv } from '@/features/export/export-data.ts';
import { FieldSelectionError, hasSelection, type RawSelection, type SelectedField } from './field-select.ts';
import {
  createItemViewContext,
  parseItemSelection,
  projectItem,
  ITEM_DETAIL_DEFAULT_FIELDS,
  ITEM_SUMMARY_DEFAULT_FIELDS,
  SEARCH_DEFAULT_FIELDS,
} from './item-view.ts';
import { createLocationViewContext, parseLocationSelection, projectLocation } from './location-view.ts';
import { BadQueryError, parseOrderBy, readOption } from './odata.ts';
import { parseODataFilter } from './odata-filter.ts';
import { SearchAstError } from '@/db/search/parseASTtoSQL.ts';
import type { SearchAST } from '@/db/search/ast.ts';
import type { ItemSort } from '@/db/repositories/item/sql.ts';
import type { Page, Item } from '@/db/repositories/types';
import {
  toCapabilityKey,
  toCategoryDetail,
  toCategorySummary,
  toItemSummary,
  toLocation,
  type ListEnvelope,
  type PaginationMeta,
} from './dto.ts';
import { loadItemDetail } from '../item-detail.ts';

/** The versioned API base path. */
export const API_V1_BASE = '/api/v1';

/**
 * The read-only iCalendar subscription feed path (`GET /api/v1/calendar.ics`). Exported so
 * `server.ts` can special-case its auth: a calendar client cannot send an `Authorization`
 * header, so — **for this path only** — the bearer token may also arrive as a `?token=` query
 * parameter (the standard for calendar subscriptions). Keeping that weaker token-in-URL posture
 * scoped to this one endpoint limits the blast radius.
 */
export const API_V1_CALENDAR_PATH = `${API_V1_BASE}/calendar.ics`;

/** The three read-only syndication-feed paths (RSS / Atom / JSON Feed) → their emitter format. */
export const API_V1_FEED_PATHS: Readonly<Record<string, FeedFormat>> = {
  [`${API_V1_BASE}/activity.rss`]: 'rss',
  [`${API_V1_BASE}/activity.atom`]: 'atom',
  [`${API_V1_BASE}/activity.json`]: 'json',
};

/**
 * The read-only paths that also accept the bearer token as a `?token=` query parameter (a feed /
 * calendar client subscribing by URL cannot send an `Authorization` header). Deliberately scoped
 * to these read-only subscription surfaces only; every other path still requires the header. See
 * `server.ts` `isAuthorised`.
 */
export function pathAllowsUrlToken(pathname: string): boolean {
  return pathname === API_V1_CALENDAR_PATH || Object.hasOwn(API_V1_FEED_PATHS, pathname);
}

/** True when a request path belongs to the versioned API (the base itself or below it). */
export function isApiV1Path(pathname: string): boolean {
  return pathname === API_V1_BASE || pathname.startsWith(`${API_V1_BASE}/`);
}

/** Everything the v1 router needs from the request: the method, state accessor, write gate, body. */
export interface ApiV1Context {
  /** The HTTP method (`GET` for reads, `POST` for the opt-in write endpoints). */
  readonly method: string;
  readonly getState: () => BridgeServerState | null;
  /**
   * Reload health for `GET /api/v1/health`, threaded through from the server so the versioned
   * alias reports exactly what `/health` does (issue #312). Omit and it reports a never-failed
   * snapshot.
   */
  readonly getSnapshotHealth?: () => SnapshotHealthReport;
  /** Present only when writes are opted in; its absence makes every POST a `404`. */
  readonly write?: WriteCapability;
  /**
   * Present only when snapshot-ingest is opted in (`GUBBINS_BRIDGE_ALLOW_PUSH=on`). The ingest
   * POST itself is handled in `server.ts` (it streams the body); this is threaded through only so
   * the discovery index can report `pushable`.
   */
  readonly push?: PushCapability;
  /**
   * Whether the opt-in event stream is enabled (`GUBBINS_BRIDGE_EVENTS=on`, or implied by
   * webhooks). The `GET /api/v1/events` connection itself is handled in `server.ts` (it holds
   * the socket open); this flag is threaded through only so the discovery index can advertise it.
   */
  readonly streamable?: boolean;
  /**
   * Present only when the Home Assistant read capability is opted in (`GUBBINS_BRIDGE_HA=on`);
   * its absence makes every `/api/v1/scale/*` path a `404`.
   */
  readonly scale?: ScaleCapability;
  /**
   * The opt-in resolved-lookup observer (`GUBBINS_BRIDGE_LOOKUP_EVENTS=on`), threaded through to
   * `GET /api/v1/where`. Absent (the default) means a lookup emits no event.
   */
  readonly lookup?: LookupObserver;
  /**
   * The bridge-side webhook delivery log (`GUBBINS_BRIDGE_WEBHOOKS=on`), read by
   * `GET /api/v1/webhooks/deliveries`. Absent makes that path a `404`, matching how every other
   * opt-in capability disappears rather than returning an empty result — "the feature isn't on"
   * and "nothing has been delivered yet" are different answers and must not look alike.
   */
  readonly webhookDeliveries?: WebhookDeliveryLog;
  /**
   * The opt-in webhook test-fire capability (`GUBBINS_BRIDGE_WEBHOOKS=on`), backing
   * `POST /api/v1/webhooks/test`. Absent makes that path a `404` — the same capability-absent
   * posture as the delivery log above.
   */
  readonly webhookTest?: WebhookTestCapability;
  /** The parsed POST body (undefined for GET). */
  readonly body?: ParsedBody;
  /**
   * The id of the user whose API token authorised this request (issue #79, plan §1.3) — the
   * actor every write is attributed to. Present on POSTs; the server resolves it before routing,
   * so a request that reaches a write handler has always been identified.
   */
  readonly actorUserId?: string;
}

/**
 * Route a `/api/v1` request. The caller has already enforced the method set, auth and the rate
 * limit; any thrown error is caught by the caller and collapsed to a generic 500. `openapi.json`
 * and the index are served regardless of snapshot state; data endpoints answer 503 until a
 * snapshot has loaded. A POST is dispatched to the opt-in write router.
 */
export async function handleApiV1(res: ServerResponse, url: URL, ctx: ApiV1Context): Promise<void> {
  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .slice(2); // drop 'api','v1'

  if (ctx.method === 'POST') {
    // The webhook test-fire is a POST that writes nothing, so it is routed *before* the write
    // router — whose first act is to 405 anything that is not an item action.
    if (segments.length === 2 && segments[0] === 'webhooks' && segments[1] === 'test') {
      return void (await handleWebhookTest(res, ctx));
    }
    return void (await handleWrite(res, segments, ctx));
  }

  // Static, state-independent endpoints first.
  if (segments.length === 0) {
    return void sendJson(
      res,
      200,
      apiIndex(
        ctx.write !== undefined,
        ctx.push !== undefined,
        ctx.streamable === true,
        ctx.scale !== undefined,
      ),
    );
  }
  if (segments.length === 1 && segments[0] === 'openapi.json') {
    return void sendJson(res, 200, openapiDocument);
  }
  if (segments.length === 1 && segments[0] === '$metadata') {
    return void sendXml(res, 200, odataMetadataXml());
  }

  // The scale endpoints read Home Assistant, not the snapshot, so they are routed *before* the
  // state gate below — a bridge that has not yet loaded a snapshot can still read a scale.
  if (segments[0] === 'scale') {
    return void (await handleScale(res, segments, url, ctx.scale));
  }

  // The delivery log lives in bridge memory, not the snapshot, so — like the scale reads — it is
  // routed *before* the state gate. A bridge still waiting for its first snapshot can already have
  // refused a delivery, and answering `503` would leave the app's Webhooks screen unable to say so.
  if (segments[0] === 'webhooks') {
    return void handleWebhookDeliveries(res, segments, url, ctx.webhookDeliveries);
  }

  const state = ctx.getState();
  if (state === null) {
    return void sendError(res, 503, 'snapshot_unavailable', 'Snapshot not loaded yet', { v1: true });
  }
  const { driver } = state;

  switch (segments[0]) {
    case 'health':
      if (segments.length === 1) return void (await handleHealth(res, state, ctx.getSnapshotHealth?.()));
      break;
    case 'search':
      if (segments.length === 1) return void (await handleSearch(res, driver, url));
      break;
    case 'where':
      if (segments.length === 1) return void (await handleWhere(res, driver, url, ctx.lookup));
      break;
    case 'items':
      if (segments.length === 1) return void (await handleItems(res, driver, url));
      if (segments.length === 2 && segments[1] === '$count') {
        return void (await handleItemCount(res, driver, url));
      }
      if (segments.length === 2) return void (await handleItem(res, driver, url, decode(segments[1]!)));
      break;
    case 'items.csv':
      if (segments.length === 1) return void (await handleItemsCsv(res, driver, url));
      break;
    case 'calendar.ics':
      if (segments.length === 1) return void (await handleCalendar(res, state, url));
      break;
    case 'activity.rss':
    case 'activity.atom':
    case 'activity.json': {
      const format = API_V1_FEED_PATHS[url.pathname];
      if (segments.length === 1 && format !== undefined) {
        return void (await handleActivityFeed(res, state, url, format));
      }
      break;
    }
    case 'locations':
      if (segments.length === 1) return void (await handleLocations(res, driver, url));
      if (segments.length === 2) return void (await handleLocation(res, driver, url, decode(segments[1]!)));
      break;
    case 'categories':
      if (segments.length === 1) return void (await handleCategories(res, driver, url));
      if (segments.length === 2) return void (await handleCategory(res, driver, decode(segments[1]!)));
      break;
    case 'capabilities':
      if (segments.length === 1) return void (await handleCapabilities(res, driver, url));
      break;
  }

  sendError(res, 404, 'not_found', 'Not found', { v1: true });
}

// --- Webhook delivery log (opt-in, off by default) --------------------------------

/**
 * Route `GET /api/v1/webhooks/deliveries` — the app's only window onto what its webhook
 * subscriptions actually did (webhooks plan §3.1).
 *
 * The bridge cannot write delivery outcomes back into the database: it is read-only over a snapshot
 * that is swapped wholesale on every hydration, so any row it wrote would be discarded on the next
 * hydrate. The log therefore lives in bridge memory and is *read* over this endpoint, on the
 * existing bearer auth — no new token, no new auth surface. Without it the delivery log and "send
 * test event" would show nothing at all, which is why the plan calls it non-optional.
 *
 * The app polls it **only while the Webhooks screen is open**, passing `since` (the highest `seq`
 * it has already seen) so a poll returns just what is new rather than the whole buffer each time.
 *
 * `404` when webhooks are off, matching every other opt-in capability: "the feature isn't enabled"
 * must not be indistinguishable from "nothing has been delivered".
 */
function handleWebhookDeliveries(
  res: ServerResponse,
  segments: readonly string[],
  url: URL,
  log: WebhookDeliveryLog | undefined,
): void {
  if (segments.length !== 2 || segments[1] !== 'deliveries' || log === undefined) {
    return void sendError(res, 404, 'not_found', 'Not found', { v1: true });
  }

  const rawSince = url.searchParams.get('since');
  let since: number | undefined;
  if (rawSince !== null) {
    const parsed = Number(rawSince);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return void sendError(res, 400, 'bad_request', '"since" must be a non-negative integer', {
        v1: true,
      });
    }
    since = parsed;
  }

  const rawLimit = url.searchParams.get('limit');
  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return void sendError(res, 400, 'bad_request', '"limit" must be a positive integer', { v1: true });
    }
    limit = Math.min(parsed, MAX_DELIVERY_LOG_PAGE);
  }

  const deliveries = log.list({
    ...(since !== undefined ? { since } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  // `latestSeq` is returned alongside the page so a poller can advance its cursor even when the
  // page is empty — otherwise a quiet minute would leave it re-requesting the same `since` forever.
  sendJson(res, 200, { deliveries, latestSeq: log.latestSeq() });
}

// --- Webhook test-fire (opt-in, off by default) -----------------------------------

/**
 * The result of a test fire. `outcome` reuses the delivery log's vocabulary plus one value the log
 * has no need for — `unmatched`, meaning the subscription's own rules excluded the synthetic event
 * so nothing was sent and no row was written.
 */
type WebhookTestOutcome = WebhookDeliveryRecord['outcome'] | 'unmatched';

/** The `200` body: what happened, in the same terms the delivery log uses. */
interface WebhookTestResult {
  readonly outcome: WebhookTestOutcome;
  readonly status: number | null;
  readonly attempts: number;
  readonly detail: string | null;
  /** The delivery-log row's sequence number, or `null` when no row was written. */
  readonly seq: number | null;
}

/**
 * `POST /api/v1/webhooks/test` — fire a synthetic event at **one** app-configured subscription
 * (webhooks plan §5.5).
 *
 * Everything but the event is real: the subscription is read from the hydrated snapshot and mapped
 * through the same `subscriptionToDeliveryTarget` the delivery path uses, the real matcher decides
 * whether it would be delivered, and the real deliverer (and therefore the real SSRF guard) issues
 * it, writing a real delivery-log row the app's existing `deliveries` poll picks up. A shortcut
 * around any of that would report success for a subscription that never delivers.
 *
 * The status codes are three genuinely different answers, and the UI says something different for
 * each: `404` — webhooks are not enabled on this bridge at all; `422` — the subscription exists in
 * the app but has not reached the bridge yet ("changes reach the bridge on the next sync"); `400` —
 * the request itself was malformed.
 *
 * Nothing secret can reach the response: the outcome is read back from the delivery-log record,
 * which by construction carries no secret, signature, header or query string.
 */
async function handleWebhookTest(res: ServerResponse, ctx: ApiV1Context): Promise<void> {
  const capability = ctx.webhookTest;
  if (capability === undefined) {
    return void sendError(res, 404, 'not_found', 'Not found', { v1: true }); // feature off → invisible
  }

  if (ctx.body === undefined || ctx.body.ok === false) {
    return void sendError(res, 400, 'bad_request', 'Request body must be a JSON object.', { v1: true });
  }
  const body = ctx.body.value;
  const subscriptionId =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).subscriptionId : undefined;
  if (typeof subscriptionId !== 'string' || subscriptionId.trim().length === 0) {
    return void sendError(res, 400, 'bad_request', 'Body must include a "subscriptionId" string.', {
      v1: true,
    });
  }

  const state = ctx.getState();
  if (state === null) {
    return void sendError(res, 503, 'snapshot_unavailable', 'Snapshot not loaded yet', { v1: true });
  }

  const subscription = await new WebhookRepository(state.driver).getById(subscriptionId);
  if (subscription === undefined) {
    // Distinct from the 404 above: the feature *is* on, this subscription simply is not in the
    // snapshot the bridge is serving — almost always because it has not synced across yet.
    return void sendError(
      res,
      422,
      'unprocessable',
      'That subscription is not in the snapshot this bridge is serving. It reaches the bridge on the next sync.',
      { v1: true },
    );
  }

  // Built from the subscription's own types, so the event is the same one either branch reports on.
  const event = buildWebhookTestEvent(subscription.eventTypes);

  const { target, warnings } = subscriptionToDeliveryTarget(subscription, capability.secrets);
  if (target === null) {
    // Today this is only an unresolvable `secret_ref`, which drops the subscription rather than
    // delivering it unsigned. That happens before the deliverer is ever reached, so the row it
    // would have written is recorded here instead — otherwise this refusal would be the one
    // outcome missing from the delivery log the app shows, and `seq` would be null for a delivery
    // that was genuinely blocked rather than simply unmatched. The warning names the missing ref;
    // never its value, and the URL is redacted by the deliverer's own rule.
    const detail = warnings[0] ?? 'The subscription cannot be delivered as configured.';
    const row = ctx.webhookDeliveries?.record({
      targetId: subscription.id,
      targetName: subscription.name,
      source: 'database',
      url: redactUrl(subscription.url),
      method: subscription.method,
      eventId: event.id,
      eventType: event.type,
      outcome: 'blocked',
      attempts: 0,
      status: null,
      detail,
    });
    return void sendJson(res, 200, {
      outcome: 'blocked',
      status: null,
      attempts: 0,
      detail,
      seq: row?.seq ?? null,
    } satisfies WebhookTestResult);
  }

  const record = await capability.deliver(target, event, state.driver);
  if (record === null) {
    // The matcher refused it — the subscription is disabled, or its filter excluded an event that
    // is about no real item. A true answer about a real rule, deliberately not forced through.
    return void sendJson(res, 200, {
      outcome: 'unmatched',
      status: null,
      attempts: 0,
      detail:
        'The subscription did not match the test event, so nothing was sent. A disabled ' +
        'subscription, or a filter that narrows to an item, location or tag, will exclude it.',
      seq: null,
    } satisfies WebhookTestResult);
  }

  sendJson(res, 200, {
    outcome: record.outcome,
    status: record.status,
    attempts: record.attempts,
    detail: record.detail,
    seq: record.seq,
  } satisfies WebhookTestResult);
}

// --- Home Assistant scale reads (opt-in, off by default) --------------------------

/**
 * Route `GET /api/v1/scale/*` — the opt-in inbound Home Assistant read behind "count by weight"
 * (issue #122):
 *
 *   GET /api/v1/scale/entities          → { entities: ScaleEntityDto[] } — the picker's source
 *   GET /api/v1/scale/state?entity_id=… → the current reading, reconciled to grams
 *
 * When the capability is absent (`GUBBINS_BRIDGE_HA` unset/off) every path here is a `404`, the
 * same "the feature simply isn't there" posture the write and push opt-ins take.
 *
 * A reading that can't be interpreted is a **`409`, not a `200` with a null weight**: the caller
 * is about to turn this number into a stock count, so "the scale is unavailable" and "that
 * sensor reports a unit I can't convert" must be impossible to mistake for a valid zero.
 */
async function handleScale(
  res: ServerResponse,
  segments: readonly string[],
  url: URL,
  scale: ScaleCapability | undefined,
): Promise<void> {
  if (scale === undefined || segments.length !== 2) {
    return void sendError(res, 404, 'not_found', 'Not found', { v1: true });
  }

  try {
    if (segments[1] === 'entities') {
      return void sendJson(res, 200, { entities: await scale.client.listScaleEntities() });
    }

    if (segments[1] === 'state') {
      const entityId = (url.searchParams.get('entity_id') ?? '').trim();
      if (entityId === '') {
        return void sendError(res, 400, 'bad_request', 'entity_id is required', { v1: true });
      }
      const outcome = await scale.client.readScale(entityId);
      if (!outcome.ok) {
        // A non-scale entity is answered as a missing one, so this endpoint reveals nothing about
        // the user's other Home Assistant entities (issue #179). The client already maps this to a
        // thrown 404; handling it here too keeps the guarantee even if a client returns it inline.
        if (outcome.issue === 'not-a-scale') {
          return void sendError(res, 404, 'not_found', 'No such entity.', { v1: true });
        }
        return void sendError(res, 409, SCALE_ISSUE_CODES[outcome.issue], scaleIssueMessage(outcome.issue), {
          v1: true,
        });
      }
      return void sendJson(res, 200, outcome.reading);
    }
  } catch (err) {
    if (err instanceof HaError) {
      return void sendError(res, err.status, err.code, err.message, { v1: true });
    }
    throw err; // unexpected → the caller's generic 500
  }

  sendError(res, 404, 'not_found', 'Not found', { v1: true });
}

/**
 * Map each **`409`** reading issue to its published error code. An explicit table rather than a
 * derived string (`scale_${issue.replace(…)}`): the codes are part of the API contract, so they
 * must be checkable against {@link ApiErrorCode} and greppable, and adding an issue must not
 * silently mint an undocumented code. `not-a-scale` is absent by design — it is answered as a
 * `404`, never a `409`, so it has no scale-specific code (issue #179).
 */
type ScaleConflictIssue = Exclude<ScaleReadingIssue, 'not-a-scale'>;

const SCALE_ISSUE_CODES: Readonly<Record<ScaleConflictIssue, ApiErrorCode>> = {
  unavailable: 'scale_unavailable',
  'not-a-number': 'scale_not_a_number',
};

/**
 * A plain, secret-free explanation of why a genuine scale couldn't be read. Both cases describe a
 * scale that is present but not reporting a usable weight; neither names the entity or echoes any
 * of its state back, so nothing about the wider home leaks through the message.
 */
function scaleIssueMessage(issue: ScaleConflictIssue): string {
  switch (issue) {
    case 'unavailable':
      return 'The scale is unavailable in Home Assistant.';
    case 'not-a-number':
      return 'That entity does not report a numeric weight.';
  }
}

// --- writes (opt-in, off by default) ----------------------------------------------

/**
 * Route a POST to the limited write endpoints. The only valid POST targets are
 * `items/{id}/adjust-quantity` and `items/{id}/adjust-gauge`; both take a `{ delta, note? }` body
 * and round-trip through the §7.3 sync merge (see `write.ts`). A POST to a read resource is a
 * `405`; an unknown item sub-action is a `404`; and when writes are not opted in (`ctx.write`
 * absent) a write path is a `404` too, so the feature is invisible unless enabled.
 */
async function handleWrite(res: ServerResponse, segments: string[], ctx: ApiV1Context): Promise<void> {
  const isItemAction = segments[0] === 'items' && segments.length === 3;
  if (!isItemAction) {
    // POST to a GET resource (e.g. /api/v1/items) or a non-existent path: method not allowed.
    return void sendError(res, 405, 'method_not_allowed', 'Method not allowed', {
      v1: true,
      headers: { allow: 'GET' },
    });
  }
  const action = segments[2];
  if (action !== 'adjust-quantity' && action !== 'adjust-gauge') {
    return void sendError(res, 404, 'not_found', 'Not found', { v1: true }); // unknown sub-action
  }
  if (ctx.write === undefined) {
    return void sendError(res, 404, 'not_found', 'Not found', { v1: true }); // feature off → invisible
  }

  if (ctx.body === undefined || ctx.body.ok === false) {
    return void sendError(res, 400, 'bad_request', 'Request body must be a JSON object.', { v1: true });
  }
  const parsed = parseAdjustBody(ctx.body.value);
  if (!parsed.ok) return void sendError(res, 400, 'bad_request', parsed.message, { v1: true });

  const op: WriteOperation = {
    kind: action,
    itemId: decode(segments[1]!),
    delta: parsed.delta,
    ...(parsed.note !== undefined ? { note: parsed.note } : {}),
  };

  // The server identifies every caller before routing, so this is set on any POST that gets
  // here; the guard keeps the attribution requirement honest rather than defaulting silently.
  if (ctx.actorUserId === undefined) {
    return void sendError(res, 401, 'unauthorized', 'Unauthorised', { v1: true });
  }

  try {
    sendJson(res, 200, await ctx.write.execute(op, ctx.actorUserId));
  } catch (err) {
    if (err instanceof WriteError) {
      sendError(res, err.status, err.code, err.message, { v1: true });
      return;
    }
    throw err; // unexpected → the caller's generic 500
  }
}

/** Validate the `{ delta, note? }` adjust body shape (the numeric/integer domain check is the
 * repository's, so it stays single-sourced and yields a 422 with the app's own wording). */
function parseAdjustBody(
  value: unknown,
): { ok: true; delta: number; note?: string } | { ok: false; message: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, message: 'Body must be a JSON object with a numeric "delta".' };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.delta !== 'number' || !Number.isFinite(record.delta)) {
    return { ok: false, message: 'Body must include a finite numeric "delta".' };
  }
  if (record.note !== undefined && record.note !== null && typeof record.note !== 'string') {
    return { ok: false, message: '"note", when present, must be a string.' };
  }
  const note = typeof record.note === 'string' ? record.note : undefined;
  return { ok: true, delta: record.delta, ...(note !== undefined ? { note } : {}) };
}

// --- meta -------------------------------------------------------------------------

function apiIndex(writable: boolean, pushable: boolean, streamable: boolean, scalable: boolean): unknown {
  return {
    name: 'Gubbins Bridge API',
    /**
     * The **API contract** version — what these endpoints promise. Deliberately distinct from
     * `bridge` below, which says which *build* is answering: the contract can stay at 1.0.0
     * across many releases of the software that implements it.
     */
    version: '1.0.0',
    /**
     * Which build of Gubbins this bridge is (issue #282). A client that knows its own version
     * can compare these to spot a checkout left behind by a `git pull` that never happened —
     * the bridge has no auto-update, so drift is otherwise completely invisible.
     */
    bridge: {
      version: BRIDGE_VERSION,
      schemaVersion: BRIDGE_SCHEMA_VERSION,
    },
    openapi: `${API_V1_BASE}/openapi.json`,
    /** Whether this bridge has the opt-in write endpoints enabled (read-only when false). */
    writable,
    /** Whether this bridge has the opt-in snapshot-ingest endpoint enabled (PWA "push to bridge"). */
    pushable,
    /** Whether this bridge has the opt-in read-only SSE event stream enabled. */
    streamable,
    /**
     * Whether this bridge has the opt-in Home Assistant read enabled, i.e. whether "count by
     * weight" can pull a live reading off a scale entity. The PWA reads this to decide whether
     * to offer the button at all, rather than showing a control that would always 404.
     */
    scalable,
    endpoints: [
      `${API_V1_BASE}/openapi.json`,
      `${API_V1_BASE}/$metadata`,
      `${API_V1_BASE}/health`,
      `${API_V1_BASE}/search`,
      `${API_V1_BASE}/where`,
      `${API_V1_BASE}/items`,
      `${API_V1_BASE}/items.csv`,
      `${API_V1_BASE}/calendar.ics`,
      `${API_V1_BASE}/activity.rss`,
      `${API_V1_BASE}/activity.atom`,
      `${API_V1_BASE}/activity.json`,
      `${API_V1_BASE}/items/{id}`,
      `${API_V1_BASE}/items/$count`,
      `${API_V1_BASE}/locations`,
      `${API_V1_BASE}/locations/{id}`,
      `${API_V1_BASE}/categories`,
      `${API_V1_BASE}/categories/{id}`,
      `${API_V1_BASE}/capabilities`,
      ...(writable
        ? [`POST ${API_V1_BASE}/items/{id}/adjust-quantity`, `POST ${API_V1_BASE}/items/{id}/adjust-gauge`]
        : []),
      ...(pushable ? [`POST ${API_V1_BASE}/snapshot`] : []),
      ...(streamable ? [`${API_V1_BASE}/events`] : []),
      ...(scalable ? [`${API_V1_BASE}/scale/entities`, `${API_V1_BASE}/scale/state`] : []),
    ],
  };
}

async function handleHealth(
  res: ServerResponse,
  state: BridgeServerState,
  health: SnapshotHealthReport | undefined,
): Promise<void> {
  const itemCount = await new ItemRepository(state.driver).countByAst(emptyAst('AND'));
  sendJson(res, 200, healthBody(state.snapshotGeneratedAt, itemCount, health));
}

// --- search / where (aliases of the legacy contract, same bodies) -----------------

async function handleSearch(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const q = readQueryParam(res, url, true);
  if (q === null) return;
  const limit = readResultLimit(url, true); // versioned API honours the $top alias
  const raw = readSelection(url);

  // With a `fields`/`include` selection, project the raw rows through the item field engine;
  // otherwise keep the compact ItemMatch shape (byte-identical to the legacy /search alias).
  if (hasSelection(raw)) {
    const selection = parseSelectionOr400(res, SEARCH_DEFAULT_FIELDS, raw);
    if (selection === null) return;
    const rows = await searchItemRows(driver, q, { limit });
    const matches = await Promise.all(
      rows.map((row) => projectItem(createItemViewContext(driver, row), selection)),
    );
    return void sendJson(res, 200, { query: q.trim(), matches });
  }

  const matches = await searchItems(driver, q, { limit });
  sendJson(res, 200, { query: q.trim(), matches });
}

async function handleWhere(
  res: ServerResponse,
  driver: Driver,
  url: URL,
  lookup: LookupObserver | undefined,
): Promise<void> {
  const q = readQueryParam(res, url, true);
  if (q === null) return;
  sendJson(res, 200, await whereIs(driver, q, { observer: lookup }));
}

// --- items ------------------------------------------------------------------------

async function handleItems(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const page = readPage(url);
  const raw = readSelection(url);
  const selection = hasSelection(raw)
    ? parseSelectionOr400(res, ITEM_SUMMARY_DEFAULT_FIELDS, raw)
    : undefined;
  if (selection === null) return; // a 400 was already sent

  const sort = parseOrderByOr400(res, url);
  if (sort === null) return;

  const ast = parseItemFilterOr400(res, url);
  if (ast === null) return; // an invalid $filter already sent a 400

  const items = new ItemRepository(driver);
  const filters = readItemListFilters(url);
  const wantCount = url.searchParams.get('$count') === 'true';

  let result: Page<Item>;
  let total: number | undefined;
  try {
    result = await itemPage(items, ast, filters, sort, page.limit, page.offset);
    if (wantCount) total = await itemCount(items, ast, filters);
  } catch (err) {
    // An AST-translation error (SearchAstError — e.g. an operator not valid for the field, or a
    // too-deep filter) is the caller's fault → 400.
    if (err instanceof SearchAstError) {
      return void sendError(res, 400, 'bad_request', err.message, { v1: true });
    }
    throw err;
  }

  // Resolve location names from one bounded read of the (physical, not 100k-row) tree,
  // rather than an N+1 lookup per row.
  const locationNames = await locationNameMap(driver);
  const data: readonly unknown[] =
    selection === undefined
      ? result.rows.map((item) => toItemSummary(item, locationNames.get(item.locationId) ?? null))
      : await Promise.all(
          result.rows.map((item) =>
            projectItem(
              createItemViewContext(driver, item, {
                locationName: locationNames.get(item.locationId) ?? null,
              }),
              selection,
            ),
          ),
        );
  sendList(res, data, page, result.hasMore, total);
}

/**
 * `GET /api/v1/items/$count` — the OData inline-count path: the grand total of matching items as
 * a bare `text/plain` integer, honouring the same `$filter`/`$search`/location/category scope.
 */
async function handleItemCount(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const ast = parseItemFilterOr400(res, url);
  if (ast === null) return;

  const items = new ItemRepository(driver);
  const filters = readItemListFilters(url);
  try {
    sendText(res, 200, String(await itemCount(items, ast, filters)));
  } catch (err) {
    if (err instanceof SearchAstError) {
      return void sendError(res, 400, 'bad_request', err.message, { v1: true });
    }
    throw err;
  }
}

/**
 * `GET /api/v1/items.csv` — a spreadsheet-friendly CSV of the matching items (the same column
 * shape and RFC-4180 quoting as the app's own export, reused verbatim so the two never drift).
 * A refreshable pull for Excel/Power BI "From Web". Honours the same `$filter`/`$search`/
 * `$orderby`/location/category/includeInactive scope as `GET /api/v1/items`; unlike the JSON
 * list it returns **all** matching rows (up to {@link MAX_CSV_ROWS}), not a single page.
 */
async function handleItemsCsv(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const sort = parseOrderByOr400(res, url);
  if (sort === null) return;
  const ast = parseItemFilterOr400(res, url);
  if (ast === null) return;

  const filters = readItemListFilters(url);
  try {
    const rows = await collectAllItems(driver, ast, filters, sort);
    sendCsv(res, 200, buildItemsCsv(rows), 'items.csv');
  } catch (err) {
    if (err instanceof SearchAstError) {
      return void sendError(res, 400, 'bad_request', err.message, { v1: true });
    }
    throw err;
  }
}

/**
 * Gather every matching item (for the CSV export) by looping the repository a page at a time,
 * stopping at {@link MAX_CSV_ROWS} so a huge dataset can't buffer unbounded. Uses the same
 * `$filter`-vs-`list` split as the JSON endpoint, so the CSV row set matches `GET /items`.
 */
async function collectAllItems(
  driver: Driver,
  ast: SearchAST | undefined,
  filters: ItemQueryFilters,
  sort: readonly ItemSort[] | undefined,
): Promise<readonly Item[]> {
  const items = new ItemRepository(driver);
  const rows: Item[] = [];
  for (let offset = 0; rows.length < MAX_CSV_ROWS; offset += MAX_PAGE_LIMIT) {
    const page = await itemPage(items, ast, filters, sort, MAX_PAGE_LIMIT, offset);
    rows.push(...page.rows);
    if (!page.hasMore) break;
  }
  return rows.length > MAX_CSV_ROWS ? rows.slice(0, MAX_CSV_ROWS) : rows;
}

// --- calendar (read-only iCalendar subscription feed) -----------------------------

/**
 * `GET /api/v1/calendar.ics` — the read-only iCalendar feed: loan due-backs, asset bookings,
 * maintenance/service dates, and warranty expiries as VEVENTs with stable per-source UIDs (see
 * `ical/feed.ts`). The optional `?type=loans|bookings|maintenance|warranty` (comma-separated)
 * narrows it to selected sources; an unknown type is a 400. `DTSTAMP` is the snapshot's
 * generation instant, so the output is stable across refetches of the same snapshot. Auth
 * (bearer header **or** the `?token=` query param, see `server.ts`) and the rate limit are
 * applied by the caller before routing here.
 */
async function handleCalendar(res: ServerResponse, state: BridgeServerState, url: URL): Promise<void> {
  const types = parseCalendarTypes(url);
  if (types === null) {
    return void sendError(
      res,
      400,
      'bad_request',
      'Unknown "type"; expected a comma-separated subset of loans, bookings, maintenance, warranty.',
      { v1: true },
    );
  }
  const now = Date.now();
  // Stamp events with the snapshot's generation time when known (stable across refetches),
  // else fall back to "now". `snapshotGeneratedAt` is an ISO string; parse it back to ms.
  const parsed = state.snapshotGeneratedAt !== null ? Date.parse(state.snapshotGeneratedAt) : NaN;
  const dtstamp = Number.isFinite(parsed) ? parsed : now;
  const ics = await buildCalendar(state.driver, { dtstamp, now, ...(types !== undefined ? { types } : {}) });
  sendCalendar(res, 200, ics);
}

/**
 * Parse the optional `?type=` selector into a validated source list. Absent (or blank) ⇒
 * `undefined` (the whole calendar); a comma-separated list of known sources ⇒ that subset; any
 * unknown token ⇒ `null` (the caller sends a 400).
 */
function parseCalendarTypes(url: URL): readonly CalendarSourceType[] | undefined | null {
  const raw = url.searchParams.get('type');
  if (raw === null) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  const types: CalendarSourceType[] = [];
  for (const part of parts) {
    if (!isCalendarSourceType(part)) return null;
    if (!types.includes(part)) types.push(part);
  }
  return types;
}

// --- activity feeds (read-only RSS / Atom / JSON Feed of the Phase 80 activity log) ------

/** Which syndication format a feed path renders. */
export type FeedFormat = 'rss' | 'atom' | 'json';

/** The emitter + media type for each feed format. */
const FEED_RENDERERS: Record<FeedFormat, { emit: typeof emitRss; contentType: string }> = {
  rss: { emit: emitRss, contentType: 'application/rss+xml' },
  atom: { emit: emitAtom, contentType: 'application/atom+xml' },
  json: { emit: emitJsonFeed, contentType: 'application/feed+json' },
};

/**
 * `GET /api/v1/activity.{rss,atom,json}` — the read-only syndication feed of the cross-item
 * `item_history` activity log (Phase 80), each entry carrying a stable, host-free URN id so a
 * reader updates in place rather than duplicating on refetch (see `feeds/*`). The optional
 * `?limit=` narrows the window (clamped to [1, 50]). Like the calendar, auth may arrive as a
 * `?token=` query param (a feed reader cannot send an auth header) — applied by the caller. The
 * feed's build timestamp is the snapshot's generation instant when known (stable across refetches).
 */
async function handleActivityFeed(
  res: ServerResponse,
  state: BridgeServerState,
  url: URL,
  format: FeedFormat,
): Promise<void> {
  const items = await buildActivityFeed(state.driver, { limit: readFeedLimit(url) });
  const channel = feedChannel(state, url);
  const { emit, contentType } = FEED_RENDERERS[format];
  sendFeed(res, 200, emit(channel, items), contentType);
}

/** Parse the optional `?limit=` (a positive integer); `undefined` falls back to the feed default. */
function readFeedLimit(url: URL): number | undefined {
  const raw = url.searchParams.get('limit');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Build the channel metadata: a host-free self/home URL (token stripped) + the build timestamp. */
function feedChannel(state: BridgeServerState, url: URL): FeedChannel {
  // Strip the token so it is never echoed into the feed body (self URL) — the token may have
  // arrived as a `?token=` query param on this path.
  const self = new URL(url.href);
  self.searchParams.delete('token');
  const parsed = state.snapshotGeneratedAt !== null ? Date.parse(state.snapshotGeneratedAt) : NaN;
  return {
    title: 'Gubbins activity',
    description: 'Recent inventory activity from Gubbins.',
    homeUrl: `${url.protocol}//${url.host}`,
    selfUrl: self.href,
    updated: Number.isFinite(parsed) ? parsed : Date.now(),
  };
}

/** The active-scope + non-page item list filters (location/category/$search), shared by rows + $count. */
type ItemQueryFilters = {
  locationId?: string;
  categoryId?: string;
  search?: string;
  includeInactive: boolean;
};

function readItemListFilters(url: URL): ItemQueryFilters {
  return {
    locationId: url.searchParams.get('location') ?? undefined,
    categoryId: url.searchParams.get('category') ?? undefined,
    // OData `$search` maps onto the app's FTS list filter.
    search: url.searchParams.get('$search') ?? undefined,
    includeInactive: url.searchParams.get('includeInactive') === 'true',
  };
}

/**
 * Fetch one page of items, single-sourcing the `$filter`-vs-`list` split every item query uses:
 * with a `$filter` the compiled `ast` is the **sole** row filter (location/category/$search are
 * ignored); without one, the plain `list` honours those scope filters. May throw
 * `SearchAstError` when the AST is invalid for a field — the caller maps that to a `400`.
 */
function itemPage(
  items: ItemRepository,
  ast: SearchAST | undefined,
  filters: ItemQueryFilters,
  sort: readonly ItemSort[] | undefined,
  limit: number,
  offset: number,
): Promise<Page<Item>> {
  return ast !== undefined
    ? items.searchByAst(ast, { limit, offset, includeInactive: filters.includeInactive, sort })
    : items.list({ ...filters, limit, offset, sort });
}

/** The `$count` twin of {@link itemPage}: the grand total under the same filter, no paging. */
function itemCount(
  items: ItemRepository,
  ast: SearchAST | undefined,
  filters: ItemQueryFilters,
): Promise<number> {
  return ast !== undefined
    ? items.countByAst(ast, { includeInactive: filters.includeInactive })
    : items.count(filters);
}

/**
 * Parse the optional `$filter` into a SearchAST, or send a `400` and return `null`. Returns
 * `undefined` when `$filter` is absent (use the plain `list` path). Only reports *syntax* errors
 * here (BadQueryError); an AST-translation error surfaces when the query runs.
 */
function parseItemFilterOr400(res: ServerResponse, url: URL): SearchAST | undefined | null {
  const raw = url.searchParams.get('$filter');
  if (raw === null) return undefined;
  try {
    return parseODataFilter(raw);
  } catch (err) {
    if (err instanceof BadQueryError) {
      sendError(res, 400, 'bad_request', err.message, { v1: true });
      return null;
    }
    throw err;
  }
}

async function handleItem(res: ServerResponse, driver: Driver, url: URL, id: string): Promise<void> {
  const raw = readSelection(url);
  if (hasSelection(raw)) {
    const selection = parseSelectionOr400(res, ITEM_DETAIL_DEFAULT_FIELDS, raw);
    if (selection === null) return;
    const item = await new ItemRepository(driver).getById(id);
    if (item === undefined) return notFound(res, 'item');
    return void sendJson(res, 200, await projectItem(createItemViewContext(driver, item), selection));
  }

  const detail = await loadItemDetail(driver, id);
  if (detail === null) return notFound(res, 'item');
  sendJson(res, 200, detail);
}

// --- locations --------------------------------------------------------------------

async function handleLocations(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const page = readPage(url);
  const raw = readSelection(url);
  const result = await new LocationRepository(driver).list({ limit: page.limit, offset: page.offset });

  // Without a selection the response is the plain `LocationDto` it has always been; with one,
  // the same rows go through the shared field-selection engine (so `include=fields` adds the
  // location's custom-field values).
  if (!hasSelection(raw)) {
    return void sendList(res, result.rows.map(toLocation), page, result.hasMore);
  }
  const selection = parseLocationSelectionOr400(res, raw);
  if (selection === null) return;
  const rows = await Promise.all(
    result.rows.map((location) => projectLocation(createLocationViewContext(driver, location), selection)),
  );
  sendList(res, rows, page, result.hasMore);
}

async function handleLocation(res: ServerResponse, driver: Driver, url: URL, id: string): Promise<void> {
  const raw = readSelection(url);
  const selection = hasSelection(raw) ? parseLocationSelectionOr400(res, raw) : undefined;
  if (selection === null) return;

  const location = await new LocationRepository(driver).getById(id);
  if (location === undefined) return notFound(res, 'location');
  // The live item count is the number of items whose home location is this one.
  const itemCount = await new ItemRepository(driver).count({ locationId: id });
  const row = { ...location, itemCount };

  if (selection === undefined) return void sendJson(res, 200, toLocation(row));
  sendJson(res, 200, await projectLocation(createLocationViewContext(driver, row), selection));
}

// --- categories -------------------------------------------------------------------

async function handleCategories(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const page = readPage(url);
  const result = await new CategoryRepository(driver).list({ limit: page.limit, offset: page.offset });
  sendList(res, result.rows.map(toCategorySummary), page, result.hasMore);
}

async function handleCategory(res: ServerResponse, driver: Driver, id: string): Promise<void> {
  const categories = new CategoryRepository(driver);
  const category = await categories.getById(id);
  if (category === undefined) return notFound(res, 'category');
  const fields = await categories.listFields(id);
  sendJson(res, 200, toCategoryDetail(category, fields));
}

// --- capabilities -----------------------------------------------------------------

async function handleCapabilities(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const page = readPage(url);
  const result = await new ItemRepository(driver).listCapabilityKeys({
    limit: page.limit,
    offset: page.offset,
  });
  sendList(res, result.rows.map(toCapabilityKey), page, result.hasMore);
}

// --- helpers ----------------------------------------------------------------------

type Driver = BridgeServerState['driver'];

/**
 * Read the optional field-selection parameters off the query string, accepting both the plain
 * REST names (`fields`/`include`) and their OData aliases (`$select`/`$expand`, which win when
 * both are present).
 */
function readSelection(url: URL): RawSelection {
  const fields = readOption(url, '$select', 'fields');
  const include = readOption(url, '$expand', 'include');
  return {
    ...(fields !== null ? { fields } : {}),
    ...(include !== null ? { include } : {}),
  };
}

/**
 * Parse the optional `$orderby` into a validated sort spec, or send a `400` and return `null`.
 * Returns `undefined` when `$orderby` is absent (keep the endpoint's default ordering).
 */
function parseOrderByOr400(res: ServerResponse, url: URL): readonly ItemSort[] | undefined | null {
  const raw = url.searchParams.get('$orderby');
  if (raw === null) return undefined;
  try {
    return parseOrderBy(raw);
  } catch (err) {
    if (err instanceof BadQueryError) {
      sendError(res, 400, 'bad_request', err.message, { v1: true });
      return null;
    }
    throw err;
  }
}

/**
 * Parse a field selection, or send a `400 bad_request` (v1 envelope) and return `null` when it
 * is invalid. The `FieldSelectionError` message is caller-facing and PII-free by construction.
 */
function parseSelectionOr400(
  res: ServerResponse,
  defaults: readonly string[],
  raw: RawSelection,
): readonly SelectedField[] | null {
  return selectionOr400(res, () => parseItemSelection(defaults, raw));
}

/** The location-vocabulary counterpart of {@link parseSelectionOr400}. */
function parseLocationSelectionOr400(
  res: ServerResponse,
  raw: RawSelection,
): readonly SelectedField[] | null {
  return selectionOr400(res, () => parseLocationSelection(raw));
}

function selectionOr400(
  res: ServerResponse,
  parse: () => readonly SelectedField[],
): readonly SelectedField[] | null {
  try {
    return parse();
  } catch (err) {
    if (err instanceof FieldSelectionError) {
      sendError(res, 400, 'bad_request', err.message, { v1: true });
      return null;
    }
    throw err;
  }
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function notFound(res: ServerResponse, resource: string): void {
  sendError(res, 404, 'not_found', `No such ${resource}`, { v1: true });
}

function sendList<T>(
  res: ServerResponse,
  data: readonly T[],
  page: PageRequest,
  hasMore: boolean,
  total?: number,
): void {
  const pagination: PaginationMeta = {
    limit: page.limit,
    offset: page.offset,
    count: data.length,
    hasMore,
    ...(total !== undefined ? { total } : {}),
  };
  const envelope: ListEnvelope<T> = { data, pagination };
  sendJson(res, 200, envelope);
}

/** A bounded id→name map of all locations (the physical hierarchy, not the item set). */
async function locationNameMap(driver: Driver): Promise<Map<string, string>> {
  const tree = await new LocationRepository(driver).getTree();
  const map = new Map<string, string>();
  const walk = (nodes: readonly LocationTreeNode[]): void => {
    for (const node of nodes) {
      map.set(node.id, node.name);
      walk(node.children);
    }
  };
  walk(tree);
  return map;
}
