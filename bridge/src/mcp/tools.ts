/**
 * The MCP tool registry — the Model Context Protocol surface an LLM/agent (e.g. Claude) calls
 * to query, and optionally adjust, the Gubbins inventory.
 *
 * The **read** tools ({@link ALL_TOOLS}) are thin wrappers over the *same* read-only core the
 * HTTP API uses: the transport-agnostic query core ({@link searchItems}/{@link whereIs}), the
 * shared {@link loadItemDetail} loader, and the app's own repositories — projected through the
 * same stable DTOs (`api/dto.ts`). There is no bespoke SQL: the only SQL is the parameterised
 * `parseASTtoSQL` the repositories already use. This module is pure logic (driver in, plain
 * JSON-serialisable data out) so each tool is unit-testable without any transport.
 *
 * The **write** tools ({@link createWriteTools}) are *not* part of {@link ALL_TOOLS} — they only
 * exist when the composition root builds them with a write executor, which it does solely under
 * the `GUBBINS_BRIDGE_ALLOW_WRITES` opt-in and a JSON snapshot source. With the flag off the
 * tools are never constructed, so they are absent from `tools/list` *and* uncallable — the same
 * "invisible when disabled" posture the HTTP write endpoints take (they 404). Each one maps 1:1
 * to an HTTP write endpoint and round-trips through the identical §7.3 sync merge (see
 * `write.ts`); no new mutation path is introduced here.
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { CategoryRepository } from '@/db/repositories/CategoryRepository.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { searchItems, searchItemRows, whereIs, DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT } from '../query.ts';
import { loadItemDetail } from '../item-detail.ts';
import {
  toCapabilityKey,
  toCategorySummary,
  toLocation,
  type ListEnvelope,
  type PaginationMeta,
} from '../api/dto.ts';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../api/limits.ts';
import {
  FieldSelectionError,
  hasSelection,
  type RawSelection,
  type SelectedField,
} from '../api/field-select.ts';
import {
  createItemViewContext,
  parseItemSelection,
  projectItem,
  ITEM_DETAIL_DEFAULT_FIELDS,
  SEARCH_DEFAULT_FIELDS,
} from '../api/item-view.ts';
import { createLocationViewContext, parseLocationSelection, projectLocation } from '../api/location-view.ts';
import { MAX_NOTE_LENGTH, WriteError, type WriteOperation, type WriteResult } from '../write.ts';

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
  /**
   * True for a write tool (issue #394): its result reflects a mutation the executor applied to a
   * freshly-read snapshot, not the watcher's possibly-stale *read* driver, so the stale-snapshot
   * caveat the dispatcher prepends to read results must not be attached to it. Read tools omit it.
   */
  readonly mutates?: boolean;
  /** Execute the tool against the hydrated driver, returning JSON-serialisable data. */
  run(driver: IDatabaseDriver, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/**
 * Thrown when a tool's arguments are invalid (missing/empty/wrong type). The dispatcher
 * turns it into an MCP `isError` tool result so the calling model can see and correct it,
 * rather than a transport-level failure. Messages are caller-supplied and PII-free.
 */
export class ToolInputError extends Error {}

/** The shared `fields`/`include` argument schemas (comma-separated, mirroring the HTTP API). */
const FIELDS_SCHEMA: JsonSchema = {
  type: 'string',
  description:
    'Sparse fieldset: a comma-separated list of fields to return instead of the default set ' +
    '(e.g. "name,unitCost"). Nest an array field with a dot ("placements.quantity"). Naming an ' +
    'extended field opts it in.',
};

const INCLUDE_SCHEMA: JsonSchema = {
  type: 'string',
  description:
    'Comma-separated extended fields (or groups: relations, pricing, lifecycle, reorder, ' +
    'timestamps, fields, all) to add on top of the default payload (e.g. "capabilities,notes"). ' +
    'Use "fields" for the item\'s custom-field values (fieldValues), with any value inherited ' +
    'from its location already resolved.',
};

/** The `include` schema for the location list tool, whose only extended field is `fieldValues`. */
const LOCATION_INCLUDE_SCHEMA: JsonSchema = {
  type: 'string',
  description:
    'Comma-separated extended fields (or the groups "fields" / "all") to add on top of the ' +
    'default payload. Use "fields" for the location\'s custom-field values (fieldValues) — ' +
    'user-recorded metadata such as a mapped device entity id or a label reference.',
};

// --- the tools --------------------------------------------------------------------

const searchTool: McpTool = {
  name: 'gubbins_search',
  description:
    'Search the Gubbins inventory and return compact matches (id, name, total quantity, ' +
    'primary location, MPN, manufacturer). Accepts a casual phrase ("M3 bolts") or the ' +
    'power-user grammar (field:value, cap:key>n, AND/OR, parentheses). Relevance-ranked, ' +
    `top-N (default ${DEFAULT_RESULT_LIMIT}, max ${MAX_RESULT_LIMIT}). Use "fields" to return ` +
    'only specific fields (e.g. just the price) or "include" to add extended fields.',
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
      fields: FIELDS_SCHEMA,
      include: INCLUDE_SCHEMA,
    },
    required: ['q'],
    additionalProperties: false,
  },
  async run(driver, args) {
    const q = requireString(args, 'q');
    const limit = optionalInteger(args, 'limit');
    const selection = selectionFromArgs(args, (raw) => parseItemSelection(SEARCH_DEFAULT_FIELDS, raw));
    if (selection === undefined) {
      return { query: q.trim(), matches: await searchItems(driver, q, { limit }) };
    }
    const rows = await searchItemRows(driver, q, { limit });
    const matches = await Promise.all(
      rows.map((row) => projectItem(createItemViewContext(driver, row), selection)),
    );
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
    'and parametric capabilities. Returns { found: false } when no item has that id. Use ' +
    '"fields" to project only specific fields, or "include" to add extended fields (e.g. notes, ' +
    'or "fields" for the item\'s custom-field values).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The item id (as returned by gubbins_search).' },
      fields: FIELDS_SCHEMA,
      include: INCLUDE_SCHEMA,
    },
    required: ['id'],
    additionalProperties: false,
  },
  async run(driver, args) {
    const id = requireString(args, 'id');
    const selection = selectionFromArgs(args, (raw) => parseItemSelection(ITEM_DETAIL_DEFAULT_FIELDS, raw));
    if (selection === undefined) {
      const item = await loadItemDetail(driver, id);
      return item === null ? { found: false, id } : { found: true, item };
    }
    const row = await new ItemRepository(driver).getById(id);
    return row === undefined
      ? { found: false, id }
      : { found: true, item: await projectItem(createItemViewContext(driver, row), selection) };
  },
};

