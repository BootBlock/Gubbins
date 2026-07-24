/**
 * Pure builders for the Granular Export Wizard (spec §3 Export Wizard, §4.5
 * Markdown/Obsidian vault). Kept free of React, repositories and the DOM so the
 * serialisation is unit-tested in isolation; the wizard wires these to repository
 * reads and the download/zip side-effects.
 */
import type { Checkout, Contact, FieldType, Item, ItemHistoryEntry } from '@/db/repositories';
import { JSON_EXPORT_KIND } from '@/lib/json-export-kind';
import { toCsv, type TabularCell, type TabularColumn } from './tabular-export';

/** Schema version of the JSON data-export payload (independent of the backup format's own). */
export const JSON_EXPORT_FORMAT_VERSION = 1;

export interface JsonExportPayload {
  readonly kind: typeof JSON_EXPORT_KIND;
  readonly formatVersion: number;
  readonly exportedAt: number;
  /** Self-describing so the file explains itself to whoever opens it years later. */
  readonly note: string;
  readonly items: readonly Item[];
  readonly contacts: readonly Contact[];
  readonly checkouts: readonly Checkout[];
}

/** Spelled out in the file itself — the wizard's hint is long gone by the time it is reopened. */
const JSON_EXPORT_NOTE =
  'A read-only extract of items, contacts and loans for use in other tools. ' +
  'Gubbins cannot import this file back — use Backup & restore for a restorable backup.';

/** Build the portable, versioned JSON data extract (§3). */
export function buildJsonExport(
  data: Pick<JsonExportPayload, 'items' | 'contacts' | 'checkouts'>,
  exportedAt = Date.now(),
): string {
  const payload: JsonExportPayload = {
    kind: JSON_EXPORT_KIND,
    formatVersion: JSON_EXPORT_FORMAT_VERSION,
    exportedAt,
    note: JSON_EXPORT_NOTE,
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
  'notes',
  'trackingMode',
  'quantity',
  'isUnlimited',
  'mpn',
  'manufacturer',
  'unitCost',
  // Intrinsic weight in canonical grams (issue #25); blank when unset.
  'weight',
  // Intrinsic bounding-box dimensions in canonical millimetres (issue #30); blank when unset.
  'width',
  'height',
  'depth',
] as const;

/** Item CSV columns as a {@link TabularColumn} spec for the shared serialiser. */
const ITEM_CSV_COLUMNS: readonly TabularColumn<Item>[] = CSV_COLUMNS.map((col) => ({
  header: col,
  value: (item) => {
    // An unlimited-supply item (Phase 82) has no finite count — leave its quantity cell
    // blank (∞ has no numeric CSV representation); the `isUnlimited` column carries the truth.
    if (col === 'quantity' && item.isUnlimited) return '';
    return (item as unknown as Record<string, TabularCell>)[col];
  },
}));

/** Build a spreadsheet-friendly CSV of items (RFC-4180 quoting via the shared serialiser). */
export function buildItemsCsv(items: readonly Item[]): string {
  return toCsv(ITEM_CSV_COLUMNS, items);
}

/**
 * Catalog CSV column spec for the Phase 67 round-trip import format.
 * Headers match the synonym map in `catalog-import.ts` so a file exported here
 * can be imported back without a manual column-mapping step.
 */
const CATALOG_CSV_COLUMNS = [
  'name',
  'description',
  'notes',
  'sku',
  'quantity',
  'locationId',
  'categoryId',
  'trackingMode',
  'manufacturer',
  'unitCost',
  // Canonical grams (issue #25); round-trips back through the `weight` import synonym.
  'weight',
  // Canonical millimetres (issue #30); round-trip back through the dimension import synonyms.
  'width',
  'height',
  'depth',
  'batchNumber',
  'lotNumber',
  'condition',
  'reorderPoint',
  'reorderQty',
  'isUnlimited',
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
 * A category custom-field column for the catalogue export (Phase 72). One column
 * per field *definition* encountered: the `header` is the field's name (or key) — it
 * round-trips back through `inferColumnMapping`'s custom-field name match — and
 * `fieldId` keys the per-item value lookup.
 */
export interface CatalogCustomFieldColumn {
  readonly fieldId: string;
  readonly header: string;
  /**
   * The field's type — needed so an `IMAGE` column exports a short marker rather than its
   * (potentially huge) base64 `data:` URL, which would bloat and corrupt a spreadsheet and
   * can't round-trip through import anyway. Optional for back-compat with older callers.
   */
  readonly fieldType?: FieldType;
}

/** Placeholder written for an IMAGE cell — the base64 image never belongs in a CSV. */
const IMAGE_CELL_MARKER = '[image]';

/**
 * Build a catalog CSV that round-trips through the Phase 67 import wizard
 * without requiring manual column mapping (headers match the auto-detection
 * synonyms). RFC-4180 quoting, CRLF rows.
 *
 * When `customFields` are supplied (Phase 72) one extra column per definition is
 * appended after the core columns, its header being the field name; each item's
 * value is read from `valuesByItem` (item id → field id → stored value, defaulting
 * to blank). The custom columns are deduplicated by field id (first wins) so a field
 * shared by several items yields a single column.
 */
export function buildCatalogCsv(
  items: readonly Item[],
  customFields: readonly CatalogCustomFieldColumn[] = [],
  valuesByItem: ReadonlyMap<string, Readonly<Record<string, string | null>>> = new Map(),
): string {
  const seen = new Set<string>();
  const custom = customFields.filter((c) => (seen.has(c.fieldId) ? false : (seen.add(c.fieldId), true)));

  const columns: readonly TabularColumn<Item>[] = [
    ...CATALOG_CSV_COLUMNS.map((col) => ({
      header: col,
      value: (item: Item) => catalogCsvValue(item, col) as TabularCell,
    })),
    ...custom.map((c) => ({
      header: c.header,
      value: (item: Item) => {
        const raw = valuesByItem.get(item.id)?.[c.fieldId] ?? null;
        // Never dump a base64 image into a cell — emit a marker instead.
        if (c.fieldType === 'IMAGE') return raw ? IMAGE_CELL_MARKER : null;
        return raw;
      },
    })),
  ];
  return toCsv(columns, items);
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
export function buildVault(vaultItems: readonly VaultItem[], options: VaultOptions = {}): VaultBuild {
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
 *
 * @internal Exported for unit tests only.
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
  if (item.notes) lines.push('## Notes', '', item.notes, '');

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
 *
 * @internal Exported for unit tests only.
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
  // Always quote strings to keep the YAML safe regardless of content. Escape the
  // backslash first so a value ending in one can't consume the closing quote.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeCell(value: string): string {
  // Escape the backslash first so a value containing one can't defeat the pipe escaping.
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Make a string safe as a single file/folder name segment.
 *
 * @internal Exported for unit tests only.
 */
export function sanitiseSegment(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80);
}
