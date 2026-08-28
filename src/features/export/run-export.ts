/**
 * Export orchestration (spec §3 Export Wizard, §2, §4.5).
 *
 * Gathers data through the repository layer (never raw SQL), hands it to the pure
 * builders in {@link export-data}, and triggers the browser download. Phase 14 adds the
 * §4.5 granularity (whole inventory / a single item / a Project-BOM scope / a Location and
 * its items) and pulls
 * full-resolution image bytes out of OPFS into the vault's `/assets` (the cross-device
 * full-res transport — JSON sync keeps blobs out per §4 strict isolation). The Markdown
 * vault is zipped off-thread in {@link export-vault.worker}. Item reads are paginated (≤100)
 * per §2.1 and looped to completion — by keyset seek, not by deep OFFSET (issue #527) — and every
 * per-item extra (custom fields, tags, loans, history, images, attachments) is read a bucket of
 * items at a time rather than one item at a time; the bounded location/category name lookups are
 * read whole.
 */
import {
  getAttachmentRepository,
  getCheckoutRepository,
  getCategoryRepository,
  getContactRepository,
  getImageRepository,
  getItemRepository,
  getLocationRepository,
  getProjectRepository,
  getTagRepository,
  type Checkout,
  type Contact,
  type Item,
  type ItemListFilters,
  type ItemSeek,
  type LocationWithCount,
} from '@/db/repositories';
import { getReportRepository } from '@/db/repositories';
import { bucketIds } from '@/features/inventory/id-buckets';
import { toLocationExportRows } from '@/features/inventory/locations-export';
import { readImageBlob } from '@/features/images/opfs-images';
import { assertPermissions } from '@/features/users/assert-permission';
import { currentAuthority } from '@/features/users/current-authority';
import { download } from './download';
import { summariseBudget } from '@/features/projects/budget';
import { moneyDecimals } from '@/lib/money';
import {
  buildAbcCsv,
  buildAgingCsv,
  buildConsumptionCsv,
  buildDataHygieneCsv,
  buildDeadStockCsv,
  buildMovementCsv,
  buildSpendCsv,
  buildTurnoverCsv,
  buildValuationCsv,
  buildValuationTrendCsv,
} from '@/features/reports/report-csv';
import {
  ABC_WINDOW_DAYS,
  DATA_HYGIENE_STALE_DAYS,
  REPORT_MOVEMENT_BUCKETS,
  REPORT_WINDOW_DAYS,
  SPEND_BUCKETS,
  VALUATION_TREND_POINTS,
} from '@/features/reports/queries';
import { normaliseAnalyticsWindow } from '@/features/reports/analytics-windows';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { getFormatters } from '@/lib/format';
import {
  buildCatalogCsv,
  buildCatalogNameLookup,
  buildItemsExport,
  buildJsonExport,
  buildProjectVault,
  buildVault,
  type CatalogCustomFieldColumn,
  type CatalogNameLookup,
  type VaultBuild,
  type VaultItem,
  type VaultLocation,
} from './export-data';
import type { TabularExportFormat } from './tabular-export';
import type { ExportFormat, ExportScope, ReportExportKind } from './useExportStore';
import { zipInVaultWorker } from './zip-in-worker';

const PAGE = 100;

/**
 * How many Activity Log entries a vault note inlines per item (issue #610).
 *
 * An item's ledger is unbounded, and the vault reads it for *every* exported item at once, so
 * this is a ceiling rather than a whole-set read: the note is a document to keep, not a backup,
 * and a hundred-thousand-row table helps nobody. It is deliberately far above what a real item
 * accumulates — a consumable adjusted weekly takes about twenty years to reach it — where the
 * old cap of one page was passed inside two.
 *
 * Reaching it is never silent: the read asks for one entry more than this, and an item that
 * returns the extra is written out with `historyTruncated`, which puts a line in the note
 * saying what it holds. That is the whole point — the previous read stopped at 100 and rendered
 * a full-looking table.
 */
const VAULT_HISTORY_LIMIT = 1000;

