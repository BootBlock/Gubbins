/**
 * `GET /api/v1/items.csv` over a catalogue several walk-pages deep (issue #533), against the
 * SYNTHETIC fixture plus generated rows (no real or personal data).
 *
 * The export used to walk `LIMIT 100 OFFSET n` until it had the whole catalogue in memory, build
 * the entire document as one string, and send it with `res.end(text)`. Each of those is asserted
 * here from the outside, because each is invisible in the bytes alone: a keyset walk and an offset
 * walk return the same CSV, and so do a streamed response and a buffered one.
 *
 *   - **No offset walking.** The statements the route runs are recorded, and only the first page
 *     may carry an `OFFSET` (the unfiltered path's first read has nowhere to seek from yet).
 *   - **Streamed.** The first bytes reach the client before the walk has finished reading, which a
 *     response assembled in memory and handed to `res.end()` in one call cannot do.
 *   - **Conditional.** A spreadsheet set to refresh on open re-fetches this constantly, so the
 *     second identical fetch must cost a `304` rather than a second walk.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { mintTestToken } from '../fixtures/test-identity.ts';
import { createBridgeServer, type BridgeServerState } from '../server.ts';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import type { SqlParams } from '@/db/rpc/driver';
import { CSV_WALK_PAGE_SIZE } from './items-csv.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-snapshot.json', import.meta.url);

/** Deep enough to need several walk pages, so a page-boundary bug has somewhere to happen. */
const GENERATED_ITEMS = CSV_WALK_PAGE_SIZE * 2 + 7;
/** Half the generated rows carry this quantity, so `$filter` selects a multi-page subset. */
const BULK_QUANTITY = 500;

let TOKEN = '';
let hydrated: HydrateResult;
let server: ReturnType<typeof createBridgeServer>;
let baseUrl: string;
let fixtureItems = 0;
/** Every SQL statement the driver has been asked to run since {@link recorded} last reset it. */
let statements: string[] = [];
/** Milliseconds to stall each driver read by; 0 for every test bar the streaming one. */
let readDelayMs = 0;

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  TOKEN = await mintTestToken(hydrated.driver);

  const items = new ItemRepository(hydrated.driver);
  fixtureItems = await items.count();
  for (let i = 0; i < GENERATED_ITEMS; i += 1) {
    // Padded so the names sort in creation order, and duplicated in pairs so the walk has ties to
    // resolve on the id tiebreak rather than only distinct sort keys.
    await items.create({
      name: `Generated part ${String(Math.floor(i / 2)).padStart(4, '0')}`,
      quantity: i % 2 === 0 ? BULK_QUANTITY : i,
    });
  }

  // The driver the server reads through, with every statement recorded. Only `query` is wrapped —
  // it is the one the item walk uses, and the point is to see how the walk pages. `readDelayMs`
  // slows each read on demand, which is what lets the streaming test below observe the response
  // arriving *while* the walk is still running rather than only after it.
  const driver = new Proxy(hydrated.driver, {
    get(target, prop, receiver) {
      if (prop !== 'query') return Reflect.get(target, prop, receiver);
      return async (sql: string, params?: SqlParams) => {
        statements.push(sql);
        if (readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, readDelayMs));
        return target.query(sql, params);
      };
    },
  });
  const state: BridgeServerState = {
    driver,
    snapshotGeneratedAt: new Date(hydrated.snapshot.generatedAt).toISOString(),
  };
  server = createBridgeServer({ getState: () => state });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await hydrated.driver.close();
});

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
}

/** Fetch `path` and hand back the response together with the statements it ran. */
async function recorded(
  path: string,
  headers?: Record<string, string>,
): Promise<{
  res: Response;
  body: string;
  sql: string[];
}> {
  statements = [];
  const res = await get(path, headers);
  const body = await res.text();
  return { res, body, sql: statements };
}

/** The data rows of a CSV body (the header dropped), which is also the id column of each. */
function dataRows(body: string): string[] {
  return body.split('\r\n').slice(1);
}

