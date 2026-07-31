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

import { KNOWN_EVENT_TYPES } from '@/features/events/event-types.ts';
import { ITEM_STATUS_FILTERS } from '@/db/repositories/item/status-filter.ts';
import { ITEM_FIELD_REGISTRY } from './api/item-view.ts';
import { LOCATION_FIELD_REGISTRY } from './api/location-view.ts';
import { FILTERABLE_FIELD_NAMES } from './api/odata-filter.ts';
import { SEARCHABLE_FIELD_NAMES } from './api/odata.ts';
import { API_ERROR_CODES } from './api/respond.ts';

/** A plain JSON value — the spec is pure data, serialisable to JSON and YAML alike. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const SERVER_URL = 'http://127.0.0.1:8787';

const bearerSecurity: JsonValue = [{ bearerAuth: [] }];

/**
 * The `{ error: { code, message } }` envelope every v1 error uses. The `code` enum is the whole
 * of {@link API_ERROR_CODES} — a published enum that omits a code the bridge can actually send
 * is worse than none, because a client branching on it meets an "impossible" value in the field.
 */
const errorSchema: JsonValue = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        // Derived from the codes `respond.ts` can actually send, never hand-listed beside them.
        code: { type: 'string', enum: [...API_ERROR_CODES] },
        message: { type: 'string' },
      },
    },
  },
};

/**
 * The flat `{ "error": "<message>" }` envelope the **unversioned** paths answer with — of which
 * `/metrics` is the only one this document describes. It is byte-for-byte the shape the bridge
 * has always returned there, kept so the existing consumers never regress; `respond.ts` picks
 * between the two envelopes from the request path, so an error at `/metrics` carries no `code`
 * and cannot be described by {@link errorSchema} (issue #367).
 */
const legacyErrorSchema: JsonValue = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'string',
      description: 'A short, secret-free explanation. No machine-readable code accompanies it.',
      example: 'Method not allowed',
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
 * The item and location field vocabularies, read straight off the registries that serve the
 * requests rather than restated here. A hand-kept copy of a field list is how the API's filterable
 * set silently drifted from the app's (issue #143), so every list in this document is generated
 * from its source. `field-vocabulary.test.ts` re-asserts that from the emitted document, so a
 * future hand-written copy is caught the moment a registry moves (issue #250).
 */
const ITEM_FIELD_LIST = [...ITEM_FIELD_REGISTRY.keys()].join(', ');
const LOCATION_FIELD_LIST = [...LOCATION_FIELD_REGISTRY.keys()].join(', ');

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
    '`fields=name,unitCost` returns just those two. Nest an array-of-object field with a dot: ' +
    `\`placements.quantity\`. An unknown field is a 400. Valid fields: ${ITEM_FIELD_LIST}.`,
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
    'top of the default payload. Groups: relations (placements, capabilities, categoryName, ' +
    'tags), pricing (unitCost, purchasePrice, currentValue), lifecycle (acquiredAt, warrantyExpiresAt, ' +
    'purchasePrice, depreciationMonths), reorder (reorderPoint, reorderGaugePercent, ' +
    'reorderQty), timestamps (createdAt, updatedAt), fields (fieldValues — the custom-field ' +
    'values, with location inheritance resolved), and all (every extended field). An ' +
    'unknown name is a 400.',
  schema: { type: 'string' },
  example: 'capabilities,notes',
};

/**
 * The `include` (field expansion) parameter for the **location** read endpoints. Locations
 * have a single extended field, `fieldValues` — the custom-field values the location holds.
 */
const locationIncludeParam: JsonValue = {
  name: 'include',
  in: 'query',
  required: false,
  description:
    'Field expansion: a comma-separated list of extended fields, or named groups, to ADD on ' +
    "top of the default payload. Groups: fields (fieldValues — the location's custom-field " +
    'values) and all. An unknown name is a 400.',
  schema: { type: 'string' },
  example: 'fields',
};

/** The `fields` (sparse fieldset) parameter for the location read endpoints. */
const locationFieldsParam: JsonValue = {
  name: 'fields',
  in: 'query',
  required: false,
  description:
    'Sparse fieldset: a comma-separated list of location fields to return INSTEAD of the ' +
    `default set. Valid fields: ${LOCATION_FIELD_LIST}. Nest the array field with a dot: ` +
    '`fieldValues.value`. An unknown field is a 400.',
  schema: { type: 'string' },
  example: 'id,name,fieldValues',
};

/**
 * OData-style query-option aliases on the **plain REST** endpoints — a convenience subset for
 * callers fluent in OData, which keeps the `{ data, pagination }` envelope. Each is an alias of
 * a plain REST parameter and wins when both are supplied; `$orderby` and `$filter` add genuinely
 * new capability on the items list. The same options drive the real OData service under
 * `/api/v1/odata`, which additionally speaks the protocol (service document, JSON envelope,
 * `OData-Version`) — see the `odata` tag.
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

const locationSelectParam = odataAlias('$select', 'fields', 'id,name,fieldValues');
const locationExpandParam = odataAlias('$expand', 'include', 'fields');

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
    `Free-text search across ${SEARCHABLE_FIELD_NAMES.join(', ')} via the FTS5 index. Matches ` +
    'whole-word prefixes across all of those columns at once, so it is the fast counterpart to ' +
    "$filter's contains(), which is an unindexed substring scan of one named field. Ignored when " +
    '$filter is set.',
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
    'SQL). Supported: comparisons eq/ne/gt/lt, the contains(field, string) function, and/or/not ' +
    'with parentheses, and single-quoted string / numeric / boolean literals. contains() is the ' +
    'substring test OData URL Conventions 5.1.1.8 defines - true when the text occurs anywhere ' +
    'in the field, mid-word included, ignoring case for ASCII - so it is a scan rather than a ' +
    'full-text index lookup; use $search for the fast whole-word match. Dates are quoted ' +
    "'YYYY-MM-DD' and money is in the base currency's major units. `tag` compares against a tag " +
    "name and matches when ANY of the item's tags does. Field names are case-insensitive. " +
    `Filterable fields: ${FILTERABLE_FIELD_NAMES.join(', ')}. Anything outside the subset ` +
    '(ge/le, startswith/endswith, arithmetic, lambdas, an unknown field) is a 400, as is an ' +
    'operator a field does not accept. When present it is the sole row filter ' +
    '(location/category/$search are ignored).',
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

/**
 * The conditional-request headers every polled subscription surface accepts (issue #363). A
 * client that echoes back the `ETag` (or the `Last-Modified`) it was given gets a `304` while
 * the snapshot is unchanged, and the bridge skips the projection entirely.
 */
const conditionalParams: readonly JsonValue[] = [
  {
    name: 'If-None-Match',
    in: 'header',
    required: false,
    description:
      'The weak ETag from a previous response. Matches ⇒ 304 Not Modified. Takes precedence over ' +
      'If-Modified-Since.',
    schema: { type: 'string' },
    example: 'W/"3Qk1s0Zk9pQmVzdEV0YWc"',
  },
  {
    name: 'If-Modified-Since',
    in: 'header',
    required: false,
    description:
      'The Last-Modified value from a previous response, for a client that keeps no ETag. Only ' +
      'consulted when If-None-Match is absent.',
    schema: { type: 'string' },
    example: 'Fri, 27 Jun 2025 04:53:20 GMT',
  },
];

/** The validators a polled subscription response carries, on both the `200` and the `304`. */
const validatorHeaders: JsonValue = {
  ETag: { schema: { type: 'string' }, description: 'The weak entity-tag of this representation.' },
  'Last-Modified': { schema: { type: 'string' }, description: 'When this representation last changed.' },
  'Cache-Control': {
    schema: { type: 'string' },
    description:
      'private, no-cache — store it, but revalidate every time. Private because a feed carries ' +
      'personal inventory behind a bearer token, so no shared cache may hold a copy.',
  },
};

/**
 * The `304 Not Modified` a revalidating poll gets. Bodyless, and it repeats the validators so the
 * client's stored copy is refreshed on the same terms a `200` would have set.
 */
const notModifiedResponse: JsonValue = {
  description:
    'The cached copy is still current — nothing has changed since the snapshot (or, for the ' +
    'calendar, the day) the validators name. No body.',
  headers: validatorHeaders,
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
        'weaker token-in-URL posture scoped to the feed/calendar paths. Read-only. A poll that ' +
        'sends back the previous ETag is answered 304 Not Modified while the snapshot is unchanged.',
      parameters: [feedTokenParam, feedLimitParam, ...conditionalParams],
      responses: {
        200: {
          description: 'The feed document.',
          headers: validatorHeaders,
          content: { [mediaType]: { schema: { type: 'string' }, example } },
        },
        304: notModifiedResponse,
        ...(errorResponses(401, 429) as Record<string, JsonValue>),
      },
    },
  };
}

/**
 * Standard error responses reused across operations, in whichever envelope the path answers with
 * (`errorRef`) — see {@link legacyErrorSchema}.
 *
 * Asking for `401` implies `403`: since issue #79 every authenticated route can also refuse a
 * *known* caller whose role does not reach it, and listing the two together at every call site
 * would be noise that one operation would eventually be missing.
 *
 * `405`, `500` and `503` are added to **every** operation for the same reason, only more so: all
 * three are answered by shared code that wraps the whole request — the method guard, the
 * snapshot-loaded gate and the outer catch-all, each of which runs in `server.ts` *before* the
 * request is routed anywhere. They are therefore reachable at every path, they belong to no single
 * operation, and OpenAPI 3 gives nowhere but each operation to declare them. A contract-testing
 * tool that meets one it cannot find in the document reports the *bridge* as at fault (issue #367).
 */