export interface ExportOptions {
  readonly includeInactive: boolean;
  /** §4.5 granularity. Defaults to the whole inventory. */
  readonly scope?: ExportScope;
  /** The chosen item/project/location id (scope `ITEM`/`PROJECT`/`LOCATION`). */
  readonly targetId?: string | null;
  /** Which §3 aggregate report to serialise for the `REPORTS` format (Phase 61). */
  readonly reportKind?: ReportExportKind;
  /**
   * Which file format the items (`CSV`) export is written in (issue #132). Defaults to `csv`,
   * which is what that export produced before the other tabular formats were offered.
   */
  readonly itemFileFormat?: TabularExportFormat;
}

/** Slug + label suffix for a report-CSV download name. */
const REPORT_FILE_SLUG: Record<ReportExportKind, string> = {
  VALUATION: 'valuation',
  CONSUMPTION: 'consumption',
  MOVEMENT: 'movement',
  DEAD_STOCK: 'dead-stock',
  ABC: 'abc-analysis',
  TURNOVER: 'turnover',
  AGING: 'stock-aging',
  VALUATION_TREND: 'valuation-trend',
  DATA_HYGIENE: 'data-hygiene',
  SPEND: 'spend',
};

/**
 * The shared date formatter (issue #328), bound to the user's current preferences. A report CSV's
 * date columns render through the same `useFormatters().date` seam the Reports screen uses, so an
 * exported window/bucket date reads identically to the one on screen (and in the user's locale)
 * rather than a UTC-sliced ISO stamp. Read outside React via `getState()`; only the locale affects
 * the date, but the full bundle is fetched from its process-wide cache so nothing is rebuilt.
 */
function reportDateFormatter(): (ms: number) => string {
  const p = usePreferencesStore.getState();
  return getFormatters(p.locale, p.baseCurrency, p.weightUnit, p.dimensionUnit, p.volumeUnit).date;
}

/**
 * Build the CSV string for the chosen §3 report through `ReportRepository` (Phase 61).
 *
 * Where a report is driven by a user-selectable window on the Reports screen, the export reads
 * that same preference rather than the bare default, so the CSV covers the span the user was
 * looking at when they exported it. Each report reads the preference its own on-screen section
 * is bound to — movement and spend have their own, while turnover and the valuation trend share
 * the analytics window. Reads go through `normaliseAnalyticsWindow` so a stale persisted value
 * can never reach a repository call. Reports with a fixed span (ABC's annual window, consumption,
 * data hygiene) are deliberately left on their constants — they have no on-screen control.
 *
 * Dead stock established this (issue #92) and movement followed it (issue #86); turnover, the
 * valuation trend and spend were brought into line afterwards, having silently exported the
 * default window regardless of what the user had selected on screen.
 */
async function buildReportCsv(kind: ReportExportKind): Promise<string> {
  const repo = getReportRepository();
  const formatDate = reportDateFormatter();
  switch (kind) {
    case 'VALUATION':
      return buildValuationCsv(await repo.inventoryValue());
    case 'CONSUMPTION':
      return buildConsumptionCsv(await repo.consumptionRate(REPORT_WINDOW_DAYS), formatDate);
    case 'MOVEMENT':
      return buildMovementCsv(
        await repo.movement(
          normaliseAnalyticsWindow(usePreferencesStore.getState().reportsMovementWindow),
          REPORT_MOVEMENT_BUCKETS,
        ),
        formatDate,
      );
    case 'DEAD_STOCK':
      // Dead stock is bound to the configured idle threshold rather than an analytics window.
      return buildDeadStockCsv(await repo.deadStock(usePreferencesStore.getState().deadStockDays));
    case 'ABC':
      return buildAbcCsv(await repo.abcAnalysis(ABC_WINDOW_DAYS));
    case 'TURNOVER':
      return buildTurnoverCsv(
        await repo.turnover(normaliseAnalyticsWindow(usePreferencesStore.getState().reportsAnalyticsWindow)),
      );
    case 'AGING':
      return buildAgingCsv(await repo.stockAging());
    case 'VALUATION_TREND':
      return buildValuationTrendCsv(
        await repo.valuationTrend(
          normaliseAnalyticsWindow(usePreferencesStore.getState().reportsAnalyticsWindow),
          VALUATION_TREND_POINTS,
        ),
        formatDate,
      );
    case 'DATA_HYGIENE':
      return buildDataHygieneCsv(await repo.dataHygiene(DATA_HYGIENE_STALE_DAYS));
    case 'SPEND':
      return buildSpendCsv(
        await repo.spendAnalytics(
          normaliseAnalyticsWindow(usePreferencesStore.getState().reportsSpendWindow),
          SPEND_BUCKETS,
        ),
        formatDate,
      );
  }
}

