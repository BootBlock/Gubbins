/**
 * Pure builders for the Granular Export Wizard (spec §3 Export Wizard, §4.5
 * Markdown/Obsidian vault). Kept free of React, repositories and the DOM so the
 * serialisation is unit-tested in isolation; the wizard wires these to repository
 * reads and the download/zip side-effects.
 */
import type {
  Checkout,
  Contact,
  FieldType,
  GaugeState,
  Item,
  ItemHistoryEntry,
  LocationWithCount,
} from '@/db/repositories';
import { JSON_EXPORT_KIND } from '@/lib/json-export-kind';
import { toDateInputValue } from '@/lib/date-input';
import { isoTimestamp } from './export-every-page';
import {
  buildTabularExport,
  toCsv,
  type TabularCell,
  type TabularColumn,
  type TabularExportFormat,
  type TabularExportResult,
} from './tabular-export';

/**
 * Schema version of the JSON data-export payload (independent of the backup format's own).
 *
 * v2 adds the `locations` array (issue #617, `N7`). Before it, an item's `locationId` was a bare
 * UUID pointing at nothing in the file, so the payload could not say where anything was — and a
 * location's own description, icon, capacity, dimensions and walk order left the app in no export
 * at all.
 */
export const JSON_EXPORT_FORMAT_VERSION = 2;

export interface JsonExportPayload {
  readonly kind: typeof JSON_EXPORT_KIND;
  readonly formatVersion: number;
  readonly exportedAt: number;
  /** Self-describing so the file explains itself to whoever opens it years later. */
  readonly note: string;
  readonly items: readonly Item[];
  readonly contacts: readonly Contact[];
  readonly checkouts: readonly Checkout[];
  /**
   * Every location the user has, whatever the export's scope (issue #617, `N7`).
   *
   * Deliberately the whole hierarchy rather than only the locations the exported items sit in:
   * `parentId` chains upward, so a partial list would leave a path that stops halfway, and an
   * empty location's description would never leave the app at all — the gap this closes. The
   * hierarchy is bounded physical structure (the same reasoning that lets `LocationRepository`
   * expose an uncapped `listAll`), so carrying all of it is cheap even for a one-item export.
   * The Markdown vault narrows by scope instead, for a reason that doesn't apply here: there
   * each location becomes a **folder** on disk, and a one-item export would otherwise unpack as
   * a tree of empty ones.
   */
  readonly locations: readonly LocationWithCount[];
}

/** Spelled out in the file itself — the wizard's hint is long gone by the time it is reopened. */
const JSON_EXPORT_NOTE =
  'A read-only extract of items, locations, contacts and loans for use in other tools. ' +
  "Each item's locationId refers to an entry in the locations array. " +
  'Gubbins cannot import this file back — use Backup & restore for a restorable backup.';

/** Build the portable, versioned JSON data extract (§3). */
export function buildJsonExport(
  data: Pick<JsonExportPayload, 'items' | 'contacts' | 'checkouts' | 'locations'>,
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
    locations: data.locations,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * The keys of `T` whose value can be written straight into a tabular cell.
 *
 * `Item` carries object-valued fields alongside its scalars (`gauge`, `operationalMetadata`,
 * `thumbnailBlob`), and a column list is just a list of names — so without this filter, adding
 * one of them compiles cleanly and emits `[object Object]` into the user's file (issue #357).
 * Constraining the lists below to `ScalarKeys<Item>` makes that a compile error instead, and
 * lets each value be read off the row directly rather than through a cast.
 */
type ScalarKeys<T> = {
  [K in keyof T]-?: T[K] extends TabularCell ? K : never;
}[keyof T];

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
] as const satisfies readonly ScalarKeys<Item>[];

/**
 * Item export columns as a {@link TabularColumn} spec for the shared serialiser.
 *
 * @internal Exported for unit tests only.
 */
