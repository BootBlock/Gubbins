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
import {
  createMcpDispatcher,
  DEFAULT_PROTOCOL_VERSION,
  type JsonRpcResponse,
  type McpDispatch,
} from './dispatcher.ts';

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
  it('echoes the requested protocol version and advertises the tools capability', async () => {
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

  it('falls back to the default protocol version when none is requested', async () => {
    const res = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect((res.result as { protocolVersion: string }).protocolVersion).toBe(DEFAULT_PROTOCOL_VERSION);
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
