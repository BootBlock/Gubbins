import { describe, it, expect } from 'vitest';
import type { Item, ItemHistoryEntry } from '@/db/repositories';
import {
  BACKUP_FORMAT_VERSION,
  buildItemsCsv,
  buildJsonBackup,
  buildVaultFiles,
  sanitiseSegment,
  type VaultItem,
} from './export-data';

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    name: 'NE555 Timer',
    description: 'Classic timer IC',
    locationId: 'l1',
    categoryId: null,
    trackingMode: 'DISCRETE',
    quantity: 12,
    serialNo: null,
    mpn: 'NE555P',
    manufacturer: 'TI',
    unitCost: 0.25,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    gauge: null,
    thumbnailBlob: undefined,
    ...overrides,
  };
}

describe('export-data builders', () => {
  it('builds a versioned JSON backup', () => {
    const json = buildJsonBackup({ items: [makeItem()], contacts: [], checkouts: [] }, 1234);
    const parsed = JSON.parse(json);
    expect(parsed.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(parsed.exportedAt).toBe(1234);
    expect(parsed.items).toHaveLength(1);
  });

  it('builds CSV with RFC-4180 quoting', () => {
    const csv = buildItemsCsv([makeItem({ name: 'Cap, 10µF', description: 'a "good" one' })]);
    const [header, row] = csv.split('\r\n');
    expect(header).toContain('name');
    expect(row).toContain('"Cap, 10µF"');
    expect(row).toContain('"a ""good"" one"');
  });

  it('builds a vault file with YAML frontmatter and an activity table', () => {
    const history: ItemHistoryEntry[] = [
      { id: 'h1', itemId: 'i1', action: 'CREATED', quantityDelta: null, netValueDelta: null, note: 'Added', metadata: null, createdAt: 0 },
    ];
    const vaultItems: VaultItem[] = [
      { item: makeItem(), history, locationName: 'Workshop/Cabinet A', categoryName: 'ICs' },
    ];
    const files = buildVaultFiles(vaultItems);
    const path = Object.keys(files)[0]!;
    expect(path).toBe('Workshop-Cabinet A/NE555 Timer.md');
    const md = files[path]!;
    expect(md).toContain('---');
    expect(md).toContain('id: "i1"');
    expect(md).toContain('quantity: 12');
    expect(md).toContain('## Activity');
    expect(md).toContain('| CREATED |'.trim());
  });

  it('disambiguates colliding item names', () => {
    const vaultItems: VaultItem[] = [
      { item: makeItem({ id: 'aaaaaaaa-1', name: 'Widget' }), history: [], locationName: 'Box', categoryName: null },
      { item: makeItem({ id: 'bbbbbbbb-2', name: 'Widget' }), history: [], locationName: 'Box', categoryName: null },
    ];
    const paths = Object.keys(buildVaultFiles(vaultItems));
    expect(new Set(paths).size).toBe(2);
  });

  it('sanitises path segments', () => {
    expect(sanitiseSegment('a/b:c*?')).toBe('a-b-c--');
    expect(sanitiseSegment('  ..hidden ')).toBe('hidden');
  });
});