export const ITEM_CSV_COLUMNS: readonly TabularColumn<Item>[] = CSV_COLUMNS.map((col) => ({
  header: col,
  value: (item) => {
    // An unlimited-supply item (Phase 82) has no finite count — leave its quantity cell
    // blank (∞ has no numeric CSV representation); the `isUnlimited` column carries the truth.
    if (col === 'quantity' && item.isUnlimited) return '';
    return item[col];
  },
}));

/** Build a spreadsheet-friendly CSV of items (RFC-4180 quoting via the shared serialiser). */
export function buildItemsCsv(items: readonly Item[]): string {
  return toCsv(ITEM_CSV_COLUMNS, items);
}

/**
 * Serialise the item list to any of the shared tabular formats (issue #132).
 *
 * The columns were already a `TabularColumn` spec, so the wizard's items export was CSV-only
 * for no reason beyond the branch that produced it: a project's bill of materials could be
 * saved as an Excel workbook while the item list it was drawn from could not. This routes the
 * same columns through the same dispatch every other list export uses.
 *
 * `buildItemsCsv` stays as the CSV shorthand — the catalogue round-trip and the frozen
 * byte-for-byte CSV tests are built on it.
 */
export function buildItemsExport(
  items: readonly Item[],
  format: TabularExportFormat,
): Promise<TabularExportResult> {
  return buildTabularExport(format, ITEM_CSV_COLUMNS, items, {
    title: 'Items',
    caption: `${items.length} item${items.length === 1 ? '' : 's'}`,
  });
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
  // Scanner + per-unit identity (issue #141). The barcode is what the scanner looks an item up
  // by, so a catalogue that round-trips without it comes back unscannable.
  'barcode',
  'serialNumber',
  'quantity',
  'locationId',
  'categoryId',
  'trackingMode',
  // Consumable-Gauge configuration (issue #341); blank on every other tracking mode. Exported
  // so a gauge item survives the spreadsheet round-trip — the importer needs the unit and the
  // capacity to re-create one at all.
  'unitOfMeasure',
  'grossCapacity',
  'tareWeight',
  'currentNetValue',
  // The figure a gauge's stock is valued from (issue #683) — without it a catalogue that
  // round-trips comes back unpriced, and the inventory total drops by every gauge's contents.
  'costPerUnitOfMeasure',
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
  // Perishable expiry (issue #141), written as the `YYYY-MM-DD` calendar day the stored instant
  // falls on — the app-wide date-input convention, and the one form the importer reads back.
  'expiryDate',
  'condition',
  'reorderPoint',
  'reorderQty',
  'isUnlimited',
  // Freeform tags as a comma-separated list (issue #141). Not a column on the item row, so its
  // value comes from `tagsByItem` rather than {@link catalogCsvValue}.
  'tags',
] as const satisfies readonly (ScalarKeys<Item> | VirtualCatalogColumn)[];

type CatalogCsvColumn = (typeof CATALOG_CSV_COLUMNS)[number];

/** The gauge sub-object's fields, which sit one level down on the item rather than flat. */
const GAUGE_CSV_COLUMNS = [
  'unitOfMeasure',
  'grossCapacity',
  'tareWeight',
  'currentNetValue',
  'costPerUnitOfMeasure',
] as const satisfies readonly ScalarKeys<GaugeState>[];

type GaugeCsvColumn = (typeof GAUGE_CSV_COLUMNS)[number];

/**
 * The catalog columns that are *not* a plain field of the item row: they either rename a field
 * (`sku`), reformat one (`expiryDate`), read the gauge sub-object, or come from a separate
 * table (`tags`). Every other column name has to be a scalar `Item` key, which is what keeps
 * {@link catalogCsvValue}'s fall-through a direct read.
 */
type VirtualCatalogColumn = 'sku' | 'expiryDate' | 'tags' | GaugeCsvColumn;

