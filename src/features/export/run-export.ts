/**
 * Export orchestration (spec §3 Export Wizard, §2, §4.5).
 *
 * Gathers data through the repository layer (never raw SQL), hands it to the pure
 * builders in {@link export-data}, and triggers the browser download. The Markdown
 * vault is zipped off-thread in {@link export-vault.worker}. Reads are paginated
 * (≤100) per §2.1 and looped to completion for a full export.
 */
import {
  getCheckoutRepository,
  getCategoryRepository,
  getContactRepository,
  getItemRepository,
  getLocationRepository,
  type Checkout,
  type Contact,
  type Item,
} from '@/db/repositories';
import {
  buildItemsCsv,
  buildJsonBackup,
  buildVaultFiles,
  type VaultItem,
} from './export-data';
import type { ExportFormat } from './useExportStore';
import type { VaultZipRequest, VaultZipResponse } from './export-vault.worker';

const PAGE = 100;

/** Page through a repository list to gather every row (full-export scope). */
async function collectItems(includeInactive: boolean): Promise<Item[]> {
  const repo = getItemRepository();
  const all: Item[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await repo.list({ includeInactive, limit: PAGE, offset });
    all.push(...page.rows);
    if (!page.hasMore) break;
  }
  return all;
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

/** Run an export of the chosen format, returning the downloaded filename. */
export async function runExport(
  format: ExportFormat,
  options: { includeInactive: boolean },
): Promise<string> {
  const items = await collectItems(options.includeInactive);

  if (format === 'CSV') {
    const name = `gubbins-items-${stamp()}.csv`;
    download(new Blob([buildItemsCsv(items)], { type: 'text/csv;charset=utf-8' }), name);
    return name;
  }

  if (format === 'JSON') {
    const [contacts, checkouts] = await Promise.all([
      collectContacts(),
      collectCheckouts(items),
    ]);
    const name = `gubbins-backup-${stamp()}.json`;
    const json = buildJsonBackup({ items, contacts, checkouts });
    download(new Blob([json], { type: 'application/json' }), name);
    return name;
  }

  // VAULT — build per-item markdown, then zip off-thread.
  const itemRepo = getItemRepository();
  const locations = await getLocationRepository().list({ limit: PAGE });
  const categories = await getCategoryRepository().list({ limit: PAGE });
  const locationNames = new Map(locations.rows.map((l) => [l.id, l.name]));
  const categoryNames = new Map(categories.rows.map((c) => [c.id, c.name]));

  const vaultItems: VaultItem[] = [];
  for (const item of items) {
    const history = await itemRepo.getHistory(item.id, { limit: PAGE });
    vaultItems.push({
      item,
      history: history.rows,
      locationName: locationNames.get(item.locationId) ?? 'Unfiled',
      categoryName: item.categoryId ? (categoryNames.get(item.categoryId) ?? null) : null,
    });
  }

  const files = buildVaultFiles(vaultItems);
  const zip = await zipInWorker(files);
  const name = `gubbins-vault-${stamp()}.zip`;
  download(new Blob([zip as BlobPart], { type: 'application/zip' }), name);
  return name;
}

/** Zip the vault files in the fflate Web Worker (§4.5). */
function zipInWorker(files: Record<string, string>): Promise<Uint8Array> {
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
    const request: VaultZipRequest = { files };
    worker.postMessage(request);
  });
}
