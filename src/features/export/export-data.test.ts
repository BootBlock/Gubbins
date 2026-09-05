import { describe, it, expect } from 'vitest';
import type { Item, ItemHistoryEntry, LocationWithCount } from '@/db/repositories';
import { JSON_EXPORT_KIND } from '@/lib/json-export-kind';
import {
  JSON_EXPORT_FORMAT_VERSION,
  buildCatalogCsv,
  buildItemsCsv,
  buildItemsExport,
  itemsCsvHeader,
  itemsCsvRow,
  buildJsonExport,
  buildProjectMasterNote,
  buildProjectVault,
  buildVault,
  buildVaultFiles,
  sanitiseSegment,
  type CatalogCustomFieldColumn,
  type VaultItem,
  type VaultLocation,
} from './export-data';
import { DELIMITED_ROW_SEPARATOR } from './tabular-export';

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

function makeLocation(overrides: Partial<LocationWithCount> = {}): LocationWithCount {
  return {
    id: 'l1',
    name: 'Cabinet A',
    parentId: null,
    isSystem: false,
    description: null,
    color: null,
    icon: null,
    capacity: null,
    isDefault: false,
    archivedAt: null,
    lastCountedAt: null,
    deadStockMode: 'inherit',
    deadStockDays: null,
    width: null,
    height: null,
    depth: null,
    usableVolume: null,
    packingFactor: null,
    walkOrder: null,
    updatedAt: 0,
    itemCount: 0,
    ...overrides,
  };
}

function makeVaultLocation(overrides: Partial<LocationWithCount> = {}): VaultLocation {
  const location = makeLocation(overrides);
  return { location, path: location.name, parentName: null };
}