const listLocationsTool: McpTool = {
  name: 'gubbins_list_locations',
  description:
    'List storage locations (paginated), each with its live item count. Use the ids/names ' +
    'here to interpret search results or to filter further. Pass include="fields" to also get ' +
    "each location's custom-field values (user-recorded metadata).",
  inputSchema: {
    ...pageSchema('locations'),
    properties: {
      ...pageSchema('locations').properties,
      fields: FIELDS_SCHEMA,
      include: LOCATION_INCLUDE_SCHEMA,
    },
  },
  async run(driver, args) {
    const page = clampPage(args);
    const result = await new LocationRepository(driver).list({ limit: page.limit, offset: page.offset });
    const selection = selectionFromArgs(args, (raw) => parseLocationSelection(raw));
    if (selection === undefined) return envelope(result.rows.map(toLocation), page, result.hasMore);
    const rows = await Promise.all(
      result.rows.map((location) => projectLocation(createLocationViewContext(driver, location), selection)),
    );
    return envelope(rows, page, result.hasMore);
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

/** Look a read tool up by name, or undefined if there is no such tool. */
export function findTool(name: string): McpTool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}

// --- the write tools (opt-in) -----------------------------------------------------

/**
 * Executes one mutation, returning the updated item. This is the *same* single-flight executor
 * the HTTP write endpoints use ({@link createWriteExecutor}) — it re-reads the snapshot fresh,
 * applies the change through the app's own repository, and writes the merged snapshot back
 * atomically.
 *
 * Deliberately takes **no actor**, unlike the HTTP executor: the MCP transport is the local
 * process's own stdio and carries no credential at all, so there is no identity to attribute a
 * write to. The composition root binds it to the System user explicitly (see `mcp/serve.ts`) —
 * naming that choice once, in the open, rather than letting each call site default to it.
 */
export type WriteExecutor = (op: WriteOperation) => Promise<WriteResult>;

/** The shared `delta`/`note` argument schemas for both adjust tools. */
const NOTE_SCHEMA: JsonSchema = {
  type: 'string',
  description:
    'Optional short reason recorded on the item\'s history entry (e.g. "Taken to the workshop"). ' +
    `Max ${MAX_NOTE_LENGTH} characters.`,
};

/**
 * Build the opt-in write tools over a write executor. Called only when writes are enabled, so
 * the returned tools simply *are not there* otherwise — there is no per-call flag to check.
 *
 * Note the executor closes over the snapshot path and does its own fresh read/hydrate, so these
 * tools deliberately ignore the read driver they are handed: mutating the watcher's shared,
 * possibly-stale read snapshot is exactly the drift `write.ts` exists to prevent.
 */
export function createWriteTools(execute: WriteExecutor): readonly McpTool[] {
  const adjustQuantityTool: McpTool = {
    name: 'gubbins_adjust_quantity',
    mutates: true,
    description:
      "Adjust a DISCRETE item's stock at its home location by a signed whole number — a positive " +
      'delta checks stock in, a negative delta checks it out (e.g. delta -2 to take two). Records ' +
      "the change in the item's history and returns the updated item. Use gubbins_search first to " +
      'get the item id, and confirm with the user before adjusting.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item id (as returned by gubbins_search).' },
        delta: {
          type: 'integer',
          description: 'Signed whole number to add to the current quantity (negative to check out).',
        },
        note: NOTE_SCHEMA,
      },
      required: ['id', 'delta'],
      additionalProperties: false,
    },
    async run(_driver, args) {
      return runWrite(execute, {
        kind: 'adjust-quantity',
        itemId: requireString(args, 'id'),
        delta: requireInteger(args, 'delta'),
        ...noteArg(args),
      });
    },
  };

  const adjustGaugeTool: McpTool = {
    name: 'gubbins_adjust_gauge',
    mutates: true,
    description:
      "Adjust a CONSUMABLE_GAUGE item's net value by a signed amount (e.g. a part-used bottle or " +
      "reel). The result is clamped to the item's [0, capacity] range. Records the change in the " +
      "item's history and returns the updated item. Use gubbins_search first to get the item id, " +
      'and confirm with the user before adjusting.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item id (as returned by gubbins_search).' },
        delta: {
          type: 'number',
          description: 'Signed amount to add to the current net value (negative to consume).',
        },
        note: NOTE_SCHEMA,
      },
      required: ['id', 'delta'],
      additionalProperties: false,
    },
    async run(_driver, args) {
      return runWrite(execute, {
        kind: 'adjust-gauge',
        itemId: requireString(args, 'id'),
        delta: requireNumber(args, 'delta'),
        ...noteArg(args),
      });
    },
  };

  const checkOutTool: McpTool = {
    name: 'gubbins_check_out',
    mutates: true,
    description:
      'Lend an item out to a borrower — a person (contact), a project, or a location such as a ' +
      'van. Supply exactly one borrower: contactId, contactName (an unknown name creates the ' +
      'contact), projectId or locationId. Discrete stock is decremented while the loan is open; ' +
      'a serialised item goes out as a whole and cannot be lent twice. Returns the loan, whose ' +
      'id checks it back in later. Use gubbins_search first to get the item id, and confirm with ' +
      'the user before lending.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item id (as returned by gubbins_search).' },
        contactId: { type: 'string', description: 'Lend to this existing contact.' },
        contactName: {
          type: 'string',
          description: "Lend to a contact by name; one is created if there's no match.",
        },
        projectId: { type: 'string', description: 'Lend to this existing project instead.' },
        locationId: { type: 'string', description: 'Lend to this existing location instead ("in the van").' },
        quantity: { type: 'integer', description: 'Units to lend; defaults to 1.', minimum: 1 },
        dueDate: {
          type: 'string',
          description: 'Optional due date as a calendar day, "yyyy-MM-dd". Omit for an open-ended loan.',
        },
        fromLocationId: {
          type: 'string',
          description: "Draw the units from this placement; defaults to the item's own location.",
        },
        note: {
          type: 'string',
          description:
            'Optional short reason recorded on the loan (e.g. "For the Henderson job"). ' +
            `Max ${MAX_NOTE_LENGTH} characters.`,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(_driver, args) {
      return runWrite(execute, {
        kind: 'check-out',
        itemId: requireString(args, 'id'),
        ...optionalStringArg(args, 'contactId'),
        ...optionalStringArg(args, 'contactName'),
        ...optionalStringArg(args, 'projectId'),
        ...optionalStringArg(args, 'locationId'),
        ...optionalStringArg(args, 'dueDate'),
        ...optionalStringArg(args, 'fromLocationId'),
        ...(args.quantity !== undefined && args.quantity !== null
          ? { quantity: requireInteger(args, 'quantity') }
          : {}),
        ...noteArg(args),
      });
    },
  };

  const checkInTool: McpTool = {
    name: 'gubbins_check_in',
    mutates: true,
    description:
      'Return a lent item, restoring its stock to wherever it was lent from and closing the ' +
      'loan. When the item has exactly one open loan the item id alone is enough; if it has ' +
      'several, pass checkoutId to say which one is back. Confirm with the user before returning.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item id (as returned by gubbins_search).' },
        checkoutId: {
          type: 'string',
          description: 'Which loan to close; only needed when the item has more than one open loan.',
        },
        note: {
          type: 'string',
          description:
            'Optional short remark recorded on the return (e.g. "Came back with a chipped blade"). ' +
            `Max ${MAX_NOTE_LENGTH} characters.`,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(_driver, args) {
      return runWrite(execute, {
        kind: 'check-in',
        itemId: requireString(args, 'id'),
        ...optionalStringArg(args, 'checkoutId'),
        ...noteArg(args),
      });
    },
  };

  const transferStockTool: McpTool = {
    name: 'gubbins_transfer_stock',
    mutates: true,
    description:
      "Move units of a DISCRETE item from one location to another, leaving the item's total " +
      'unchanged. Use this rather than two quantity adjustments — those only ever touch the ' +
      "item's home location. The whole amount moves or none of it does. Use " +
      'gubbins_list_locations to get the location ids, and confirm with the user before moving stock.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item id (as returned by gubbins_search).' },
        fromLocationId: { type: 'string', description: 'The location the units are moving out of.' },
        toLocationId: { type: 'string', description: 'The location the units are moving into.' },
        quantity: { type: 'integer', description: 'How many units to move.', minimum: 1 },
      },
      required: ['id', 'fromLocationId', 'toLocationId', 'quantity'],
      additionalProperties: false,
    },
    async run(_driver, args) {
      return runWrite(execute, {
        kind: 'transfer-stock',
        itemId: requireString(args, 'id'),
        fromLocationId: requireString(args, 'fromLocationId'),
        toLocationId: requireString(args, 'toLocationId'),
        quantity: requireInteger(args, 'quantity'),
      });
    },
  };

  return [adjustQuantityTool, adjustGaugeTool, checkOutTool, checkInTool, transferStockTool];
}

