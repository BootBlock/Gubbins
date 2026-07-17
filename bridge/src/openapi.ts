/**
 * The OpenAPI 3 description of the versioned read-only bridge API (`/api/v1`).
 *
 * This object is the **single source of truth** for the spec: it is served verbatim (as
 * JSON) at `GET /api/v1/openapi.json`, and the committed `bridge/openapi.yaml` is emitted
 * from it by `openapi-yaml.ts` (a test asserts the two never drift). Authoring it by hand
 * as a typed object — rather than deriving it from the route code by reflection — keeps the
 * description intentional and reviewable, and means the YAML is generated, never hand-kept.
 *
 * Every example is synthetic (the same made-up parts as the test fixture); no real or
 * personal data, hosts, or tokens appear here (CLAUDE.md / security checklist).
 */

/** A plain JSON value — the spec is pure data, serialisable to JSON and YAML alike. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const SERVER_URL = 'http://127.0.0.1:8787';

const bearerSecurity: JsonValue = [{ bearerAuth: [] }];

/** The `{ error: { code, message } }` envelope every v1 error uses. */
const errorSchema: JsonValue = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          enum: [
            'bad_request',
            'unauthorized',
            'not_found',
            'method_not_allowed',
            'too_many_requests',
            'snapshot_unavailable',
            'unprocessable',
            'payload_too_large',
            'internal_error',
          ],
        },
        message: { type: 'string' },
      },
    },
  },
};

const paginationSchema: JsonValue = {
  type: 'object',
  required: ['limit', 'offset', 'count', 'hasMore'],
  properties: {
    limit: { type: 'integer', description: 'Effective page size after clamping.' },
    offset: { type: 'integer', description: 'Zero-based offset of the first row.' },
    count: { type: 'integer', description: 'Rows returned in this page (≤ limit).' },
    hasMore: { type: 'boolean', description: 'True when a further page may exist.' },
    total: {
      type: 'integer',
      description: 'Grand total across all pages — present only when the OData $count=true option is set.',
    },
  },
};

const limitParam: JsonValue = {
  name: 'limit',
  in: 'query',
  required: false,
  description: 'Page size, clamped to [1, 100]. Defaults to 50.',
  schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
};

const offsetParam: JsonValue = {
  name: 'offset',
  in: 'query',
  required: false,
  description: 'Zero-based row offset. Defaults to 0.',
  schema: { type: 'integer', minimum: 0, default: 0 },
};

const qParam: JsonValue = {
  name: 'q',
  in: 'query',
  required: true,
  description:
    "Search query. Accepts the app's full grammar (field:value, cap:key>n, AND/OR/parens) " +
    'as well as a casual phrase like "M3 bolt". Max 200 characters.',
  schema: { type: 'string', maxLength: 200 },
  example: 'M3 bolt',
};

/**
 * The `fields` (sparse fieldset / projection) parameter shared by the item read endpoints.
 * Present it and the response contains ONLY the named fields; omit it for the endpoint's
 * default payload. Naming an extended field opts it in; one level of nesting is supported for
 * the array fields via a dotted path (e.g. `placements.quantity`).
 */
const fieldsParam: JsonValue = {
  name: 'fields',
  in: 'query',
  required: false,
  description:
    'Sparse fieldset: a comma-separated list of item fields to return INSTEAD of the default ' +
    'set (a projection). Naming an extended field (e.g. unitCost, notes) opts it in, so ' +
    '`fields=name,unitCost` returns just those two. Nest an array field with a dot: ' +
    '`placements.quantity`. An unknown field is a 400. Valid fields: id, name, quantity, ' +
    'isUnlimited, locationId, locationName, categoryId, categoryName, mpn, manufacturer, ' +
    'trackingMode, isActive, description, notes, condition, serialNo, parentId, unitCost, purchasePrice, ' +
    'weight, width, height, depth, expiryDate, batchNumber, lotNumber, acquiredAt, warrantyExpiresAt, depreciationMonths, ' +
    'reorderPoint, reorderGaugePercent, reorderQty, operationalMetadata, gauge, createdAt, ' +
    'updatedAt, placements, capabilities.',
  schema: { type: 'string' },
  example: 'name,unitCost',
};

/**
 * The `include` (field expansion) parameter shared by the item read endpoints — adds extended
 * fields on top of the default payload, singly or by named group.
 */
const includeParam: JsonValue = {
  name: 'include',
  in: 'query',
  required: false,
  description:
    'Field expansion: a comma-separated list of extended fields, or named groups, to ADD on ' +
    'top of the default payload. Groups: relations (placements, capabilities, categoryName), ' +
    'pricing (unitCost, purchasePrice), lifecycle (acquiredAt, warrantyExpiresAt, ' +
    'purchasePrice, depreciationMonths), reorder (reorderPoint, reorderGaugePercent, ' +
    'reorderQty), timestamps (createdAt, updatedAt), and all (every extended field). An ' +
    'unknown name is a 400.',
  schema: { type: 'string' },
  example: 'capabilities,notes',
};

/**
 * OData-style query-option aliases (a convenience subset, NOT a compliant OData service — no
 * $metadata, $batch or $apply). Each is an alias of a plain REST parameter and wins when both
 * are supplied. `$orderby` and `$filter` add genuinely new capability on the items list.
 */
const odataAlias = (name: string, of: string, example: string): JsonValue => ({
  name,
  in: 'query',
  required: false,
  description: `OData-style alias of \`${of}\` (this alias wins if both are given).`,
  schema: { type: 'string' },
  example,
});

