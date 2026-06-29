/**
 * stdio transport for the MCP server: newline-delimited JSON-RPC over a readable/writable
 * pair (by default the process's own stdin/stdout, the MCP stdio convention for local agents).
 *
 * IMPORTANT: in an MCP stdio server, **stdout is the protocol channel** — only JSON-RPC
 * messages may be written there. All human/diagnostic logging must go to stderr (the
 * composition root in `serve.ts` does exactly that). Each message is a single line of JSON
 * with no embedded newline (`JSON.stringify` guarantees this; any newlines inside string
 * values are escaped), per the MCP stdio framing rules.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { createMcpDispatcher, type JsonRpcResponse, type McpDispatcherOptions } from './dispatcher.ts';

/** JSON-RPC parse-error code, returned (with a null id) when a line is not valid JSON. */
const PARSE_ERROR = -32700;

export interface StdioServerOptions extends McpDispatcherOptions {
  /** Where to read newline-delimited requests (defaults to `process.stdin`). */
  readonly input?: Readable;
  /** Where to write newline-delimited responses (defaults to `process.stdout`). */
  readonly output?: Writable;
}

export interface StdioServer {
  /** Stop reading and release the line reader. */
  close(): void;
}

/**
 * Start an MCP stdio server. Reads one JSON-RPC message per line, dispatches it (read-only),
 * and writes each response as its own line; notifications and blank lines produce no output.
 * Lines are handled in order so responses never interleave on the wire.
 */
export function runStdioServer(options: StdioServerOptions): StdioServer {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const dispatch = createMcpDispatcher(options);
  const rl = createInterface({ input, crlfDelay: Infinity });

  // Serialise line handling: a local read-only server has no need to interleave responses,
  // and in-order writes keep the framing trivially correct.
  let chain: Promise<void> = Promise.resolve();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    chain = chain.then(async () => {
      const response = await handleLine(dispatch, trimmed);
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    });
  });

  return {
    close(): void {
      rl.close();
    },
  };
}

/** Parse one line and dispatch it; a malformed line is a JSON-RPC parse error with a null id. */
async function handleLine(
  dispatch: (message: unknown) => Promise<JsonRpcResponse | null>,
  line: string,
): Promise<JsonRpcResponse | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } };
  }
  return dispatch(parsed);
}