/**
 * Run one mutation, translating a {@link WriteError} into a model-visible {@link ToolInputError}.
 * Every `WriteError` message is safe domain text by construction (see `write.ts` — no SQL, paths
 * or PII), and each case is one the model can act on: correct the id, pick the right tool for the
 * tracking mode, or retry when the snapshot is briefly unavailable mid-write.
 */
async function runWrite(execute: WriteExecutor, op: WriteOperation): Promise<unknown> {
  try {
    const result = await execute(op);
    // The loan operations also report the checkout they opened or closed — its id is what a
    // later return names, so the model must be able to read it back. The stock operations have
    // no loan, and are left with exactly the payload they have always returned.
    return {
      updated: true,
      item: result.item,
      ...(result.checkout !== null ? { checkout: result.checkout } : {}),
    };
  } catch (err) {
    if (err instanceof WriteError) throw new ToolInputError(err.message);
    throw err;
  }
}

/**
 * Read the optional `note`. Only the *type* is checked here; the length bound is the write
 * core's ({@link applyOperation}), so it stays single-sourced across both write surfaces — an
 * over-long note comes back as a `WriteError` that {@link runWrite} surfaces to the model.
 */
function noteArg(args: Readonly<Record<string, unknown>>): { note?: string } {
  const value = args.note;
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') throw new ToolInputError('"note" must be a string when provided.');
  return { note: value };
}

