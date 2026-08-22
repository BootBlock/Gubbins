/**
 * MCP dispatcher (JSON-RPC) tests over the SYNTHETIC fixture. They drive the dispatcher with
 * crafted parsed messages — no streams — asserting the protocol handshake, tool listing,
 * tool-call success/error envelopes, and the JSON-RPC guards (unknown method/tool,
 * notifications, snapshot-not-loaded).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import type { BridgeServerState } from '../server.ts';
import { HEALTHY_RELOAD, summarizeSnapshotHealth } from '../snapshot-health.ts';
import {
  createMcpDispatcher,
  DEFAULT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcResponse,
  type McpDispatch,
} from './dispatcher.ts';
import type { McpTool } from './tools.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-snapshot.json', import.meta.url);

let hydrated: HydrateResult;
let state: BridgeServerState;
let dispatch: McpDispatch;

beforeEach(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  state = { driver: hydrated.driver, snapshotGeneratedAt: '2026-06-29T00:00:00.000Z' };
  dispatch = createMcpDispatcher({ getState: () => state });
});

afterEach(async () => {
  await hydrated.driver.close();
});

/** Dispatch a request and assert a (non-null) response came back. */
async function call(message: unknown): Promise<JsonRpcResponse> {
  const response = await dispatch(message);
  expect(response).not.toBeNull();
  return response!;
}

describe('initialize', () => {
  /** Run `initialize` with the given params and return the negotiated protocol version. */
  async function negotiate(params: unknown): Promise<string> {
    const res = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params });
    return (res.result as { protocolVersion: string }).protocolVersion;
  }

  it('agrees to a supported protocol version and advertises the tools capability', async () => {
    const res = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    });
    expect(res.id).toBe(1);
    const result = res.result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
      serverInfo: { name: string };
    };
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe('gubbins-bridge-mcp');
  });

  it('agrees to every revision it claims to support', async () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(await negotiate({ protocolVersion: version, capabilities: {} })).toBe(version);
    }
  });

  it('names its newest revision rather than echoing an unsupported one (issue #568)', async () => {
    // The disagreement the handshake exists to express: a client asking for a revision we do not
    // implement must be told what we *do* speak, not handed its own string back.
    expect(await negotiate({ protocolVersion: '2099-01-01', capabilities: {} })).toBe(
      DEFAULT_PROTOCOL_VERSION,
    );
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(DEFAULT_PROTOCOL_VERSION);
  });

  it('does not echo a malformed protocol version back', async () => {
    expect(await negotiate({ protocolVersion: '2024-11-o5', capabilities: {} })).toBe(
      DEFAULT_PROTOCOL_VERSION,
    );
    expect(await negotiate({ protocolVersion: 20241105, capabilities: {} })).toBe(DEFAULT_PROTOCOL_VERSION);
  });

  it('falls back to the default protocol version when none is requested', async () => {
    expect(await negotiate({})).toBe(DEFAULT_PROTOCOL_VERSION);
  });
});

describe('ping', () => {
  it('returns an empty result', async () => {
    const res = await call({ jsonrpc: '2.0', id: 'p', method: 'ping' });
    expect(res.result).toEqual({});
  });
});

describe('tools/list', () => {
  it('lists the six tools with their schemas', async () => {
    const res = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const { tools } = res.result as { tools: { name: string; inputSchema: unknown }[] };
    expect(tools.map((t) => t.name)).toEqual([
      'gubbins_search',
      'gubbins_where_is',
      'gubbins_get_item',
      'gubbins_list_locations',
      'gubbins_list_categories',
      'gubbins_list_capabilities',
    ]);
    expect(tools[0]!.inputSchema).toBeDefined();
  });
});