describe('GET /api/v1/items.csv over a multi-page catalogue', () => {
  it('exports every matching row, not the first page and not a capped prefix', async () => {
    const { res, body } = await recorded('/api/v1/items.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');

    const rows = dataRows(body);
    expect(rows).toHaveLength(fixtureItems + GENERATED_ITEMS);
    // Ids are column 0 and never quoted, so this is also a duplicate/skip check across the
    // page boundaries the walk crossed.
    expect(new Set(rows.map((line) => line.split(',')[0])).size).toBe(rows.length);
  });

  it('walks with a keyset cursor rather than deepening OFFSETs', async () => {
    const { sql } = await recorded('/api/v1/items.csv');
    const itemReads = sql.filter((text) => text.includes('FROM items'));
    expect(itemReads.length).toBeGreaterThan(2); // it really did take several pages

    // Only the very first page may offset — and at 0. Every page after it seeks past a cursor,
    // which is what keeps the walk linear instead of quadratic in the row count.
    expect(itemReads.filter((text) => text.includes('OFFSET')).length).toBeLessThanOrEqual(1);
  });

  /**
   * The claim under test is that the export writes as it reads. Both a streamed and a buffered
   * response produce identical bytes and identical headers, so the only thing that separates them
   * is *when* the client can see the first of those bytes: a buffered export finishes every read
   * before it writes anything, a streamed one writes page 1 while page 2 is still being fetched.
   *
   * So the reads are stalled (`readDelayMs`) to make the walk slow enough to observe, and the
   * body is consumed a chunk at a time rather than with `res.text()`. Counting the reads issued at
   * the moment the first chunk lands against the total is the discriminator — buffering makes the
   * two equal by construction.
   */
  it('writes the first rows before the walk has finished reading', async () => {
    readDelayMs = 20;
    try {
      statements = [];
      const res = await get('/api/v1/items.csv');
      const reader = res.body!.getReader();

      const first = await reader.read();
      expect(first.done).toBe(false);
      const readsWhenFirstChunkLanded = statements.filter((text) => text.includes('FROM items')).length;

      while (!(await reader.read()).done) {
        // Drain the rest so the walk runs to completion and the socket closes cleanly.
      }
      const totalReads = statements.filter((text) => text.includes('FROM items')).length;

      expect(totalReads).toBeGreaterThan(1);
      expect(readsWhenFirstChunkLanded).toBeLessThan(totalReads);
    } finally {
      readDelayMs = 0;
    }
  });

  it('walks a $filter-ed export past its first page too', async () => {
    const { res, body, sql } = await recorded(`/api/v1/items.csv?$filter=quantity eq ${BULK_QUANTITY}`);
    expect(res.status).toBe(200);
    // Every generated even-indexed row, and none of the odd ones (whose quantity is their index).
    expect(dataRows(body)).toHaveLength(Math.ceil(GENERATED_ITEMS / 2));
    expect(sql.filter((text) => text.includes('FROM items') && text.includes('OFFSET'))).toHaveLength(0);
  });
});

describe('GET /api/v1/items.csv conditional requests', () => {
  it('offers validators a refreshing spreadsheet can revalidate against', async () => {
    const res = await get('/api/v1/items.csv');
    expect(res.headers.get('etag')).toMatch(/^W\//);
    expect(res.headers.get('last-modified')).not.toBeNull();
    // Private: the export is personal inventory behind a bearer token, so no shared cache may
    // keep a copy — and no-cache, so every reuse revalidates.
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    await res.text();
  });

  it('answers an unchanged re-fetch with a 304 and does not read an item at all', async () => {
    const etag = (await get('/api/v1/items.csv')).headers.get('etag');
    expect(etag).not.toBeNull();

    const { res, body, sql } = await recorded('/api/v1/items.csv', { 'if-none-match': etag! });
    expect(res.status).toBe(304);
    expect(body).toBe('');
    expect(res.headers.get('etag')).toBe(etag);
    // The whole point: the refresh costs a header exchange, not a walk of the catalogue.
    expect(sql.filter((text) => text.includes('FROM items'))).toHaveLength(0);
  });

  it('honours If-Modified-Since for a client that keeps no ETag', async () => {
    const lastModified = (await get('/api/v1/items.csv')).headers.get('last-modified');
    const res = await get('/api/v1/items.csv', { 'if-modified-since': lastModified! });
    expect(res.status).toBe(304);
  });

  it('gives each scope its own tag, so one export never revalidates against another', async () => {
    const whole = (await get('/api/v1/items.csv')).headers.get('etag');
    const filtered = await get(`/api/v1/items.csv?$filter=quantity eq ${BULK_QUANTITY}`);
    expect(filtered.headers.get('etag')).not.toBe(whole);

    // A filtered export handed the *unfiltered* export's tag must be re-sent in full, not 304'd.
    const crossed = await get(`/api/v1/items.csv?$filter=quantity eq ${BULK_QUANTITY}`, {
      'if-none-match': whole!,
    });
    expect(crossed.status).toBe(200);
    await Promise.all([filtered.text(), crossed.text()]);
  });

  it('splits the tag on a scope parameter that is not the $filter', async () => {
    // The tag is cut over the *parsed* scope — the AST, the list filters and the sort — so every
    // parameter that can move a row into or out of the export is in the key by construction, not
    // because a list of parameter names was kept up to date beside it.
    const plain = (await get('/api/v1/items.csv')).headers.get('etag');
    for (const query of ['?includeInactive=true', '?$orderby=quantity desc', '?$search=Generated']) {
      const scoped = await get(`/api/v1/items.csv${query}`);
      expect(scoped.headers.get('etag'), query).not.toBe(plain);
      await scoped.text();
    }
  });

  it('ignores a parameter the export does not read, rather than splitting the tag on it', async () => {
    // A spreadsheet that appends a cache-buster would otherwise pay for a full export every
    // refresh, which is the cost this endpoint exists to stop paying.
    const plain = (await get('/api/v1/items.csv')).headers.get('etag');
    const busted = await get('/api/v1/items.csv?_=1730000000000');
    expect(busted.headers.get('etag')).toBe(plain);
    await busted.text();
  });
});