const selectParam = odataAlias('$select', 'fields', 'name,unitCost');
const expandParam = odataAlias('$expand', 'include', 'capabilities,notes');
const topParam = odataAlias('$top', 'limit', '10');
const skipParam = odataAlias('$skip', 'offset', '0');

const countParam: JsonValue = {
  name: '$count',
  in: 'query',
  required: false,
  description:
    'When "true", include the grand total of matching rows (across all pages) as ' +
    '`pagination.total`. Costs one extra COUNT query.',
  schema: { type: 'boolean', default: false },
  example: 'true',
};

const searchParam: JsonValue = {
  name: '$search',
  in: 'query',
  required: false,
  description:
    'Free-text search across the item name/description/notes/mpn/manufacturer via the FTS5 ' +
    'index (ignored when $filter is set).',
  schema: { type: 'string' },
  example: 'esp32',
};

const orderbyParam: JsonValue = {
  name: '$orderby',
  in: 'query',
  required: false,
  description:
    'Sort the result: a comma-separated list of "<field> [asc|desc]" terms (default asc). ' +
    'Sortable fields: name, quantity, unitCost, mpn, manufacturer, createdAt, updatedAt, ' +
    'serialNo. NULLs sort last; ties break on id for stable pagination. An unknown field is a 400.',
  schema: { type: 'string' },
  example: 'quantity desc,name',
};

const filterParam: JsonValue = {
  name: '$filter',
  in: 'query',
  required: false,
  description:
    'A constrained OData-style boolean filter compiled to the app search AST (never bespoke ' +
    'SQL). Supported: comparisons eq/gt/lt, the contains(field, string) function, and/or with ' +
    'parentheses. Filterable fields: name, description, notes, mpn, manufacturer, quantity, ' +
    'weight, width, height, depth, category(Id), location(Id). Unsupported operators (ne/ge/le, not, startswith, arithmetic, ' +
    'lambdas) are a 400. When present it is the sole row filter (location/category are ignored).',
  schema: { type: 'string' },
  example: "quantity gt 10 and contains(name,'bolt')",
};

/** The `token` query-param shared by the read-only subscription surfaces (calendar + feeds). */
const feedTokenParam: JsonValue = {
  name: 'token',
  in: 'query',
  required: false,
  description:
    'The shared bearer token, for feed/calendar clients that cannot send an Authorization header. ' +
    'Accepted on the read-only subscription paths only; prefer the Authorization header elsewhere.',
  schema: { type: 'string' },
};

/** The `limit` query-param on the syndication feeds (window size, clamped to [1, 50]). */
const feedLimitParam: JsonValue = {
  name: 'limit',
  in: 'query',
  required: false,
  description: 'Number of recent activity entries to include, clamped to [1, 50]. Defaults to 50.',
  schema: { type: 'integer', minimum: 1, maximum: 50, default: 50 },
};

/** A syndication-feed GET operation: the shared params + a single string-body media type. */
function feedOperation(summary: string, mediaType: string, example: string): JsonValue {
  return {
    get: {
      tags: ['feeds'],
      summary,
      description:
        'A read-only feed of the recent cross-item activity log (item_history), newest first, each ' +
        'entry carrying a stable host-free URN id so a reader updates it in place rather than ' +
        'duplicating on refetch. Like the calendar, this path ALSO accepts the bearer token as a ' +
        '`token` query parameter (a feed reader cannot send an Authorization header) — a deliberately ' +
        'weaker token-in-URL posture scoped to the feed/calendar paths. Read-only.',
      parameters: [feedTokenParam, feedLimitParam],
      responses: {
        200: {
          description: 'The feed document.',
          content: { [mediaType]: { schema: { type: 'string' }, example } },
        },
        ...(errorResponses(401, 429, 503) as Record<string, JsonValue>),
      },
    },
  };
}

/** Standard error responses reused across operations. */
const errorResponses = (...codes: number[]): JsonValue => {
  const all: Record<number, JsonValue> = {
    400: response('Bad request — missing or invalid parameter.', '#/components/schemas/Error'),
    401: {
      description: 'Missing or invalid bearer token.',
      headers: { 'WWW-Authenticate': { schema: { type: 'string' }, description: 'Bearer' } },
      content: jsonContent('#/components/schemas/Error'),
    },
    404: response('Resource not found.', '#/components/schemas/Error'),
    413: response(
      'The pushed snapshot exceeded the configured maximum size (GUBBINS_BRIDGE_MAX_PUSH_BYTES).',
      '#/components/schemas/Error',
    ),
    422: response(
      'The request was well-formed but rejected (e.g. quantity below zero, the wrong tracking mode, or a snapshot from a newer Gubbins build).',
      '#/components/schemas/Error',
    ),
    429: {
      description: 'Rate limit exceeded for this client.',
      headers: {
        'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait.' },
      },
      content: jsonContent('#/components/schemas/Error'),
    },
    503: response('Snapshot not loaded yet.', '#/components/schemas/Error'),
  };
  const out: Record<string, JsonValue> = {};
  for (const code of codes) {
    const value = all[code];
    if (value !== undefined) out[String(code)] = value;
  }
  return out;
};

function jsonContent(ref: string, example?: JsonValue): JsonValue {
  const media: Record<string, JsonValue> = { schema: { $ref: ref } };
  if (example !== undefined) media.example = example;
  return { 'application/json': media };
}

