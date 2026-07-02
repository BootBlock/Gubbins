import { describe, it, expect } from 'vitest';
import type { Item, ItemHistoryEntry } from '@/db/repositories';
import {
  BACKUP_FORMAT_VERSION,
  buildCatalogCsv,
  buildItemsCsv,
  buildJsonBackup,
  buildProjectMasterNote,
  buildProjectVault,
  buildVault,
  buildVaultFiles,
  sanitiseSegment,
  type CatalogCustomFieldColumn,
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
      {
        id: 'h1',
        itemId: 'i1',
        action: 'CREATED',
        quantityDelta: null,
        netValueDelta: null,
        note: 'Added',
        metadata: null,
        createdAt: 0,
      },
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
      {
        item: makeItem({ id: 'aaaaaaaa-1', name: 'Widget' }),
        history: [],
        locationName: 'Box',
        categoryName: null,
      },
      {
        item: makeItem({ id: 'bbbbbbbb-2', name: 'Widget' }),
        history: [],
        locationName: 'Box',
        categoryName: null,
      },
    ];
    const paths = Object.keys(buildVaultFiles(vaultItems));
    expect(new Set(paths).size).toBe(2);
  });

  it('sanitises path segments', () => {
    expect(sanitiseSegment('a/b:c*?')).toBe('a-b-c--');
    expect(sanitiseSegment('  ..hidden ')).toBe('hidden');
  });
});

describe('buildCatalogCsv — custom-field columns (Phase 72)', () => {
  it('appends one column per definition with per-item values', () => {
    const cols: CatalogCustomFieldColumn[] = [
      { fieldId: 'f-res', header: 'Resistance' },
      { fieldId: 'f-tol', header: 'Tolerance' },
    ];
    const values = new Map([['i1', { 'f-res': '10000', 'f-tol': '1%' }]]);
    const csv = buildCatalogCsv([makeItem()], cols, values);
    const [header, row] = csv.split('\r\n');
    expect(header.endsWith('Resistance,Tolerance')).toBe(true);
    expect(row!.endsWith('10000,1%')).toBe(true);
  });

  it('leaves a blank cell when an item has no stored value for a field', () => {
    const cols: CatalogCustomFieldColumn[] = [{ fieldId: 'f-res', header: 'Resistance' }];
    const csv = buildCatalogCsv([makeItem()], cols, new Map());
    const [, row] = csv.split('\r\n');
    expect(row!.endsWith(',')).toBe(true);
  });

  it('deduplicates columns by field id (first header wins)', () => {
    const cols: CatalogCustomFieldColumn[] = [
      { fieldId: 'f-res', header: 'Resistance' },
      { fieldId: 'f-res', header: 'Resistance (dup)' },
    ];
    const csv = buildCatalogCsv([makeItem()], cols, new Map());
    const header = csv.split('\r\n')[0]!;
    expect(header.match(/Resistance/g)).toHaveLength(1);
  });

  it('quotes a custom-field header/value containing a comma (RFC-4180)', () => {
    const cols: CatalogCustomFieldColumn[] = [{ fieldId: 'f-x', header: 'A, B' }];
    const values = new Map([['i1', { 'f-x': 'x, y' }]]);
    const csv = buildCatalogCsv([makeItem()], cols, values);
    const [header, row] = csv.split('\r\n');
    expect(header).toContain('"A, B"');
    expect(row).toContain('"x, y"');
  });

  it('is unchanged when no custom fields are supplied', () => {
    const plain = buildCatalogCsv([makeItem()]);
    expect(plain.split('\r\n')[0]).not.toContain('Resistance');
  });
});

describe('buildVault — §4.5 asset extraction (Phase 14)', () => {
  it('embeds a full-res image wiki-link and lists both bytes as /assets', () => {
    const thumb = new Uint8Array([1, 2, 3]);
    const vaultItems: VaultItem[] = [
      {
        item: makeItem({ id: '3f2c9a1b-aaaa', name: 'NE555 Timer' }),
        history: [],
        locationName: 'Box',
        categoryName: null,
        images: [{ id: 'img1', opfsPath: 'images/abc.webp', thumbnail: thumb }],
      },
    ];
    const { files, assets } = buildVault(vaultItems);
    const md = files['Box/NE555 Timer.md']!;
    // Obsidian-style embed by bare filename (resolves anywhere in the vault).
    expect(md).toContain('## Images');
    expect(md).toContain('![[NE555 Timer-3f2c9a1b-1.webp]]');
    // Full-res (read from OPFS later) and the thumbnail bytes are both staged under /assets.
    const fullRes = assets.find((a) => a.path === 'assets/NE555 Timer-3f2c9a1b-1.webp');
    expect(fullRes?.opfsPath).toBe('images/abc.webp');
    const thumbAsset = assets.find((a) => a.path === 'assets/NE555 Timer-3f2c9a1b-1.thumb.webp');
    expect(thumbAsset?.bytes).toBe(thumb);
  });

  it('renders a Datasheets section linking URLs and local pointers (no bytes exist)', () => {
    const vaultItems: VaultItem[] = [
      {
        item: makeItem({ name: 'Widget' }),
        history: [],
        locationName: 'Box',
        categoryName: null,
        attachments: [
          { kind: 'URL', value: 'https://example.com/ds.pdf', label: 'Datasheet' },
          { kind: 'LOCAL_POINTER', value: 'C:/docs/widget.pdf', label: null },
        ],
      },
    ];
    const { files } = buildVault(vaultItems);
    const md = files['Box/Widget.md']!;
    expect(md).toContain('## Datasheets');
    expect(md).toContain('[Datasheet](https://example.com/ds.pdf)');
    expect(md).toContain('C:/docs/widget.pdf');
  });

  it('produces no assets when an item has no images', () => {
    const vaultItems: VaultItem[] = [
      { item: makeItem(), history: [], locationName: 'Box', categoryName: null },
    ];
    expect(buildVault(vaultItems).assets).toHaveLength(0);
  });
});

