/**
 * Pure builders for the Granular Export Wizard (spec §3 Export Wizard, §2 Versioned
 * JSON backup, §4.5 Markdown/Obsidian vault). Kept free of React, repositories and
 * the DOM so the serialisation is unit-tested in isolation; the wizard wires these
 * to repository reads and the download/zip side-effects.
 */
import type {
  Checkout,
  Contact,
  Item,
  ItemHistoryEntry,
} from '@/db/repositories';

/** Schema version of the JSON backup payload (§2 "Versioned JSON File"). */
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupPayload {
  readonly formatVersion: number;
  readonly exportedAt: number;
  readonly items: readonly Item[];
  readonly contacts: readonly Contact[];
  readonly checkouts: readonly Checkout[];
}

/** Build the agnostic versioned JSON backup string (§2). */
export function buildJsonBackup(
  data: Omit<BackupPayload, 'formatVersion' | 'exportedAt'>,
  exportedAt = Date.now(),
): string {
  const payload: BackupPayload = {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt,
    items: data.items,
    contacts: data.contacts,
    checkouts: data.checkouts,
  };
  return JSON.stringify(payload, null, 2);
}

const CSV_COLUMNS = [
  'id',
  'name',
  'description',
  'trackingMode',
  'quantity',
  'mpn',
  'manufacturer',
  'unitCost',
] as const;

