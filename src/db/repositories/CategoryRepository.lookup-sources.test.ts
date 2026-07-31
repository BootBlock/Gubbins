/**
 * `categories.lookup_sources` — the storage half of the category data lookups (issue #616).
 *
 * The column follows `hidden_capabilities` exactly, and the two properties that matter are the
 * ones a test can actually pin:
 *
 * 1. **A malformed stored value costs this one field, never the whole read.** The column is opaque
 *    `TEXT` with no `json_valid()` CHECK precisely so a bad payload from a peer cannot fail a sync
 *    apply, which means the mapper is the only thing standing between it and a crash.
 * 2. **An unrecognised provider id survives a round-trip.** A peer on a newer version may attach a
 *    provider this build has never heard of; narrowing on read would silently discard that choice
 *    the next time this device wrote the row back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { CategoryRepository } from './CategoryRepository';

describe('categories.lookup_sources', () => {
  let driver: MemoryDriver;
  let categories: CategoryRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    categories = new CategoryRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  /** The raw stored text, so the canonical form can be asserted rather than inferred. */
  const storedFor = async (id: string): Promise<string | null> => {
    const row = await driver.queryOne<{ lookup_sources: string | null }>(
      'SELECT lookup_sources FROM categories WHERE id = ?;',
      [id],
    );
    return row?.lookup_sources ?? null;
  };

  it('defaults to no lookups, stored as NULL', async () => {
    const created = await categories.create({ name: 'Movie' });
    expect(created.lookupSources).toEqual([]);
    expect(await storedFor(created.id)).toBeNull();
  });

  it('round-trips an attached provider', async () => {
    const created = await categories.create({
      name: 'Movie',
      lookupSources: [{ providerId: 'wikidata-film', fieldMap: null }],
    });
    expect(created.lookupSources).toEqual([{ providerId: 'wikidata-film', fieldMap: null }]);
    expect(await categories.getById(created.id)).toMatchObject({
      lookupSources: [{ providerId: 'wikidata-film', fieldMap: null }],
    });
  });

  it('round-trips a fieldMap override', async () => {
    const created = await categories.create({
      name: 'Movie',
      lookupSources: [{ providerId: 'wikidata-film', fieldMap: { director: 'f1', cast: 'f2' } }],
    });
    expect(created.lookupSources[0]!.fieldMap).toEqual({ director: 'f1', cast: 'f2' });
  });

  it('carries the sources through the list reads', async () => {
    const created = await categories.create({
      name: 'Movie',
      lookupSources: [{ providerId: 'wikidata-film', fieldMap: null }],
    });
    const all = await categories.listAll();
    expect(all.find((row) => row.id === created.id)?.lookupSources).toHaveLength(1);
    const page = await categories.list();
    expect(page.rows.find((row) => row.id === created.id)?.lookupSources).toHaveLength(1);
  });

  it('updates and clears independently of every other column', async () => {
    const created = await categories.create({ name: 'Movie', glyph: '🎬' });
    const attached = await categories.update(created.id, {
      lookupSources: [{ providerId: 'wikidata-film', fieldMap: null }],
    });
    expect(attached.lookupSources).toHaveLength(1);
    expect(attached.glyph).toBe('🎬');

    // Untouched by an update that does not mention it.
    const renamed = await categories.update(created.id, { name: 'Films I own' });
    expect(renamed.lookupSources).toHaveLength(1);

    // Both spellings of "no lookups" clear it, and both store the one canonical empty form —
    // never "[]" or "null", so an LWW merge can't see two spellings of the same choice as a change.
    const byEmptyArray = await categories.update(created.id, { lookupSources: [] });
    expect(byEmptyArray.lookupSources).toEqual([]);
    expect(await storedFor(created.id)).toBeNull();

    await categories.update(created.id, { lookupSources: [{ providerId: 'wikidata-film', fieldMap: null }] });
    const byNull = await categories.update(created.id, { lookupSources: null });
    expect(byNull.lookupSources).toEqual([]);
    expect(await storedFor(created.id)).toBeNull();
  });

  it('canonicalises what it stores, so re-picking the same set is not an edit', async () => {
    const a = await categories.create({
      name: 'A',
      lookupSources: [
        { providerId: 'zeta', fieldMap: { b: '2', a: '1' } },
        { providerId: 'alpha', fieldMap: null },
      ],
    });
    const b = await categories.create({
      name: 'B',
      lookupSources: [
        { providerId: 'alpha', fieldMap: {} },
        { providerId: 'zeta', fieldMap: { a: '1', b: '2' } },
        // A duplicate provider is meaningless — one category runs a provider once.
        { providerId: 'zeta', fieldMap: { a: 'other' } },
      ],
    });
    expect(await storedFor(a.id)).toBe(await storedFor(b.id));
    expect(await storedFor(a.id)).toBe(
      '[{"providerId":"alpha"},{"providerId":"zeta","fieldMap":{"a":"1","b":"2"}}]',
    );
  });

  it('drops a blank provider id rather than storing an entry that names nothing', async () => {
    const created = await categories.create({
      name: 'A',
      lookupSources: [
        { providerId: '   ', fieldMap: null },
        { providerId: ' wikidata-film ', fieldMap: null },
      ],
    });
    expect(created.lookupSources).toEqual([{ providerId: 'wikidata-film', fieldMap: null }]);
  });

  it('keeps a provider id this build does not recognise, through a full round-trip', async () => {
    // The invariant that matters for sync: an older device must not discard a newer peer's choice
    // just by touching the row.
    const created = await categories.create({
      name: 'Vinyl record',
      lookupSources: [{ providerId: 'musicbrainz-release', fieldMap: { label: 'f7' } }],
    });
    const reread = await categories.getById(created.id);
    const rewritten = await categories.update(created.id, { lookupSources: reread!.lookupSources });
    expect(rewritten.lookupSources).toEqual([
      { providerId: 'musicbrainz-release', fieldMap: { label: 'f7' } },
    ]);
  });
});

