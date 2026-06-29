/**
 * Export orchestration (spec §3 Export Wizard, §2, §4.5).
 *
 * Gathers data through the repository layer (never raw SQL), hands it to the pure
 * builders in {@link export-data}, and triggers the browser download. Phase 14 adds the
 * §4.5 granularity (whole inventory / a single item / a Project-BOM scope) and pulls
 * full-resolution image bytes out of OPFS into the vault's `/assets` (the cross-device
 * full-res transport — JSON sync keeps blobs out per §4 strict isolation). The Markdown
 * vault is zipped off-thread in {@link export-vault.worker}. Reads are paginated (≤100)
 * per §2.1 and looped to completion.
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
  type Checkout,
  type Contact,
  type Item,
} from '@/db/repositories';
import { readImageBlob } from '@/features/images/opfs-images';
import {
  buildItemsCsv,
  buildJsonBackup,
  buildProjectVault,
  buildVault,
  type VaultAsset,
  type VaultBuild,
  type VaultItem,
} from './export-data';
import type { ExportFormat, ExportScope } from './useExportStore';
import type { VaultZipRequest, VaultZipResponse } from './export-vault.worker';

const PAGE = 100;

export interface ExportOptions {
  readonly includeInactive: boolean;
  /** §4.5 granularity. Defaults to the whole inventory. */
  readonly scope?: ExportScope;
  /** The chosen item id (scope `ITEM`) or project id (scope `PROJECT`). */
  readonly targetId?: string | null;
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

async function collectCheckouts(items: readonly Item[]): Promise<Checkout[]> {
  const repo = getCheckoutRepository();
  const all: Checkout[] = [];
  for (const item of items) {
    const page = await repo.listForItem(item.id, { limit: PAGE });
    all.push(...page.rows);
  }
  return all;
}

function download(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(href);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A short, file-safe suffix describing the scope, for the download name. */
function scopeSuffix(scope: ExportScope, items: readonly Item[]): string {
  if (scope === 'ITEM') return items[0] ? `-${items[0].name.replace(/[^\w-]+/g, '_').slice(0, 24)}` : '';
  if (scope === 'PROJECT') return '-project';
  return '';
}

/** Run an export of the chosen format & scope, returning the downloaded filename. */
export async function runExport(format: ExportFormat, options: ExportOptions): Promise<string> {
  const scope = options.scope ?? 'ALL';
  const items = await collectItems(options);
  const suffix = scopeSuffix(scope, items);

  if (format === 'CSV') {
    const name = `gubbins-items${suffix}-${stamp()}.csv`;
    download(new Blob([buildItemsCsv(items)], { type: 'text/csv;charset=utf-8' }), name);
    return name;
  }

  if (format === 'JSON') {
    const [contacts, checkouts] = await Promise.all([
      collectContacts(),
      collectCheckouts(items),
    ]);
    const name = `gubbins-export${suffix}-${stamp()}.json`;
    const json = buildJsonBackup({ items, contacts, checkouts });
    download(new Blob([json], { type: 'application/json' }), name);
    return name;
  }

  // VAULT — build per-item markdown + extract image assets, then zip off-thread.
  const itemRepo = getItemRepository();
  const imageRepo = getImageRepository();
  const attachmentRepo = getAttachmentRepository();
  const locations = await getLocationRepository().list({ limit: PAGE });
  const categories = await getCategoryRepository().list({ limit: PAGE });
  const locationNames = new Map(locations.rows.map((l) => [l.id, l.name]));
  const categoryNames = new Map(categories.rows.map((c) => [c.id, c.name]));

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
    const project = await getProjectRepository().getById(options.targetId);
    build = project ? buildProjectVault(project.name, vaultItems) : buildVault(vaultItems);
  } else {
    build = buildVault(vaultItems);
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
function zipInWorker(
  files: Record<string, string>,
  assets: Record<string, Uint8Array>,
): Promise<Uint8Array> {
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