/**
 * Read one optional string argument into a spreadable fragment, so an omitted argument stays
 * *absent* from the operation rather than arriving as `undefined` — the difference matters for
 * the borrower fields, where "not supplied" and "supplied as nothing" are different requests.
 * Only the type is checked; which combination is valid is the repository's call.
 */
function optionalStringArg<K extends string>(
  args: Readonly<Record<string, unknown>>,
  key: K,
): Partial<Record<K, string>> {
  const value = args[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') throw new ToolInputError(`"${key}" must be a string when provided.`);
  return { [key]: value } as Partial<Record<K, string>>;
}

// --- argument helpers -------------------------------------------------------------

function requireString(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolInputError(`"${key}" is required and must be a non-empty string.`);
  }
  return value;
}

/**
 * A required, finite number. Zero is rejected for the adjust deltas it serves: a no-op write
 * would still append a history row and rewrite the snapshot, so it is far more likely to be a
 * model mistake than an intent.
 */
function requireNumber(args: Readonly<Record<string, unknown>>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolInputError(`"${key}" is required and must be a finite number.`);
  }
  if (value === 0) throw new ToolInputError(`"${key}" must not be zero.`);
  return value;
}

/** A required, finite whole number (a fractional value is a mistake, not something to round). */
function requireInteger(args: Readonly<Record<string, unknown>>, key: string): number {
  const value = requireNumber(args, key);
  if (!Number.isInteger(value)) {
    throw new ToolInputError(`"${key}" must be a whole number.`);
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

/**
 * Resolve a `fields`/`include` selection from tool args, or `undefined` when neither is given
 * (so the caller keeps its default shape). An invalid selection surfaces as a model-visible
 * {@link ToolInputError} rather than a generic failure.
 */
function selectionFromArgs(
  args: Readonly<Record<string, unknown>>,
  parse: (raw: RawSelection) => readonly SelectedField[],
): readonly SelectedField[] | undefined {
  const raw = {
    ...(args.fields != null ? { fields: optionalStringList(args, 'fields') } : {}),
    ...(args.include != null ? { include: optionalStringList(args, 'include') } : {}),
  };
  if (!hasSelection(raw)) return undefined;
  try {
    return parse(raw);
  } catch (err) {
    if (err instanceof FieldSelectionError) throw new ToolInputError(err.message);
    throw err;
  }
}

/** A `fields`/`include` argument may be a comma-separated string or an array of field names. */
function optionalStringList(args: Readonly<Record<string, unknown>>, key: string): string | string[] {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  throw new ToolInputError(`"${key}" must be a comma-separated string or an array of strings.`);
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
