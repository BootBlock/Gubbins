import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ContactRepository } from './ContactRepository';

describe('ContactRepository', () => {
  let driver: MemoryDriver;
  let contacts: ContactRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    contacts = new ContactRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('counts every contact, including those past the capped first page (issue #149)', async () => {
    expect(await contacts.count()).toBe(0);

    for (let i = 0; i < 105; i += 1) {
      await contacts.create({ name: `Contact ${String(i).padStart(3, '0')}` });
    }

    // The list is clamped to the strict §2.1 ceiling, so the rows in hand undercount the
    // dictionary — which is why the Contacts screen needs a separate total to page against.
    const firstPage = await contacts.list({ limit: 100 });
    expect(firstPage.rows).toHaveLength(100);
    expect(firstPage.hasMore).toBe(true);
    expect(await contacts.count()).toBe(105);

    // The second page reaches the contacts the old single-read screen could never show.
    const secondPage = await contacts.list({ limit: 100, offset: 100 });
    expect(secondPage.rows).toHaveLength(5);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.rows[0]?.name).toBe('Contact 100');
  });
});