describe('buildProjectMasterNote — §4.5 project scope (Phase 14)', () => {
  it('lists the project components with wiki-links and Dataview frontmatter', () => {
    const note = buildProjectMasterNote('Robot Arm', [
      makeItem({ id: 'a', name: 'Servo' }),
      makeItem({ id: 'b', name: 'Bracket' }),
    ]);
    expect(note).toContain('type: project');
    expect(note).toContain('# Robot Arm');
    expect(note).toContain('- [[Servo]]');
    expect(note).toContain('- [[Bracket]]');
  });

  it('omits the budget section when no budget object is given', () => {
    const note = buildProjectMasterNote('Robot Arm', [makeItem({ id: 'a', name: 'Servo' })]);
    expect(note).not.toContain('## Budget');
  });

  it('renders a budget summary section and frontmatter when budgeted (Phase 58)', () => {
    const note = buildProjectMasterNote('Robot Arm', [makeItem({ id: 'a', name: 'Servo' })], {
      budget: 500,
      totalSpent: 240,
      committedFromBom: 180,
      manualExpenseTotal: 60,
      remaining: 260,
      projectedFinalCost: 480,
    });
    expect(note).toContain('budget: 500');
    expect(note).toContain('spent: 240');
    expect(note).toContain('remaining: 260');
    expect(note).toContain('## Budget');
    expect(note).toContain('| Budget | 500 |');
    expect(note).toContain('| Projected total | 480 |');
  });

  it('still renders spend with no budget set when there is recorded spend', () => {
    const note = buildProjectMasterNote('Robot Arm', [makeItem({ id: 'a', name: 'Servo' })], {
      budget: null,
      totalSpent: 30,
      committedFromBom: 0,
      manualExpenseTotal: 30,
      remaining: null,
      projectedFinalCost: 30,
    });
    expect(note).toContain('## Budget');
    expect(note).not.toContain('| Budget |'); // no allocated budget row
    expect(note).toContain('| Spent so far | 30 |');
  });
});

describe('buildVault rootFolder — §4.5 project sub-folders (Phase 19)', () => {
  it('nests every note and asset under the given top-level folder', () => {
    const thumb = new Uint8Array([1, 2, 3]);
    const vaultItems: VaultItem[] = [
      {
        item: makeItem({ id: '3f2c9a1b-aaaa', name: 'Servo' }),
        history: [],
        locationName: 'Workshop',
        categoryName: null,
        images: [{ id: 'img1', opfsPath: 'images/abc.webp', thumbnail: thumb }],
      },
    ];
    const { files, assets } = buildVault(vaultItems, { rootFolder: 'Robot Arm' });
    // The component note nests under <project>/<location>/<item>.md.
    expect(Object.keys(files)).toContain('Robot Arm/Workshop/Servo.md');
    // Assets travel with the project so it stays self-contained.
    expect(assets.every((a) => a.path.startsWith('Robot Arm/assets/'))).toBe(true);
    // The embed is still a bare wiki-link (resolves anywhere in the vault).
    expect(files['Robot Arm/Workshop/Servo.md']!).toContain('![[Servo-3f2c9a1b-1.webp]]');
  });

  it('sanitises an unsafe root folder name and falls back when empty', () => {
    const vaultItems: VaultItem[] = [
      { item: makeItem({ name: 'Servo' }), history: [], locationName: 'Box', categoryName: null },
    ];
    expect(Object.keys(buildVault(vaultItems, { rootFolder: 'a/b:c' }).files)[0]).toBe('a-b-c/Box/Servo.md');
    expect(Object.keys(buildVault(vaultItems, { rootFolder: '   ' }).files)[0]).toBe('Project/Box/Servo.md');
  });

  it('leaves paths un-prefixed when no rootFolder is given (whole-vault scope)', () => {
    const vaultItems: VaultItem[] = [
      { item: makeItem({ name: 'Servo' }), history: [], locationName: 'Box', categoryName: null },
    ];
    expect(Object.keys(buildVault(vaultItems).files)[0]).toBe('Box/Servo.md');
  });
});

describe('buildProjectVault — §4.5 project folder + sub-folders (Phase 19)', () => {
  it('packs the master note and component sub-folders inside one project folder', () => {
    const vaultItems: VaultItem[] = [
      {
        item: makeItem({ id: 'a', name: 'Servo' }),
        history: [],
        locationName: 'Workshop',
        categoryName: null,
      },
      {
        item: makeItem({ id: 'b', name: 'Bracket' }),
        history: [],
        locationName: 'Drawer A2',
        categoryName: null,
      },
    ];
    const { files } = buildProjectVault('Robot Arm', vaultItems);
    const paths = Object.keys(files);
    // Master note lives inside the project folder, named after the project.
    expect(paths).toContain('Robot Arm/Robot Arm.md');
    // Components nest under the same project folder, in their Location sub-folders.
    expect(paths).toContain('Robot Arm/Workshop/Servo.md');
    expect(paths).toContain('Robot Arm/Drawer A2/Bracket.md');
    // Every file is contained by the project folder (nothing leaks to the zip root).
    expect(paths.every((p) => p.startsWith('Robot Arm/'))).toBe(true);
    // The master note wiki-links each component by bare name.
    const master = files['Robot Arm/Robot Arm.md']!;
    expect(master).toContain('- [[Servo]]');
    expect(master).toContain('- [[Bracket]]');
  });
});