function errorResponsesIn(errorRef: string, codes: readonly number[]): JsonValue {
  const withForbidden = codes.includes(401) ? [...codes, 403] : codes;
  const requested = [...new Set([...withForbidden, 405, 500, 503])].sort((a, b) => a - b);
  const all: Record<number, JsonValue> = {
    400: response('Bad request — missing or invalid parameter.', errorRef),
    401: {
      description: 'Missing, unknown or revoked API token.',
      headers: { 'WWW-Authenticate': { schema: { type: 'string' }, description: 'Bearer' } },
      content: jsonContent(errorRef),
    },
    403: response("The token is valid, but its owner's role does not permit this route.", errorRef),
    404: response('Resource not found.', errorRef),
    405: {
      description:
        'The request method is not allowed. The bridge answers GET and HEAD everywhere, and POST ' +
        'only on the opt-in write, snapshot-ingest and webhook-test paths. Declared on every ' +
        'operation because the method guard runs ahead of routing, so it answers any request to ' +
        'this path — not only the method documented here. That is also why `Allow` is answered ' +
        'bridge-wide there rather than per path: on a bridge with a POST opt-in enabled it names ' +
        'POST even for a path that only reads. A POST the versioned router itself refuses is the ' +
        'one case answered with that resource’s own methods.',
      headers: {
        Allow: {
          schema: { type: 'string' },
          description:
            'The methods the bridge serves, e.g. "GET, HEAD, OPTIONS" — see the description above ' +
            'for when this is bridge-wide rather than scoped to the path.',
        },
      },
      content: jsonContent(errorRef),
    },
    413: response(
      'The pushed snapshot exceeded the configured maximum size (GUBBINS_BRIDGE_MAX_PUSH_BYTES).',
      errorRef,
    ),
    415: response('The request body was not declared as application/json.', errorRef),
    422: response(
      'The request was well-formed but rejected (e.g. quantity below zero, the wrong tracking mode, or a snapshot from a newer Gubbins build).',
      errorRef,
    ),
    429: {
      description: 'Rate limit exceeded for this client.',
      headers: {
        'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait.' },
      },
      content: jsonContent(errorRef),
    },
    500: {
      description:
        'An unexpected failure the bridge could not attribute to the request. The message is ' +
        'fixed and detail-free — no stack trace, file path, SQL or query text ever reaches a ' +
        'caller (the detail is logged locally only).',
      content: jsonContent(errorRef),
    },
    502: response(
      'Home Assistant could not be reached, refused the bridge’s access token, or answered ' +
        'unusably: home_assistant_unreachable, home_assistant_unauthorised or home_assistant_error.',
      errorRef,
    ),
    503: {
      description:
        'No snapshot has been loaded yet, so the bridge does not yet know who any caller is and ' +
        'lets nobody in. Reachable at every path — including the reads that need no snapshot data ' +
        'of their own — because the check precedes routing. Retry once the snapshot lands.',
      headers: {
        'Retry-After': {
          schema: { type: 'integer' },
          description: 'Seconds to wait before retrying.',
        },
      },
      content: jsonContent(errorRef),
    },
  };
  const out: Record<string, JsonValue> = {};
  for (const code of requested) {
    const value = all[code];
    if (value !== undefined) out[String(code)] = value;
  }
  return out;
}

/** The error responses of a versioned (`/api/v1`) operation — the structured envelope. */
const errorResponses = (...codes: number[]): JsonValue =>
  errorResponsesIn('#/components/schemas/Error', codes);

/** The error responses of an unversioned path — the flat, historical envelope. */
const legacyErrorResponses = (...codes: number[]): JsonValue =>
  errorResponsesIn('#/components/schemas/LegacyError', codes);

function jsonContent(ref: string, example?: JsonValue): JsonValue {
  const media: Record<string, JsonValue> = { schema: { $ref: ref } };
  if (example !== undefined) media.example = example;
  return { 'application/json': media };
}

function response(description: string, ref: string, example?: JsonValue): JsonValue {
  return { description, content: jsonContent(ref, example) };
}

/**
 * The `{id}` path parameter of an OData key segment. The template is `…({id})`, so the value
 * substituted is the key *inside* the parentheses — quoted or bare, both accepted.
 */
function odataKeyParam(resource: string): JsonValue {
  return {
    name: 'id',
    in: 'path',
    required: true,
    description: `The ${resource} id, e.g. \`'abc'\` (quotes optional).`,
    schema: { type: 'string' },
    example: "'abc'",
  };
}

/** The OData collection envelope: context, optional inline count, rows, optional paging link. */
function okODataCollection(itemRef: string): JsonValue {
  return {
    description: 'A page of results in the OData JSON envelope.',
    headers: {
      'OData-Version': { schema: { type: 'string' }, description: '4.0 (on every response).' },
    },
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['@odata.context', 'value'],
          properties: {
            '@odata.context': { type: 'string' },
            '@odata.count': {
              type: 'integer',
              description: 'The grand total across all pages — present only when $count=true.',
            },
            value: { type: 'array', items: { $ref: itemRef } },
            '@odata.nextLink': {
              type: 'string',
              description:
                'The absolute URL of the next page. Emitted whenever a full page came back, so ' +
                'on an exact-boundary last page it is present and leads to an empty collection — ' +
                'follow it until a page carries no link, rather than assuming every linked page ' +
                'has rows.',
            },
          },
        },
      },
    },
  };
}