/**
 * Walk a filtered item list to completion, seeking rather than offsetting (issue #527).
 *
 * `LIMIT ? OFFSET ?` makes SQLite produce and discard every row before the page, so walking a
 * 100k catalogue a page at a time cost ~50M discarded rows across the run — quadratic in the
 * catalogue size, for a file the user expects to download. A keyset seek asks for "the page
 * strictly after this row's sort key" instead, which the ordering index answers at constant cost
 * however deep the walk has gone. The order and the cursor both come from `list-order.ts`, the
 * same spec the infinite-scroll list seeks by (issue #172), so the walk visits every row exactly
 * once.
 *
 * The loop stops on the first page that reports no more, and also on a page that carries no
 * cursor to seek past — an empty page has none, and without that guard a driver that reported
 * `hasMore` on one would spin.
 */
async function collectItemsByWalk(
  filters: Omit<ItemListFilters, 'limit' | 'offset' | 'seek'>,
): Promise<Item[]> {
  const repo = getItemRepository();
  const all: Item[] = [];
  let seek: ItemSeek | undefined;
  for (;;) {
    const page = await repo.list({ ...filters, limit: PAGE, seek });
    all.push(...page.rows);
    if (!page.hasMore || page.endCursor === undefined || page.rows.length === 0) break;
    seek = { cursor: page.endCursor, direction: 'forward', startIndex: all.length };
  }
  return all;
}

/** Every item in the catalogue (full-export scope). */
function collectAllItems(includeInactive: boolean): Promise<Item[]> {
  return collectItemsByWalk({ includeInactive });
}

/**
 * Resolve the catalogue's custom-field columns + per-item values for the export
 * (Phase 72). Reads each item's resolved fields through the lenient-defaulting read path and
 * accumulates: one column per field definition encountered (header = field name, dedup by field
 * id, in first-seen order), plus a map of item id → { field id → stored value }. Only fields
 * with a *stored* value contribute a value (lenient defaults are left blank so a re-import does
 * not pin a default into a stored row).
 *
 * The read is batched (issue #527): one `resolveItemFieldsMany` per {@link bucketIds} slice,
 * the way `collectItemTags` already read tags. Called per item, `resolveItemFields` re-read the
 * whole `locations` table and every inheritable offer once for each exported item, which is what
 * put the catalogue CSV at roughly four queries per item.
 *
 * Column order is still first-seen in **item** order, not row order, so the header row is the one
 * the per-item loop produced before: the items are walked in order and each item's fields taken
 * from the batch's map.
 */
async function collectCustomFieldColumns(items: readonly Item[]): Promise<{
  columns: CatalogCustomFieldColumn[];
  valuesByItem: Map<string, Record<string, string | null>>;
}> {
  const repo = getCategoryRepository();
  const columns: CatalogCustomFieldColumn[] = [];
  const seen = new Set<string>();
  const valuesByItem = new Map<string, Record<string, string | null>>();

  // Only categorised items can carry custom fields, so uncategorised ones are never asked about.
  const categorised = items.filter((item) => item.categoryId !== null);
  for (const bucket of bucketIds(categorised.map((i) => i.id))) {
    const resolvedByItem = await repo.resolveItemFieldsMany(bucket);
    for (const itemId of bucket) {
      const resolved = resolvedByItem.get(itemId);
      if (resolved === undefined || resolved.length === 0) continue;
      const values: Record<string, string | null> = {};
      for (const field of resolved) {
        if (!seen.has(field.id)) {
          seen.add(field.id);
          columns.push({ fieldId: field.id, header: field.name, fieldType: field.fieldType });
        }
        if (field.hasStoredValue) values[field.id] = field.value;
      }
      if (Object.keys(values).length > 0) valuesByItem.set(itemId, values);
    }
  }

  return { columns, valuesByItem };
}