describe('tools/call', () => {
  it('runs a tool and returns both text content and structuredContent', async () => {
    const res = await call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'gubbins_search', arguments: { q: 'ESP32 Dev Board' } },
    });
    const result = res.result as {
      content: { type: string; text: string }[];
      structuredContent: { matches: { id: string }[] };
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.type).toBe('text');
    expect(result.structuredContent.matches[0]!.id).toBe('item-esp32');
    // The text content is the same data, JSON-encoded.
    expect(JSON.parse(result.content[0]!.text).matches[0].id).toBe('item-esp32');
  });

  it('does not annotate a successful result when the snapshot is fresh (issue #394)', async () => {
    const fresh = createMcpDispatcher({
      getState: () => state,
      getSnapshotHealth: () => summarizeSnapshotHealth(HEALTHY_RELOAD),
    });
    const res = await fresh({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'gubbins_search', arguments: { q: 'ESP32 Dev Board' } },
    });
    const result = (res as JsonRpcResponse).result as { content: { text: string }[] };
    // A healthy call keeps its single data block — the very first block is the JSON payload.
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text).matches[0].id).toBe('item-esp32');
  });

  it('prepends a staleness caveat to a successful result when the snapshot is stale (issue #394)', async () => {
    const staleReport = summarizeSnapshotHealth({
      ...HEALTHY_RELOAD,
      consecutiveFailures: 5,
      lastError: "ENOENT: no such file or directory, open '/srv/gubbins-sync.json'",
      lastErrorAt: '2026-06-29T00:05:00.000Z',
      lastSuccessAt: '2026-06-29T00:00:00.000Z',
    });
    const stale = createMcpDispatcher({ getState: () => state, getSnapshotHealth: () => staleReport });
    const res = await stale({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'gubbins_search', arguments: { q: 'ESP32 Dev Board' } },
    });
    const result = (res as JsonRpcResponse).result as {
      content: { type: string; text: string }[];
      structuredContent: { matches: { id: string }[] };
      isError: boolean;
    };
    // Caveat first (so the model reads it before the data), then the untouched data block.
    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.text).toContain('out of date');
    expect(result.content[0]!.text).not.toContain('/srv/gubbins-sync.json'); // redacted
    expect(JSON.parse(result.content[1]!.text).matches[0].id).toBe('item-esp32');
    // The structured payload stays clean — staleness is metadata about the answer, not part of it.
    expect(result.structuredContent).not.toHaveProperty('stale');
    expect(result.structuredContent.matches[0]!.id).toBe('item-esp32');
    expect(result.isError).toBe(false);
  });

  it('does not caveat a write (mutating) tool result even when the read snapshot is stale (issue #394)', async () => {
    // A write executes against a freshly-read snapshot, not the watcher's stale read driver, so its
    // confirmation must not carry the read-staleness caveat.
    const writeTool: McpTool = {
      name: 'gubbins_pretend_write',
      mutates: true,
      description: 'A stand-in mutating tool.',
      inputSchema: { type: 'object', additionalProperties: false },
      run: async () => ({ updated: true }),
    };
    const staleReport = summarizeSnapshotHealth({ ...HEALTHY_RELOAD, consecutiveFailures: 9 });
    const stale = createMcpDispatcher({
      getState: () => state,
      getSnapshotHealth: () => staleReport,
      tools: [writeTool],
    });
    const res = await stale({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: writeTool.name, arguments: {} },
    });
    const result = (res as JsonRpcResponse).result as { content: { text: string }[] };
    // Single block, no caveat — the write result stands on its own.
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ updated: true });
  });

  it('returns a normal (non-error) result with found:false for an unknown item id', async () => {
    const res = await call({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'gubbins_get_item', arguments: { id: 'nope' } },
    });
    const result = res.result as { isError: boolean; structuredContent: { found: boolean } };
    expect(result.isError).toBe(false);
    expect(result.structuredContent.found).toBe(false);
  });

  it('logs the real reason for an unexpected tool failure without leaking it (issue #568)', async () => {
    const broken: McpTool = {
      name: 'gubbins_pretend_broken',
      description: 'A stand-in tool that throws.',
      inputSchema: { type: 'object', additionalProperties: false },
      run: async () => {
        throw new Error('no such column: widget_id');
      },
    };
    const logged: string[] = [];
    const withLog = createMcpDispatcher({
      getState: () => state,
      tools: [broken],
      logError: (message) => logged.push(message),
    });
    const res = await withLog({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: broken.name, arguments: {} },
    });
    const result = (res as JsonRpcResponse).result as { isError: boolean; content: { text: string }[] };
    // The model still sees only the generic message — the SQL stays out of the protocol channel.
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('The tool failed to run.');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('gubbins_pretend_broken');
    expect(logged[0]).toContain('no such column: widget_id');
  });

  it('does not log a bad-argument failure, which the model already sees', async () => {
    const logged: string[] = [];
    const withLog = createMcpDispatcher({
      getState: () => state,
      logError: (message) => logged.push(message),
    });
    await withLog({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'gubbins_search', arguments: {} },
    });
    expect(logged).toEqual([]);
  });

  it('returns an isError tool result for invalid arguments', async () => {
    const res = await call({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'gubbins_search', arguments: {} },
    });
    const result = res.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('q');
  });

  it('errors with -32602 for an unknown tool', async () => {
    const res = await call({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'gubbins_delete_everything', arguments: {} },
    });
    expect(res.error?.code).toBe(-32602);
  });

  it('errors with -32602 when name is missing', async () => {
    const res = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} });
    expect(res.error?.code).toBe(-32602);
  });

  it('returns an isError tool result when no snapshot is loaded', async () => {
    const noState = createMcpDispatcher({ getState: () => null });
    const res = await noState({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'gubbins_search', arguments: { q: 'M3' } },
    });
    expect((res!.result as { isError: boolean }).isError).toBe(true);
  });
});

