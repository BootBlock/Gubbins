/**
 * The read-only MCP tool registry — the Model Context Protocol surface an LLM/agent (e.g.
 * Claude) calls to query the Gubbins inventory.
 *
 * Every tool is a thin wrapper over the *same* read-only core the HTTP API uses: the
 * transport-agnostic query core ({@link searchItems}/{@link whereIs}), the shared
 * {@link loadItemDetail} loader, and the app's own repositories — projected through the same
 * stable DTOs (`api/dto.ts`). There is **no bespoke SQL and no write path**: the only SQL is
 * the parameterised `parseASTtoSQL` the repositories already use. This module is pure logic
 * (driver in, plain JSON-serialisable data out) so each tool is unit-testable without any
 * transport.
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { CategoryRepository } from '@/db/repositories/CategoryRepository.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { searchItems, whereIs, DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT } from '../query.ts';
import { loadItemDetail } from '../item-detail.ts';
import {
  toCapabilityKey,
  toCategorySummary,
  toLocation,
  type ListEnvelope,
  type PaginationMeta,
} from '../api/dto.ts';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../api/limits.ts';

/** A minimal JSON-Schema subset — enough to describe each tool's arguments in `tools/list`. */
export interface JsonSchema {
  readonly type: 'object' | 'string' | 'integer' | 'number' | 'boolean';
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly additionalProperties?: boolean;
}

/** One MCP tool: its advertised definition plus the read-only handler that runs it. */
export interface McpTool {
  /** Stable, agent-facing tool name (snake_case, `gubbins_`-prefixed to avoid collisions). */
  readonly name: string;
  /** One-line description shown to the calling model. */
  readonly description: string;
  /** JSON-Schema for the tool's arguments (sent verbatim in `tools/list`). */
  readonly inputSchema: JsonSchema;
  /** Execute the tool against the hydrated driver, returning JSON-serialisable data. */
  run(driver: IDatabaseDriver, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/**
 * Thrown when a tool's arguments are invalid (missing/empty/wrong type). The dispatcher
 * turns it into an MCP `isError` tool result so the calling model can see and correct it,
 * rather than a transport-level failure. Messages are caller-supplied and PII-free.
 */
export class ToolInputError extends Error {}

// --- the tools --------------------------------------------------------------------

const searchTool: McpTool = {
  name: 'gubbins_search',
  description:
    'Search the Gubbins inventory and return compact matches (id, name, total quantity, ' +
    'primary location, MPN, manufacturer). Accepts a casual phrase ("M3 bolts") or the ' +
    'power-user grammar (field:value, cap:key>n, AND/OR, parentheses). Relevance-ranked, ' +
    `top-N (default ${DEFAULT_RESULT_LIMIT}, max ${MAX_RESULT_LIMIT}).`,
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'The search query (casual phrase or power-user grammar).' },
      limit: {
        type: 'integer',
        description: `Max matches to return (clamped to [1, ${MAX_RESULT_LIMIT}]).`,
        minimum: 1,
        maximum: MAX_RESULT_LIMIT,
      },
    },
    required: ['q'],
    additionalProperties: false,
  },
  async run(driver, args) {
    const q = requireString(args, 'q');
    const matches = await searchItems(driver, q, { limit: optionalInteger(args, 'limit') });
    return { query: q.trim(), matches };
  },
};

const whereIsTool: McpTool = {
  name: 'gubbins_where_is',
  description:
    'Answer "where is X?": the top matches for a query, each with its per-location stock ' +
    'breakdown (e.g. "5 on Shelf 2, 2 in Bin 4"), plus one short spoken British-English ' +
    'sentence suitable for reading aloud.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'What to locate (casual phrase or power-user grammar).' },
      limit: {
        type: 'integer',
        description: `Max items to locate (clamped to [1, ${MAX_RESULT_LIMIT}]).`,
        minimum: 1,
        maximum: MAX_RESULT_LIMIT,
      },
    },
    required: ['q'],
    additionalProperties: false,
  },
  async run(driver, args) {
    const q = requireString(args, 'q');
    return whereIs(driver, q, { limit: optionalInteger(args, 'limit') });
  },
};