/**
 * Resolve the readable location paths and category names the catalogue CSV writes (issue #596).
 *
 * A location is keyed to its **full** path (`Workshop / Cabinet A / Drawer 3`) via the same
 * {@link toLocationExportRows} the location list and the vault's folder notes use, so all three
 * spell an ancestry identically — and so a bare `Drawer 1` that exists in two rooms is written
 * as the one the item is really in, rather than a name that names both. Where even the path is
 * shared, {@link buildCatalogNameLookup} drops it and the row keeps its id.
 */
async function collectCatalogNames(): Promise<CatalogNameLookup> {
  const [locations, categories] = await Promise.all([
    getLocationRepository().listAll(),
    getCategoryRepository().listAll(),
  ]);
  return buildCatalogNameLookup(
    toLocationExportRows(locations).map((r) => ({ id: r.location.id, name: r.location.name, path: r.path })),
    categories,
  );
}

/**
 * Resolve each item's tag names for the catalogue export (issue #141).
 *
 * Tags live in the `item_tags` join rather than on the item row, so they are read separately —
 * one bounded `listForItems` per {@link bucketIds} slice, rather than a single `IN (…)` the width
 * of the whole catalogue. Items with no tags are simply absent from the map.
 */
async function collectItemTags(items: readonly Item[]): Promise<Map<string, string[]>> {
  const repo = getTagRepository();
  const byItem = new Map<string, string[]>();
  for (const bucket of bucketIds(items.map((i) => i.id))) {
    for (const { itemId, name } of await repo.listForItems(bucket)) {
      const names = byItem.get(itemId);
      if (names) names.push(name);
      else byItem.set(itemId, [name]);
    }
  }
  return byItem;
}

/** Every item whose primary location matches (§4.5). */
function collectLocationItems(locationId: string, includeInactive: boolean): Promise<Item[]> {
  return collectItemsByWalk({ locationId, includeInactive });
}

/** The item ids referenced by a project's BOM lines (matched items only). */
async function collectProjectItems(projectId: string): Promise<Item[]> {
  const projects = getProjectRepository();
  const items = getItemRepository();
  const ids: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await projects.listLines(projectId, { limit: PAGE, offset });
    for (const line of page.rows) if (line.itemId) ids.push(line.itemId);
    if (!page.hasMore) break;
  }
  // One batched read per bucket rather than a `getById` per BOM line (issue #527). The lines'
  // order is preserved: the deduplicated id list drives the output, and the map only answers
  // which of those ids still resolve to an item (an unmatched line simply has none).
  const unique = [...new Set(ids)];
  const rows: Item[] = [];
  for (const bucket of bucketIds(unique)) {
    const byId = await items.getManyById(bucket);
    for (const id of bucket) {
      const item = byId.get(id);
      if (item) rows.push(item);
    }
  }
  return rows;
}

/** Resolve the item set for the chosen scope (§4.5). */
async function collectItems(options: ExportOptions): Promise<Item[]> {
  const scope = options.scope ?? 'ALL';
  if (scope === 'ITEM') {
    if (!options.targetId) return [];
    const item = await getItemRepository().getById(options.targetId);
    return item ? [item] : [];
  }
  if (scope === 'PROJECT') {
    return options.targetId ? collectProjectItems(options.targetId) : [];
  }
  if (scope === 'LOCATION') {
    return options.targetId ? collectLocationItems(options.targetId, options.includeInactive) : [];
  }
  return collectAllItems(options.includeInactive);
}

async function collectContacts(): Promise<Contact[]> {
  const repo = getContactRepository();
  const all: Contact[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await repo.list({ limit: PAGE, offset });
    all.push(...page.rows);
    if (!page.hasMore) break;
  }
  return all;
}

/**
 * Which locations a scoped export writes out (issue #617, `N7`).
 *
 * A whole-inventory export carries the **whole** hierarchy — a location with nothing in it still
 * has a description, a capacity and a walk order, and that is precisely what left the app in no
 * export at all. Any narrower scope carries only the locations its items actually sit in, plus the
 * chosen location itself for a `LOCATION` scope (so exporting an empty shelf still says something
 * about it); otherwise a one-item vault would be padded out with a folder per location in the
 * vault, nearly all of them empty.
 *
 * The ancestry each row needs is resolved against `all`, never the filtered subset — a path that
 * stopped at the first unexported ancestor would be wrong rather than short.
 */
