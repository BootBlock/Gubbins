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
          'all items with pagination, use GET /api/v1/items instead.',
        parameters: [
          qParam,
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Max results, clamped to [1, 25]. Defaults to 5.',
            schema: { type: 'integer', minimum: 1, maximum: 25, default: 5 },
          },
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
        parameters: [
          limitParam,
          offsetParam,
          {
            name: 'location',
            in: 'query',
            required: false,
            description: 'Filter to items whose home location is this location id.',
            schema: { type: 'string' },
          },
          {
            name: 'category',
            in: 'query',
            required: false,
            description: 'Filter to items in this category id.',
            schema: { type: 'string' },
          },
          {
            name: 'includeInactive',
            in: 'query',
            required: false,
            description: 'Include soft-deleted items when "true". Defaults to active only.',
            schema: { type: 'boolean', default: false },
          },
        ],
        responses: {
          200: okList('#/components/schemas/ItemSummary'),
          ...(errorResponses(401, 429, 503) as Record<string, JsonValue>),
        },
      },
    },
    '/api/v1/items/{id}': {
      get: {
        tags: ['items'],
        summary: 'Look up one item by id (with placements and capabilities)',
        parameters: [idParam('item')],
        responses: {
          200: response('The item.', '#/components/schemas/ItemDetail'),
          ...(errorResponses(401, 404, 429, 503) as Record<string, JsonValue>),
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
          quantity: { type: 'integer', example: 7 },
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
          quantity: { type: 'integer', example: 42 },
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
        required: ['id', 'name', 'fieldType', 'options', 'isRequired', 'defaultValue', 'position'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string', example: 'Voltage' },
          fieldType: { type: 'string', example: 'TEXT' },
          options: { type: 'array', items: { type: 'string' }, nullable: true },
          isRequired: { type: 'boolean' },
          defaultValue: { type: 'string', nullable: true },
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
