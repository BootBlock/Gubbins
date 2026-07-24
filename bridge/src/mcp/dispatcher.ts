/**
 * The transport-agnostic MCP request dispatcher: a tiny, stdlib-only JSON-RPC 2.0 handler
 * for the Model Context Protocol's read-only surface. Kept separate from the stdio framing
 * (`stdio.ts`) so it can be unit-tested by handing it a parsed message and asserting the
 * response — no streams involved.
 *
 * Why hand-rolled rather than `@modelcontextprotocol/sdk`: the bridge's defining invariant is
 * **zero runtime dependencies and no build step** (see `README.md`). The read-only surface we
 * need — `initialize`, `tools/list`, `tools/call`, `ping` — is small and stable, so a minimal
 * JSON-RPC loop preserves that invariant (the same "stdlib-first" call made for the HTTP
 * server).
 *
 * The dispatcher itself is transport plumbing and holds no policy: what a caller may do is
 * decided entirely by the `tools` list it is built with. The composition root includes the
 * opt-in write tools only under `GUBBINS_BRIDGE_ALLOW_WRITES`; with the flag off the list is
 * read-only and nothing here can mutate anything.
 */
import type { BridgeServerState } from '../server.ts';
import { stalenessCaveat, type SnapshotHealthReport } from '../snapshot-health.ts';
import { ALL_TOOLS, ToolInputError, type McpTool } from './tools.ts';

/** The MCP protocol revision we advertise when a client doesn't request a specific one. */
export const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

/** Identifying info returned to the client during `initialize`. */
export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

const DEFAULT_SERVER_INFO: ServerInfo = { name: 'gubbins-bridge-mcp', version: '1.0.0' };

/** A parsed JSON-RPC request. A request with no `id` is a notification (no reply is sent). */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

/** A JSON-RPC response (success or error). */
export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

// Standard JSON-RPC error codes (a small subset is all we surface).
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface McpDispatcherOptions {
  /** Accessor for the current hydrated state (null until the first snapshot loads). */
  readonly getState: () => BridgeServerState | null;
  /** The tools to expose (defaults to {@link ALL_TOOLS}; overridable for tests). */
  readonly tools?: readonly McpTool[];
  /** Server identity returned by `initialize`. */
  readonly serverInfo?: ServerInfo;
  /**
   * Reload health for the served snapshot (issue #394). A failed re-hydrate keeps the last good
   * snapshot live, so without this an assistant answering "how many do I have?" presents a stale
   * count as authoritative with nothing to caveat it. When present and the verdict is stale, a
   * short caveat is prepended to each successful tool result so the model can degrade honestly —
   * the MCP analogue of `/health`'s `ok: false`. Omit and tool results are never annotated.
   */
  readonly getSnapshotHealth?: () => SnapshotHealthReport;
}

/** A function that handles one parsed message, resolving to a response or null (notification). */
export type McpDispatch = (message: unknown) => Promise<JsonRpcResponse | null>;

/**
 * Build an MCP dispatcher over the given state accessor and tools. The returned function
 * takes an already-parsed JSON value (the stdio layer handles framing and parse errors) and
 * resolves to the JSON-RPC response, or `null` for a notification (which gets no reply).
 */