function scopedLocations(
  scope: ExportScope,
  targetId: string | null | undefined,
  all: readonly LocationWithCount[],
  items: readonly Item[],
): readonly VaultLocation[] {
  const rows = toLocationExportRows(all);
  if (scope === 'ALL') return rows;
  const homes = new Set(items.map((item) => item.locationId));
  return rows.filter((row) => row.location.id === targetId || homes.has(row.location.id));
}

/**
 * Every loan against the exported items, for the JSON payload.
 *
 * Batched one query per {@link bucketIds} slice (issue #527) rather than one per item. That also
 * removes an accidental cap: the per-item read asked for a single page of 100, so an item lent
 * out more often than that had the rest of its loan history silently left out of the file.
 *
 * Deliberately uncapped, where the vault's Activity Log read below keeps its per-item cap. The
 * two are asked for different reasons: the JSON payload is a data extract, and a `checkouts`
 * array that quietly stops at 100 rows per item is wrong in a way the file cannot admit to,
 * whereas the vault note renders a *recent activity* section that was always an excerpt.
 */
async function collectCheckouts(items: readonly Item[]): Promise<Checkout[]> {
  const repo = getCheckoutRepository();
  const all: Checkout[] = [];
  for (const bucket of bucketIds(items)) {
    // The batched read groups by `item_id`; the payload is re-grouped into the order the items
    // themselves are exported in, which is the order the per-item loop produced. Otherwise the
    // `checkouts` array would silently resort itself by raw id for no reason a reader could see.
    const byItem = new Map<string, Checkout[]>();
    for (const loan of await repo.listForItems(bucket.map((i) => i.id))) {
      const list = byItem.get(loan.itemId);
      if (list) list.push(loan);
      else byItem.set(loan.itemId, [loan]);
    }
    for (const item of bucket) all.push(...(byItem.get(item.id) ?? []));
  }
  return all;
}

// The single download side-effect lives in `./download` so every export path — this
// wizard, the §3 Reports CSV, and the project BOM export (issue #27) — shares one copy.
// Re-exported so existing importers keep resolving `download` from `run-export`.
export { download };

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A short, file-safe suffix describing the scope, for the download name. */
function scopeSuffix(scope: ExportScope, items: readonly Item[]): string {
  if (scope === 'ITEM') return items[0] ? `-${items[0].name.replace(/[^\w-]+/g, '_').slice(0, 24)}` : '';
  if (scope === 'PROJECT') return '-project';
  if (scope === 'LOCATION') return '-location';
  return '';
}

/**
 * Run an export of the chosen format & scope, returning the downloaded filename.
 *
 * Gated on `export:run` (issue #429), asserted here — before the first repository read — rather
 * than in the wizard that calls it. Reading one item at a time and extracting the whole vault to
 * a file are different acts, which is why `export` is a subject of its own and not an action on
 * `items`; and a check in a component is not a check, because this function is the seam every
 * format goes through. It is required *on top of* the subject reads below, each of which still
 * asserts its own key, so an export can never reach data its session could not otherwise see.
 *
 * The pure builders in `./export-data` stay ungated on purpose: they take rows they are handed
 * and return a string, touching no repository and no session. The `export-vault.worker` is
 * likewise ungated — it receives a finished `path → text` map and zips it, having no database
 * access and, as a worker, no session to resolve an authority from.
 */