describe('protocol guards', () => {
  it('returns -32601 for an unknown method', async () => {
    const res = await call({ jsonrpc: '2.0', id: 9, method: 'does/not/exist' });
    expect(res.error?.code).toBe(-32601);
  });

  it('does not reply to a notification (no id)', async () => {
    expect(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('rejects a malformed request that carries an id', async () => {
    const res = await call({ id: 10, method: 'initialize' }); // missing jsonrpc
    expect(res.error?.code).toBe(-32600);
  });

  it('stays silent on a malformed message with no id', async () => {
    expect(await dispatch({ foo: 'bar' })).toBeNull();
  });
});

describe('the tool list is the only gate', () => {
  /** A stand-in for an opt-in tool that was NOT built (e.g. writes disabled). */
  const absentTool: McpTool = {
    name: 'gubbins_absent',
    description: 'Never included in the dispatcher’s tool list.',
    inputSchema: { type: 'object', additionalProperties: false },
    run: async () => ({ ran: true }),
  };

  it('refuses to call a tool that is not in the configured list', async () => {
    // Guards the write opt-in: a model that guesses a disabled tool's name must get "Unknown
    // tool", never a dispatch. Resolving against a global registry instead of this list would
    // silently make every opt-in tool callable regardless of configuration.
    const response = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: absentTool.name, arguments: {} },
    });
    expect(response.error?.message).toMatch(/Unknown tool/);
    expect(response.result).toBeUndefined();
  });

  it('lists and calls a tool once it IS in the configured list', async () => {
    const withTool = createMcpDispatcher({ getState: () => state, tools: [absentTool] });
    const listed = await withTool({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((listed!.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual([
      absentTool.name,
    ]);

    const called = await withTool({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: absentTool.name, arguments: {} },
    });
    expect((called!.result as { isError: boolean }).isError).toBe(false);
  });

  it('no longer reaches the read tools when given a restricted list', async () => {
    const restricted = createMcpDispatcher({ getState: () => state, tools: [absentTool] });
    const response = await restricted({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'gubbins_search', arguments: { q: 'bolt' } },
    });
    expect(response!.error?.message).toMatch(/Unknown tool/);
  });
});
