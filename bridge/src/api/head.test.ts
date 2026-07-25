/**
 * Unit tests for {@link suppressResponseBody} — the HEAD seam (issue #360) — against a real
 * `node:http` server rather than the bridge, because it is a *general* adapter: it has to answer
 * correctly for any handler, not only for the single `writeHead` + `end(text)` shape every current
 * bridge responder happens to use. `server-head.test.ts` covers the bridge's own routes.
 *
 * The response is read over a raw socket: `fetch` normalises headers and discards a HEAD body, so
 * it cannot tell "no body, correct headers" from "nothing on the wire at all".
 */
import { createServer, type RequestListener, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { suppressResponseBody } from './head.ts';

let server: Server | null = null;

afterEach(async () => {
  if (server !== null) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

/** Serve `handler` (with the HEAD adapter installed) and return the raw wire response to `method`. */
async function serve(handler: RequestListener, method: string): Promise<string> {
  server = createServer((req, res) => {
    if (req.method === 'HEAD') suppressResponseBody(res);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${method} / HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nconnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
  });
}

describe('suppressResponseBody', () => {
  it('answers with the headers and no body, stamping the length the GET would have sent', async () => {
    const handler: RequestListener = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
    };
    const raw = await serve(handler, 'HEAD');

    expect(raw).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(raw).toMatch(/\r\ncontent-type: application\/json; charset=utf-8\r\n/i);
    expect(raw).toMatch(/\r\ncontent-length: 11\r\n/i);
    expect(raw.indexOf('\r\n\r\n')).toBe(raw.length - 4);
  });

  // Node's `_implicitHeader()` is `this.writeHead(this.statusCode)`, so it routes back through the
  // patched `writeHead`. Unless the adapter writes the head itself, a handler that never calls
  // `writeHead` puts no status line on the wire and the client waits for the request timeout.
  it('still answers when the handler relies on the implicit header', async () => {
    const handler: RequestListener = (_req, res) => {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('nope');
    };
    const raw = await serve(handler, 'HEAD');

    expect(raw).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
    expect(raw).toMatch(/\r\ncontent-type: text\/plain; charset=utf-8\r\n/i);
    expect(raw).toMatch(/\r\ncontent-length: 4\r\n/i);
    expect(raw.indexOf('\r\n\r\n')).toBe(raw.length - 4);
  });

  it('counts every chunk a progressive handler writes, in bytes and not characters', async () => {
    const handler: RequestListener = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.write('héllo'); // 6 bytes, 5 characters
      res.write(Buffer.from(' — ✓', 'utf8')); // 8 bytes
      res.end('!');
    };
    const raw = await serve(handler, 'HEAD');

    expect(raw).toMatch(/\r\ncontent-length: 15\r\n/i);
    expect(raw.indexOf('\r\n\r\n')).toBe(raw.length - 4);
  });

  it('leaves a length the handler set itself alone, and omits one when nothing was written', async () => {
    const claimed = await serve((_req, res) => {
      // A handler that knows the length of content it is not sending (a conditional response).
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '4096' });
      res.end();
    }, 'HEAD');
    expect(claimed).toMatch(/\r\ncontent-length: 4096\r\n/i);

    // An unbounded or genuinely empty response gets no length rather than a `0` that would be a lie
    // (and that RFC 9110 §8.6 forbids outright on a 204).
    const streaming = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end();
    }, 'HEAD');
    expect(streaming).not.toMatch(/content-length/i);
    expect(streaming).not.toMatch(/transfer-encoding/i);
  });

  it('leaves a GET on the same handler untouched', async () => {
    const handler: RequestListener = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('body');
    };
    const raw = await serve(handler, 'GET');

    expect(raw).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(raw).toContain('body');
    // The adapter is not installed for a GET, so Node frames it as it always would: `writeHead`
    // commits the framing before `end(body)` knows the length, hence chunked and no
    // `Content-Length`. Which is why the HEAD's synthesised length is worth having — it is the only
    // place a client can learn the size (RFC 9110 §8.6 permits exactly that).
    expect(raw).toMatch(/\r\ntransfer-encoding: chunked\r\n/i);
    expect(raw).not.toMatch(/content-length/i);
  });
});
