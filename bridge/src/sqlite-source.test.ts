/**
 * Direct `.sqlite` data-source tests (Deferred-work: Direct `.sqlite` data source).
 *
 * The fixture `.sqlite` is **generated at test time** from the same synthetic JSON snapshot the
 * rest of the bridge tests use (no binary DB is committed — `.gitignore` blocks `*.sqlite`/`*.db`
 * anyway, and it would only ever be synthetic): we hydrate the JSON into a *file-backed*
 * `node:sqlite` DB, which is byte-for-byte the format the app's raw export produces. We then
 * prove the raw-`.sqlite` front-end answers identically to the JSON path, that the source
 * detector and the write-gating behave, and that a newer-than-known schema is refused.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { emptyAst } from '@/db/search/ast';
import { migrations, runMigrations, TARGET_SCHEMA_VERSION } from '@/db/migrations';
import { parseBackupJson } from '@/features/sync/backup';
import { restoreSnapshot } from '@/features/sync/snapshot';
import { parseTextQuery } from '@/features/search/parse-text-query';
import { createNodeDriver } from './node-driver.ts';
import { hydrateFromFile, type HydrateResult } from './hydrate.ts';
import {
  detectSource,
  hydrateFromSqliteFile,
  pushEnabledForSource,
  sourceKindFromExtension,
  writesEnabledForSource,
} from './sqlite-source.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);

/** Build a real, synthetic `.sqlite` file from the JSON fixture (the raw-export format). */
async function buildSyntheticSqlite(destPath: string): Promise<void> {
  const text = await readFile(fileURLToPath(FIXTURE_URL), 'utf8');
  const driver = createNodeDriver(destPath);
  try {
    await runMigrations(driver, migrations);
    await restoreSnapshot(driver, parseBackupJson(text));
  } finally {
    await driver.close();
  }
}