function isGaugeColumn(col: CatalogCsvColumn): col is GaugeCsvColumn {
  return (GAUGE_CSV_COLUMNS as readonly string[]).includes(col);
}

/**
 * Map a logical catalog-CSV column to the Item field that holds the value. `tags` is handled by
 * the caller (it comes from a separate map, not the item row), so it is excluded here.
 */
function catalogCsvValue(item: Item, col: Exclude<CatalogCsvColumn, 'tags'>): TabularCell {
  // `sku` and `mpn` refer to the same field; export as `sku` so the importer
  // auto-maps it without requiring a manual column selection.
  if (col === 'sku') return item.mpn;
  // The expiry instant is written as its calendar day through the shared date-input seam
  // (`@/lib/date-input`), so it round-trips exactly through the importer — which reads the same
  // `YYYY-MM-DD` form back to the same midnight-UTC instant — in every timezone. Anything that
  // is not a usable instant leaves the cell blank rather than throwing: `toDateInputValue` calls
  // `toISOString`, which raises on a non-finite value, and one unusable row must not cost the
  // user the whole export file.
  if (col === 'expiryDate') {
    return Number.isFinite(item.expiryDate) ? toDateInputValue(item.expiryDate) : null;
  }
  // Gauge configuration lives in the derived `gauge` sub-object (null for every other tracking
  // mode, which leaves these cells blank). Only the stored parameters are exported: the derived
  // `percentageRemaining` / `currentGrossWeight` are computed from them on the way back in.
  if (isGaugeColumn(col)) {
    return item.gauge?.[col] ?? null;
  }
  return item[col];
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
 *
 * `tagsByItem` (item id → tag names, issue #141) fills the `tags` column. Tags live in their own
 * M:N join rather than on the item row, so they have to be read separately and handed in; an
 * item that is absent from the map simply has no tags. The names are joined with `,` — the
 * separator the tag editor itself reserves, so no tag name can contain one — and the shared
 * serialiser quotes the cell.
 */
export function buildCatalogCsv(
  items: readonly Item[],
  customFields: readonly CatalogCustomFieldColumn[] = [],
  valuesByItem: ReadonlyMap<string, Readonly<Record<string, string | null>>> = new Map(),
  tagsByItem: ReadonlyMap<string, readonly string[]> = new Map(),
): string {
  const seen = new Set<string>();
  const custom = customFields.filter((c) => (seen.has(c.fieldId) ? false : (seen.add(c.fieldId), true)));

  const columns: readonly TabularColumn<Item>[] = [
    ...CATALOG_CSV_COLUMNS.map((col) => ({
      header: col,
      value: (item: Item) =>
        col === 'tags' ? (tagsByItem.get(item.id)?.join(', ') ?? null) : catalogCsvValue(item, col),
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

/**
 * A location to write a **folder note** for (issue #617, `N7`).
 *
 * The vault reduced a location to a folder name and nothing else, so a place's description, icon,
 * capacity, dimensions and walk order left the app in no export at all. One note per location
 * gives them somewhere to live, at the Obsidian folder-note path (`Folder/Folder.md`) so the
 * folder itself carries them.
 */
export interface VaultLocation {
  /**
   * Structurally the same row the location **list** export builds
   * (`@/features/inventory/locations-export`), so the orchestrator resolves each location's
   * ancestry once and feeds both. Declared here rather than imported so this pure builder keeps
   * depending on nothing but the repository DTOs; the two are checked against each other at the
   * call site.
   */
  readonly location: LocationWithCount;
  /**
   * The full path **including** this location, e.g. `Workshop / Cabinet A / Drawer 3`. Carried
   * because the vault's folders are keyed by a location's own name, so the note is the only place
   * that can say *which* "Drawer 3" this is.
   */
  readonly path: string;
  /** The immediate parent's name, or `null` for a top-level location. */
  readonly parentName: string | null;
}

export interface VaultOptions {
  /**
   * When set, every note and asset nests under this single top-level folder (§4.5 project
   * scope: "a folder containing the Project's master `.md` file alongside sub-folders of
   * associated components"). Sanitised here; falls back to `Project` if it empties out.
   */
  readonly rootFolder?: string;
  /**
   * Locations to write folder notes for (issue #617, `N7`). Omit for a vault that should carry
   * item notes alone — which is what every caller did before, so the layout is unchanged without
   * it.
   */
  readonly locations?: readonly VaultLocation[];
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
 *
 * With `options.locations` (issue #617, `N7`) each location also gets an Obsidian **folder note**
 * at `Folder/Folder.md`, carrying what the vault previously threw away: the description, icon,
 * capacity, dimensions and walk order. Those are written *first*, so the folder note keeps the
 * canonical name and an item that happens to share its location's name takes the id-suffixed
 * fallback instead — the folder's own note is the one that cannot be renamed without breaking
 * Obsidian's folder-note convention.
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

  for (const entry of options.locations ?? []) {
    const folder = sanitiseSegment(entry.location.name) || 'Unfiled';
    // The vault's folders are keyed by a location's *name*, so two same-named locations in
    // different branches already share one folder. The second one to claim it takes the same
    // id-suffixed fallback a colliding item name does, rather than overwriting the first; each
    // note's `path` frontmatter is what says which location it describes.
    let path = `${prefix}${folder}/${folder}.md`;
    if (used.has(path.toLowerCase())) {
      path = `${prefix}${folder}/${folder}-${entry.location.id.slice(0, 8)}.md`;
    }
    used.add(path.toLowerCase());
    files[path] = renderLocationMarkdown(entry);
  }

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
  locations?: readonly VaultLocation[],
): VaultBuild {
  const folder = sanitiseSegment(projectName) || PROJECT_FOLDER_FALLBACK;
  const { files, assets } = buildVault(vaultItems, { rootFolder: folder, locations });
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

/**
 * One location's Obsidian **folder note** (issue #617, `N7`) — the page that carries what a
 * location records about itself, which the vault previously reduced to a folder name.
 *
 * The frontmatter holds the stored values verbatim (the `icon` glyph *name*, not its humanised
 * label; millimetres, not the reader's `dimensionUnit`), matching how an item note writes `trackingMode`
 * — this is Dataview-queryable metadata, whereas the spreadsheet export next door is read by a
 * person and uses the labels. `path` is what disambiguates two same-named locations sharing a
 * folder.
 *
 * Deliberately **no** contents list: the folder is keyed by location name, so a list here could
 * not honestly claim to be *this* location's items when two share the folder — and each item note
 * already carries `location:` in its own frontmatter, which is what Dataview queries anyway.
 */
function renderLocationMarkdown(entry: VaultLocation): string {
  const { location } = entry;
  const front: Record<string, string | number | boolean | null> = {
    type: 'location',
    id: location.id,
    name: location.name,
    path: entry.path,
    parent: entry.parentName,
    icon: location.icon,
    items: location.itemCount,
    capacity: location.capacity,
    // Canonical stored units — millimetres and cubic millimetres (issue #457).
    width: location.width,
    height: location.height,
    depth: location.depth,
    usableVolume: location.usableVolume,
    packingFactor: location.packingFactor,
    walkOrder: location.walkOrder,
    default: location.isDefault,
    // Through the shared export seam, so the vault and the location list export agree about what
    // an unreadable stored timestamp does — blank the field rather than fail the whole file.
    archived: isoTimestamp(location.archivedAt),
    lastCounted: isoTimestamp(location.lastCountedAt),
    deadStockMode: location.deadStockMode,
    deadStockDays: location.deadStockDays,
    color: location.color,
  };

  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(front)) {
    lines.push(`${key}: ${yamlValue(value)}`);
  }
  lines.push('---', '', `# ${location.name}`, '');
  if (location.description) lines.push(location.description, '');
  return lines.join('\n');
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