/** Build a spreadsheet-friendly CSV of items (RFC-4180 quoting). */
export function buildItemsCsv(items: readonly Item[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = items.map((item) =>
    CSV_COLUMNS.map((col) => csvCell((item as unknown as Record<string, unknown>)[col])).join(','),
  );
  return [header, ...rows].join('\r\n');
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Catalog CSV column spec for the Phase 67 round-trip import format.
 * Headers match the synonym map in `catalog-import.ts` so a file exported here
 * can be imported back without a manual column-mapping step.
 */
const CATALOG_CSV_COLUMNS = [
  'name',
  'description',
  'sku',
  'quantity',
  'locationId',
  'categoryId',
  'trackingMode',
  'manufacturer',
  'unitCost',
  'batchNumber',
  'lotNumber',
  'condition',
  'reorderPoint',
  'reorderQty',
] as const;

type CatalogCsvColumn = (typeof CATALOG_CSV_COLUMNS)[number];

/** Map a logical catalog-CSV column to the Item field that holds the value. */
function catalogCsvValue(item: Item, col: CatalogCsvColumn): unknown {
  // `sku` and `mpn` refer to the same field; export as `sku` so the importer
  // auto-maps it without requiring a manual column selection.
  if (col === 'sku') return item.mpn;
  return (item as unknown as Record<string, unknown>)[col];
}

/**
 * Build a catalog CSV that round-trips through the Phase 67 import wizard
 * without requiring manual column mapping (headers match the auto-detection
 * synonyms). RFC-4180 quoting, CRLF rows.
 */
export function buildCatalogCsv(items: readonly Item[]): string {
  const header = CATALOG_CSV_COLUMNS.join(',');
  const rows = items.map((item) =>
    CATALOG_CSV_COLUMNS.map((col) => csvCell(catalogCsvValue(item, col))).join(','),
  );
  return [header, ...rows].join('\r\n');
}

// --- Markdown / Obsidian vault (§4.5) ------------------------------------------

/** A full-resolution image to extract into the vault's `/assets` (§4.5). */
export interface VaultImage {
  readonly id: string;
  /** OPFS path of the full-resolution file (read by the orchestrator). */
  readonly opfsPath: string;
  /** Thumbnail bytes already held in the DB blob, extracted alongside the full-res. */
  readonly thumbnail?: Uint8Array | null;
}

/** A datasheet pointer (§4 strict isolation — only the link/path, never bytes). */
export interface VaultAttachment {
  readonly kind: 'URL' | 'LOCAL_POINTER';
  readonly value: string;
  readonly label: string | null;
}

export interface VaultItem {
  readonly item: Item;
  readonly history: readonly ItemHistoryEntry[];
  readonly locationName: string;
  readonly categoryName: string | null;
  readonly images?: readonly VaultImage[];
  readonly attachments?: readonly VaultAttachment[];
}

/**
 * A binary asset the vault references. The pure builder names the asset and decides its
 * source; the orchestrator fills the bytes (reading `opfsPath` from OPFS, or using the
 * already-resolved `bytes`). Full-res files synced from another device whose local bytes
 * are missing are simply skipped by the orchestrator.
 */
export interface VaultAsset {
  readonly path: string;
  readonly opfsPath?: string;
  readonly bytes?: Uint8Array | null;
}

export interface VaultBuild {
  readonly files: Record<string, string>;
  readonly assets: readonly VaultAsset[];
}

export interface VaultOptions {
  /**
   * When set, every note and asset nests under this single top-level folder (§4.5 project
   * scope: "a folder containing the Project's master `.md` file alongside sub-folders of
   * associated components"). Sanitised here; falls back to `Project` if it empties out.
   */
  readonly rootFolder?: string;
}

/** Fallback name for a project folder whose name sanitises to nothing. */
const PROJECT_FOLDER_FALLBACK = 'Project';

/** Extension of an OPFS image path, defaulting to `webp` (§4.2 pipeline writes WebP). */
function extOf(path: string): string {
  const ext = path.split('.').pop();
  return ext && ext.length > 0 && ext !== path ? ext.toLowerCase() : 'webp';
}

/**
 * Build the Markdown vault (§4.5): one `.md` per item under a `Location/Item.md`
 * hierarchy with strictly-typed YAML frontmatter (Obsidian Dataview), the description,
 * an `## Images` section embedding full-res images by Obsidian wiki-link, a `##
 * Datasheets` section of pointer links, and the Activity Ledger table. Full-resolution
 * images **and** thumbnails are extracted into `/assets` (§4.5). Returns the `path → text`
 * map plus the {@link VaultAsset} descriptors the orchestrator fills with bytes.
 */
export function buildVault(
  vaultItems: readonly VaultItem[],
  options: VaultOptions = {},
): VaultBuild {
  const files: Record<string, string> = {};
  const assets: VaultAsset[] = [];
  const used = new Set<string>();
  // §4.5 project scope nests everything under one project folder; whole-vault scope passes
  // no rootFolder, so the prefix is empty and the Location/Item.md layout is untouched.
  const prefix = options.rootFolder
    ? `${sanitiseSegment(options.rootFolder) || PROJECT_FOLDER_FALLBACK}/`
    : '';

  for (const entry of vaultItems) {
    const folder = sanitiseSegment(entry.locationName) || 'Unfiled';
    let base = sanitiseSegment(entry.item.name) || 'item';
    let path = `${prefix}${folder}/${base}.md`;
    if (used.has(path.toLowerCase())) {
      base = `${base}-${entry.item.id.slice(0, 8)}`;
      path = `${prefix}${folder}/${base}.md`;
    }
    used.add(path.toLowerCase());

    // Stable, vault-unique asset filenames (id-suffixed so two items can share a name).
    const assetBase = `${sanitiseSegment(entry.item.name) || 'item'}-${entry.item.id.slice(0, 8)}`;
    const imageNames = (entry.images ?? []).map((image, i) => {
      const ext = extOf(image.opfsPath);
      const fullName = `${assetBase}-${i + 1}.${ext}`;
      assets.push({ path: `${prefix}assets/${fullName}`, opfsPath: image.opfsPath });
      if (image.thumbnail) {
        assets.push({ path: `${prefix}assets/${assetBase}-${i + 1}.thumb.${ext}`, bytes: image.thumbnail });
      }
      return fullName;
    });

    files[path] = renderItemMarkdown(entry, imageNames);
  }
  return { files, assets };
}

/**
 * Build a Project/BOM-scope vault (§4.5): one self-contained project folder holding the
 * master `.md` note alongside the component notes in their Location sub-folders (and the
 * shared `/assets`). Composes {@link buildVault} (rooted at the project folder) with
 * {@link buildProjectMasterNote}, so the layout is pure and unit-tested in one place. The
 * master note's bare wiki-links resolve to the nested component notes anywhere in the vault.
 */
export function buildProjectVault(
  projectName: string,
  vaultItems: readonly VaultItem[],
  budget?: VaultBudget,
): VaultBuild {
  const folder = sanitiseSegment(projectName) || PROJECT_FOLDER_FALLBACK;
  const { files, assets } = buildVault(vaultItems, { rootFolder: folder });
  const master = buildProjectMasterNote(
    projectName,
    vaultItems.map((entry) => entry.item),
    budget,
  );
  return { files: { ...files, [`${folder}/${folder}.md`]: master }, assets };
}

/**
 * Back-compatible thin wrapper: the `path → text` map only (no asset extraction). Used by
 * callers that zip text alone.
 */
export function buildVaultFiles(vaultItems: readonly VaultItem[]): Record<string, string> {
  return buildVault(vaultItems).files;
}

function renderItemMarkdown(entry: VaultItem, imageNames: readonly string[]): string {
  const { item } = entry;
  const front: Record<string, string | number | boolean | null> = {
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    trackingMode: item.trackingMode,
    mpn: item.mpn,
    manufacturer: item.manufacturer,
    unitCost: item.unitCost,
    category: entry.categoryName,
    location: entry.locationName,
    active: item.isActive,
  };

  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(front)) {
    lines.push(`${key}: ${yamlValue(value)}`);
  }
  lines.push('---', '', `# ${item.name}`, '');
  if (item.description) lines.push(item.description, '');

  if (imageNames.length > 0) {
    lines.push('## Images', '');
    for (const name of imageNames) lines.push(`![[${name}]]`);
    lines.push('');
  }

  const attachments = entry.attachments ?? [];
  if (attachments.length > 0) {
    lines.push('## Datasheets', '');
    for (const a of attachments) {
      const label = a.label ?? (a.kind === 'URL' ? 'Datasheet' : 'Local file');
      lines.push(a.kind === 'URL' ? `- [${label}](${a.value})` : `- ${label} — ${a.value}`);
    }
    lines.push('');
  }

  if (entry.history.length > 0) {
    lines.push('## Activity', '', '| When | Action | Note |', '| --- | --- | --- |');
    for (const h of entry.history) {
      const when = new Date(h.createdAt).toISOString().slice(0, 10);
      lines.push(`| ${when} | ${h.action} | ${escapeCell(h.note ?? '')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Budget figures for a Project/BOM-scope vault export (§4 budgeting). A locale-free,
 * repository-free numeric subset so the pure exporter can render it without a formatter.
 */
export interface VaultBudget {
  readonly budget: number | null;
  readonly totalSpent: number;
  readonly committedFromBom: number;
  readonly manualExpenseTotal: number;
  readonly remaining: number | null;
  readonly projectedFinalCost: number;
}

/**
 * The master `.md` for a Project/BOM-scope vault export (§4.5): Dataview frontmatter
 * plus a component checklist wiki-linking each item note by name, and — when the project
 * carries a budget or any recorded spend — a `## Budget` summary (§4 budgeting).
 */
export function buildProjectMasterNote(
  projectName: string,
  items: readonly Item[],
  budget?: VaultBudget,
): string {
  const showBudget = budget != null && (budget.budget != null || budget.totalSpent > 0);

  const lines: string[] = [
    '---',
    'type: project',
    `name: ${yamlValue(projectName)}`,
    `components: ${items.length}`,
  ];
  if (showBudget) {
    lines.push(`budget: ${budget.budget ?? 'null'}`);
    lines.push(`spent: ${budget.totalSpent}`);
    if (budget.remaining != null) lines.push(`remaining: ${budget.remaining}`);
  }
  lines.push('---', '', `# ${projectName}`, '');

  if (showBudget) {
    lines.push('## Budget', '', '| Measure | Amount |', '| --- | --- |');
    if (budget.budget != null) lines.push(`| Budget | ${budget.budget} |`);
    lines.push(`| Committed (BOM) | ${budget.committedFromBom} |`);
    lines.push(`| Expenses | ${budget.manualExpenseTotal} |`);
    lines.push(`| Spent so far | ${budget.totalSpent} |`);
    if (budget.remaining != null) lines.push(`| Remaining | ${budget.remaining} |`);
    lines.push(`| Projected total | ${budget.projectedFinalCost} |`);
    lines.push('');
  }

  lines.push('## Components', '');
  for (const item of items) lines.push(`- [[${item.name}]]`);
  lines.push('');
  return lines.join('\n');
}

function yamlValue(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Always quote strings to keep the YAML safe regardless of content.
  return `"${value.replace(/"/g, '\\"')}"`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Make a string safe as a single file/folder name segment. */
export function sanitiseSegment(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80);
}
