/**
 * Issue #638: a sync that merges and then fails to push must not lose the local half.
 *
 * The pass is two round-trips with a database commit between them. When the upload fails, the
 * pull has *already* been applied and re-read — the remote's winners have overwritten local
 * rows, its tombstones have deleted them — so the only thing left of the user's overwritten
 * edits is the conflict list the merge produced. A bare transport error throws that away with
 * the unreturned outcome, and no later sync can re-detect it: the local row the detector would
 * compare against *is* the remote row now, so it no longer differs.
 *
 * These tests pin the engine half: the failure carries what landed, it carries the conflicts,
 * and it keeps the underlying error reachable so the UI can still route an expired token to the
 * reconnect path. They also pin the negative case — a first publish changes nothing locally, so
 * it must stay an ordinary failure.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ContactRepository } from '@/db/repositories';
import { MemoryCloudProvider } from './providers/memory-provider';
import type { CloudProvider } from './provider';
import { readSyncMeta, runSync } from './sync-engine';
import { SyncPushFailedError } from './sync-errors';

const NO_QUOTA = { skipQuotaCheck: true } as const;

async function makeDevice(): Promise<{ driver: MemoryDriver; contacts: ContactRepository }> {
  const driver = createMemoryDriver();
  await runMigrations(driver, migrations);
  return { driver, contacts: new ContactRepository(driver) };
}

/** The shared provider with its upload disabled, as a dropped connection leaves it. */
function withFailingPush(inner: CloudProvider, failure: Error): CloudProvider {
  return {
    id: inner.id,
    label: inner.label,
    getServerTime: () => inner.getServerTime(),
    fetchSnapshot: () => inner.fetchSnapshot(),
    pushSnapshot: () => Promise.reject(failure),
  };
}

describe('a merge whose push fails (#638)', () => {
  let a: Awaited<ReturnType<typeof makeDevice>>;
  let b: Awaited<ReturnType<typeof makeDevice>>;
  let provider: MemoryCloudProvider;

  beforeEach(async () => {
    a = await makeDevice();
    b = await makeDevice();
    provider = new MemoryCloudProvider();
  });

  it('carries the conflicts the merge produced instead of discarding them', async () => {
    // The #72 collision setup: both devices edit the same contact offline, A syncs first.
    const contact = await a.contacts.create({ name: 'Original' });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, { ...NO_QUOTA, now: () => 1 });

    await b.contacts.update(contact.id, { name: 'B edit' });
    await a.contacts.update(contact.id, { name: 'A edit' });
    await runSync(a.driver, provider, NO_QUOTA);

    // B pulls and merges, but its upload never lands.
    const offline = withFailingPush(provider, new Error('Failed to fetch'));
    const err = await runSync(b.driver, offline, NO_QUOTA).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SyncPushFailedError);
    const failure = err as SyncPushFailedError;
    expect(failure.localOutcome.status).toBe('MERGED_NOT_PUBLISHED');
    // B's edit is already gone from the database…
    expect((await b.contacts.getById(contact.id))?.name).toBe('A edit');
    // …so the record of it riding out on the error is the only copy that survives.
    expect(failure.localOutcome.conflicts).toHaveLength(1);
    expect(failure.localOutcome.conflicts[0]).toMatchObject({
      tableName: 'contacts',
      rowId: contact.id,
      kind: 'UPDATE',
    });
    expect(failure.localOutcome.conflicts[0]!.localVersion.name).toBe('B edit');
    expect(failure.localOutcome.conflicts[0]!.remoteVersion?.name).toBe('A edit');
  });

  it('shows why the conflicts cannot simply be re-detected on the next sync', async () => {
    const contact = await a.contacts.create({ name: 'Original' });
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, { ...NO_QUOTA, now: () => 1 });

    await b.contacts.update(contact.id, { name: 'B edit' });
    await a.contacts.update(contact.id, { name: 'A edit' });
    await runSync(a.driver, provider, NO_QUOTA);

    await expect(
      runSync(b.driver, withFailingPush(provider, new Error('Failed to fetch')), NO_QUOTA),
    ).rejects.toBeInstanceOf(SyncPushFailedError);

    // The retry succeeds, but B's local row is now A's — there is nothing left to differ from
    // the remote, so the collision is invisible to the detector. This is why the failed pass has
    // to hand its conflicts out rather than leave them for "next time".
    const retry = await runSync(b.driver, provider, NO_QUOTA);
    expect(retry.status).toBe('SYNCED');
    expect(retry.conflicts).toHaveLength(0);
  });

  it('reports what the merge brought in, and leaves the sync watermark unmoved', async () => {
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, { ...NO_QUOTA, now: () => 1 });
    // Two peer rows for B to pull in.
    await a.contacts.create({ name: 'From A' });
    await a.contacts.create({ name: 'Also from A' });
    await runSync(a.driver, provider, NO_QUOTA);

    const before = await readSyncMeta(b.driver);
    const err = await runSync(b.driver, withFailingPush(provider, new Error('offline')), NO_QUOTA).catch(
      (e: unknown) => e as SyncPushFailedError,
    );

    // The tally covers every row the merge applied (the peer's baseline rows as well as its two
    // contacts), and both of those contacts really are readable here despite the failed upload.
    expect((err as SyncPushFailedError).localOutcome.pulled).toBeGreaterThanOrEqual(2);
    const names = (await b.contacts.list()).rows.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['From A', 'Also from A']));
    // The prune and the `sync_meta` stamp run *after* the push, so they genuinely did not happen.
    expect((err as SyncPushFailedError).localOutcome.prunedTombstones).toBe(0);
    expect((await readSyncMeta(b.driver)).lastSyncTimestamp).toBe(before.lastSyncTimestamp);
  });

  it('keeps the transport error reachable as the cause', async () => {
    await runSync(a.driver, provider, NO_QUOTA);
    await runSync(b.driver, provider, { ...NO_QUOTA, now: () => 1 });
    await a.contacts.create({ name: 'From A' });
    await runSync(a.driver, provider, NO_QUOTA);

    const transport = new Error('401 Unauthorized');
    const err = await runSync(b.driver, withFailingPush(provider, transport), NO_QUOTA).catch(
      (e: unknown) => e as SyncPushFailedError,
    );

    expect((err as SyncPushFailedError).cause).toBe(transport);
  });

  it('reports the §7.2 TTL clone as half-completed too — it has replaced the tables already', async () => {
    await a.contacts.create({ name: 'From A' });
    await runSync(a.driver, provider, NO_QUOTA);
    // B's last sync is far enough back that the tombstone TTL forces a wholesale clone.
    await runSync(b.driver, provider, { ...NO_QUOTA, now: () => 1 });

    const err = await runSync(b.driver, withFailingPush(provider, new Error('offline')), {
      ...NO_QUOTA,
      ttlMs: 1,
    }).catch((e: unknown) => e as SyncPushFailedError);

    expect(err).toBeInstanceOf(SyncPushFailedError);
    expect((err as SyncPushFailedError).localOutcome.status).toBe('MERGED_NOT_PUBLISHED');
    // The clone landed regardless of the push: B holds A's record.
    expect((await b.contacts.list()).rows.map((c) => c.name)).toContain('From A');
  });

  it('leaves a failed first publish an ordinary failure — nothing changed locally', async () => {
    await a.contacts.create({ name: 'Only here' });
    const transport = new Error('Failed to fetch');

    // `publish` mode only reads the local state, so "sync failed" is the whole truth.
    await expect(runSync(a.driver, withFailingPush(provider, transport), NO_QUOTA)).rejects.toBe(transport);
  });
});
