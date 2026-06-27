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

// --- Markdown / Obsidian vault (§4.5) ------------------------------------------

export interface VaultItem {
  readonly item: Item;
  readonly history: readonly ItemHistoryEntry[];
  readonly locationName: string;
  readonly categoryName: string | null;
}

/**
 * Build the Markdown vault file set (§4.5): one `.md` per item under a
 * `Location/Item.md` hierarchy, with strictly-typed YAML frontmatter (for Obsidian
 * Dataview), the description body, and a formatted Activity Ledger table. Returns a
 * `path → text` map the wizard zips (via fflate in a worker). Name collisions are
 * disambiguated with a short id suffix so no file is silently overwritten.
 */
export function buildVaultFiles(vaultItems: readonly VaultItem[]): Record<string, string> {
  const files: Record<string, string> = {};
  const used = new Set<string>();

  for (const entry of vaultItems) {
    const folder = sanitiseSegment(entry.locationName) || 'Unfiled';
    let base = sanitiseSegment(entry.item.name) || 'item';
    let path = `${folder}/${base}.md`;
    if (used.has(path.toLowerCase())) {
      base = `${base}-${entry.item.id.slice(0, 8)}`;
      path = `${folder}/${base}.md`;
    }
    used.add(path.toLowerCase());
    files[path] = renderItemMarkdown(entry);
  }
  return files;
}

function renderItemMarkdown(entry: VaultItem): string {
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