const getItemTool: McpTool = {
  name: 'gubbins_get_item',
  description:
    'Fetch one inventory item by its stable id, with full detail: per-location placements ' +
    'and parametric capabilities. Returns { found: false } when no item has that id.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The item id (as returned by gubbins_search).' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async run(driver, args) {
    const id = requireString(args, 'id');
    const item = await loadItemDetail(driver, id);
    return item === null ? { found: false, id } : { found: true, item };
  },
};

const listLocationsTool: McpTool = {
  name: 'gubbins_list_locations',
  description:
    'List storage locations (paginated), each with its live item count. Use the ids/names ' +
    'here to interpret search results or to filter further.',
  inputSchema: pageSchema('locations'),
  async run(driver, args) {
    const page = clampPage(args);
    const result = await new LocationRepository(driver).list({ limit: page.limit, offset: page.offset });
    return envelope(result.rows.map(toLocation), page, result.hasMore);
  },
};

const listCategoriesTool: McpTool = {
  name: 'gubbins_list_categories',
  description: 'List item categories (paginated), each with the number of custom fields it defines.',
  inputSchema: pageSchema('categories'),
  async run(driver, args) {
    const page = clampPage(args);
    const result = await new CategoryRepository(driver).list({ limit: page.limit, offset: page.offset });
    return envelope(result.rows.map(toCategorySummary), page, result.hasMore);
  },
};

const listCapabilitiesTool: McpTool = {
  name: 'gubbins_list_capabilities',
  description:
    'List the distinct, queryable capability vocabulary — the keys you can filter on with ' +
    '`cap:<key>` in gubbins_search (e.g. cap:voltage>3). Each entry reports how many items ' +
    'use the key and whether its values are numeric and/or textual.',
  inputSchema: pageSchema('capability keys'),
  async run(driver, args) {
    const page = clampPage(args);
    const result = await new ItemRepository(driver).listCapabilityKeys({
      limit: page.limit,
      offset: page.offset,
    });
    return envelope(result.rows.map(toCapabilityKey), page, result.hasMore);
  },
};

/** Every read-only tool the MCP server exposes, in a stable order. */
export const ALL_TOOLS: readonly McpTool[] = [
  searchTool,
  whereIsTool,
  getItemTool,
  listLocationsTool,
  listCategoriesTool,
  listCapabilitiesTool,
];

/** Look a tool up by name, or undefined if there is no such tool. */
export function findTool(name: string): McpTool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}

// --- argument helpers -------------------------------------------------------------

function requireString(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolInputError(`"${key}" is required and must be a non-empty string.`);
  }
  return value;
}

function optionalInteger(args: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolInputError(`"${key}" must be a number when provided.`);
  }
  return Math.floor(value);
}

interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

/** Clamp the optional `limit`/`offset` arguments to the API's page bounds. */
function clampPage(args: Readonly<Record<string, unknown>>): PageRequest {
  return {
    limit: clampInt(optionalInteger(args, 'limit'), DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT),
    offset: clampInt(optionalInteger(args, 'offset'), 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Wrap a page of mapped rows in the same `{ data, pagination }` envelope the HTTP API uses. */
function envelope<T>(data: readonly T[], page: PageRequest, hasMore: boolean): ListEnvelope<T> {
  const pagination: PaginationMeta = {
    limit: page.limit,
    offset: page.offset,
    count: data.length,
    hasMore,
  };
  return { data, pagination };
}

/** The shared `limit`/`offset` argument schema for the paginated list tools. */
function pageSchema(noun: string): JsonSchema {
  return {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: `Max ${noun} per page (clamped to [1, ${MAX_PAGE_LIMIT}], default ${DEFAULT_PAGE_LIMIT}).`,
        minimum: 1,
        maximum: MAX_PAGE_LIMIT,
      },
      offset: { type: 'integer', description: 'Zero-based offset of the first row.', minimum: 0 },
    },
    additionalProperties: false,
  };
}
