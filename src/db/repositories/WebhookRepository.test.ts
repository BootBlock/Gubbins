import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { TombstoneRepository, WebhookRepository } from './index';

/**
 * WebhookRepository (issue #87). Exercises the thin SQL glue around the pure
 * `@/features/webhooks/subscription` seam: create/update funnel through
 * `planWebhookSubscription`, the JSON columns round-trip as typed values rather than strings,
 * the two secret forms stay mutually exclusive, and a delete records a tombstone so the removal
 * syncs (which is also how the bridge learns to stop delivering).
 *
 * The `webhooks` table's own CHECK constraints are exercised directly against the driver at the
 * end — the repository should never be able to write a row that trips one, but the constraint is
 * the last line of defence for a row arriving over sync from a peer, so it is asserted here
 * rather than assumed.
 */
describe('WebhookRepository (issue #87)', () => {
  let driver: MemoryDriver;
  let webhooks: WebhookRepository;
  let tombstones: TombstoneRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    webhooks = new WebhookRepository(driver);
    tombstones = new TombstoneRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  const draft = {
    name: 'Home Assistant',
    url: 'https://ha.example.test/api/webhook/gubbins',
    eventTypes: ['item.created'],
  };

  it('creates a subscription, normalising through the seam', async () => {
    const created = await webhooks.create({
      ...draft,
      name: '  Home Assistant ',
      method: 'post',
      template: '   ',
    });
    expect(created).toMatchObject({
      name: 'Home Assistant',
      url: 'https://ha.example.test/api/webhook/gubbins',
      method: 'POST',
      enabled: true,
      secret: null,
      secretRef: null,
      eventTypes: ['item.created'],
      filter: null,
      template: null,
      headers: null,
    });
  });

  it('defaults the method to POST and softens an unknown one rather than failing', async () => {
    expect((await webhooks.create(draft)).method).toBe('POST');
    expect((await webhooks.create({ ...draft, method: 'TRACE' })).method).toBe('POST');
    expect((await webhooks.create({ ...draft, method: 'patch' })).method).toBe('PATCH');
  });

  it('rejects a blank name', async () => {
    await expect(webhooks.create({ ...draft, name: '  ' })).rejects.toThrow(/must have a name/i);
  });

  /**
   * Unlike the wishlist's link field, a scheme-less endpoint is NOT defaulted to https: quietly
   * guessing the scheme for a LAN box the user meant to reach over http yields a subscription
   * that silently never delivers.
   */
  it('rejects an endpoint that is not an absolute http(s) URL', async () => {
    for (const url of ['', '   ', 'ha.example.test/hook', 'file:///etc/passwd', 'not a url']) {
      await expect(webhooks.create({ ...draft, url })).rejects.toThrow(/http:\/\/ or https:\/\//i);
    }
  });

  it('rejects a subscription with no event types', async () => {
    await expect(webhooks.create({ ...draft, eventTypes: [] })).rejects.toThrow(/at least one event/i);
    await expect(webhooks.create({ ...draft, eventTypes: ['  '] })).rejects.toThrow(/at least one event/i);
  });

  it('de-duplicates event types and collapses a list containing the wildcard', async () => {
    const many = await webhooks.create({
      ...draft,
      eventTypes: ['item.created', 'item.moved', 'item.created'],
    });
    expect(many.eventTypes).toEqual(['item.created', 'item.moved']);

    const wild = await webhooks.create({ ...draft, eventTypes: ['item.created', '*'] });
    expect(wild.eventTypes).toEqual(['*']);
  });

  /** The JSON columns are opaque TEXT in SQLite; a caller must never see or supply a string. */
  it('round-trips the JSON columns as typed values, not strings', async () => {
    const created = await webhooks.create({
      ...draft,
      eventTypes: ['item.created', 'stock.adjusted'],
      filter: { locationId: 'loc-1', minQuantity: 5 },
      headers: { 'X-Source': 'gubbins' },
    });
    expect(created.eventTypes).toEqual(['item.created', 'stock.adjusted']);
    expect(created.filter).toEqual({ locationId: 'loc-1', minQuantity: 5 });
    expect(created.headers).toEqual({ 'X-Source': 'gubbins' });

    // …and they are genuinely stored as JSON text, so the bridge can read them the same way.
    const row = await driver.queryOne<{ event_types: string; filter: string; headers: string }>(
      'SELECT event_types, filter, headers FROM webhooks WHERE id = ?;',
      [created.id],
    );
    expect(JSON.parse(row!.event_types)).toEqual(['item.created', 'stock.adjusted']);
    expect(JSON.parse(row!.filter)).toEqual({ locationId: 'loc-1', minQuantity: 5 });
    expect(JSON.parse(row!.headers)).toEqual({ 'X-Source': 'gubbins' });
  });

  it('rejects a header map with a blank name or a non-text value', async () => {
    await expect(webhooks.create({ ...draft, headers: { '  ': 'x' } })).rejects.toThrow(/header/i);
    await expect(
      webhooks.create({ ...draft, headers: { 'X-Count': 3 as unknown as string } }),
    ).rejects.toThrow(/header/i);
  });

  it('lists enabled and disabled subscriptions alike, by name, case-insensitively', async () => {
    await webhooks.create({ ...draft, name: 'zapier' });
    await webhooks.create({ ...draft, name: 'Discord', enabled: false });
    await webhooks.create({ ...draft, name: 'node-red' });
    const page = await webhooks.list();
    expect(page.rows.map((w) => w.name)).toEqual(['Discord', 'node-red', 'zapier']);
    expect(page.rows.map((w) => w.enabled)).toEqual([false, true, true]);
  });

  it('updates only the provided fields', async () => {
    const created = await webhooks.create({ ...draft, template: '{{event.type}}' });
    const updated = await webhooks.update(created.id, { enabled: false });
    expect(updated).toMatchObject({
      name: 'Home Assistant',
      template: '{{event.type}}',
      enabled: false,
    });
  });

  it('clears an optional field when passed null', async () => {
    const created = await webhooks.create({ ...draft, filter: { tag: 'critical' }, template: 'x' });
    const updated = await webhooks.update(created.id, { filter: null, template: null });
    expect(updated.filter).toBeNull();
    expect(updated.template).toBeNull();
  });

  it('refuses to clear the name or invalidate the URL on update', async () => {
    const created = await webhooks.create(draft);
    await expect(webhooks.update(created.id, { name: '  ' })).rejects.toThrow(/must have a name/i);
    await expect(webhooks.update(created.id, { url: 'javascript:alert(1)' })).rejects.toThrow(
      /http:\/\/ or https:\/\//i,
    );
    await expect(webhooks.update(created.id, { eventTypes: [] })).rejects.toThrow(/at least one event/i);
  });

  it('throws when updating a subscription that does not exist', async () => {
    await expect(webhooks.update('never-existed', { enabled: false })).rejects.toThrow(/does not exist/i);
  });

  describe('the signing secret (plan §6.1)', () => {
    /**
     * The headline security property of the `secret_ref` option: the row names a secret the
     * bridge holds in its own config, and the VALUE never enters the database — so it never
     * enters the sync artefact (which by design sits on a NAS or in a cloud drive) or a backup.
     * Asserted against the raw row rather than the mapped object, because it is the stored bytes
     * that travel.
     */
    it('puts no secret value in the database when a subscription uses secret_ref', async () => {
      const created = await webhooks.create({ ...draft, secretRef: 'ha-signing-key' });
      expect(created.secret).toBeNull();
      expect(created.secretRef).toBe('ha-signing-key');

      const row = await driver.queryOne<Record<string, unknown>>('SELECT * FROM webhooks WHERE id = ?;', [
        created.id,
      ]);
      expect(row!.secret).toBeNull();
      expect(row!.secret_ref).toBe('ha-signing-key');

      // Nothing anywhere in the row carries a secret value — only its name.
      expect(JSON.stringify(row)).not.toContain('ha-signing-key-value');
      const columns = await driver.query<{ name: string }>("SELECT name FROM pragma_table_info('webhooks');");
      const secretBearing = columns.filter((c) => c.name === 'secret');
      expect(secretBearing).toHaveLength(1);
      expect(row!.secret).toBeNull();
    });

    it('accepts an in-row secret, and a subscription with neither form', async () => {
      expect((await webhooks.create({ ...draft, secret: '<example-signing-secret>' })).secret).toBe(
        '<example-signing-secret>',
      );
      const unsigned = await webhooks.create(draft);
      expect(unsigned.secret).toBeNull();
      expect(unsigned.secretRef).toBeNull();
    });

    it('refuses a subscription carrying both forms at once', async () => {
      await expect(
        webhooks.create({ ...draft, secret: '<example-signing-secret>', secretRef: 'ha-signing-key' }),
      ).rejects.toThrow(/not both/i);
    });

    /** The conflict is resolved against the row's post-update state, not just the patch. */
    it('refuses an update that would leave both forms set', async () => {
      const created = await webhooks.create({ ...draft, secretRef: 'ha-signing-key' });
      await expect(webhooks.update(created.id, { secret: '<example-signing-secret>' })).rejects.toThrow(
        /not both/i,
      );
    });

    it('switches between the two forms when one is cleared in the same update', async () => {
      const created = await webhooks.create({ ...draft, secret: '<example-signing-secret>' });
      const switched = await webhooks.update(created.id, { secret: null, secretRef: 'ha-signing-key' });
      expect(switched.secret).toBeNull();
      expect(switched.secretRef).toBe('ha-signing-key');
    });
  });

  it('records a tombstone on delete so the removal syncs', async () => {
    const created = await webhooks.create(draft);
    await webhooks.delete(created.id);
    expect(await webhooks.getById(created.id)).toBeUndefined();
    const recorded = await tombstones.list();
    expect(recorded.rows.some((t) => t.tableName === 'webhooks' && t.id === created.id)).toBe(true);
  });

  it('records no tombstone when deleting an id that was never here', async () => {
    await webhooks.delete('never-existed');
    expect((await tombstones.list()).rows).toEqual([]);
  });

  /**
   * The repository can never write these, but a row arriving over sync from a peer bypasses it
   * entirely — so the CHECKs, not the seam, are what actually hold the invariants.
   */
  describe('the schema CHECK constraints', () => {
    const insert = (columns: string, values: string) =>
      driver.execute(`INSERT INTO webhooks (id, name, url, event_types${columns})
         VALUES ('w1', 'Peer', 'https://example.test/hook', '["*"]'${values});`);

    it('defaults method to POST and enabled to 1', async () => {
      await insert('', '');
      const row = await driver.queryOne<{ method: string; enabled: number }>(
        "SELECT method, enabled FROM webhooks WHERE id = 'w1';",
      );
      expect(row?.method).toBe('POST');
      expect(Number(row?.enabled)).toBe(1);
    });

    it('accepts every supported method', async () => {
      for (const method of ['POST', 'GET', 'PUT', 'PATCH']) {
        await driver.execute(
          `INSERT INTO webhooks (id, name, url, method, event_types)
           VALUES (?, 'Peer', 'https://example.test/hook', ?, '["*"]');`,
          [`w-${method}`, method],
        );
      }
      const count = await driver.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM webhooks;');
      expect(Number(count?.n)).toBe(4);
    });

    it('rejects an unsupported method', async () => {
      await expect(insert(', method', ", 'DELETE'")).rejects.toThrow(/CHECK constraint failed/i);
    });

    it('rejects a non-boolean enabled', async () => {
      await expect(insert(', enabled', ', 2')).rejects.toThrow(/CHECK constraint failed/i);
    });

    it('rejects a row carrying both a secret and a secret_ref', async () => {
      await expect(insert(', secret, secret_ref', ", 'value', 'name'")).rejects.toThrow(
        /CHECK constraint failed/i,
      );
      // Either alone, and neither, are all legal.
      await insert(', secret', ", 'value'");
      await driver.execute(
        `INSERT INTO webhooks (id, name, url, event_types, secret_ref)
         VALUES ('w2', 'Peer', 'https://example.test/hook', '["*"]', 'name');`,
      );
    });
  });

  /**
   * A row written by a newer (or corrupt) peer must not fail the read, or it would abort a sync
   * apply mid-batch. Each JSON field softens independently, and an unreadable event-type list
   * leaves the subscription inert rather than over-firing.
   */
  it('softens malformed JSON columns on read rather than throwing', async () => {
    await driver.execute(
      `INSERT INTO webhooks (id, name, url, event_types, filter, headers)
       VALUES ('bad', 'Corrupt', 'https://example.test/hook', 'not json', '[1,2]', '{"X":3}');`,
    );
    const read = await webhooks.getById('bad');
    expect(read).toMatchObject({ name: 'Corrupt', eventTypes: [], filter: null, headers: null });
  });

  /**
   * "Empty means none" holds on the way out as well as in, so a caller can test `headers` for
   * presence without also having to count its keys.
   */
  it('reads a stored empty header object back as null', async () => {
    await driver.execute(
      `INSERT INTO webhooks (id, name, url, event_types, headers)
       VALUES ('empty', 'Empty', 'https://example.test/hook', '["*"]', '{}');`,
    );
    expect((await webhooks.getById('empty'))!.headers).toBeNull();
  });
});
