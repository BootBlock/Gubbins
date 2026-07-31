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
 * per §2.1 and looped to completion; the bounded location/category name lookups are read whole.
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
  type LocationWithCount,
} from '@/db/repositories';
import { getReportRepository } from '@/db/repositories';
import { bucketIds } from '@/features/inventory/id-buckets';
import { toLocationExportRows } from '@/features/inventory/locations-export';
import { readImageBlob } from '@/features/images/opfs-images';
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
  buildItemsExport,
  buildJsonExport,
  buildProjectVault,
  buildVault,
  type CatalogCustomFieldColumn,
  type VaultAsset,
  type VaultBuild,
  type VaultItem,
  type VaultLocation,
} from './export-data';
import type { TabularExportFormat } from './tabular-export';
import type { ExportFormat, ExportScope, ReportExportKind } from './useExportStore';
import type { VaultZipRequest, VaultZipResponse } from './export-vault.worker';

const PAGE = 100;

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

/** Page through a repository list to gather every row (full-export scope). */
async function collectAllItems(includeInactive: boolean): Promise<Item[]> {
  const repo = getItemRepository();
  const all: Item[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await repo.list({ includeInactive, limit: PAGE, offset });
    all.push(...page.rows);
    if (!page.hasMore) break;
  }
  return all;
}

/**
 * Resolve the catalogue's custom-field columns + per-item values for the export
 * (Phase 72). Iterates each item's resolved fields via `resolveItemFields` (the
 * existing lenient-defaulting read path) and accumulates: one column per field
 * definition encountered (header = field name, dedup by field id, in first-seen
 * order), plus a map of item id → { field id → stored value }. Only fields with a
 * *stored* value contribute a value (lenient defaults are left blank so a re-import
 * does not pin a default into a stored row).
 */
async function collectCustomFieldColumns(items: readonly Item[]): Promise<{
  columns: CatalogCustomFieldColumn[];
  valuesByItem: Map<string, Record<string, string | null>>;
}> {
  const repo = getCategoryRepository();
  const columns: CatalogCustomFieldColumn[] = [];
  const seen = new Set<string>();
  const valuesByItem = new Map<string, Record<string, string | null>>();

  for (const item of items) {
    if (!item.categoryId) continue; // no category → no custom fields
    const resolved = await repo.resolveItemFields(item.id);
    if (resolved.length === 0) continue;
    const values: Record<string, string | null> = {};
    for (const field of resolved) {
      if (!seen.has(field.id)) {
        seen.add(field.id);
        columns.push({ fieldId: field.id, header: field.name, fieldType: field.fieldType });
      }
      if (field.hasStoredValue) values[field.id] = field.value;
    }
    if (Object.keys(values).length > 0) valuesByItem.set(item.id, values);
  }

  return { columns, valuesByItem };
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

/** Page through a repository list to gather every item whose primary location matches (§4.5). */
async function collectLocationItems(locationId: string, includeInactive: boolean): Promise<Item[]> {
  const repo = getItemRepository();
  const all: Item[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await repo.list({ locationId, includeInactive, limit: PAGE, offset });
    all.push(...page.rows);
    if (!page.hasMore) break;
  }
  return all;
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
  const seen = new Set<string>();
  const rows: Item[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const item = await items.getById(id);
    if (item) rows.push(item);
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

async function collectCheckouts(items: readonly Item[]): Promise<Checkout[]> {
  const repo = getCheckoutRepository();
  const all: Checkout[] = [];
  for (const item of items) {
    const page = await repo.listForItem(item.id, { limit: PAGE });
    all.push(...page.rows);
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

/** Run an export of the chosen format & scope, returning the downloaded filename. */
export async function runExport(format: ExportFormat, options: ExportOptions): Promise<string> {
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
    const name = `gubbins-catalog-${stamp()}.csv`;
    download(
      new Blob([buildCatalogCsv(allItems, columns, valuesByItem, tagsByItem)], {
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
  // location to a folder name, so its description, kind, capacity, dimensions and walk order
  // were the one thing it threw away.
  const vaultLocations = scopedLocations(scope, options.targetId, locations, items);

  const vaultItems: VaultItem[] = [];
  for (const item of items) {
    const [history, images, attachments] = await Promise.all([
      itemRepo.getHistory(item.id, { limit: PAGE }),
      imageRepo.listForItem(item.id),
      attachmentRepo.listForItem(item.id),
    ]);
    vaultItems.push({
      item,
      history: history.rows,
      locationName: locationNames.get(item.locationId) ?? 'Unfiled',
      categoryName: item.categoryId ? (categoryNames.get(item.categoryId) ?? null) : null,
      images: images.map((img) => ({
        id: img.id,
        opfsPath: img.fullResOpfsPath,
        thumbnail: img.thumbnailBlob,
      })),
      attachments: attachments.map((a) => ({ kind: a.kind, value: a.value, label: a.label })),
    });
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

  const assetBytes = await resolveAssets(assets);
  const zip = await zipInWorker(files, assetBytes);
  const name = `gubbins-vault${suffix}-${stamp()}.zip`;
  download(new Blob([zip as BlobPart], { type: 'application/zip' }), name);
  return name;
}

/**
 * Resolve each {@link VaultAsset} to bytes: read full-res files from OPFS, pass through
 * already-held thumbnail bytes. A full-res file missing locally (synced from another
 * device whose bytes never travelled — §4 strict isolation) is skipped, never failing the
 * whole export.
 */
async function resolveAssets(assets: readonly VaultAsset[]): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  for (const asset of assets) {
    if (asset.bytes) {
      out[asset.path] = asset.bytes;
      continue;
    }
    if (!asset.opfsPath) continue;
    const blob = await readImageBlob(asset.opfsPath);
    if (blob) out[asset.path] = new Uint8Array(await blob.arrayBuffer());
  }
  return out;
}

/** Zip the vault files + assets in the fflate Web Worker (§4.5). */
function zipInWorker(files: Record<string, string>, assets: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./export-vault.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<VaultZipResponse>) => {
      resolve(event.data.zip);
      worker.terminate();
    };
    worker.onerror = (err) => {
      reject(err);
      worker.terminate();
    };
    const request: VaultZipRequest = { files, assets };
    worker.postMessage(request);
  });
}