describe('export-data builders', () => {
  it('builds a versioned JSON data export', () => {
    const json = buildJsonExport({ items: [makeItem()], contacts: [], checkouts: [], locations: [] }, 1234);
    const parsed = JSON.parse(json);
    expect(parsed.formatVersion).toBe(JSON_EXPORT_FORMAT_VERSION);
    expect(parsed.exportedAt).toBe(1234);
    expect(parsed.items).toHaveLength(1);
  });

  // Issue #153: the file must say what it is. Without the marker it parses as a valid but
  // empty backup snapshot, so an import silently succeeds having brought nothing in.
  it('marks the JSON export as a data extract, not a restorable backup', () => {
    const parsed = JSON.parse(buildJsonExport({ items: [], contacts: [], checkouts: [], locations: [] }));
    expect(parsed.kind).toBe(JSON_EXPORT_KIND);
    expect(parsed.note).toMatch(/cannot import this file back/i);
  });

  // Issue #617 (`N7`): before this the payload was `{ items, contacts, checkouts }`, so an
  // item's `locationId` was a UUID pointing at nothing in the file and a location's own
  // description left the app in no export at all.
  it('carries the locations an item’s locationId refers to', () => {
    const parsed = JSON.parse(
      buildJsonExport({
        items: [makeItem({ locationId: 'l1' })],
        contacts: [],
        checkouts: [],
        locations: [makeLocation({ id: 'l1', description: 'Overflow for the workshop' })],
      }),
    );
    expect(parsed.locations).toHaveLength(1);
    expect(parsed.locations[0].id).toBe('l1');
    expect(parsed.locations[0].description).toBe('Overflow for the workshop');
    expect(parsed.items[0].locationId).toBe(parsed.locations[0].id);
    // The note has to say the array is there, or nobody opening the file knows to look.
    expect(parsed.note).toMatch(/locationId/);
  });

  /**
   * The bridge's `items.csv` streams the export a page at a time, writing the header once and then
   * a row per item (issue #533), so the same file has two producers. This drives both and compares
   * the bytes rather than trusting that they agree: a change to the column list, the quoting, the
   * formula neutralisation or the row separator that reaches one and not the other fails here.
   *
   * The rows are chosen to exercise every branch that could differ — a delimiter, an embedded
   * quote, a newline, a formula trigger, a blank unlimited quantity, and an absent optional field.
   */
  it('serialises identically row-by-row (the streamed export) and whole-string', () => {
    const items = [
      makeItem({ id: 'a', name: 'Cap, 10µF', description: 'a "good" one' }),
      makeItem({ id: 'b', name: 'Bolt', description: '=1+cmd|"/c calc"!A1' }),
      makeItem({ id: 'c', name: 'Multi\nline', notes: 'second\r\nline', unitCost: null }),
      makeItem({ id: 'd', name: 'Tap water', quantity: 999, isUnlimited: true }),
    ];
    const streamed = [itemsCsvHeader(), ...items.map(itemsCsvRow)].join(DELIMITED_ROW_SEPARATOR);
    expect(streamed).toBe(buildItemsCsv(items));
  });

  it('builds CSV with RFC-4180 quoting', () => {
    const csv = buildItemsCsv([makeItem({ name: 'Cap, 10µF', description: 'a "good" one' })]);
    const [header, row] = csv.split('\r\n');
    expect(header).toContain('name');
    expect(row).toContain('"Cap, 10µF"');
    expect(row).toContain('"a ""good"" one"');
  });

  // Issue #180: an item field that would open as a spreadsheet formula is neutralised with a
  // leading single quote, so opening the export cannot execute a DDE / WEBSERVICE payload.
  it('neutralises a formula-injection payload in an exported item field', () => {
    const csv = buildItemsCsv([makeItem({ name: 'Bolt', description: '=1+cmd|"/c calc"!A1' })]);
    const [, row] = csv.split('\r\n');
    expect(row).toContain('"\'=1+cmd|""/c calc""!A1"');
  });

  it('exports isUnlimited and leaves the quantity cell blank for an unlimited row (Phase 82)', () => {
    const csv = buildItemsCsv([
      makeItem({ id: 'fin', name: 'Bolt', quantity: 12, isUnlimited: false }),
      makeItem({ id: 'inf', name: 'Tap water', quantity: 999, isUnlimited: true }),
    ]);
    const [header, finite, unlimited] = csv.split('\r\n');
    const cols = header.split(',');
    const qtyIdx = cols.indexOf('quantity');
    const unlimitedIdx = cols.indexOf('isUnlimited');
    expect(qtyIdx).toBeGreaterThanOrEqual(0);
    expect(unlimitedIdx).toBeGreaterThanOrEqual(0);
    // Finite item: real quantity, isUnlimited=false.
    expect(finite.split(',')[qtyIdx]).toBe('12');
    expect(finite.split(',')[unlimitedIdx]).toBe('false');
    // Unlimited item: blank quantity cell, isUnlimited=true.
    expect(unlimited.split(',')[qtyIdx]).toBe('');
    expect(unlimited.split(',')[unlimitedIdx]).toBe('true');
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
        actorUserId: 'user-ada',
        actorDisplayName: 'Ada Okafor',
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

  it('escapes backslashes so they cannot break out of YAML frontmatter or table cells', () => {
    const history: ItemHistoryEntry[] = [
      {
        id: 'h1',
        itemId: 'i1',
        action: 'CREATED',
        quantityDelta: null,
        netValueDelta: null,
        note: 'a\\|b',
        metadata: null,
        actorUserId: 'user-ada',
        actorDisplayName: 'Ada Okafor',
        createdAt: 0,
      },
    ];
    const vaultItems: VaultItem[] = [
      { item: makeItem({ name: 'Widget\\' }), history, locationName: 'Box', categoryName: null },
    ];
    const md = Object.values(buildVaultFiles(vaultItems))[0]!;
    // A trailing backslash is doubled, so the closing quote survives.
    expect(md).toContain('name: "Widget\\\\"');
    // The backslash is doubled before the pipe is escaped, so the cell stays intact.
    expect(md).toContain('a\\\\\\|b');
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

  it('cuts a long segment between whole characters, never inside one (issue #346)', () => {
    // A spanner (U+1F527) straddling the eightieth character: a UTF-16 `slice` keeps its
    // leading half alone, and a lone surrogate is not a name any filesystem can carry.
    const name = `${'a'.repeat(79)}🔧 and more`;
    const segment = sanitiseSegment(name);

    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(name.slice(0, 80))).toBe(true);
    expect(loneSurrogate.test(segment)).toBe(false);
    expect(segment).toBe(`${'a'.repeat(79)}🔧`);
  });

  it('still cuts a long ASCII segment at eighty characters', () => {
    expect(sanitiseSegment('a'.repeat(200))).toBe('a'.repeat(80));
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

  it('carries a gauge item’s configuration so it can be imported back (issue #341)', () => {
    // Without the unit and the capacity the importer cannot re-create a gauge item at all.
    const gaugeItem = makeItem({
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: {
        unitOfMeasure: 'g',
        grossCapacity: 1000,
        tareWeight: 200,
        currentNetValue: 750,
        percentageRemaining: 75,
        currentGrossWeight: 950,
      },
    });
    const [header, row] = buildCatalogCsv([gaugeItem]).split('\r\n');
    const columns = header!.split(',');
    const cells = row!.split(',');
    const cellFor = (col: string) => cells[columns.indexOf(col)];

    expect(columns).toContain('unitOfMeasure');
    expect(cellFor('unitOfMeasure')).toBe('g');
    expect(cellFor('grossCapacity')).toBe('1000');
    expect(cellFor('tareWeight')).toBe('200');
    expect(cellFor('currentNetValue')).toBe('750');
  });

  it('leaves the gauge columns blank for an item that is not gauge-tracked', () => {
    const [header, row] = buildCatalogCsv([makeItem()]).split('\r\n');
    const columns = header!.split(',');
    const cells = row!.split(',');
    for (const col of ['unitOfMeasure', 'grossCapacity', 'tareWeight', 'currentNetValue']) {
      expect(cells[columns.indexOf(col)]).toBe('');
    }
  });

  it('writes a marker for an IMAGE column instead of its base64 value (issue #453)', () => {
    const cols: CatalogCustomFieldColumn[] = [{ fieldId: 'f-cov', header: 'Cover art', fieldType: 'IMAGE' }];
    const values = new Map([['i1', { 'f-cov': 'data:image/webp;base64,UklGRhoAAABX' }]]);
    const csv = buildCatalogCsv([makeItem()], cols, values);
    const [, row] = csv.split('\r\n');
    expect(row).toContain('[image]');
    expect(row).not.toContain('base64');
  });

  it('leaves an IMAGE cell blank when the item has no cover', () => {
    const cols: CatalogCustomFieldColumn[] = [{ fieldId: 'f-cov', header: 'Cover art', fieldType: 'IMAGE' }];
    const csv = buildCatalogCsv([makeItem()], cols, new Map());
    expect(csv.split('\r\n')[1]!.endsWith(',')).toBe(true);
  });
});

describe('buildVault — §4.5 asset extraction (Phase 14)', () => {
  it('embeds a full-res image wiki-link and lists both bytes as /assets', () => {
    const thumb = new Uint8Array([1, 2, 3]);
    const full = new Uint8Array([9, 9, 9, 9]);
    const vaultItems: VaultItem[] = [
      {
        item: makeItem({ id: '3f2c9a1b-aaaa', name: 'NE555 Timer' }),
        history: [],
        locationName: 'Box',
        categoryName: null,
        images: [{ id: 'img1', opfsPath: 'images/abc.webp', thumbnail: thumb, fullRes: full }],
      },
    ];
    const { files, assets } = buildVault(vaultItems);
    const md = files['Box/NE555 Timer.md']!;
    // Obsidian-style embed by bare filename (resolves anywhere in the vault).
    expect(md).toContain('## Images');
    expect(md).toContain('![[NE555 Timer-3f2c9a1b-1.webp]]');
    // Full-res and the thumbnail bytes are both staged under /assets.
    const fullRes = assets.find((a) => a.path === 'assets/NE555 Timer-3f2c9a1b-1.webp');
    expect(fullRes?.bytes).toBe(full);
    const thumbAsset = assets.find((a) => a.path === 'assets/NE555 Timer-3f2c9a1b-1.thumb.webp');
    expect(thumbAsset?.bytes).toBe(thumb);
  });

  it('embeds the thumbnail when this device holds no full-resolution file (issue #635)', () => {
    // A photo synced from a peer device, downgraded by Storage Triage, or added while storage
    // was critical: the row points at an OPFS file that is not here. Embedding the full-res
    // name wrote a dead link, because the zip only ever carried the thumbnail.
    const thumb = new Uint8Array([1, 2, 3]);
    const vaultItems: VaultItem[] = [
      {
        item: makeItem({ id: '3f2c9a1b-aaaa', name: 'NE555 Timer' }),
        history: [],
        locationName: 'Box',
        categoryName: null,
        images: [{ id: 'img1', opfsPath: 'images/abc.webp', thumbnail: thumb, fullRes: null }],
      },
    ];
    const { files, assets } = buildVault(vaultItems);
    const md = files['Box/NE555 Timer.md']!;
    expect(md).toContain('![[NE555 Timer-3f2c9a1b-1.thumb.webp]]');
    expect(md).not.toContain('![[NE555 Timer-3f2c9a1b-1.webp]]');
    // Every staged asset is a file the zip will really contain, and the full-res is not one.
    expect(assets.map((a) => a.path)).toEqual(['assets/NE555 Timer-3f2c9a1b-1.thumb.webp']);
  });

  it('embeds nothing for an image with neither full-resolution bytes nor a thumbnail (issue #635)', () => {
    const vaultItems: VaultItem[] = [
      {
        item: makeItem({ id: '3f2c9a1b-aaaa', name: 'NE555 Timer' }),
        history: [],
        locationName: 'Box',
        categoryName: null,
        images: [{ id: 'img1', opfsPath: 'images/abc.webp', thumbnail: null, fullRes: null }],
      },
    ];
    const { files, assets } = buildVault(vaultItems);
    // No file to link, so no section at all — a wiki-link to nothing is a broken embed.
    expect(files['Box/NE555 Timer.md']!).not.toContain('## Images');
    expect(assets).toEqual([]);
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

/**
 * Issue #617 (`N7`): the vault reduced a location to a folder name, so its description, icon,
 * capacity, dimensions and walk order were the one thing it threw away.
 */
describe('buildVault — location folder notes (issue #617)', () => {
  const items: VaultItem[] = [
    { item: makeItem({ name: 'Servo' }), history: [], locationName: 'Cabinet A', categoryName: null },
  ];

  it('writes an Obsidian folder note carrying what the folder name could not', () => {
    const { files } = buildVault(items, {
      locations: [
        {
          location: makeLocation({
            name: 'Cabinet A',
            icon: 'Archive',
            description: 'No solvents here, unventilated.',
            capacity: 40,
            width: 600,
            walkOrder: 2,
            itemCount: 1,
          }),
          path: 'Workshop / Cabinet A',
          parentName: 'Workshop',
        },
      ],
    });
    const note = files['Cabinet A/Cabinet A.md']!;
    expect(note).toContain('type: "location"');
    expect(note).toContain('path: "Workshop / Cabinet A"');
    expect(note).toContain('parent: "Workshop"');
    expect(note).toContain('icon: "Archive"');
    expect(note).toContain('capacity: 40');
    expect(note).toContain('width: 600');
    expect(note).toContain('walkOrder: 2');
    expect(note).toContain('# Cabinet A');
    expect(note).toContain('No solvents here, unventilated.');
    // The items still land beside it, untouched.
    expect(files['Cabinet A/Servo.md']).toBeDefined();
  });

  it('leaves the layout untouched when no locations are supplied', () => {
    expect(Object.keys(buildVault(items).files)).toEqual(['Cabinet A/Servo.md']);
  });

  it('keeps the folder note’s canonical name when an item shares the location’s name', () => {
    const clash: VaultItem[] = [
      {
        item: makeItem({ id: 'aaaaaaaa-1', name: 'Cabinet A' }),
        history: [],
        locationName: 'Cabinet A',
        categoryName: null,
      },
    ];
    const paths = Object.keys(buildVault(clash, { locations: [makeVaultLocation()] }).files);
    // The folder note keeps `Folder/Folder.md` — renaming it would break Obsidian's convention —
    // so the item takes the id-suffixed fallback a colliding item name already takes.
    expect(paths).toContain('Cabinet A/Cabinet A.md');
    expect(paths).toContain('Cabinet A/Cabinet A-aaaaaaaa.md');
  });

  it('does not let two same-named locations overwrite each other’s note', () => {
    // The vault's folders are keyed by a location's *name*, so "Cabinet A" in two branches
    // already share one folder. Both notes must survive, and say which is which.
    const { files } = buildVault([], {
      locations: [
        {
          location: makeLocation({ id: 'aaaaaaaa-1' }),
          path: 'Workshop / Cabinet A',
          parentName: 'Workshop',
        },
        { location: makeLocation({ id: 'bbbbbbbb-2' }), path: 'Garage / Cabinet A', parentName: 'Garage' },
      ],
    });
    const paths = Object.keys(files);
    expect(paths).toHaveLength(2);
    expect(files['Cabinet A/Cabinet A.md']).toContain('path: "Workshop / Cabinet A"');
    expect(files['Cabinet A/Cabinet A-bbbbbbbb.md']).toContain('path: "Garage / Cabinet A"');
  });

  it('writes timestamps as ISO instants and survives an unusable one', () => {
    const { files } = buildVault([], {
      locations: [makeVaultLocation({ lastCountedAt: 0, archivedAt: Number.NaN })],
    });
    const note = files['Cabinet A/Cabinet A.md']!;
    expect(note).toContain('lastCounted: "1970-01-01T00:00:00.000Z"');
    // A non-finite stored timestamp blanks its own field rather than throwing the whole export.
    expect(note).toContain('archived: null');
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
        images: [{ id: 'img1', opfsPath: 'images/abc.webp', thumbnail: thumb, fullRes: new Uint8Array([9]) }],
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

// ---------------------------------------------------------------------------
// Issue #141 — the catalogue CSV carries the identity columns
// ---------------------------------------------------------------------------

describe('buildCatalogCsv — identity columns (issue #141)', () => {
  /** Read one item row's cells back as a header → value map. */
  function cellsOf(csv: string): Record<string, string> {
    const [header, row] = csv.split('\r\n');
    const columns = header!.split(',');
    const cells = row!.split(',');
    return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? '']));
  }

  it('carries the barcode, serial number and expiry date so a catalogue round-trips', () => {
    const csv = buildCatalogCsv([
      makeItem({
        barcode: '5012345678900',
        serialNumber: 'SN-4417',
        expiryDate: Date.UTC(2026, 7, 1),
      }),
    ]);
    expect(cellsOf(csv)).toMatchObject({
      barcode: '5012345678900',
      serialNumber: 'SN-4417',
      // The `YYYY-MM-DD` form the importer reads back to the very same instant.
      expiryDate: '2026-08-01',
    });
  });

  it('leaves the expiry cell blank for an item that has none', () => {
    expect(cellsOf(buildCatalogCsv([makeItem({ expiryDate: null })])).expiryDate).toBe('');
  });

  it('writes an item’s tags as the comma-separated list the importer reads back', () => {
    const csv = buildCatalogCsv([makeItem()], [], new Map(), new Map([['i1', ['fridge', 'perishable']]]));
    // The cell holds a comma, so RFC-4180 quoting is what keeps it one column.
    expect(csv.split('\r\n')[1]).toContain('"fridge, perishable"');
  });

  it('leaves the tags cell blank for an item with none', () => {
    expect(cellsOf(buildCatalogCsv([makeItem()])).tags).toBe('');
  });
});

/**
 * The items export is no longer CSV-only (issue #132): the same columns route through the shared
 * dispatch every other list export uses, so the item list can be saved as a spreadsheet, a table
 * or plain text — the formats a project's bill of materials already offered.
 */
describe('buildItemsExport — every tabular format (issue #132)', () => {
  it('produces the same bytes as buildItemsCsv for the CSV format', async () => {
    // The catalogue round-trip and the frozen CSV tests are built on buildItemsCsv; routing the
    // wizard through the shared dispatch must not change what a CSV export contains.
    const items = [makeItem({ name: 'Cap, 10µF' }), makeItem({ id: 'i2', name: 'Bolt' })];
    const { content } = await buildItemsExport(items, 'csv');
    expect(content).toBe(buildItemsCsv(items));
  });

  it('reports the MIME type and extension each format needs for its download', async () => {
    const items = [makeItem()];
    await expect(buildItemsExport(items, 'tsv')).resolves.toMatchObject({
      mimeType: expect.stringContaining('tab-separated'),
      extension: 'tsv',
    });
    await expect(buildItemsExport(items, 'markdown')).resolves.toMatchObject({ extension: 'md' });
    await expect(buildItemsExport(items, 'html')).resolves.toMatchObject({ extension: 'html' });
    await expect(buildItemsExport(items, 'json')).resolves.toMatchObject({ extension: 'json' });
    await expect(buildItemsExport(items, 'txt')).resolves.toMatchObject({ extension: 'txt' });
  });

  it('produces a real spreadsheet — bytes, not text — for the Excel format', async () => {
    const { content, extension, mimeType } = await buildItemsExport([makeItem()], 'xlsx');
    expect(extension).toBe('xlsx');
    expect(mimeType).toContain('spreadsheetml');
    expect(content).toBeInstanceOf(Uint8Array);
    // A .xlsx is a zip; its first two bytes are the local-file-header signature "PK".
    expect(Array.from((content as Uint8Array).slice(0, 2))).toEqual([0x50, 0x4b]);
  });

  it('keeps native types in the JSON form, so a number stays a number', async () => {
    const { content } = await buildItemsExport([makeItem({ quantity: 12, unitCost: 0.25 })], 'json');
    const [row] = JSON.parse(String(content)) as Record<string, unknown>[];
    expect(row!.quantity).toBe(12);
    expect(row!.unitCost).toBe(0.25);
    expect(row!.name).toBe('NE555 Timer');
  });

  it('heads and captions the document formats', async () => {
    const { content } = await buildItemsExport([makeItem()], 'markdown');
    expect(String(content)).toContain('# Items');
    const text = await buildItemsExport([makeItem(), makeItem({ id: 'i2' })], 'txt');
    expect(String(text.content)).toContain('2 items');
  });

  it('carries the unlimited-quantity blanking into every format, not just CSV', async () => {
    const { content } = await buildItemsExport([makeItem({ name: 'Tap water', isUnlimited: true })], 'json');
    const [row] = JSON.parse(String(content)) as Record<string, unknown>[];
    expect(row!.quantity).toBe('');
    expect(row!.isUnlimited).toBe(true);
  });
});