describe('source detection', () => {
  it('classifies by extension', () => {
    expect(sourceKindFromExtension('/a/gubbins-sync.json')).toBe('json');
    expect(sourceKindFromExtension('/a/export.sqlite')).toBe('sqlite');
    expect(sourceKindFromExtension('/a/export.sqlite3')).toBe('sqlite');
    expect(sourceKindFromExtension('/a/export.DB')).toBe('sqlite');
    expect(sourceKindFromExtension('/a/mystery.bin')).toBeNull();
  });

  it('sniffs the SQLite magic header for an ambiguous extension', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gubbins-detect-'));
    try {
      const dbPath = path.join(dir, 'mystery.bin');
      await buildSyntheticSqlite(dbPath);
      expect(await detectSource(dbPath)).toBe('sqlite');

      const jsonPath = path.join(dir, 'mystery2.bin');
      await writeFile(jsonPath, '{"formatVersion":1,"tables":{}}', 'utf8');
      expect(await detectSource(jsonPath)).toBe('json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('defaults an unreadable/ambiguous path to JSON (the documented format)', async () => {
    expect(await detectSource(path.join(tmpdir(), 'does-not-exist.unknown'))).toBe('json');
  });
});

describe('writesEnabledForSource', () => {
  it('allows writes only for a JSON source', () => {
    expect(writesEnabledForSource(true, 'json')).toBe(true);
    expect(writesEnabledForSource(true, 'sqlite')).toBe(false);
    expect(writesEnabledForSource(false, 'json')).toBe(false);
    expect(writesEnabledForSource(false, 'sqlite')).toBe(false);
  });
});

describe('pushEnabledForSource', () => {
  it('allows push only for a JSON source (refused for a raw .sqlite, mirroring writes)', () => {
    expect(pushEnabledForSource(true, 'json')).toBe(true);
    expect(pushEnabledForSource(true, 'sqlite')).toBe(false);
    expect(pushEnabledForSource(false, 'json')).toBe(false);
    expect(pushEnabledForSource(false, 'sqlite')).toBe(false);
  });
});

describe('hydrateFromSqliteFile', () => {
  let dir: string;
  let dbPath: string;
  let hydrated: HydrateResult;
  let items: ItemRepository;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gubbins-sqlite-'));
    dbPath = path.join(dir, 'gubbins-export.sqlite');
    await buildSyntheticSqlite(dbPath);
    hydrated = await hydrateFromSqliteFile(dbPath);
    items = new ItemRepository(hydrated.driver);
  });

  afterEach(async () => {
    await hydrated.driver.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports the current schema version (idempotent migrate of an already-current export)', () => {
    expect(hydrated.migration.to).toBe(TARGET_SCHEMA_VERSION);
    expect(hydrated.snapshot.generatedAt).toBeGreaterThan(0);
  });

  it('loads the expected row counts (parity with the JSON path)', async () => {
    const count = async (sql: string) =>
      Number((await hydrated.driver.queryOne<{ n: number }>(sql))?.n ?? -1);
    expect(await count('SELECT COUNT(*) AS n FROM items WHERE is_active = 1')).toBe(4);
    expect(await count('SELECT COUNT(*) AS n FROM item_stock')).toBe(5);
  });

  it('answers a casual name query through parseTextQuery → searchByAst', async () => {
    const parsed = parseTextQuery('ESP32');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const page = await items.searchByAst(parsed.ast);
    expect(page.rows.map((r) => r.id)).toEqual(['item-esp32']);
  });

  it('matches a distinctive FTS token and a power-user cap: query', async () => {
    const nylon = parseTextQuery('Nylon');
    expect(nylon.ok).toBe(true);
    if (!nylon.ok) return;
    expect((await items.searchByAst(nylon.ast)).rows.map((r) => r.name)).toEqual(['M3 Nylon Washer']);

    const cap = parseTextQuery('cap:voltage>3');
    expect(cap.ok).toBe(true);
    if (!cap.ok) return;
    expect((await items.searchByAst(cap.ast)).rows.map((r) => r.id)).toEqual(['item-esp32']);
  });

  it('keeps the recompute triggers (items.quantity = SUM(item_stock))', async () => {
    expect((await items.getById('item-esp32'))?.quantity).toBe(7);
  });

  it("never mutates the user's export file (it works on a private copy)", async () => {
    const before = await stat(dbPath);
    await items.searchByAst(emptyAst('AND'));
    const after = await stat(dbPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });

  it('refuses a database newer than this bridge understands', async () => {
    const newerPath = path.join(dir, 'newer.sqlite');
    await buildSyntheticSqlite(newerPath);
    const raw = createNodeDriver(newerPath);
    await raw.execute(`PRAGMA user_version = ${TARGET_SCHEMA_VERSION + 5};`);
    await raw.close();
    await expect(hydrateFromSqliteFile(newerPath)).rejects.toThrow(/newer/i);
  });
});

describe('hydrateFromFile dispatch', () => {
  it('hydrates a raw .sqlite identically to the JSON snapshot', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gubbins-dispatch-'));
    try {
      const dbPath = path.join(dir, 'export.sqlite');
      const jsonPath = path.join(dir, 'gubbins-sync.json');
      await buildSyntheticSqlite(dbPath);
      await writeFile(jsonPath, await readFile(fileURLToPath(FIXTURE_URL), 'utf8'), 'utf8');

      const fromDb = await hydrateFromFile(dbPath);
      const fromJson = await hydrateFromFile(jsonPath);
      try {
        // The same query through the same app repositories should return the same items,
        // regardless of which source the driver was hydrated from.
        const ids = async (h: HydrateResult) =>
          (await new ItemRepository(h.driver).searchByAst(emptyAst('AND'))).rows.map((r) => r.id).sort();
        expect(await ids(fromDb)).toEqual(await ids(fromJson));
      } finally {
        await fromDb.driver.close();
        await fromJson.driver.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