export function createMcpDispatcher(options: McpDispatcherOptions): McpDispatch {
  const tools = options.tools ?? ALL_TOOLS;
  const serverInfo = options.serverInfo ?? DEFAULT_SERVER_INFO;

  return async function dispatch(message: unknown): Promise<JsonRpcResponse | null> {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      // Not a well-formed request. If it carries an id we can report it; otherwise stay silent.
      const id = isObject(message) ? coerceId(message.id) : null;
      return id === undefined ? null : error(id, INVALID_REQUEST, 'Invalid request');
    }

    const method = message.method;
    const params = message.params;
    const isNotification = !('id' in message) || message.id === undefined;
    const id = coerceId(message.id) ?? null;

    try {
      switch (method) {
        case 'initialize':
          return isNotification ? null : result(id, initializeResult(params, serverInfo));
        case 'ping':
          return isNotification ? null : result(id, {});
        case 'tools/list':
          return isNotification ? null : result(id, { tools: tools.map(toToolDefinition) });
        case 'tools/call':
          return isNotification
            ? null
            : result(id, await callTool(params, tools, options.getState, options.getSnapshotHealth));
        default:
          // Notifications (e.g. notifications/initialized) need no reply and no error.
          if (isNotification) return null;
          return error(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
      }
    } catch (err) {
      if (isNotification) return null;
      if (err instanceof RpcError) return error(id, err.code, err.message);
      // Never leak internals (SQL, paths, stacks) to the caller.
      return error(id, INTERNAL_ERROR, 'Internal error');
    }
  };
}

// --- method handlers --------------------------------------------------------------

function initializeResult(params: unknown, serverInfo: ServerInfo): unknown {
  // Echo the client's requested protocol version when it sends one (our small, stable surface
  // is version-agnostic), else advertise our default.
  const requested = isObject(params) ? params.protocolVersion : undefined;
  const protocolVersion = typeof requested === 'string' ? requested : DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo,
  };
}

function toToolDefinition(tool: McpTool): unknown {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

async function callTool(
  params: unknown,
  tools: readonly McpTool[],
  getState: () => BridgeServerState | null,
  getSnapshotHealth?: () => SnapshotHealthReport,
): Promise<unknown> {
  const name = isObject(params) ? params.name : undefined;
  if (typeof name !== 'string') {
    throw new RpcError(INVALID_PARAMS, 'tools/call requires a string "name"');
  }
  // Resolve *only* within the configured tool list — never a global registry lookup. The list is
  // the single gate: an opt-in tool that wasn't built (writes disabled) must be uncallable, not
  // merely unlisted, so a model that guesses the name gets "Unknown tool" rather than a mutation.
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) {
    throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
  }

  const rawArgs = isObject(params) ? params.arguments : undefined;
  const args = isObject(rawArgs) ? rawArgs : {};

  const state = getState();
  if (state === null) {
    return toolError('Inventory snapshot is not loaded yet; try again shortly.');
  }

  try {
    const data = await tool.run(state.driver, args);
    // When the served snapshot is knowingly out of date, prepend a caveat as its own text block so
    // the model reads it before the data and can qualify anything it reports (issue #394). The
    // structured payload is left untouched — the staleness is metadata about the answer, not part
    // of it — and the caveat is skipped entirely when the data is current, so a healthy call keeps
    // its existing single-block shape. A *write* tool's result reflects the mutation the executor
    // applied to a freshly-read snapshot, not the watcher's stale read driver, so it is never
    // caveated — the staleness verdict is about the read surface, which the write did not use.
    const caveat = getSnapshotHealth && !tool.mutates ? stalenessCaveat(getSnapshotHealth()) : null;
    const dataBlock = { type: 'text', text: JSON.stringify(data, null, 2) };
    return {
      content: caveat === null ? [dataBlock] : [{ type: 'text', text: caveat }, dataBlock],
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    // Bad arguments are an expected, model-correctable outcome → an isError tool result, so
    // the model sees the message; anything else collapses to a generic, leak-free message.
    if (err instanceof ToolInputError) return toolError(err.message);
    return toolError('The tool failed to run.');
  }
}

/** Build an MCP tool result flagged as an error (visible to the calling model). */
function toolError(message: string): unknown {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// --- small helpers ----------------------------------------------------------------

/** A protocol-level error to surface as a JSON-RPC error response (not a tool result). */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Normalise an incoming id: JSON-RPC permits string, number or null; anything else → undefined. */
function coerceId(id: unknown): string | number | null | undefined {
  if (typeof id === 'string' || typeof id === 'number' || id === null) return id;
  return undefined;
}
