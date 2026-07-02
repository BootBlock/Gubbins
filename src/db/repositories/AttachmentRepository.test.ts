import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { DbError } from '@/db/errors';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { AttachmentRepository } from './AttachmentRepository';
import { ItemRepository } from './ItemRepository';

describe('AttachmentRepository', () => {
  let driver: MemoryDriver;
  let attachments: AttachmentRepository;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    attachments = new AttachmentRepository(driver);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('adds an external URL datasheet', async () => {
    const item = await items.create({ name: 'NE555' });
    const att = await attachments.add({
      itemId: item.id,
      kind: 'URL',
      value: 'https://www.ti.com/lit/ds/ne555.pdf',
      label: 'TI datasheet',
    });
    expect(att.kind).toBe('URL');
    expect(att.label).toBe('TI datasheet');
  });

  it('stores a local pointer as a bare path string (sync-safe, §4)', async () => {
    const item = await items.create({ name: 'NE555' });
    const att = await attachments.add({
      itemId: item.id,
      kind: 'LOCAL_POINTER',
      value: 'C:\\Datasheets\\NE555.pdf',
    });
    expect(att.kind).toBe('LOCAL_POINTER');
    expect(att.value).toBe('C:\\Datasheets\\NE555.pdf');
  });

  it('rejects a blank value and an invalid URL', async () => {
    const item = await items.create({ name: 'NE555' });
    await expect(attachments.add({ itemId: item.id, kind: 'URL', value: '   ' })).rejects.toBeInstanceOf(
      DbError,
    );
    await expect(
      attachments.add({ itemId: item.id, kind: 'URL', value: 'not a url' }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('lists, updates and removes attachments', async () => {
    const item = await items.create({ name: 'NE555' });
    const att = await attachments.add({ itemId: item.id, kind: 'URL', value: 'https://a.test/d.pdf' });

    await attachments.update(att.id, { label: 'Renamed' });
    let list = await attachments.listForItem(item.id);
    expect(list[0]?.label).toBe('Renamed');

    await attachments.remove(att.id);
    list = await attachments.listForItem(item.id);
    expect(list).toHaveLength(0);
  });

  it('stamps the origin device id on a local pointer and leaves it null for a URL', async () => {
    const item = await items.create({ name: 'NE555' });
    const local = await attachments.add({
      itemId: item.id,
      kind: 'LOCAL_POINTER',
      value: 'C:\\Datasheets\\NE555.pdf',
      originDeviceId: 'dev-A',
    });
    expect(local.originDeviceId).toBe('dev-A');

    const url = await attachments.add({
      itemId: item.id,
      kind: 'URL',
      value: 'https://a.test/d.pdf',
    });
    expect(url.originDeviceId).toBeNull();
  });

  it('re-links a foreign pointer to a new path on this device', async () => {
    const item = await items.create({ name: 'NE555' });
    const att = await attachments.add({
      itemId: item.id,
      kind: 'LOCAL_POINTER',
      value: 'C:\\old\\path.pdf',
      originDeviceId: 'dev-A',
    });
    const relinked = await attachments.update(att.id, {
      value: '/home/me/ne555.pdf',
      originDeviceId: 'dev-B',
    });
    expect(relinked.kind).toBe('LOCAL_POINTER');
    expect(relinked.value).toBe('/home/me/ne555.pdf');
    expect(relinked.originDeviceId).toBe('dev-B');
  });

  it('replaces an unlinked local pointer with a validated external URL', async () => {
    const item = await items.create({ name: 'NE555' });
    const att = await attachments.add({
      itemId: item.id,
      kind: 'LOCAL_POINTER',
      value: 'C:\\old\\path.pdf',
      originDeviceId: 'dev-A',
    });
    const asUrl = await attachments.update(att.id, {
      kind: 'URL',
      value: 'https://ti.com/ne555.pdf',
      originDeviceId: null,
    });
    expect(asUrl.kind).toBe('URL');
    expect(asUrl.value).toBe('https://ti.com/ne555.pdf');
    expect(asUrl.originDeviceId).toBeNull();

    // Switching to a URL validates against the *new* kind.
    await expect(attachments.update(att.id, { kind: 'URL', value: 'not a url' })).rejects.toBeInstanceOf(
      DbError,
    );
  });

  it('gates attachment growth on the storage Hard Stop, but allows removal', async () => {
    const item = await items.create({ name: 'NE555' });
    const att = await attachments.add({ itemId: item.id, kind: 'URL', value: 'https://a.test/d.pdf' });

    const locked = new AttachmentRepository(driver, { isWriteSuspended: () => true });
    await expect(
      locked.add({ itemId: item.id, kind: 'URL', value: 'https://b.test/d.pdf' }),
    ).rejects.toMatchObject({ code: 'WRITE_SUSPENDED' });
    await expect(locked.remove(att.id)).resolves.toBeUndefined();
  });
});