describe('categories.lookup_sources — a malformed stored value never throws', () => {
  let driver: MemoryDriver;
  let categories: CategoryRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    categories = new CategoryRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  let seq = 0;

  /** Write `raw` straight into the column, as a peer's sync apply would, and read it back. */
  const withRaw = async (raw: string): Promise<readonly unknown[]> => {
    seq += 1;
    const created = await categories.create({ name: `Category ${seq}` });
    await driver.execute('UPDATE categories SET lookup_sources = ? WHERE id = ?;', [raw, created.id]);
    return (await categories.getById(created.id))!.lookupSources;
  };

  it('reads a non-array, unparseable or wrongly-typed payload as no lookups', async () => {
    for (const raw of ['not json', '{}', '"wikidata-film"', 'null', '42', '[]']) {
      expect(await withRaw(raw), raw).toEqual([]);
    }
  });

  it('drops individual members that are not usable entries, keeping the ones that are', async () => {
    const raw = JSON.stringify([
      null,
      42,
      'wikidata-film',
      ['wikidata-film'],
      { fieldMap: { a: 'b' } },
      { providerId: '' },
      { providerId: 'wikidata-film' },
    ]);
    expect(await withRaw(raw)).toEqual([{ providerId: 'wikidata-film', fieldMap: null }]);
  });

  it('salvages an entry whose optional fieldMap is malformed, rather than discarding the entry', async () => {
    // The `providerId` *is* the entry; the map is an optional refinement, so a bad map degrades to
    // "bind by name" — which is exactly what an absent map means.
    for (const fieldMap of ['nope', 42, null, [], { a: 5 }, { a: '' }, {}]) {
      const raw = JSON.stringify([{ providerId: 'wikidata-film', fieldMap }]);
      expect(await withRaw(raw), JSON.stringify(fieldMap)).toEqual([
        { providerId: 'wikidata-film', fieldMap: null },
      ]);
    }
  });

  it('keeps only the string-valued members of a partly-malformed fieldMap', async () => {
    const raw = JSON.stringify([{ providerId: 'wikidata-film', fieldMap: { director: 'f1', cast: 7 } }]);
    expect(await withRaw(raw)).toEqual([{ providerId: 'wikidata-film', fieldMap: { director: 'f1' } }]);
  });

  it('de-duplicates a repeated provider id on read, first occurrence winning', async () => {
    const raw = JSON.stringify([
      { providerId: 'wikidata-film', fieldMap: { director: 'first' } },
      { providerId: 'wikidata-film', fieldMap: { director: 'second' } },
    ]);
    expect(await withRaw(raw)).toEqual([{ providerId: 'wikidata-film', fieldMap: { director: 'first' } }]);
  });
});