function okList(description: string, itemRef: string): JsonValue {
  return {
    description,
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

/**
 * The nested, array-of-object element shapes. Each is declared once here and published twice:
 * strictly (every key guaranteed) for the reads that cannot be projected, and — via
 * {@link projectedElement} — without its `required` list for the reads that can. A dotted
 * `fields` path narrows an element to just the named sub-keys (`fields=placements.quantity`
 * yields `[{ "quantity": 5 }]`), so the strict shape cannot describe both (issue #367).
 */
const placementSchema: JsonValue = {
  type: 'object',
  required: ['locationId', 'locationName', 'quantity'],
  properties: {
    locationId: { type: 'string', example: 'loc-shelf-2' },
    locationName: { type: 'string', example: 'Shelf 2' },
    quantity: { type: 'integer', example: 5 },
  },
};

const capabilitySchema: JsonValue = {
  type: 'object',
  required: ['key', 'valueNum', 'valueText', 'weight'],
  properties: {
    key: { type: 'string', example: 'voltage' },
    valueNum: { type: 'number', nullable: true, example: 3.3 },
    valueText: { type: 'string', nullable: true, example: null },
    weight: { type: 'number', example: 2 },
  },
};

const itemFieldValueSchema: JsonValue = {
  type: 'object',
  description:
    "One of the item's custom-field values, resolved exactly as the app resolves it: a " +
    'value set on the item wins, otherwise the value offered by the nearest ancestor ' +
    'location that makes it inheritable, otherwise the field default. Fields with no ' +
    'value are omitted. Read-only.',
  required: ['name', 'fieldType', 'value', 'source', 'inheritedFrom'],
  properties: {
    name: { type: 'string', example: 'Datasheet' },
    fieldType: { type: 'string', example: 'TEXT' },
    value: { type: 'string', example: 'https://example.com/esp32.pdf' },
    source: {
      type: 'string',
      enum: ['stored', 'inherited', 'default'],
      example: 'stored',
      description:
        'Where the value came from: set on the item (`stored`), inherited from an ' +
        'ancestor location (`inherited`), or the field default (`default`).',
    },
    inheritedFrom: {
      type: 'object',
      nullable: true,
      description: 'The location that supplied the value when `source` is `inherited`; null otherwise.',
      required: ['locationId', 'locationName'],
      properties: {
        locationId: { type: 'string', example: 'loc-shelf-2' },
        locationName: { type: 'string', example: 'Shelf 2' },
      },
    },
  },
};

const locationFieldValueSchema: JsonValue = {
  type: 'object',
  description: 'One custom-field value held by a location. Fields with no value are omitted. Read-only.',
  required: ['name', 'fieldType', 'value', 'isInheritable'],
  properties: {
    name: { type: 'string', example: 'Indicator Entity' },
    fieldType: { type: 'string', example: 'TEXT' },
    value: { type: 'string', example: 'light.shelf_two' },
    isInheritable: {
      type: 'boolean',
      example: true,
      description:
        'True when the location offers this value to the items stored beneath it; false ' +
        "when it is the location's own metadata only.",
    },
  },
};

/**
 * The projected twin of a nested element schema: the same shape with its `required` list
 * dropped, because a dotted `fields` path can narrow the element to any subset of its keys.
 * Derived rather than restated so the two can never disagree about a property.
 */
function projectedElement(strict: JsonValue): JsonValue {
  const { required: _required, ...rest } = strict as Record<string, JsonValue>;
  const note =
    'Returned by a read that accepts a sparse fieldset: a dotted path such as ' +
    '`placements.quantity` narrows each element to exactly the named sub-keys, so no property ' +
    'here is required. Without one, every property below is present.';
  const existing = rest.description;
  return { ...rest, description: typeof existing === 'string' ? `${existing}\n\n${note}` : note };
}

/**
 * Every field the item projection engine can return, described **once**.
 *
 * `ItemSummary`, `ItemDetail` and `ItemProjection` are all curated views over this map, so a
 * field is typed and explained in exactly one place and the three can never disagree about it.
 * The keys are the field vocabulary of `api/item-view.ts` — the names a caller may pass to
 * `fields`/`$select` and `include`/`$expand` — and a drift test asserts the two stay identical,
 * so adding a field to the engine without describing it here fails the build.
 *
 * `ItemMatch` is deliberately *not* built from this map: it is the compact `/where` DTO, whose
 * `locationId` is resolved through the locations table (and so is null when an item's home
 * location cannot be resolved), whereas the projection engine reads the raw column.
 */
const itemFieldSchemas: Readonly<Record<string, JsonValue>> = {
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
  locationId: {
    type: 'string',
    example: 'loc-drawer-a',
    description: 'The stable id of the item’s primary/home location — what an automation acts on.',
  },
  locationName: { type: 'string', nullable: true, example: 'Drawer A' },
  categoryId: { type: 'string', nullable: true, example: 'cat-fasteners' },
  categoryName: { type: 'string', nullable: true, example: 'Fasteners' },
  mpn: { type: 'string', nullable: true, example: 'FAS-M3-10' },
  manufacturer: { type: 'string', nullable: true, example: 'Acme Fasteners' },
  trackingMode: {
    type: 'string',
    enum: ['DISCRETE', 'SERIALISED', 'CONSUMABLE_GAUGE', 'UNTRACKED'],
    example: 'DISCRETE',
  },
  isActive: { type: 'boolean', example: true },
  description: {
    type: 'string',
    nullable: true,
    description: 'What the item *is* — factual, display-worthy copy.',
  },
  notes: { type: 'string', nullable: true, description: 'The owner’s own free-text remarks.' },
  condition: {
    type: 'string',
    nullable: true,
    description: 'Operational condition; null when untracked.',
  },
  barcode: {
    type: 'string',
    nullable: true,
    example: '5012345678900',
    description:
      'The retail barcode (GTIN — EAN/UPC) printed on the article; null if none. Distinct from ' +
      '`mpn`, which is the maker’s own code.',
  },
  isFavourite: {
    type: 'boolean',
    example: false,
    description: 'True when the user has starred this item.',
  },
  serialNumber: {
    type: 'string',
    nullable: true,
    example: 'SN-2024-0042',
    description: 'The maker’s per-unit identifier as printed on the article.',
  },
  serialNo: {
    type: 'integer',
    nullable: true,
    description: 'Instance number (1..N) of a SERIALISED clone; null otherwise.',
  },
  parentId: {
    type: 'string',
    nullable: true,
    description: 'The parent item when this is a child variant; null for a standalone item.',
  },
  unitCost: {
    type: 'number',
    nullable: true,
    description: 'Current replacement value per unit, in the base currency; null if unpriced.',
  },
  purchasePrice: {
    type: 'number',
    nullable: true,
    description: 'Original acquisition cost, in the base currency; null if unpriced.',
  },
  currentValue: {
    type: 'number',
    nullable: true,
    description:
      'Manual current/market value per unit, in the base currency; null when none is set. When ' +
      'present it wins over the depreciated replacement cost in valuation.',
  },
  weight: {
    type: 'number',
    nullable: true,
    description: 'Intrinsic mass in canonical **grams**; null when not recorded.',
  },
  width: {
    type: 'number',
    nullable: true,
    description: 'Intrinsic bounding-box width in canonical **millimetres**; null when not recorded.',
  },
  height: {
    type: 'number',
    nullable: true,
    description: 'Intrinsic bounding-box height in canonical **millimetres**; null when not recorded.',
  },
  depth: {
    type: 'number',
    nullable: true,
    description: 'Intrinsic bounding-box depth in canonical **millimetres**; null when not recorded.',
  },
  expiryDate: {
    type: 'integer',
    nullable: true,
    description: 'Perishable expiry instant (UNIX-ms); null when non-perishable.',
  },
  batchNumber: { type: 'string', nullable: true },
  lotNumber: { type: 'string', nullable: true },
  acquiredAt: {
    type: 'string',
    format: 'date',
    nullable: true,
    example: '2025-03-14',
    description: 'Acquisition date (YYYY-MM-DD); null when untracked.',
  },
  warrantyExpiresAt: {
    type: 'string',
    format: 'date',
    nullable: true,
    example: '2027-06-15',
    description: 'Warranty expiry date (YYYY-MM-DD); null when untracked.',
  },
  depreciationMonths: {
    type: 'integer',
    nullable: true,
    description: 'Useful life for straight-line depreciation; null when it does not depreciate.',
  },
  deadStockMode: {
    type: 'string',
    enum: ['inherit', 'always', 'never'],
    example: 'inherit',
    description:
      'Whether this item is reported as dead stock. `inherit` — the default — defers to the ' +
      'item’s location chain; the other two override it.',
  },
  reorderPoint: {
    type: 'integer',
    nullable: true,
    description: 'This item’s own DISCRETE low-stock floor; null falls back to the global default.',
  },
  reorderGaugePercent: {
    type: 'number',
    nullable: true,
    description:
      'This item’s own CONSUMABLE_GAUGE percentage-remaining floor; null falls back to the global default.',
  },
  reorderQty: {
    type: 'integer',
    nullable: true,
    description: 'Suggested top-up amount for the shopping list; null when unset.',
  },
  operationalMetadata: {
    type: 'object',
    nullable: true,
    additionalProperties: true,
    description:
      'A schema-less map of arbitrary operational parameters (e.g. `{ "bed_temp_celsius": 60 }`); ' +
      'null when none are set.',
    example: { bed_temp_celsius: 60 },
  },
  gauge: {
    nullable: true,
    description: 'The consumable-gauge state; null unless `trackingMode` is CONSUMABLE_GAUGE.',
    allOf: [{ $ref: '#/components/schemas/GaugeState' }],
  },
  createdAt: { type: 'integer', description: 'UNIX-ms.' },
  updatedAt: { type: 'integer', description: 'UNIX-ms.' },
  // The three nested fields point at the *projected* element schemas: a dotted `fields` path
  // narrows their elements too. `ItemDetail` overrides them with the strict shapes, because a
  // write response is never projected.
  placements: {
    type: 'array',
    description: 'Where this item’s stock sits, per location.',
    items: { $ref: '#/components/schemas/PlacementProjection' },
  },
  capabilities: {
    type: 'array',
    description: 'The item’s queryable capability values.',
    items: { $ref: '#/components/schemas/CapabilityProjection' },
  },
  tags: {
    type: 'array',
    description:
      'The names of the tags this item carries, ordered by name. A tag *is* its name, so these ' +
      "values can be fed straight back into a `$filter` as `tag eq '<name>'`. Only the item's " +
      'own tags — a tag on its location belongs to that location.',
    items: { type: 'string' },
    example: ['fragile', 'workshop'],
  },
  fieldValues: {
    type: 'array',
    description: 'The item’s custom-field values, with location inheritance resolved.',
    items: { $ref: '#/components/schemas/ItemFieldValueProjection' },
  },
};

/** The `ItemSummary` field set — the default payload of `GET /api/v1/items` rows. */
const ITEM_SUMMARY_FIELDS: readonly string[] = [
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
];

/** What `ItemDetail` adds on top of `ItemSummary` — the default payload of `GET /api/v1/items/{id}`. */
const ITEM_DETAIL_EXTRA_FIELDS: readonly string[] = [
  'description',
  'categoryName',
  'unitCost',
  'condition',
  'serialNumber',
  'serialNo',
  'parentId',
  'expiryDate',
  'batchNumber',
  'lotNumber',
  'createdAt',
  'updatedAt',
  'placements',
  'capabilities',
  'tags',
];

/**
 * Build a `properties` map for the named subset of {@link itemFieldSchemas}. Throws on an
 * unknown name rather than emitting an `undefined` value that would serialise to broken YAML.
 */
function itemProps(names: readonly string[]): JsonValue {
  return Object.fromEntries(
    names.map((name) => {
      const schema = itemFieldSchemas[name];
      if (schema === undefined) throw new Error(`No item field schema for "${name}"`);
      return [name, schema];
    }),
  );
}

export const openapiDocument: JsonValue = {
  openapi: '3.0.3',
  info: {
    title: 'Gubbins Bridge API',
    version: '1.0.0',
    description:
      'Read-only HTTP API over a Gubbins inventory snapshot, served by the local companion ' +
      'bridge. Every endpoint is a read and requires a bearer token; each accepts HEAD as well ' +
      'as GET (same status and headers, no body), so a calendar or feed client can probe a URL ' +
      'before subscribing to it. The one exception is /api/v1/events: a HEAD there reports the ' +
      'media type the stream serves and returns at once, rather than opening a stream, so it ' +
      'carries no Content-Length and never the 429 a GET gives at the concurrent-stream cap. ' +
      'The unversioned paths ' +
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
      name: 'odata',
      description:
        'A conformant (if small) OData v4 read service at /api/v1/odata, for tools that speak ' +
        'OData natively — Excel/Power Query, Power BI, Simple.OData.Client. It serves a service ' +
        'document, the CSDL $metadata, and the same items/locations/categories reads in the ' +
        'OData JSON envelope ({ "@odata.context", "value" }) with the OData-Version header. The ' +
        'plain /api/v1 endpoints keep their { data, pagination } envelope, so nothing here ' +
        'changes an existing consumer. Only the items set is filterable, sortable, countable and ' +
        'searchable; the CSDL says so in Org.OData.Capabilities.V1 terms, and a system query ' +
        'option a resource does not support is a 400 rather than being ignored.',
    },
    {
      name: 'writes',
      description:
        'Opt-in stock and loan mutations (off by default; enabled with ' +
        'GUBBINS_BRIDGE_ALLOW_WRITES=on). Each write round-trips through the same sync merge the ' +
        'PWA uses, so it is applied without drift on the next sync. When writes are disabled ' +
        'these paths return 404.',
    },
    {
      name: 'push',
      description:
        'Opt-in snapshot ingest — the PWA "push to bridge" (off by default; enabled with ' +
        'GUBBINS_BRIDGE_ALLOW_PUSH=on, and only for a JSON snapshot source). A separate opt-in ' +
        'from writes, but a wider privilege: it merges caller-supplied content into the whole ' +
        'served dataset, not a single bounded stock delta. Accepts the same versioned backup JSON ' +
        'the bridge reads from a synced folder, merges it into the served snapshot and writes the ' +
        'result atomically; the watcher then re-hydrates. When push is disabled this path returns 404.',
    },
    {
      name: 'events',
      description:
        'Opt-in read-only event stream (off by default; enabled with GUBBINS_BRIDGE_EVENTS=on, or ' +
        'implied by GUBBINS_BRIDGE_WEBHOOKS=on). A Server-Sent Events feed of typed inventory-change ' +
        'events, the same events delivered to outbound webhooks. When disabled this path returns 404.',
    },
    {
      name: 'webhooks',
      description:
        'Opt-in outbound webhooks (off by default; enabled with GUBBINS_BRIDGE_WEBHOOKS=on). The ' +
        'bridge is the sole deliverer: subscriptions are configured in the app and arrive over the ' +
        'existing sync, and the operator’s webhooks.json / GUBBINS_BRIDGE_WEBHOOKS_TARGETS entries ' +
        'are merged alongside them. Delivery outcomes cannot be written back into the snapshot (it ' +
        'is swapped wholesale on every hydration), so the bridge keeps an in-memory delivery log ' +
        'and exposes it here for the app to poll. When disabled this path returns 404.',
    },
    {
      name: 'scale',
      description:
        'Opt-in Home Assistant reads (off by default; enabled with GUBBINS_BRIDGE_HA=on) — the ' +
        'inbound path behind "count by weight". Lets the app read a live weight off a Home ' +
        'Assistant scale entity, reconciled to canonical grams. Outbound-only and read-only: the ' +
        'bridge calls Home Assistant and cannot invoke a service. When disabled these return 404.',
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
        tags: ['odata'],
        summary: 'Moved — redirects to the OData service’s own $metadata',
        description:
          'A CSDL is only actionable from the service root whose entity sets it declares, so the ' +
          'document now lives at /api/v1/odata/$metadata. This path answers 301 with that ' +
          'location; every OData client follows it.',
        responses: {
          301: {
            description: 'Permanent redirect to /api/v1/odata/$metadata.',
            headers: {
              Location: { schema: { type: 'string' }, description: '/api/v1/odata/$metadata' },
            },
          },
          ...(errorResponses(401, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/odata': {
      get: {
        tags: ['odata'],
        summary: 'OData service document — the entity sets on offer',
        description:
          'The document an OData client reads first (OData Protocol §11.1.1): a @odata.context ' +
          'pointing at $metadata and a value array naming the items, locations and categories ' +
          'entity sets. Answered without a loaded snapshot — it describes the service, not the ' +
          'inventory.',
        responses: {
          200: {
            description: 'The service document.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['@odata.context', 'value'],
                  properties: {
                    '@odata.context': { type: 'string' },
                    value: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          kind: { type: 'string' },
                          url: { type: 'string' },
                        },
                      },
                    },
                  },
                },
                example: {
                  '@odata.context': `${SERVER_URL}/api/v1/odata/$metadata`,
                  value: [{ name: 'items', kind: 'EntitySet', url: 'items' }],
                },
              },
            },
          },
          ...(errorResponses(401, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/odata/$metadata': {
      get: {
        tags: ['odata'],
        summary: 'OData CSDL $metadata',
        description:
          'The OData v4 CSDL describing the read model — the items/locations/categories entity ' +
          'sets, their complex types, which properties a default (unprojected) request returns, ' +
          'and the Org.OData.Capabilities.V1 restrictions naming exactly what each set can be ' +
          'filtered, sorted, counted and searched on. Answered without a loaded snapshot.',
        responses: {
          200: {
            description: 'The CSDL $metadata XML.',
            content: { 'application/xml': { schema: { type: 'string' } } },
          },
          ...(errorResponses(401, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/odata/items': {
      get: {
        tags: ['odata'],
        summary: 'The items entity set, in the OData JSON envelope',
        description:
          'The same rows as GET /api/v1/items — same paging, same $filter/$orderby/$search/' +
          '$select/$expand — wrapped as { "@odata.context", "@odata.count"?, "value", ' +
          '"@odata.nextLink"? }. $count=true reports the grand total as @odata.count. A page ' +
          'capped by the server carries @odata.nextLink; when $top was given, the link’s $top is ' +
          'reduced by the rows already delivered, so following the chain returns exactly that ' +
          'many rows. This is the only entity set that accepts $filter, $orderby, $search or ' +
          '$count; a system query option a set does not support is a 400, not silently ignored.',
        parameters: [
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
          200: okODataCollection('#/components/schemas/ItemSummary'),
          ...(errorResponses(400, 401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/odata/items({id})': {
      get: {
        tags: ['odata'],
        summary: 'One item by key, in the OData JSON envelope',
        description:
          'The canonical OData key-in-parentheses form; the unquoted items(abc) and named ' +
          "items(id='abc') spellings are accepted too. Returns the ItemDetail shape with a " +
          '@odata.context ending in /$entity, or 404.',
        parameters: [odataKeyParam('item'), selectParam, expandParam],
        responses: {
          200: response('The item, plus @odata.context.', '#/components/schemas/ItemDetail'),
          ...(errorResponses(400, 401, 404, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/odata/items/$count': {
      get: {
        tags: ['odata'],
        summary: 'The matching item count as a raw value',
        description:
          'The OData raw-value count: the grand total of matching items as a bare text/plain ' +
          'integer, honouring $filter/$search. items is the only countable entity set; the same ' +
          'path on locations or categories is a 404, as the CSDL’s CountRestrictions say.',
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
    '/api/v1/odata/locations': {
      get: {
        tags: ['odata'],
        summary: 'The locations entity set, in the OData JSON envelope',
        description:
          'A plain paged read: $select, $expand, $top and $skip only. This set is not filterable, ' +
          'sortable, countable or searchable — the CSDL declares that, and asking anyway is a 400.',
        parameters: [locationSelectParam, locationExpandParam, topParam, skipParam],
        responses: {
          200: okODataCollection('#/components/schemas/Location'),
          ...(errorResponses(400, 401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/odata/locations({id})': {
      get: {
        tags: ['odata'],
        summary: 'One location by key, in the OData JSON envelope',
        parameters: [odataKeyParam('location'), locationSelectParam, locationExpandParam],
        responses: {
          200: response('The location, plus @odata.context.', '#/components/schemas/Location'),
          ...(errorResponses(400, 401, 404, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/odata/categories': {
      get: {
        tags: ['odata'],
        summary: 'The categories entity set, in the OData JSON envelope',
        description: 'A plain paged read: $top and $skip only.',
        parameters: [topParam, skipParam],
        responses: {
          200: okODataCollection('#/components/schemas/CategorySummary'),
          ...(errorResponses(400, 401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/odata/categories({id})': {
      get: {
        tags: ['odata'],
        summary: 'One category by key, in the OData JSON envelope',
        parameters: [odataKeyParam('category')],
        responses: {
          200: response(
            'The category and its field schema, plus @odata.context.',
            '#/components/schemas/CategoryDetail',
          ),
          ...(errorResponses(400, 401, 404, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/health': {
      get: {
        tags: ['meta'],
        summary: 'Liveness, a cheap snapshot summary, and snapshot freshness',
        responses: {
          200: response('Health summary.', '#/components/schemas/Health', {
            ok: true,
            itemCount: 4,
            snapshotGeneratedAt: '2025-06-27T06:13:20.000Z',
            snapshotStale: false,
            reloadFailures: 0,
            lastReloadError: null,
            lastReloadErrorAt: null,
            lastReloadAt: '2025-06-27T06:13:21.000Z',
          }),
          ...(errorResponses(401, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/status': {
      get: {
        tags: ['meta'],
        summary: 'How many active items currently match each attention status',
        description:
          'The same counts the app’s inventory filter chips show — low stock, out of stock, on ' +
          'order, expiring, warranty expiring, on loan, overdue and maintenance due. Every status ' +
          'is always present, so a status matching nothing is a 0 rather than a missing key. ' +
          'Aggregates only: no loan, order or schedule detail is disclosed. Kept apart from ' +
          '/health because it scans items, so liveness stays cheap to poll.',
        responses: {
          200: response('The attention counts.', '#/components/schemas/ItemStatusCounts', {
            statuses: {
              'low-stock': 3,
              'out-of-stock': 1,
              'on-order': 0,
              expiring: 2,
              warranty: 0,
              'on-loan': 4,
              overdue: 1,
              'maintenance-due': 0,
            },
            snapshotGeneratedAt: '2025-06-27T06:13:20.000Z',
          }),
          ...(errorResponses(401, 429) as Record<string, JsonValue>),
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
          ...(errorResponses(400, 401, 429) as Record<string, JsonValue>),
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
          ...(errorResponses(400, 401, 429) as Record<string, JsonValue>),
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
          200: okList(
            'A page of items. Each row is the full `ItemSummary` shape (plus anything added with ' +
              '`include`/`$expand`) unless `fields`/`$select` projects it to exactly the named fields.',
            '#/components/schemas/ItemProjection',
          ),
          ...(errorResponses(400, 401, 429) as Record<string, JsonValue>),
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
          ...(errorResponses(400, 401, 429) as Record<string, JsonValue>),
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
          ...(errorResponses(400, 401, 429) as Record<string, JsonValue>),
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
          'scoped to this one path — keep the bridge loopback/LAN posture in mind). Read-only. A ' +
          'poll that sends back the previous ETag is answered 304 Not Modified until the snapshot ' +
          'changes (or a day-grained cut-off rolls over), so a subscription costs a header exchange.',
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
          ...conditionalParams,
        ],
        responses: {
          200: {
            description: 'The iCalendar document.',
            headers: validatorHeaders,
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
          304: notModifiedResponse,
          ...(errorResponses(400, 401, 429) as Record<string, JsonValue>),
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
          'drift. Auth is header-only here (no ?token=); a scrape config sends the bearer token. ' +
          'A client that revalidates with the previous ETag is answered 304 Not Modified while the ' +
          'snapshot is unchanged; a Prometheus scrape sends no conditional header and is unaffected.',
        parameters: [...conditionalParams],
        responses: {
          200: {
            description: 'The metrics exposition.',
            headers: validatorHeaders,
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
          304: notModifiedResponse,
          // The one unversioned path here, so its errors are the FLAT legacy envelope.
          ...(legacyErrorResponses(401, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/items/{id}': {
      get: {
        tags: ['items'],
        summary: 'Look up one item by id (with placements, capabilities and tags)',
        description:
          'One item with its full detail. Use `fields`/`$select` to project a sparse fieldset ' +
          '(e.g. just the price) or `include`/`$expand` to add extended fields beyond the ' +
          'default detail payload.',
        parameters: [idParam('item'), fieldsParam, includeParam, selectParam, expandParam],
        responses: {
          200: response(
            'The item — the full `ItemDetail` shape (plus anything added with `include`/`$expand`) ' +
              'unless `fields`/`$select` projects it to exactly the named fields.',
            '#/components/schemas/ItemProjection',
          ),
          ...(errorResponses(400, 401, 404, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/items/{id}/adjust-quantity': {
      post: {
        tags: ['writes'],
        summary: 'Adjust a DISCRETE item’s quantity by a signed delta',
        description:
          'Opt-in (GUBBINS_BRIDGE_ALLOW_WRITES=on); returns 404 when writes are disabled. Applies ' +
          'a signed delta to the item’s home-location stock and logs it, exactly as the app does, ' +
          'then writes the merged snapshot back so the PWA reconciles it (LWW) on its next sync. ' +
          'This is stock going in or out, not a loan — to lend an item to someone and get it back, ' +
          'use check-out / check-in, which track who has it.',
        parameters: [idParam('item')],
        requestBody: adjustRequestBody('Whole-number change; negative to take stock out.'),
        responses: {
          200: response('The updated item.', '#/components/schemas/ItemDetail'),
          ...(errorResponses(400, 401, 404, 415, 422, 429) as Record<string, JsonValue>),
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
          ...(errorResponses(400, 401, 404, 415, 422, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/items/{id}/check-out': {
      post: {
        tags: ['writes'],
        summary: 'Lend an item out to a contact, project or location',
        description:
          'Opt-in (GUBBINS_BRIDGE_ALLOW_WRITES=on); returns 404 when writes are disabled. Opens a ' +
          'loan exactly as the app does — a discrete item’s stock is drawn down from the source ' +
          'placement while the loan is open, a serialised item goes out as a whole and cannot be ' +
          'lent twice. Supply exactly one borrower; naming a contact that does not exist creates ' +
          'it, as the app does. The response carries the loan, whose id names it at check-in and ' +
          'is the id the calendar feed embeds in that loan’s UID (loan-<id>@gubbins.invalid). ' +
          'Needs checkouts:write (not stock:write).',
        parameters: [idParam('item')],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description:
                  'Exactly one of contactId / contactName / projectId / locationId identifies the ' +
                  'borrower; supplying none or several is a 422.',
                properties: {
                  contactId: { type: 'string', description: 'Lend to this existing contact.' },
                  contactName: {
                    type: 'string',
                    maxLength: 500,
                    description: 'Lend to a contact by name, creating it when there is no match.',
                  },
                  projectId: { type: 'string', description: 'Lend to this existing project.' },
                  locationId: {
                    type: 'string',
                    description: 'Lend to this existing location ("in the van").',
                  },
                  quantity: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Units to lend; defaults to 1. A serialised item always lends as 1.',
                  },
                  dueDate: {
                    type: 'string',
                    format: 'date',
                    nullable: true,
                    description:
                      'Due date as a calendar day (yyyy-MM-dd), anchored at local end-of-day so a ' +
                      'loan due "the 20th" only reads overdue once the 20th is over. Null or absent ' +
                      'for an open-ended loan.',
                    example: '2026-08-14',
                  },
                  fromLocationId: {
                    type: 'string',
                    description:
                      'Draw the units from this placement (the return restores them there); ' +
                      'defaults to the item’s own location.',
                  },
                  note: {
                    type: 'string',
                    nullable: true,
                    maxLength: 500,
                    description: 'Optional note recorded on the loan and in the activity log.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: response('The updated item and the loan that was opened.', '#/components/schemas/LoanResult'),
          ...(errorResponses(400, 401, 404, 415, 422, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/items/{id}/check-in': {
      post: {
        tags: ['writes'],
        summary: 'Return a lent item, closing its loan',
        description:
          'Opt-in (GUBBINS_BRIDGE_ALLOW_WRITES=on); returns 404 when writes are disabled. Restores ' +
          'the units to the placement (and lot) they were lent from and stamps the loan returned, ' +
          'exactly as the app does. `checkoutId` is optional when the item has exactly one open ' +
          'loan, and required (422) once it has more than one. Needs checkouts:write (not ' +
          'stock:write).',
        parameters: [idParam('item')],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  checkoutId: {
                    type: 'string',
                    description:
                      'Which loan to close. Only needed when the item has more than one open loan; ' +
                      'it must belong to this item and still be open.',
                  },
                  note: {
                    type: 'string',
                    nullable: true,
                    maxLength: 500,
                    description:
                      'Optional remark recorded on the return (kept separate from the loan’s own note).',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: response('The updated item and the loan that was closed.', '#/components/schemas/LoanResult'),
          ...(errorResponses(400, 401, 404, 415, 422, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/items/{id}/transfer-stock': {
      post: {
        tags: ['writes'],
        summary: 'Move units of a DISCRETE item between two locations',
        description:
          'Opt-in (GUBBINS_BRIDGE_ALLOW_WRITES=on); returns 404 when writes are disabled. Moves ' +
          'stock between placements in the per-location ledger, leaving the item’s total ' +
          'unchanged — what adjust-quantity cannot do, since it only ever touches the item’s home ' +
          'location. Each moved lot keeps its batch and expiry at the destination. The whole ' +
          'amount moves or none of it does: too little on hand at the source is a 422, never a ' +
          'silent partial move.',
        parameters: [idParam('item')],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['fromLocationId', 'toLocationId', 'quantity'],
                properties: {
                  fromLocationId: { type: 'string', description: 'The location the units move out of.' },
                  toLocationId: { type: 'string', description: 'The location the units move into.' },
                  quantity: {
                    type: 'integer',
                    minimum: 1,
                    description: 'How many units to move.',
                    example: 5,
                  },
                },
              },
            },
          },
        },
        responses: {
          200: response('The updated item.', '#/components/schemas/ItemDetail'),
          ...(errorResponses(400, 401, 404, 415, 422, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/snapshot': {
      post: {
        tags: ['push'],
        summary: 'Merge a pushed snapshot into the served one (the PWA "push to bridge")',
        description:
          'Opt-in (GUBBINS_BRIDGE_ALLOW_PUSH=on, JSON source only); returns 404 when push is ' +
          'disabled or the source is a raw .sqlite. A separate opt-in from writes but a wider ' +
          'privilege — it merges caller-supplied content into the whole served dataset, not a ' +
          'single bounded stock delta. Accepts the same versioned backup JSON the PWA writes to a ' +
          'synced folder, validates it with the format-version guard, merges it into the served ' +
          'snapshot (placed verbatim only when there is nothing to merge into) and writes the ' +
          'result atomically. The watcher then re-hydrates it through the normal path, so ' +
          'subsequent reads reflect the pushed data. The body is capped at ' +
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
          ...(errorResponses(400, 401, 404, 413, 415, 422, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/locations': {
      get: {
        tags: ['locations'],
        summary: 'Browse locations (paginated)',
        description:
          'The physical storage hierarchy, each entry with its live item count. Use `include=fields` ' +
          "to add `fieldValues` — the location's custom-field values, which is where a user records " +
          'metadata such as the entity id of a light above a shelf.',
        parameters: [
          limitParam,
          offsetParam,
          locationFieldsParam,
          locationIncludeParam,
          selectParam,
          expandParam,
        ],
        responses: {
          200: okList(
            'A page of locations. Each row is the full default location payload (plus `fieldValues` ' +
              'when included) unless `fields`/`$select` projects it to exactly the named fields.',
            '#/components/schemas/Location',
          ),
          ...(errorResponses(401, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/locations/{id}': {
      get: {
        tags: ['locations'],
        summary: 'Look up one location by id',
        description:
          "One location with its live item count. Use `include=fields` to add the location's " +
          'custom-field values (`fieldValues`).',
        parameters: [
          idParam('location'),
          locationFieldsParam,
          locationIncludeParam,
          selectParam,
          expandParam,
        ],
        responses: {
          200: response('The location.', '#/components/schemas/Location'),
          ...(errorResponses(401, 404, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/categories': {
      get: {
        tags: ['categories'],
        summary: 'Browse categories (paginated)',
        parameters: [limitParam, offsetParam],
        responses: {
          200: okList('A page of categories.', '#/components/schemas/CategorySummary'),
          ...(errorResponses(401, 429) as Record<string, JsonValue>),
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
          ...(errorResponses(401, 404, 429) as Record<string, JsonValue>),
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
          200: okList('A page of capability keys.', '#/components/schemas/CapabilityKey'),
          ...(errorResponses(401, 429) as Record<string, JsonValue>),
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
          ...(errorResponses(401, 404, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/webhooks/deliveries': {
      get: {
        tags: ['webhooks'],
        summary: 'Read the bridge’s recent webhook delivery outcomes',
        description:
          'Opt-in (GUBBINS_BRIDGE_WEBHOOKS=on); returns 404 when disabled. The bridge is read-only ' +
          'over a snapshot that is swapped wholesale on every hydration, so it cannot record a ' +
          'delivery outcome back into the database — anything it wrote would be discarded on the ' +
          'next hydrate. It therefore keeps a bounded in-memory log, which the app polls while its ' +
          'Webhooks screen is open. The log does not survive a bridge restart. No secret, ' +
          'signature, request header or query string is ever recorded, and each URL is reduced to ' +
          'its origin and path. Reads the bridge’s own memory rather than the snapshot — but, like ' +
          'every path, it still answers 503 until one has loaded, because the tokens that identify ' +
          'the caller arrive in that snapshot.',
        parameters: [
          {
            name: 'since',
            in: 'query',
            required: false,
            description:
              'Return only records with a higher "seq" than this — the polling form. Pass back the ' +
              '"latestSeq" from the previous response.',
            schema: { type: 'integer', minimum: 0 },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Maximum records to return, clamped to 200.',
            schema: { type: 'integer', minimum: 1, maximum: 200, default: 200 },
          },
        ],
        responses: {
          200: {
            description: 'The most recent delivery records, newest first.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['deliveries', 'latestSeq'],
                  properties: {
                    deliveries: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/WebhookDelivery' },
                    },
                    latestSeq: {
                      type: 'integer',
                      description:
                        'The highest sequence number assigned so far. Returned even when the page ' +
                        'is empty, so a poller can always advance its cursor.',
                    },
                  },
                },
                example: {
                  deliveries: [
                    {
                      seq: 42,
                      at: 1751000000000,
                      targetId: '7f3a1c58-0b2e-4a1d-9c77-2f5b8e0a1d34',
                      targetName: 'Workshop notifier',
                      source: 'database',
                      url: 'https://hooks.example.test/inventory',
                      method: 'POST',
                      eventId: 'hist-0007',
                      eventType: 'item.low_stock',
                      outcome: 'delivered',
                      attempts: 1,
                      status: 204,
                      detail: null,
                    },
                  ],
                  latestSeq: 42,
                },
              },
            },
          },
          ...(errorResponses(400, 401, 404, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/webhooks/test': {
      post: {
        tags: ['webhooks'],
        summary: 'Send a synthetic test event to one configured subscription',
        description:
          'Opt-in (GUBBINS_BRIDGE_WEBHOOKS=on); returns 404 when disabled. Fires a synthetic event ' +
          'at a single app-configured subscription so it can be checked before a real inventory ' +
          'change happens to match it. Everything but the event is real: the subscription is read ' +
          'from the hydrated snapshot, the signing secret is resolved the same way, the matcher and ' +
          'filter decide whether it would be delivered, and the SSRF guard decides whether the ' +
          'destination may be reached — so a refusal or a filter exclusion is reported rather than ' +
          'forced through. A delivery-log row is written and its "seq" returned, so the result also ' +
          'arrives through the usual deliveries poll. Mutates no inventory (it is NOT gated on ' +
          'GUBBINS_BRIDGE_ALLOW_WRITES). The event carries no real item, and no secret or signature ' +
          'appears in the response. A subscription that has not yet synced to this bridge is a 422, ' +
          'which is deliberately distinct from the 404 above.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['subscriptionId'],
                properties: {
                  subscriptionId: {
                    type: 'string',
                    description: 'The id of the subscription to test.',
                  },
                },
              },
              example: { subscriptionId: '7f3a1c58-0b2e-4a1d-9c77-2f5b8e0a1d34' },
            },
          },
        },
        responses: {
          200: {
            description: 'The test ran; the body says what happened.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['outcome', 'status', 'attempts', 'detail', 'seq'],
                  properties: {
                    outcome: {
                      type: 'string',
                      enum: ['delivered', 'failed', 'blocked', 'skipped', 'unmatched'],
                      description:
                        '"unmatched" means the subscription’s own rules (disabled, event types, or ' +
                        'filter) excluded the test event, so nothing was sent and no row was written.',
                    },
                    status: {
                      type: 'integer',
                      nullable: true,
                      description: 'The receiver’s HTTP status, or null when no response was received.',
                    },
                    attempts: { type: 'integer', description: 'How many HTTP attempts were made.' },
                    detail: {
                      type: 'string',
                      nullable: true,
                      description: 'A short, secret-free diagnostic — a refusal reason or an error.',
                    },
                    seq: {
                      type: 'integer',
                      nullable: true,
                      description: 'The delivery-log row’s sequence number, or null when no row was written.',
                    },
                  },
                },
                example: { outcome: 'delivered', status: 204, attempts: 1, detail: null, seq: 43 },
              },
            },
          },
          ...(errorResponses(400, 401, 404, 415, 422, 429) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/scale/entities': {
      get: {
        tags: ['scale'],
        summary: 'List the Home Assistant entities that can be used as a scale',
        description:
          'Opt-in (GUBBINS_BRIDGE_HA=on); returns 404 when disabled. Projects Home Assistant’s ' +
          'entity states down to those reporting a convertible mass unit, for the app’s scale ' +
          'picker. Reads Home Assistant rather than the snapshot — but, like every path, it still ' +
          'answers 503 until one has loaded, because the tokens that identify the caller arrive in ' +
          'that snapshot. Strictly read-only — the bridge cannot call a Home Assistant service.',
        responses: {
          200: {
            description: 'The pickable weight sensors.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['entities'],
                  properties: {
                    entities: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['entityId', 'name', 'unit'],
                        properties: {
                          entityId: { type: 'string', example: 'sensor.workshop_scale' },
                          name: { type: 'string', example: 'Workshop scale' },
                          unit: { type: 'string', example: 'kg' },
                        },
                      },
                    },
                  },
                },
                example: {
                  entities: [{ entityId: 'sensor.workshop_scale', name: 'Workshop scale', unit: 'kg' }],
                },
              },
            },
          },
          ...(errorResponses(401, 404, 429, 502) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/scale/state': {
      get: {
        tags: ['scale'],
        summary: 'Read the current weight from a scale entity, in grams',
        description:
          'Opt-in (GUBBINS_BRIDGE_HA=on); returns 404 when disabled. Only entities that qualify ' +
          'as scales (a convertible mass unit — mg, g, kg, oz, lb, st) can be read; any other ' +
          'entity, or an unknown one, answers 404 exactly like a missing entity, so the endpoint ' +
          'reveals nothing about the rest of your Home Assistant instance. The sensor’s own unit ' +
          'is reconciled to canonical grams. A genuine scale that cannot be read is a 409 — never ' +
          'a 200 with a zero weight — because the caller turns this number into a stock count: ' +
          'scale_unavailable or scale_not_a_number.',
        parameters: [
          {
            name: 'entity_id',
            in: 'query',
            required: true,
            description: 'The Home Assistant entity id of the scale, e.g. sensor.workshop_scale.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: 'The current reading.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['entityId', 'grams', 'value', 'unit'],
                  properties: {
                    entityId: { type: 'string', example: 'sensor.workshop_scale' },
                    grams: { type: 'number', description: 'The reading in canonical grams.', example: 1250 },
                    value: { type: 'number', description: 'The raw value as reported.', example: 1.25 },
                    unit: { type: 'string', description: 'The unit that raw value was in.', example: 'kg' },
                    lastUpdated: { type: 'string', nullable: true, format: 'date-time' },
                  },
                },
                example: {
                  entityId: 'sensor.workshop_scale',
                  grams: 1250,
                  value: 1.25,
                  unit: 'kg',
                  lastUpdated: '2025-06-27T06:13:20.000Z',
                },
              },
            },
          },
          404: response(
            'The Home Assistant read is disabled, or the entity is not a scale (or does not ' +
              'exist). A non-scale entity is deliberately indistinguishable from a missing one.',
            '#/components/schemas/Error',
            { error: { code: 'not_found', message: 'No such entity.' } },
          ),
          409: response(
            'A genuine scale that is unavailable, or is not reporting a numeric weight.',
            '#/components/schemas/Error',
            {
              error: {
                code: 'scale_unavailable',
                message: 'The scale is unavailable in Home Assistant.',
              },
            },
          ),
          ...(errorResponses(400, 401, 429, 502) as Record<string, JsonValue>),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'A per-user API token minted in the Gubbins app (Users → a user → API tokens), sent as ' +
          '"Authorization: Bearer <token>". The bridge resolves it to that user and enforces ' +
          'their permissions on every route; a route their role does not reach is a 403.',
      },
    },
    schemas: {
      Error: errorSchema,
      LegacyError: legacyErrorSchema,
      Pagination: paginationSchema,
      ApiIndex: {
        type: 'object',
        properties: {
          name: { type: 'string', example: 'Gubbins Bridge API' },
          version: {
            type: 'string',
            description:
              'The API contract version — what these endpoints promise. Distinct from "bridge", which says which build is answering.',
            example: '1.0.0',
          },
          bridge: {
            type: 'object',
            description:
              'Which build of Gubbins this bridge is. The bridge ships as source with no separate release, so it reports the repository version it was taken from; a client that knows its own can spot a bridge left behind.',
            properties: {
              version: { type: 'string', example: '0.3.0' },
              schemaVersion: {
                type: 'integer',
                description:
                  'The stored-data compatibility generation. A bridge behind on this may read the snapshot with out-of-date assumptions.',
                example: 5,
              },
            },
          },
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
          scalable: {
            type: 'boolean',
            description:
              'Whether the opt-in Home Assistant read is enabled, i.e. whether "count by weight" can pull a live reading off a scale entity.',
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
        required: [
          'ok',
          'itemCount',
          'snapshotGeneratedAt',
          'snapshotStale',
          'reloadFailures',
          'lastReloadError',
          'lastReloadErrorAt',
          'lastReloadAt',
        ],
        properties: {
          ok: {
            type: 'boolean',
            description:
              'False once the snapshot is stale — the bridge is still answering, but from data it ' +
              'knows is out of date. Treat a false value as "do not trust these numbers".',
          },
          itemCount: { type: 'integer' },
          snapshotGeneratedAt: { type: 'string', nullable: true, format: 'date-time' },
          snapshotStale: {
            type: 'boolean',
            description: 'Reloads have failed enough times in a row to call the served data stale.',
          },
          reloadFailures: {
            type: 'integer',
            description: 'Consecutive failed snapshot reloads since the last successful one.',
          },
          lastReloadError: { type: 'string', nullable: true, description: 'Why the last reload failed.' },
          lastReloadErrorAt: { type: 'string', nullable: true, format: 'date-time' },
          lastReloadAt: {
            type: 'string',
            nullable: true,
            format: 'date-time',
            description: 'When the served snapshot was last loaded successfully.',
          },
        },
      },
      ItemStatusCounts: {
        type: 'object',
        required: ['statuses', 'snapshotGeneratedAt'],
        properties: {
          statuses: {
            type: 'object',
            description:
              'One non-negative count per attention status. Derived from the canonical status ' +
              'list, so it cannot drift from the filters the app itself offers.',
            required: [...ITEM_STATUS_FILTERS],
            properties: Object.fromEntries(
              ITEM_STATUS_FILTERS.map((status) => [status, { type: 'integer', minimum: 0 }]),
            ) as JsonValue,
            additionalProperties: false,
          },
          snapshotGeneratedAt: {
            type: 'string',
            nullable: true,
            format: 'date-time',
            description: 'When the snapshot these counts were read from was generated.',
          },
        },
      },
      ItemMatch: {
        type: 'object',
        required: ['id', 'name', 'quantity', 'locationId', 'locationName', 'mpn', 'manufacturer'],
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
          locationId: {
            type: 'string',
            nullable: true,
            example: 'loc-shelf-2',
            description:
              "The primary/home location's stable id — what an automation acts on (the name is for a human). Null exactly when locationName is.",
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
          matches: {
            type: 'array',
            description:
              'Plain — with no `fields`/`include` (or `$select`/`$expand`) — every match is the ' +
              'compact `ItemMatch`. With a selection each match is an `ItemProjection` instead: ' +
              'the selected item fields and nothing else. The two are genuinely different shapes ' +
              '(among other things `ItemMatch` resolves `locationId` through the locations table, ' +
              'so it can be null), which is why both are listed rather than one covering both.',
            items: {
              anyOf: [
                { $ref: '#/components/schemas/ItemMatch' },
                { $ref: '#/components/schemas/ItemProjection' },
              ],
            },
          },
        },
      },
      Placement: placementSchema,
      PlacementProjection: projectedElement(placementSchema),
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
      Capability: capabilitySchema,
      CapabilityProjection: projectedElement(capabilitySchema),
      ItemFieldValue: itemFieldValueSchema,
      ItemFieldValueProjection: projectedElement(itemFieldValueSchema),
      // Relaxed in place, with no strict twin: every read that can return one accepts a sparse
      // fieldset, so there is no response left for the strict shape to describe.
      LocationFieldValue: projectedElement(locationFieldValueSchema),
      GaugeState: {
        type: 'object',
        description: 'The state of a CONSUMABLE_GAUGE item’s container.',
        required: [
          'unitOfMeasure',
          'grossCapacity',
          'tareWeight',
          'currentNetValue',
          'percentageRemaining',
          'currentGrossWeight',
          'attritionPercent',
          'costPerUnitOfMeasure',
        ],
        properties: {
          unitOfMeasure: { type: 'string', example: 'g' },
          grossCapacity: { type: 'number', example: 1000 },
          tareWeight: { type: 'number', description: 'Empty-container weight/volume.', example: 220 },
          currentNetValue: { type: 'number', description: 'Usable material remaining.', example: 640 },
          percentageRemaining: { type: 'number', example: 64 },
          currentGrossWeight: { type: 'number', example: 860 },
          attritionPercent: {
            type: 'number',
            nullable: true,
            description: 'Proportional waste a draw costs on top of the amount asked for; null for none.',
          },
          costPerUnitOfMeasure: {
            type: 'number',
            nullable: true,
            description:
              'What one unit of measure of the contents costs, in the base currency; null when ' +
              'unpriced. A gauge holds a measure rather than units, so this — not the item’s ' +
              'unitCost — is what its stock is valued from (currentNetValue × this).',
            example: 0.025,
          },
        },
      },
      /*
       * `ItemSummary` and `ItemDetail` keep their `required` lists because each is still the
       * guaranteed shape of a response that CANNOT be projected — the SSE event payload and the
       * two write endpoints respectively. Every read that accepts `fields`/`$select` answers with
       * `ItemProjection` instead (issue #367).
       */
      ItemSummary: {
        type: 'object',
        description:
          'The default row shape of `GET /api/v1/items`, and the item snapshot carried by an event.',
        required: [...ITEM_SUMMARY_FIELDS],
        properties: itemProps(ITEM_SUMMARY_FIELDS),
      },
      ItemDetail: {
        description: 'The default payload of `GET /api/v1/items/{id}`, and what a write returns.',
        allOf: [
          { $ref: '#/components/schemas/ItemSummary' },
          {
            type: 'object',
            required: ['placements', 'capabilities', 'tags'],
            properties: {
              ...(itemProps([...ITEM_DETAIL_EXTRA_FIELDS, 'fieldValues']) as Record<string, JsonValue>),
              // Restated with the strict element shapes: nothing that answers with `ItemDetail`
              // accepts a `fields` path, so each element really does carry all of its keys.
              placements: {
                type: 'array',
                description: 'Where this item’s stock sits, per location.',
                items: { $ref: '#/components/schemas/Placement' },
              },
              capabilities: {
                type: 'array',
                description: 'The item’s queryable capability values.',
                items: { $ref: '#/components/schemas/Capability' },
              },
              fieldValues: {
                type: 'array',
                description: 'Present only when requested with `include=fields`.',
                items: { $ref: '#/components/schemas/ItemFieldValue' },
              },
            },
          },
        ],
      },
      Checkout: {
        type: 'object',
        description:
          'One loan. The borrower is a tagged union: `borrowerType` says which kind of target ' +
          'holds it and `borrowerId` is that target’s id. `status` is derived from `returnedAt`.',
        required: [
          'id',
          'itemId',
          'borrowerType',
          'borrowerId',
          'quantity',
          'dueDate',
          'checkedOutAt',
          'returnedAt',
          'status',
          'note',
          'returnNote',
          'sourceLocationId',
        ],
        properties: {
          id: { type: 'string', example: 'a3f1c0de-0000-4000-8000-000000000000' },
          itemId: { type: 'string', example: 'item-m3-bolt' },
          borrowerType: { type: 'string', enum: ['contact', 'project', 'location'], example: 'contact' },
          borrowerId: { type: 'string', example: 'contact-sam' },
          quantity: { type: 'integer', example: 1 },
          dueDate: {
            type: 'integer',
            nullable: true,
            description: 'UNIX-ms; null for an open-ended loan.',
          },
          checkedOutAt: { type: 'integer' },
          returnedAt: { type: 'integer', nullable: true, description: 'UNIX-ms; null while still out.' },
          status: { type: 'string', enum: ['OPEN', 'RETURNED'], example: 'OPEN' },
          note: { type: 'string', nullable: true },
          returnNote: { type: 'string', nullable: true, description: 'Null while the loan is open.' },
          sourceLocationId: {
            type: 'string',
            nullable: true,
            description: 'The placement the units were drawn from; stock is restored there on return.',
          },
        },
      },
      LoanResult: {
        type: 'object',
        description: 'What the loan endpoints return: the affected item plus the loan itself.',
        required: ['item', 'checkout'],
        properties: {
          item: { $ref: '#/components/schemas/ItemDetail' },
          checkout: { $ref: '#/components/schemas/Checkout' },
        },
      },
      ItemProjection: {
        type: 'object',
        description:
          'An item as returned by a read that accepts a **sparse fieldset**, which is why no ' +
          'property here is required.\n\n' +
          'Without `fields`/`$select` the payload is the endpoint’s documented default set — ' +
          '`ItemSummary` for the items list, `ItemDetail` for a single item — plus anything added ' +
          'with `include`/`$expand`. With `fields`/`$select` it is EXACTLY the named fields and ' +
          'nothing else, so `fields=name,unitCost` yields an object of two keys. Every property ' +
          'below is one of those selectable fields; which ones arrive is decided per request, so ' +
          'a generated client must treat them all as optional.',
        properties: itemProps([...Object.keys(itemFieldSchemas)]),
      },
      /*
       * Locations need no projected twin: every field a location has is already in its default
       * payload, so one schema covers both cases — but both location reads accept `fields`, so
       * nothing here can be `required`. What a caller gets without one is spelled out below.
       */
      Location: {
        type: 'object',
        description:
          'A location. Without `fields`/`$select` the payload always carries `id`, `name`, ' +
          '`parentId`, `isSystem`, `description`, `color` and `itemCount`, plus `fieldValues` when ' +
          'asked for with `include=fields`. With `fields`/`$select` it carries EXACTLY the named ' +
          'fields — which is why no property is required (issue #367).',
        properties: {
          id: { type: 'string', example: 'loc-drawer-a' },
          name: { type: 'string', example: 'Drawer A' },
          parentId: { type: 'string', nullable: true, example: null },
          isSystem: { type: 'boolean', example: false },
          description: { type: 'string', nullable: true },
          color: { type: 'string', nullable: true },
          itemCount: { type: 'integer', example: 2 },
          fieldValues: {
            type: 'array',
            description: 'Present only when requested with `include=fields` (or named in `fields`).',
            items: { $ref: '#/components/schemas/LocationFieldValue' },
          },
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
      WebhookDelivery: {
        type: 'object',
        description:
          'One recorded webhook delivery attempt-sequence. Deliberately carries no secret, ' +
          'signature, request header or query string; the URL is reduced to its origin and path ' +
          '(a GET delivery puts its whole payload in the query, which is exactly why it is dropped).',
        required: [
          'seq',
          'at',
          'targetId',
          'targetName',
          'source',
          'url',
          'method',
          'eventId',
          'eventType',
          'outcome',
          'attempts',
          'status',
          'detail',
        ],
        properties: {
          seq: {
            type: 'integer',
            description: 'Monotonic per-log sequence number; pass the highest back as "since".',
            example: 42,
          },
          at: { type: 'integer', description: 'UNIX-ms when the delivery finished.' },
          targetId: {
            type: 'string',
            description:
              'The subscription id for an app-configured webhook, or "config:<n>" for one from the ' +
              'operator’s webhooks.json / GUBBINS_BRIDGE_WEBHOOKS_TARGETS.',
          },
          targetName: { type: 'string', example: 'Workshop notifier' },
          source: {
            type: 'string',
            enum: ['database', 'config'],
            description: 'Whether the target came from the app’s synced subscriptions or bridge config.',
          },
          url: { type: 'string', example: 'https://hooks.example.test/inventory' },
          method: { type: 'string', enum: ['POST', 'GET', 'PUT', 'PATCH'] },
          eventId: { type: 'string', example: 'hist-0007' },
          eventType: { type: 'string', enum: [...KNOWN_EVENT_TYPES] },
          outcome: {
            type: 'string',
            enum: ['delivered', 'failed', 'blocked', 'skipped'],
            description:
              'delivered = the receiver answered 2xx; failed = every attempt was made and none ' +
              'succeeded; blocked = refused before any request was issued (the SSRF guard, or an ' +
              'unresolvable secret reference); skipped = the target’s failure circuit was open.',
          },
          attempts: {
            type: 'integer',
            description: 'HTTP attempts made (0 when blocked or skipped).',
            example: 1,
          },
          status: {
            type: 'integer',
            nullable: true,
            description: 'The final response status, or null when no response was ever received.',
            example: 204,
          },
          detail: {
            type: 'string',
            nullable: true,
            description:
              'A short, truncated diagnostic — a transport error or a refusal reason. Never a secret.',
          },
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
      LocationEventData: {
        type: 'object',
        description:
          'The payload of a `location.*` event — a change to a storage *location* rather than to ' +
          'an item. Deliberately flat: it carries no item, and no live location state (a ' +
          '`location.removed` event has none left to read).',
        required: ['locationId', 'locationName', 'action', 'label', 'detail'],
        properties: {
          locationId: {
            type: 'string',
            description:
              'The location the change was about. Present on every location event including ' +
              '`location.removed` — the activity record outlives the location it names, so an ' +
              'automation keyed by location id is always told which one went.',
            example: 'loc-workshop-shelf-b',
          },
          locationName: {
            type: 'string',
            description: 'The name the location carried when the change happened.',
            example: 'Shelf B',
          },
          action: {
            type: 'string',
            // Deliberately **not** an enum, matching `BridgeEventData.action` above. The action
            // column carries no CHECK, and a row synced from a newer peer can name an action this
            // build has never heard of — `eventTypeForLocationAction` maps it to `location.changed`
            // and the payload carries it verbatim. A closed enum here would make a generated
            // validator reject that whole event (the `oneOf` would match no arm at all), which is
            // the exact failure this schema exists to prevent.
            description:
              'The raw location activity action (e.g. `CREATED`, `RENAMED`, `RE_PARENTED`, ' +
              '`ARCHIVED`, `RESTORED`, `DELETED`). Open-ended: a change made by a newer version of ' +
              'Gubbins may name an action not in that list, and arrives as `location.changed`.',
            example: 'RE_PARENTED',
          },
          label: {
            type: 'string',
            description: 'Short British-English action title.',
            example: 'Moved',
          },
          detail: {
            type: 'string',
            nullable: true,
            description: 'The stored human-readable note, or null.',
            example: 'Moved from "Workshop" to "Garage".',
          },
        },
      },
      LookupEventData: {
        type: 'object',
        required: ['query', 'itemIds', 'locationIds', 'matches'],
        description:
          'The payload of a `lookup.resolved` event. `itemIds` and `locationIds` are the flattened, ' +
          'de-duplicated unions across every match, so an automation can trigger on them without ' +
          'walking `matches`.',
        properties: {
          query: {
            type: 'string',
            description: 'The query as asked (trimmed), verbatim.',
            example: 'M3 screws',
          },
          itemIds: {
            type: 'array',
            description: 'Every matched item id, in match order, de-duplicated.',
            items: { type: 'string' },
            example: ['itm-m3-bolt'],
          },
          locationIds: {
            type: 'array',
            description: 'Every resolved location id across all matches, in encounter order, de-duplicated.',
            items: { type: 'string' },
            example: ['loc-drawer-a'],
          },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              required: ['itemId', 'itemName', 'placements'],
              properties: {
                itemId: { type: 'string', example: 'itm-m3-bolt' },
                itemName: { type: 'string', example: 'M3 × 10mm bolt' },
                placements: {
                  type: 'array',
                  description: 'Where this item’s stock sits, busiest location first.',
                  items: {
                    type: 'object',
                    required: ['locationId', 'locationName', 'quantity'],
                    properties: {
                      locationId: { type: 'string', example: 'loc-drawer-a' },
                      locationName: { type: 'string', example: 'Drawer A' },
                      quantity: { type: 'number', example: 120 },
                    },
                  },
                },
              },
            },
          },
        },
      },
      BridgeEvent: {
        type: 'object',
        required: ['id', 'type', 'occurredAt', 'data'],
        description:
          'One event delivered over the SSE stream and to outbound webhooks. `id` is deterministic ' +
          'so a consumer can dedupe; `type` is a stable dotted name. Almost every event is derived ' +
          'from a new row in the history ledger — an inventory *change* — and takes its id from that ' +
          'row. The exception is `lookup.resolved`, which is **read**-triggered (someone asked where ' +
          'an item is, and nothing changed): it has no ledger row, so its id is derived from the ' +
          'resolved query instead, and it is only emitted when its own opt-in flag is enabled.',
        properties: {
          id: { type: 'string', example: 'hist-0007' },
          type: {
            type: 'string',
            // Driven from the shared vocabulary rather than hand-listed: this enum had already
            // drifted (it was missing `item.tracking_changed`, which the bridge does emit), and a
            // published contract that under-documents what it sends is worse than no enum at all.
            enum: [...KNOWN_EVENT_TYPES],
            example: 'item.low_stock',
          },
          occurredAt: {
            type: 'string',
            format: 'date-time',
            description:
              'When the event occurred, as ISO-8601 — the ledger row’s created_at for a ' +
              'ledger-derived event, or the moment the lookup resolved for `lookup.resolved`.',
            example: '2025-06-27T06:13:20.000Z',
          },
          data: {
            description:
              'The payload, whose shape follows `type`: `LookupEventData` for `lookup.resolved`, ' +
              '`LocationEventData` for every `location.*` event, `BridgeEventData` for every ' +
              'item ledger-derived event. Discriminate on the payload rather than on `type`: ' +
              '`events.truncated` is emitted by both ledgers and so arrives with either the item ' +
              'or the location shape — the presence of `locationName` is what tells them apart.',
            oneOf: [
              { $ref: '#/components/schemas/BridgeEventData' },
              { $ref: '#/components/schemas/LocationEventData' },
              { $ref: '#/components/schemas/LookupEventData' },
            ],
          },
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
