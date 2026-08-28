/**
 * How the export *reads* a catalogue larger than one page (issue #527).
 *
 * The output of each format is covered elsewhere; what these tests pin is the shape of the reads
 * behind it, because that is what made a large catalogue unexportable and it is invisible in the
 * file. Two claims, both asserted against the repository calls the export actually issues:
 *
 * - the item walk **seeks** past the previous page's cursor rather than passing a deeper and
 *   deeper `OFFSET`, so page 1000 costs what page 1 does; and
 * - every per-item extra is read a **bucket of items at a time**, so the query count grows with
 *   the number of buckets rather than with the number of items.
 *
 * Both fail against the previous implementation, which walked by offset and called
 * `resolveItemFields` / `listForItem` / `getHistory` once per item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PAGE_SIZE } from '@/db/repositories/constants';
import { ID_BUCKET_SIZE } from '@/features/inventory/id-buckets';

/** Comfortably more than one read page (100) and one id bucket (50), and not a multiple of either. */
const ITEM_COUNT = 250;

/** The columns the vault writes into every item note's YAML frontmatter. */
const ITEM_SHAPE = {
  trackingMode: 'DISCRETE',
  mpn: null,
  manufacturer: null,
  unitCost: null,
  categoryId: 'c1',
  locationId: 'l1',
  description: null,
  notes: null,
  isActive: true,
  quantity: 1,
  isUnlimited: false,
};

/** The synthetic catalogue, in id order — the order the mocked `list` pages through. */
const ALL_ITEMS = Array.from({ length: ITEM_COUNT }, (_, i) => ({
  id: `it-${String(i).padStart(3, '0')}`,
  name: `Item ${String(i).padStart(3, '0')}`,
  ...ITEM_SHAPE,
}));

/** Every `list` call the export made, in order. */
const listCalls: { limit?: number; offset?: number; seek?: { cursor: readonly unknown[] } }[] = [];

const itemRepo = {
  list: vi.fn(async (filters: { limit?: number; offset?: number; seek?: { cursor: readonly unknown[] } }) => {
    listCalls.push(filters);
    // The cursor is opaque to the caller, so the mock defines its own: the id of the page's last
    // row. Seeking means "start after that id"; an offset read would ignore it entirely.
    const after = filters.seek?.cursor[0] as string | undefined;
    const start = after === undefined ? 0 : ALL_ITEMS.findIndex((i) => i.id === after) + 1;
    const limit = filters.limit ?? DEFAULT_PAGE_SIZE;
    const rows = ALL_ITEMS.slice(start, start + limit);
    const last = rows[rows.length - 1];
    return {
      rows,
      limit,
      offset: start,
      hasMore: start + rows.length < ALL_ITEMS.length,
      startCursor: rows[0] ? [rows[0].id] : undefined,
      endCursor: last ? [last.id] : undefined,
    };
  }),
  getHistoryForItems: vi.fn(async (_ids: readonly string[], _limit: number) => new Map()),
  getManyById: vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, { id }]))),
};

const categoryRepo = {
  listAll: vi.fn(async () => []),
  resolveItemFieldsMany: vi.fn(
    async (ids: readonly string[]) =>
      new Map(
        ids.map((id) => [
          id,
          [{ id: 'f1', name: 'Voltage', fieldType: 'TEXT', hasStoredValue: true, value: '5' }],
        ]),
      ),
  ),
};

const checkoutRepo = { listForItems: vi.fn(async (_ids: readonly string[]) => []) };
const imageRepo = { listForItems: vi.fn(async (_ids: readonly string[]) => new Map()) };
const attachmentRepo = { listForItems: vi.fn(async (_ids: readonly string[]) => new Map()) };
const tagRepo = { listForItems: vi.fn(async (_ids: readonly string[]) => []) };

vi.mock('@/db/repositories', () => ({
  getAttachmentRepository: () => attachmentRepo,
  getCategoryRepository: () => categoryRepo,
  getCheckoutRepository: () => checkoutRepo,
  getContactRepository: () => ({ list: async () => ({ rows: [], hasMore: false }) }),
  getImageRepository: () => imageRepo,
  getItemRepository: () => itemRepo,
  getLocationRepository: () => ({
    listAll: async () => [
      {
        id: 'l1',
        name: 'Workshop',
        parentId: null,
        description: null,
        icon: null,
        itemCount: 0,
        capacity: null,
        width: null,
        height: null,
        depth: null,
        usableVolume: null,
        packingFactor: null,
        walkOrder: null,
        isDefault: false,
        archivedAt: null,
        lastCountedAt: null,
        deadStockMode: 'inherit',
        deadStockDays: null,
        color: null,
      },
    ],
  }),
  getProjectRepository: () => ({}),
  getReportRepository: () => ({}),
  getTagRepository: () => tagRepo,
}));

