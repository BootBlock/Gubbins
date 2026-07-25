/**
 * `HEAD` support for the read-only surfaces (issue #360).
 *
 * RFC 9110 §9.1 makes GET **and** HEAD mandatory for a general-purpose server, and §9.3.2 defines
 * HEAD as identical to GET bar the content — the response carries the header fields the GET would
 * have carried. Real clients lean on that: Outlook and several CalDAV/webcal subscribers HEAD a
 * `.ics` URL to test reachability (and to spot a change before spending a download on it), and
 * feed readers probe the same way. `node:http` does not synthesise HEAD from GET, so a server that
 * admits only GET answers those probes with a `405` and the subscription never establishes, even
 * though the GET works perfectly.
 *
 * The bridge therefore routes a HEAD through **exactly** the GET path — same auth, same
 * permissions, same handler — after installing {@link suppressResponseBody} on the response. The
 * handler writes what it always writes; this swallows the content and stamps the byte count the GET
 * would have produced as `Content-Length`, so the two responses stay header-identical.
 *
 * Node already drops body writes on a HEAD response (`ServerResponse._hasBody` is false), but it
 * drops the implicit `Content-Length` along with them — which is precisely the header a probe wants.
 * Hence the headers are held back until `end()`, the first moment the length is known, rather than
 * going out when the handler calls `writeHead`.
 */
import type { ServerResponse } from 'node:http';

/**
 * Make `res` answer with headers only: body writes are counted and discarded, and the headers are
 * written once — at `end()` — with a `Content-Length` describing the content that was suppressed.
 *
 * Call it before any response is written (the bridge does so as soon as it has seen the method), so
 * every answer a HEAD can reach — including the `401`/`405`/`503` guards — is bodyless.
 */
export function suppressResponseBody(res: ServerResponse): void {
  // Bound up-front: the patched versions below shadow these on the instance, so a late lookup
  // through `res` would find the patch and recurse.
  const passWriteHead = res.writeHead.bind(res) as (...args: readonly unknown[]) => ServerResponse;
  const passEnd = res.end.bind(res) as (callback?: () => void) => ServerResponse;

  /** The deferred `writeHead` arguments, verbatim, or null if the handler never called it. */
  let head: readonly unknown[] | null = null;
  /** Bytes the handler tried to write — the `Content-Length` a GET would have reported. */
  let bytes = 0;
  let flushed = false;

  res.writeHead = ((...args: readonly unknown[]): ServerResponse => {
    head = args;
    return res;
  }) as ServerResponse['writeHead'];

  res.write = ((chunk?: unknown, encoding?: unknown, callback?: unknown): boolean => {
    bytes += byteLengthOf(chunk, encoding);
    deferCallback(encoding, callback);
    return true;
  }) as ServerResponse['write'];

  res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown): ServerResponse => {
    if (typeof chunk !== 'function') bytes += byteLengthOf(chunk, encoding);
    if (!flushed) {
      flushed = true;
      // Stamp the length only when the GET would actually have produced content: RFC 9110 §8.6
      // forbids `Content-Length` on a 1xx or `204`, and a response that wrote nothing here is
      // either genuinely empty or a stream (the SSE endpoint) whose length is knowable only while
      // the content is being generated — `0` would be a lie in both cases.
      if (bytes > 0 && !hasContentLength(res, head)) res.setHeader('content-length', String(bytes));
      // Write the head unconditionally, *including* when the handler never called `writeHead`.
      // Node's own `_implicitHeader()` is `this.writeHead(this.statusCode)`, which now lands on the
      // patch above and stores its arguments instead of storing the header — so a handler that
      // relies on the implicit header (`res.statusCode = 404; res.end(body)`) would otherwise put
      // no status line on the wire at all and hang the client until the request timeout.
      // `[res.statusCode]` is precisely what that implicit call would have passed.
      passWriteHead(...(head ?? [res.statusCode]));
    }
    return passEnd(finalCallback(chunk, encoding, callback));
  }) as ServerResponse['end'];
}

/** The byte count a `write`/`end` chunk would have put on the wire. */
function byteLengthOf(chunk: unknown, encoding: unknown): number {
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
  }
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

/**
 * Whether a `Content-Length` is already accounted for — set progressively via `setHeader`, or named
 * in the deferred `writeHead` arguments (whose own value must win, exactly as it would have).
 */
function hasContentLength(res: ServerResponse, head: readonly unknown[] | null): boolean {
  if (res.hasHeader('content-length')) return true;
  if (head === null) return false;
  return head.some((arg) => namesContentLength(arg));
}

/** Whether one `writeHead` argument carries a `content-length`, in either the object or array form. */
function namesContentLength(arg: unknown): boolean {
  if (Array.isArray(arg)) return arg.flat().some((v) => isContentLength(v));
  if (typeof arg === 'object' && arg !== null) return Object.keys(arg).some((k) => isContentLength(k));
  return false;
}

function isContentLength(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase() === 'content-length';
}

/** Invoke a `write` completion callback the way Node does — asynchronously, never inline. */
function deferCallback(encoding: unknown, callback: unknown): void {
  const done = typeof encoding === 'function' ? encoding : callback;
  if (typeof done === 'function') process.nextTick(done as () => void);
}

/** The completion callback out of an `end(chunk?, encoding?, callback?)` call, in any of its forms. */
function finalCallback(chunk: unknown, encoding: unknown, callback: unknown): (() => void) | undefined {
  for (const candidate of [chunk, encoding, callback]) {
    if (typeof candidate === 'function') return candidate as () => void;
  }
  return undefined;
}