function response(description: string, ref: string, example?: JsonValue): JsonValue {
  return { description, content: jsonContent(ref, example) };
}

function okList(itemRef: string): JsonValue {
  return {
    description: 'A page of results.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['data', 'pagination'],
          properties: {
            data: { type: 'array', items: { $ref: itemRef } },
            pagination: { $ref: '#/components/schemas/Pagination' },
          },
        },
      },
    },
  };
}

export const openapiDocument: JsonValue = {
  openapi: '3.0.3',
  info: {
    title: 'Gubbins Bridge API',
    version: '1.0.0',
    description:
      'Read-only HTTP API over a Gubbins inventory snapshot, served by the local companion ' +
      'bridge. Every endpoint is GET-only and requires a bearer token. The unversioned paths ' +
      '(/health, /search, /where) are permanent, stable aliases of their /api/v1 equivalents, ' +
      'kept so existing consumers (the Home Assistant integration) keep working unchanged.',
    license: { name: 'MIT' },
  },
  servers: [{ url: SERVER_URL, description: 'Local bridge (loopback default).' }],
  security: bearerSecurity,
  tags: [
    { name: 'meta', description: 'Liveness and API description.' },
    { name: 'search', description: 'Relevance search and "where is X?".' },
    { name: 'items', description: 'Browse items and look one up by id.' },
    {
      name: 'calendar',
      description:
        'A read-only iCalendar (.ics) subscription feed of Gubbins’ time-bearing facts — loan ' +
        'due-backs, asset bookings, maintenance/service dates, and warranty expiries — that any ' +
        'calendar app can subscribe to by URL.',
    },
    {
      name: 'feeds',
      description:
        'Read-only syndication feeds (RSS 2.0, Atom 1.0, JSON Feed 1.1) of the recent activity ' +
        'log — a human "what changed" stream any feed reader can subscribe to by URL.',
    },
    {
      name: 'metrics',
      description:
        'A Prometheus/OpenMetrics text-exposition of the aggregate inventory counts, at the root ' +
        '/metrics path (the scrape convention), for Grafana/Prometheus home-labs.',
    },
    { name: 'locations', description: 'Browse the locations hierarchy.' },
    { name: 'categories', description: 'Browse categories and their custom-field schema.' },
    { name: 'capabilities', description: 'Browse the queryable capability vocabulary.' },
    {
      name: 'writes',
      description:
        'Opt-in stock mutations (off by default; enabled with GUBBINS_BRIDGE_ALLOW_WRITES=on). ' +
        'Each write round-trips through the same sync merge the PWA uses, so it is applied without ' +
        'drift on the next sync. When writes are disabled these paths return 404.',
    },
    {
      name: 'push',
      description:
        'Opt-in snapshot ingest — the PWA "push to bridge" (off by default; enabled with ' +
        'GUBBINS_BRIDGE_ALLOW_PUSH=on, and only for a JSON snapshot source). Accepts the same ' +
        'versioned backup JSON the bridge reads from a synced folder and replaces it atomically; ' +
        'the watcher then re-hydrates. When push is disabled this path returns 404.',
    },
    {
      name: 'events',
      description:
        'Opt-in read-only event stream (off by default; enabled with GUBBINS_BRIDGE_EVENTS=on, or ' +
        'implied by GUBBINS_BRIDGE_WEBHOOKS=on). A Server-Sent Events feed of typed inventory-change ' +
        'events, the same events delivered to outbound webhooks. When disabled this path returns 404.',
    },
  ],
  paths: {
    '/api/v1': {
      get: {
        tags: ['meta'],
        summary: 'API index',
        description: 'A small discovery document listing the version and available endpoints.',
        responses: {
          200: response('The API index.', '#/components/schemas/ApiIndex'),
          ...(errorResponses(401, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/openapi.json': {
      get: {
        tags: ['meta'],
        summary: 'This OpenAPI document',
        responses: {
          200: {
            description: 'The OpenAPI 3 description of this API.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          ...(errorResponses(401, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/$metadata': {
      get: {
        tags: ['meta'],
        summary: 'OData CSDL $metadata (descriptive, not full-OData conformance)',
        description:
          'An OData v4 CSDL document describing the read model (the items/locations/categories ' +
          'entity sets and their complex types), for OData-aware tooling. The service implements ' +
          'only the constrained OData query subset, not the whole protocol.',
        responses: {
          200: {
            description: 'The CSDL $metadata XML.',
            content: { 'application/xml': { schema: { type: 'string' } } },
          },
          ...(errorResponses(401, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/health': {
      get: {
        tags: ['meta'],
        summary: 'Liveness and a cheap snapshot summary',
        responses: {
          200: response('Health summary.', '#/components/schemas/Health', {
            ok: true,
            itemCount: 4,
            snapshotGeneratedAt: '2025-06-27T06:13:20.000Z',
          }),
          ...(errorResponses(401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/search': {
      get: {
        tags: ['search'],
        summary: 'Relevance search (top-N, not paginated)',
        description:
          'Returns up to a hard ceiling of 25 best matches as compact item DTOs. For browsing ' +
          'all items with pagination, use GET /api/v1/items instead. Use `fields` to project ' +
          'only specific fields (e.g. just the price) or `include` to add extended fields.',
        parameters: [
          qParam,
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Max results, clamped to [1, 25]. Defaults to 5.',
            schema: { type: 'integer', minimum: 1, maximum: 25, default: 5 },
          },
          fieldsParam,
          includeParam,
          selectParam,
          expandParam,
          topParam,
        ],
        responses: {
          200: response('The matches.', '#/components/schemas/SearchResult'),
          ...(errorResponses(400, 401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/where': {
      get: {
        tags: ['search'],
        summary: '"Where is X?" — matches with per-location breakdown + a spoken sentence',
        parameters: [qParam],
        responses: {
          200: response('The enriched answer.', '#/components/schemas/WhereIsResult'),
          ...(errorResponses(400, 401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/items': {
      get: {
        tags: ['items'],
        summary: 'Browse items (paginated)',
        description:
          'Paginated item summaries. Use `fields`/`$select` to project a sparse fieldset, ' +
          '`include`/`$expand` to add extended fields, `$orderby` to sort, and `$filter` for a ' +
          'constrained OData-style boolean filter. `$top`/`$skip` alias `limit`/`offset`.',
        parameters: [
          limitParam,
          offsetParam,
          {
            name: 'location',
            in: 'query',
            required: false,
            description:
              'Filter to items whose home location is this location id (ignored when $filter is set).',
            schema: { type: 'string' },
          },
          {
            name: 'category',
            in: 'query',
            required: false,
            description: 'Filter to items in this category id (ignored when $filter is set).',
            schema: { type: 'string' },
          },
          {
            name: 'includeInactive',
            in: 'query',
            required: false,
            description: 'Include soft-deleted items when "true". Defaults to active only.',
            schema: { type: 'boolean', default: false },
          },
          fieldsParam,
          includeParam,
          selectParam,
          expandParam,
          topParam,
          skipParam,
          orderbyParam,
          filterParam,
          countParam,
          searchParam,
        ],
        responses: {
          200: okList('#/components/schemas/ItemSummary'),
          ...(errorResponses(400, 401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/items/$count': {
      get: {
        tags: ['items'],
        summary: 'The count of matching items (OData inline-count path)',
        description:
          'Returns the grand total of matching items as a bare text/plain integer, honouring the ' +
          'same $filter/$search/location/category scope as GET /api/v1/items.',
        parameters: [filterParam, searchParam],
        responses: {
          200: {
            description: 'The count, as a plain-text integer.',
            content: { 'text/plain': { schema: { type: 'integer' }, example: 4 } },
          },
          ...(errorResponses(400, 401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/items.csv': {
      get: {
        tags: ['items'],
        summary: 'Export matching items as a CSV (refreshable spreadsheet pull)',
        description:
          'A spreadsheet-friendly CSV download of the matching items (columns: id, name, ' +
          'description, notes, trackingMode, quantity, isUnlimited, mpn, manufacturer, unitCost — ' +
          "the same shape as the app's own export; the quantity cell is blank for an unlimited-" +
          'supply row). Honours the same $filter/$search/$orderby/location/' +
          'category/includeInactive scope as GET /api/v1/items, and returns ALL matching rows ' +
          '(up to a hard cap), not a single page. Point Excel/Power BI "From Web" at it for a ' +
          'refreshable pull.',
        parameters: [filterParam, searchParam, orderbyParam],
        responses: {
          200: {
            description: 'The CSV file (RFC-4180, CRLF rows).',
            content: {
              'text/csv': {
                schema: { type: 'string' },
                example:
                  'id,name,description,notes,trackingMode,quantity,isUnlimited,mpn,manufacturer,unitCost\r\n' +
                  'item-esp32,ESP32 Dev Board,,,DISCRETE,7,false,DEV-ESP32,Synthetic Silicon Co,',
              },
            },
          },
          ...(errorResponses(400, 401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/calendar.ics': {
      get: {
        tags: ['calendar'],
        summary: 'Subscribe to the read-only iCalendar feed',
        description:
          'A text/calendar (RFC 5545) VCALENDAR of Gubbins’ time-bearing facts, as VEVENTs with a ' +
          'stable per-source UID so a subscriber updates each event in place rather than ' +
          'duplicating it on refetch. Sources: loan due-backs (open checkouts with a due date), ' +
          'asset bookings (upcoming, not-yet-passed), maintenance/service due dates (time-based ' +
          'schedules), and warranty expiries. Most events are all-day. A source with no data ' +
          'simply contributes nothing (a valid, empty calendar is the natural result). Because a ' +
          'calendar client cannot send an Authorization header, this endpoint ALSO accepts the ' +
          'bearer token as a `token` query parameter (a deliberately weaker token-in-URL posture, ' +
          'scoped to this one path — keep the bridge loopback/LAN posture in mind). Read-only.',
        parameters: [
          {
            name: 'token',
            in: 'query',
            required: false,
            description:
              'The shared bearer token, for calendar clients that cannot send an Authorization ' +
              'header. Accepted on THIS path only; prefer the Authorization header everywhere else.',
            schema: { type: 'string' },
          },
          {
            name: 'type',
            in: 'query',
            required: false,
            description:
              'Restrict the feed to a comma-separated subset of sources: loans, bookings, ' +
              'maintenance, warranty. Omitted = all four. An unknown value is a 400.',
            schema: { type: 'string' },
            example: 'loans,warranty',
          },
        ],
        responses: {
          200: {
            description: 'The iCalendar document.',
            content: {
              'text/calendar': {
                schema: { type: 'string' },
                example:
                  'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Gubbins//Bridge Calendar//EN\r\n' +
                  'CALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:Gubbins\r\nBEGIN:VEVENT\r\n' +
                  'UID:warranty-item-esp32@gubbins.invalid\r\nDTSTAMP:20250627T045320Z\r\n' +
                  'DTSTART;VALUE=DATE:20270615\r\nDTEND;VALUE=DATE:20270616\r\n' +
                  'SUMMARY:Warranty expires: ESP32 Dev Board\r\nCATEGORIES:Gubbins,Warranty\r\n' +
                  'END:VEVENT\r\nEND:VCALENDAR\r\n',
              },
            },
          },
          ...(errorResponses(400, 401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/activity.rss': feedOperation(
      'Subscribe to the recent-activity feed (RSS 2.0)',
      'application/rss+xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n' +
        '    <title>Gubbins activity</title>\n    <item>\n      <title>ESP32 Dev Board — Quantity changed</title>\n' +
        '      <guid isPermaLink="false">urn:gubbins:activity:hist-0007</guid>\n    </item>\n  </channel>\n</rss>\n',
    ),
    '/api/v1/activity.atom': feedOperation(
      'Subscribe to the recent-activity feed (Atom 1.0)',
      'application/atom+xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n' +
        '  <title>Gubbins activity</title>\n  <entry>\n    <title>ESP32 Dev Board — Quantity changed</title>\n' +
        '    <id>urn:gubbins:activity:hist-0007</id>\n  </entry>\n</feed>\n',
    ),
    '/api/v1/activity.json': feedOperation(
      'Subscribe to the recent-activity feed (JSON Feed 1.1)',
      'application/feed+json',
      '{\n  "version": "https://jsonfeed.org/version/1.1",\n  "title": "Gubbins activity",\n' +
        '  "items": [\n    { "id": "urn:gubbins:activity:hist-0007", "title": "ESP32 Dev Board — Quantity changed" }\n  ]\n}\n',
    ),
    '/metrics': {
      get: {
        tags: ['metrics'],
        summary: 'Prometheus/OpenMetrics exposition of the aggregate inventory counts',
        description:
          'A text/plain (version=0.0.4) Prometheus exposition a scrape accepts directly, at the ' +
          'root /metrics path (the scrape convention) rather than under /api/v1. Gauges: ' +
          'gubbins_items_total, gubbins_low_stock_items, gubbins_out_of_stock_items, ' +
          'gubbins_locations_total, and the per-location gubbins_location_items / ' +
          'gubbins_location_capacity / gubbins_location_fullness_ratio (labelled by location). The ' +
          'low/out-of-stock counts reuse the same seams as the event stream and MQTT, so they never ' +
          'drift. Auth is header-only here (no ?token=); a scrape config sends the bearer token.',
        responses: {
          200: {
            description: 'The metrics exposition.',
            content: {
              'text/plain': {
                schema: { type: 'string' },
                example:
                  '# HELP gubbins_items_total Total active items in the inventory.\n' +
                  '# TYPE gubbins_items_total gauge\ngubbins_items_total 4\n' +
                  '# HELP gubbins_low_stock_items Active items at or below their low-stock threshold.\n' +
                  '# TYPE gubbins_low_stock_items gauge\ngubbins_low_stock_items 1\n',
              },
            },
          },
          ...(errorResponses(401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/items/{id}': {
      get: {
        tags: ['items'],
        summary: 'Look up one item by id (with placements and capabilities)',
        description:
          'One item with its full detail. Use `fields`/`$select` to project a sparse fieldset ' +
          '(e.g. just the price) or `include`/`$expand` to add extended fields beyond the ' +
          'default detail payload.',
        parameters: [idParam('item'), fieldsParam, includeParam, selectParam, expandParam],
        responses: {
          200: response('The item.', '#/components/schemas/ItemDetail'),
          ...(errorResponses(400, 401, 404, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/items/{id}/adjust-quantity': {
      post: {
        tags: ['writes'],
        summary: 'Adjust a DISCRETE item’s quantity by a signed delta (check-in / check-out)',
        description:
          'Opt-in (GUBBINS_BRIDGE_ALLOW_WRITES=on); returns 404 when writes are disabled. Applies ' +
          'a signed delta to the item’s home-location stock and logs it, exactly as the app does, ' +
          'then writes the merged snapshot back so the PWA reconciles it (LWW) on its next sync.',
        parameters: [idParam('item')],
        requestBody: adjustRequestBody('Whole-number change; negative to check out.'),
        responses: {
          200: response('The updated item.', '#/components/schemas/ItemDetail'),
          ...(errorResponses(400, 401, 404, 422, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/items/{id}/adjust-gauge': {
      post: {
        tags: ['writes'],
        summary: 'Adjust a CONSUMABLE_GAUGE item’s net value by a signed delta',
        description:
          'Opt-in (GUBBINS_BRIDGE_ALLOW_WRITES=on); returns 404 when writes are disabled. Applies a ' +
          'signed delta to the gauge’s current net value (clamped to [0, capacity]) and records it ' +
          'as a net-value delta, which the PWA replays through the §7.3 Delta-CRDT on its next sync.',
        parameters: [idParam('item')],
        requestBody: adjustRequestBody('Signed change to the net value (e.g. -45 for 45 consumed).'),
        responses: {
          200: response('The updated item.', '#/components/schemas/ItemDetail'),
          ...(errorResponses(400, 401, 404, 422, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/snapshot': {
      post: {
        tags: ['push'],
        summary: 'Replace the served snapshot (the PWA "push to bridge")',
        description:
          'Opt-in (GUBBINS_BRIDGE_ALLOW_PUSH=on, JSON source only); returns 404 when push is ' +
          'disabled or the source is a raw .sqlite. Accepts the same versioned backup JSON the ' +
          'PWA writes to a synced folder, validates it with the format-version guard, and writes ' +
          'it to the snapshot path atomically. The watcher then re-hydrates it through the normal ' +
          'path, so subsequent reads reflect the pushed data. The body is capped at ' +
          'GUBBINS_BRIDGE_MAX_PUSH_BYTES (default 64 MiB).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description:
                  'A Gubbins versioned backup/sync snapshot (the bytes produced by the PWA’s ' +
                  'snapshotToBackupJson). At minimum it carries a numeric formatVersion.',
                required: ['formatVersion'],
                properties: {
                  formatVersion: { type: 'integer', example: 3 },
                  generatedAt: { type: 'integer', description: 'UNIX-ms.', example: 1751004800000 },
                },
              },
            },
          },
        },
        responses: {
          200: response('The snapshot was accepted and published.', '#/components/schemas/SnapshotAccepted', {
            ok: true,
            formatVersion: 3,
            generatedAt: 1751004800000,
          }),
          ...(errorResponses(400, 401, 413, 422, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/locations': {
      get: {
        tags: ['locations'],
        summary: 'Browse locations (paginated)',
        parameters: [limitParam, offsetParam],
        responses: {
          200: okList('#/components/schemas/Location'),
          ...(errorResponses(401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/locations/{id}': {
      get: {
        tags: ['locations'],
        summary: 'Look up one location by id',
        parameters: [idParam('location')],
        responses: {
          200: response('The location.', '#/components/schemas/Location'),
          ...(errorResponses(401, 404, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/categories': {
      get: {
        tags: ['categories'],
        summary: 'Browse categories (paginated)',
        parameters: [limitParam, offsetParam],
        responses: {
          200: okList('#/components/schemas/CategorySummary'),
          ...(errorResponses(401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/categories/{id}': {
      get: {
        tags: ['categories'],
        summary: 'Look up one category by id (with its custom-field schema)',
        parameters: [idParam('category')],
        responses: {
          200: response('The category.', '#/components/schemas/CategoryDetail'),
          ...(errorResponses(401, 404, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/capabilities': {
      get: {
        tags: ['capabilities'],
        summary: 'Browse the queryable capability vocabulary (paginated)',
        description:
          'The distinct capability keys across active inventory, busiest first — the keys you ' +
          'can filter on with cap:<key> in a search query.',
        parameters: [limitParam, offsetParam],
        responses: {
          200: okList('#/components/schemas/CapabilityKey'),
          ...(errorResponses(401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/events': {
      get: {
        tags: ['events'],
        summary: 'Subscribe to the read-only Server-Sent Events stream',
        description:
          'Opt-in (GUBBINS_BRIDGE_EVENTS=on, or implied by GUBBINS_BRIDGE_WEBHOOKS=on); returns 404 ' +
          'when disabled. Holds the connection open and writes one "data: <BridgeEvent JSON>" frame ' +
          'per inventory change, each preceded by an SSE "id:" line for Last-Event-ID resumption, ' +
          'plus periodic ": heartbeat" comment frames. The first generation after a (re)start emits ' +
          'nothing (no history replay). Same bearer token + rate limit as every endpoint; strictly ' +
          'read-only. A 429 is returned when the concurrent-stream cap is reached.',
        parameters: [
          {
            name: 'lastEventId',
            in: 'query',
            required: false,
            description:
              'Resume after this event id (a query-string alias of the standard Last-Event-ID header, ' +
              'for clients that cannot set it). Events still buffered after this id are replayed on connect.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: 'The event stream.',
            content: {
              'text/event-stream': {
                schema: { type: 'string' },
                example:
                  'id: hist-0007\n' +
                  'data: {"id":"hist-0007","type":"item.low_stock","occurredAt":"2025-06-27T06:13:20.000Z",' +
                  '"data":{"itemId":"item-esp32","itemName":"ESP32 Dev Board","action":"QUANTITY_CHANGE",' +
                  '"kind":"stock","label":"Quantity changed","detail":"Checked out 4.","delta":"−4",' +
                  '"quantityDelta":-4,"netValueDelta":null,"item":null}}\n\n',
              },
            },
          },
          ...(errorResponses(401, 429) as Record<string, JsonValue>),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'The shared GUBBINS_BRIDGE_TOKEN, sent as "Authorization: Bearer <token>".',
      },
    },
    schemas: {
      Error: errorSchema,
      Pagination: paginationSchema,
      ApiIndex: {
        type: 'object',
        properties: {
          name: { type: 'string', example: 'Gubbins Bridge API' },
          version: { type: 'string', example: '1.0.0' },
          openapi: { type: 'string', example: '/api/v1/openapi.json' },
          writable: { type: 'boolean', description: 'Whether the opt-in write endpoints are enabled.' },
          pushable: {
            type: 'boolean',
            description: 'Whether the opt-in snapshot-ingest endpoint is enabled.',
          },
          streamable: {
            type: 'boolean',
            description: 'Whether the opt-in read-only SSE event stream (/api/v1/events) is enabled.',
          },
          endpoints: { type: 'array', items: { type: 'string' } },
        },
      },
      SnapshotAccepted: {
        type: 'object',
        required: ['ok', 'formatVersion', 'generatedAt'],
        properties: {
          ok: { type: 'boolean', example: true },
          formatVersion: { type: 'integer', example: 3 },
          generatedAt: { type: 'integer', description: 'UNIX-ms.', example: 1751004800000 },
        },
      },
      Health: {
        type: 'object',
        required: ['ok', 'itemCount', 'snapshotGeneratedAt'],
        properties: {
          ok: { type: 'boolean' },
          itemCount: { type: 'integer' },
          snapshotGeneratedAt: { type: 'string', nullable: true, format: 'date-time' },
        },
      },
      ItemMatch: {
        type: 'object',
        required: ['id', 'name', 'quantity', 'locationName', 'mpn', 'manufacturer'],
        properties: {
          id: { type: 'string', example: 'item-esp32' },
          name: { type: 'string', example: 'ESP32 Dev Board' },
          quantity: {
            type: 'integer',
            nullable: true,
            example: 7,
            description:
              'On-hand grand total; **null** for an unlimited-supply item (an infinite source has no finite count).',
          },
          locationName: { type: 'string', nullable: true, example: 'Shelf 2' },
          mpn: { type: 'string', nullable: true, example: 'DEV-ESP32' },
          manufacturer: { type: 'string', nullable: true, example: 'Synthetic Silicon Co' },
        },
      },
      SearchResult: {
        type: 'object',
        required: ['query', 'matches'],
        properties: {
          query: { type: 'string', example: 'ESP32' },
          matches: { type: 'array', items: { $ref: '#/components/schemas/ItemMatch' } },
        },
      },
      Placement: {
        type: 'object',
        required: ['locationId', 'locationName', 'quantity'],
        properties: {
          locationId: { type: 'string', example: 'loc-shelf-2' },
          locationName: { type: 'string', example: 'Shelf 2' },
          quantity: { type: 'integer', example: 5 },
        },
      },
      WhereIsMatch: {
        allOf: [
          { $ref: '#/components/schemas/ItemMatch' },
          {
            type: 'object',
            required: ['placements'],
            properties: {
              placements: { type: 'array', items: { $ref: '#/components/schemas/Placement' } },
            },
          },
        ],
      },
      WhereIsResult: {
        type: 'object',
        required: ['query', 'matches', 'spoken'],
        properties: {
          query: { type: 'string', example: 'ESP32' },
          matches: { type: 'array', items: { $ref: '#/components/schemas/WhereIsMatch' } },
          spoken: {
            type: 'string',
            example:
              'Your ESP32 Dev Board is spread across 2 locations: 5 on Shelf 2 and 2 in Bin 4 — 7 in total.',
          },
        },
      },
      Capability: {
        type: 'object',
        required: ['key', 'valueNum', 'valueText', 'weight'],
        properties: {
          key: { type: 'string', example: 'voltage' },
          valueNum: { type: 'number', nullable: true, example: 3.3 },
          valueText: { type: 'string', nullable: true, example: null },
          weight: { type: 'number', example: 2 },
        },
      },
      ItemSummary: {
        type: 'object',
        required: [
          'id',
          'name',
          'quantity',
          'isUnlimited',
          'locationId',
          'locationName',
          'categoryId',
          'mpn',
          'manufacturer',
          'trackingMode',
          'isActive',
        ],
        properties: {
          id: { type: 'string', example: 'item-m3-bolt' },
          name: { type: 'string', example: 'M3 x 10 Hex Bolt' },
          quantity: {
            type: 'integer',
            nullable: true,
            example: 42,
            description:
              'On-hand grand total across every location. **null** for an unlimited-supply ' +
              'item (`isUnlimited: true`) — an effectively infinite source has no finite count.',
          },
          isUnlimited: {
            type: 'boolean',
            example: false,
            description: 'True for an effectively infinite source (e.g. tap water); its `quantity` is null.',
          },
          locationId: { type: 'string', example: 'loc-drawer-a' },
          locationName: { type: 'string', nullable: true, example: 'Drawer A' },
          categoryId: { type: 'string', nullable: true, example: 'cat-fasteners' },
          mpn: { type: 'string', nullable: true, example: 'FAS-M3-10' },
          manufacturer: { type: 'string', nullable: true, example: 'Acme Fasteners' },
          trackingMode: {
            type: 'string',
            enum: ['DISCRETE', 'SERIALISED', 'CONSUMABLE_GAUGE', 'UNTRACKED'],
            example: 'DISCRETE',
          },
          isActive: { type: 'boolean', example: true },
        },
      },
      ItemDetail: {
        allOf: [
          { $ref: '#/components/schemas/ItemSummary' },
          {
            type: 'object',
            required: ['placements', 'capabilities'],
            properties: {
              description: { type: 'string', nullable: true },
              categoryName: { type: 'string', nullable: true, example: 'Fasteners' },
              unitCost: { type: 'number', nullable: true },
              condition: { type: 'string', nullable: true },
              serialNo: { type: 'integer', nullable: true },
              parentId: { type: 'string', nullable: true },
              expiryDate: { type: 'integer', nullable: true },
              batchNumber: { type: 'string', nullable: true },
              lotNumber: { type: 'string', nullable: true },
              createdAt: { type: 'integer' },
              updatedAt: { type: 'integer' },
              placements: { type: 'array', items: { $ref: '#/components/schemas/Placement' } },
              capabilities: { type: 'array', items: { $ref: '#/components/schemas/Capability' } },
            },
          },
        ],
      },
      Location: {
        type: 'object',
        required: ['id', 'name', 'parentId', 'isSystem', 'description', 'color', 'itemCount'],
        properties: {
          id: { type: 'string', example: 'loc-drawer-a' },
          name: { type: 'string', example: 'Drawer A' },
          parentId: { type: 'string', nullable: true, example: null },
          isSystem: { type: 'boolean', example: false },
          description: { type: 'string', nullable: true },
          color: { type: 'string', nullable: true },
          itemCount: { type: 'integer', example: 2 },
        },
      },
      CategoryField: {
        type: 'object',
        required: [
          'id',
          'name',
          'fieldType',
          'options',
          'isRequired',
          'defaultValue',
          'description',
          'position',
        ],
        properties: {
          id: { type: 'string' },
          name: { type: 'string', example: 'Voltage' },
          fieldType: { type: 'string', example: 'TEXT' },
          options: { type: 'array', items: { type: 'string' }, nullable: true },
          isRequired: { type: 'boolean' },
          defaultValue: { type: 'string', nullable: true },
          description: { type: 'string', nullable: true, example: 'Read from the label on the base.' },
          position: { type: 'integer' },
        },
      },
      CategorySummary: {
        type: 'object',
        required: ['id', 'name', 'fieldCount'],
        properties: {
          id: { type: 'string', example: 'cat-electronics' },
          name: { type: 'string', example: 'Electronics' },
          fieldCount: { type: 'integer', example: 0 },
        },
      },
      CategoryDetail: {
        type: 'object',
        required: ['id', 'name', 'fields'],
        properties: {
          id: { type: 'string', example: 'cat-electronics' },
          name: { type: 'string', example: 'Electronics' },
          fields: { type: 'array', items: { $ref: '#/components/schemas/CategoryField' } },
        },
      },
      CapabilityKey: {
        type: 'object',
        required: ['key', 'itemCount', 'hasNumericValues', 'hasTextValues'],
        properties: {
          key: { type: 'string', example: 'voltage' },
          itemCount: { type: 'integer', example: 1 },
          hasNumericValues: { type: 'boolean', example: true },
          hasTextValues: { type: 'boolean', example: false },
        },
      },
      BridgeEventData: {
        type: 'object',
        required: [
          'itemId',
          'itemName',
          'action',
          'kind',
          'label',
          'detail',
          'delta',
          'quantityDelta',
          'netValueDelta',
          'item',
        ],
        properties: {
          itemId: { type: 'string', example: 'item-esp32' },
          itemName: { type: 'string', example: 'ESP32 Dev Board' },
          action: {
            type: 'string',
            description: 'The raw §4 activity-ledger action.',
            example: 'QUANTITY_CHANGE',
          },
          kind: {
            type: 'string',
            enum: ['created', 'stock', 'movement', 'loan', 'lifecycle', 'supplier'],
            description: 'The semantic activity kind the action folds into.',
            example: 'stock',
          },
          label: { type: 'string', example: 'Quantity changed' },
          detail: { type: 'string', nullable: true, example: 'Checked out 4.' },
          delta: {
            type: 'string',
            nullable: true,
            description: 'A signed movement badge ("+3" / "−45.5"), or null when there was no movement.',
            example: '−4',
          },
          quantityDelta: { type: 'integer', nullable: true, example: -4 },
          netValueDelta: { type: 'number', nullable: true, example: null },
          item: {
            nullable: true,
            description: 'The item’s current summary, or null when the item is no longer present.',
            allOf: [{ $ref: '#/components/schemas/ItemSummary' }],
          },
        },
      },
      BridgeEvent: {
        type: 'object',
        required: ['id', 'type', 'occurredAt', 'data'],
        description:
          'One event delivered over the SSE stream and to outbound webhooks. `id` is deterministic ' +
          '(ledger-row-derived) so a consumer can dedupe; `type` is a stable dotted name.',
        properties: {
          id: { type: 'string', example: 'hist-0007' },
          type: {
            type: 'string',
            enum: [
              'item.created',
              'item.renamed',
              'stock.adjusted',
              'item.low_stock',
              'item.out_of_stock',
              'item.moved',
              'item.checked_out',
              'item.checked_in',
              'item.reserved',
              'item.reservation_cleared',
              'item.removed',
              'item.restored',
              'item.condition_changed',
              'item.maintenance_logged',
              'item.supplier_data_applied',
              'item.changed',
              'events.truncated',
            ],
            example: 'item.low_stock',
          },
          occurredAt: {
            type: 'string',
            format: 'date-time',
            description: 'The ledger row’s created_at as ISO-8601.',
            example: '2025-06-27T06:13:20.000Z',
          },
          data: { $ref: '#/components/schemas/BridgeEventData' },
        },
      },
    },
  },
};

function idParam(resource: string): JsonValue {
  return {
    name: 'id',
    in: 'path',
    required: true,
    description: `The ${resource} id.`,
    schema: { type: 'string' },
  };
}

/** The `{ delta, note? }` request body shared by both adjust endpoints. */
function adjustRequestBody(deltaDescription: string): JsonValue {
  return {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['delta'],
          properties: {
            delta: { type: 'number', description: deltaDescription, example: -1 },
            note: {
              type: 'string',
              nullable: true,
              maxLength: 500,
              description: 'Optional note recorded in the activity log.',
            },
          },
        },
      },
    },
  };
}