export async function runExport(format: ExportFormat, options: ExportOptions): Promise<string> {
  assertPermissions(currentAuthority(), ['export:run']);

  // §3 Reports CSV (Phase 61): an aggregate report, independent of the item-scope plumbing.
  if (format === 'REPORTS') {
    const kind = options.reportKind ?? 'VALUATION';
    const csv = await buildReportCsv(kind);
    const name = `gubbins-report-${REPORT_FILE_SLUG[kind]}-${stamp()}.csv`;
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), name);
    return name;
  }

  // Catalogue CSV (Phase 67): a round-trip-ready spreadsheet whose headers auto-map
  // in the import wizard. Ignores scope so it always exports all items (a whole-
  // catalogue file is the common onboarding use-case), so it short-circuits before
  // the shared item-scope plumbing rather than fetching the list twice. The download
  // reuses the existing `download` side-effect so no parallel path is introduced.
  if (format === 'CATALOG_CSV') {
    const allItems = await collectAllItems(options.includeInactive);
    // Phase 72: resolve each item's category custom fields so the catalogue CSV
    // carries one column per definition encountered (header = field name), with the
    // stored value per item. Reads go through CategoryRepository.resolveItemFields —
    // the existing lenient-defaulting read path, never raw SQL.
    const { columns, valuesByItem } = await collectCustomFieldColumns(allItems);
    // Tags come from their own join (issue #141), so they are read alongside rather than
    // being carried on the item row.
    const tagsByItem = await collectItemTags(allItems);
    // Readable location paths and category names for the two columns that used to hold raw
    // UUIDs (issue #596). Whole-set reads for the same reason the vault's are (issue #148): a
    // capped page would leave every item past it exporting an id again, which is the defect.
    const names = await collectCatalogNames();
    const name = `gubbins-catalog-${stamp()}.csv`;
    download(
      new Blob([buildCatalogCsv(allItems, columns, valuesByItem, tagsByItem, names)], {
        type: 'text/csv;charset=utf-8',
      }),
      name,
    );
    return name;
  }

  const scope = options.scope ?? 'ALL';
  const items = await collectItems(options);
  const suffix = scopeSuffix(scope, items);

  if (format === 'CSV') {
    // The extension and MIME type come from the serialiser rather than being hard-coded here:
    // the items list is no longer CSV-only (issue #132), and `content` is bytes for the XLSX
    // branch. The `BlobPart` cast is the same one `TabularExportMenu` uses — both a string and a
    // Uint8Array are valid Blob parts at runtime.
    const { content, mimeType, extension } = await buildItemsExport(items, options.itemFileFormat ?? 'csv');
    const name = `gubbins-items${suffix}-${stamp()}.${extension}`;
    download(new Blob([content as BlobPart], { type: mimeType }), name);
    return name;
  }

  if (format === 'JSON') {
    // Locations ride along whatever the scope (issue #617, `N7`): before this the payload was
    // `{ items, contacts, checkouts }`, so an item's `locationId` was a UUID pointing at nothing
    // in the file and a location's own description left the app in no export at all. Read whole
    // via the repository's uncapped `listAll` — the hierarchy is bounded physical structure, and
    // a partial list would leave `parentId` chains dangling.
    const [contacts, checkouts, locations] = await Promise.all([
      collectContacts(),
      collectCheckouts(items),
      getLocationRepository().listAll(),
    ]);
    const name = `gubbins-export${suffix}-${stamp()}.json`;
    const json = buildJsonExport({ items, contacts, checkouts, locations });
    download(new Blob([json], { type: 'application/json' }), name);
    return name;
  }

  // VAULT — build per-item markdown + extract image assets, then zip off-thread.
  const itemRepo = getItemRepository();
  const imageRepo = getImageRepository();
  const attachmentRepo = getAttachmentRepository();
  // Whole-set reads, not a page: these are the maps every exported item's location and category
  // name is resolved through, so a capped read wrote items out as "Unfiled" with no category once
  // a catalogue held more than a page of either (issue #148). Both sets are bounded structure, so
  // the repositories expose an uncapped `listAll` for exactly this kind of lookup.
  const locations = await getLocationRepository().listAll();
  const categories = await getCategoryRepository().listAll();
  const locationNames = new Map(locations.map((l) => [l.id, l.name]));
  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
  // Folder notes for the locations this scope covers (issue #617, `N7`) — the vault reduced a
  // location to a folder name, so its description, icon, capacity, dimensions and walk order
  // were the one thing it threw away.
  const vaultLocations = scopedLocations(scope, options.targetId, locations, items);

  // The per-item extras come in three batched reads per bucket of items (issue #527) rather than
  // three queries per item. The image *bytes* still resolve one file at a time below — those are
  // OPFS reads, not database round-trips, and each one is a distinct file.
  const vaultItems: VaultItem[] = [];
  for (const bucket of bucketIds(items)) {
    const ids = bucket.map((i) => i.id);
    const [historyByItem, imagesByItem, attachmentsByItem] = await Promise.all([
      // One more than the cap, so a longer log is *detected* rather than assumed: the extra entry
      // is the only difference between an item with exactly the cap and one with more.
      itemRepo.getHistoryForItems(ids, VAULT_HISTORY_LIMIT + 1),
      imageRepo.listForItems(ids),
      attachmentRepo.listForItems(ids),
    ]);
    for (const item of bucket) {
      const id = item.id;
      const images = imagesByItem.get(id) ?? [];
      const history = historyByItem.get(id) ?? [];
      const historyTruncated = history.length > VAULT_HISTORY_LIMIT;
      vaultItems.push({
        item,
        history: historyTruncated ? history.slice(0, VAULT_HISTORY_LIMIT) : history,
        historyTruncated,
        locationName: locationNames.get(item.locationId) ?? 'Unfiled',
        categoryName: item.categoryId ? (categoryNames.get(item.categoryId) ?? null) : null,
        // The full-resolution bytes are resolved *here*, before the note is written, so the note
        // and the zip are decided by one fact (issue #635). A row can point at a file this device
        // does not hold — a photo synced from a peer, one Storage Triage downgraded, or one added
        // while storage was critical — and the builder then embeds the thumbnail instead of a
        // wiki-link to a file the zip never carried.
        images: await Promise.all(
          images.map(async (img) => ({
            id: img.id,
            opfsPath: img.fullResOpfsPath,
            thumbnail: img.thumbnailBlob,
            fullRes: await readFullResBytes(img.fullResOpfsPath),
          })),
        ),
        attachments: (attachmentsByItem.get(id) ?? []).map((a) => ({
          kind: a.kind,
          value: a.value,
          label: a.label,
        })),
      });
    }
  }

  // A Project scope packs everything into one project folder — master note + the
  // component notes in their Location sub-folders (§4.5). Other scopes stay flat.
  let build: VaultBuild;
  if (scope === 'PROJECT' && options.targetId) {
    const projectRepo = getProjectRepository();
    const project = await projectRepo.getById(options.targetId);
    if (project) {
      const facts = await projectRepo.getBudget(options.targetId);
      // A pure module, so there is no `useFormatters` to read the currency's digits from — the
      // preference store is the same source that hook derives them from, and `moneyDecimals`
      // the same `Intl` lookup, so the exported figures land on the scale the app shows them at
      // rather than a flat 2dp (issue #292).
      const prefs = usePreferencesStore.getState();
      const summary = summariseBudget(facts, prefs.budgetWarnPercent, moneyDecimals(prefs.baseCurrency));
      build = buildProjectVault(
        project.name,
        vaultItems,
        {
          budget: summary.budget,
          totalSpent: summary.totalSpent,
          committedFromBom: summary.committedFromBom,
          manualExpenseTotal: summary.manualExpenseTotal,
          remaining: summary.remaining,
          projectedFinalCost: summary.projectedFinalCost,
        },
        vaultLocations,
      );
    } else {
      build = buildVault(vaultItems, { locations: vaultLocations });
    }
  } else {
    build = buildVault(vaultItems, { locations: vaultLocations });
  }
  const { files, assets } = build;

  const assetBytes: Record<string, Uint8Array> = {};
  for (const asset of assets) assetBytes[asset.path] = asset.bytes;
  const zip = await zipInVaultWorker(files, assetBytes);
  const name = `gubbins-vault${suffix}-${stamp()}.zip`;
  download(new Blob([zip as BlobPart], { type: 'application/zip' }), name);
  return name;
}

/**
 * Read one full-resolution image back from OPFS as bytes, or `null` when this device holds no
 * such file — synced from another device whose bytes never travelled (§4 strict isolation),
 * downgraded by Storage Triage, or never written because storage was critical when it was added.
 * Missing bytes are never an export failure; they decide which file the note embeds instead
 * (issue #635).
 */
async function readFullResBytes(opfsPath: string): Promise<Uint8Array | null> {
  const blob = await readImageBlob(opfsPath);
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}