const downloadSpy = vi.fn();
vi.mock('./download', () => ({ download: (...args: unknown[]) => downloadSpy(...args) }));
vi.mock('@/features/images/opfs-images', () => ({ readImageBlob: async () => undefined }));
vi.mock('./zip-in-worker', () => ({ zipInVaultWorker: async () => new Uint8Array([0]) }));

const { runExport } = await import('./run-export');
const { useSessionStore } = await import('@/state/stores/useSessionStore');
const { UNRESTRICTED_AUTHORITY } = await import('@/features/users/permissions');
const { ADMIN_USER_ID } = await import('@/db/repositories/constants');

/** How many buckets `ITEM_COUNT` items are cut into — the expected call count for a batched read. */
const EXPECTED_BUCKETS = Math.ceil(ITEM_COUNT / ID_BUCKET_SIZE);

/** The ids a batched read was asked about, flattened across its calls. */
function idsAskedAbout(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.flatMap((call) => call[0] as string[]);
}

beforeEach(() => {
  listCalls.length = 0;
  vi.clearAllMocks();
  useSessionStore.getState().setResolved(UNRESTRICTED_AUTHORITY, ADMIN_USER_ID);
});

describe('the item walk seeks rather than offsets', () => {
  it('never asks for a page by offset, and seeks past the previous page each time', async () => {
    await runExport('CSV', { includeInactive: false, scope: 'ALL' });

    expect(listCalls.length).toBeGreaterThan(1);
    // A deep OFFSET is exactly what issue #527 removed: SQLite produces and discards every row
    // before the page, so the walk cost grows with the square of the catalogue size.
    expect(listCalls.filter((c) => (c.offset ?? 0) !== 0)).toEqual([]);
    expect(listCalls[0]!.seek).toBeUndefined();
    for (const call of listCalls.slice(1)) expect(call.seek?.cursor).toBeDefined();
  });

  it('visits every item exactly once', async () => {
    await runExport('CSV', { includeInactive: false, scope: 'ALL' });
    const [blob] = downloadSpy.mock.calls[0]! as [Blob, string];
    // Asserted on the file rather than on the reads: a walk that re-seeked from the same cursor
    // would duplicate rows, and one that skipped a page would drop them — both silent in the
    // output unless the ids are counted. The header row is dropped before comparing.
    const ids = (await blob.text())
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((row) => row.split(',')[0]);
    expect(ids).toEqual(ALL_ITEMS.map((i) => i.id));
  });
});

describe('per-item extras are read a bucket at a time', () => {
  it('resolves custom fields per bucket, covering every item once (catalogue CSV)', async () => {
    await runExport('CATALOG_CSV', { includeInactive: false });
    expect(categoryRepo.resolveItemFieldsMany).toHaveBeenCalledTimes(EXPECTED_BUCKETS);
    expect(idsAskedAbout(categoryRepo.resolveItemFieldsMany)).toEqual(ALL_ITEMS.map((i) => i.id));
  });

  it('reads loans per bucket, covering every item once (JSON)', async () => {
    await runExport('JSON', { includeInactive: false, scope: 'ALL' });
    expect(checkoutRepo.listForItems).toHaveBeenCalledTimes(EXPECTED_BUCKETS);
    expect(idsAskedAbout(checkoutRepo.listForItems)).toEqual(ALL_ITEMS.map((i) => i.id));
  });

  it('reads history, images and attachments per bucket, covering every item once (vault)', async () => {
    await runExport('VAULT', { includeInactive: false, scope: 'ALL' });
    for (const mock of [itemRepo.getHistoryForItems, imageRepo.listForItems, attachmentRepo.listForItems]) {
      expect(mock).toHaveBeenCalledTimes(EXPECTED_BUCKETS);
      expect(idsAskedAbout(mock)).toEqual(ALL_ITEMS.map((i) => i.id));
    }
  });
});
