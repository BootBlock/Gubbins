/**
 * Location list export (issue #617, `N7`) — the pure column model and its ancestry resolution.
 */
import { describe, expect, it } from 'vitest';
import type { LocationWithCount } from '@/db/repositories';
import {
  buildLocationsExport,
  locationsExportColumns,
  locationsExportFilename,
  toLocationExportRows,
} from './locations-export';

function makeLocation(overrides: Partial<LocationWithCount> = {}): LocationWithCount {
  return {
    id: 'l1',
    name: 'Cabinet A',
    parentId: null,
    isSystem: false,
    description: null,
    color: null,
    kind: null,
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

/** Workshop → Cabinet A → Drawer 3, plus an unrelated top-level location. */
const TREE: LocationWithCount[] = [
  makeLocation({ id: 'w', name: 'Workshop' }),
  makeLocation({ id: 'c', name: 'Cabinet A', parentId: 'w' }),
  makeLocation({ id: 'd', name: 'Drawer 3', parentId: 'c' }),
  makeLocation({ id: 'g', name: 'Garage' }),
];

/** Read one row's cell by column header, so the assertions don't depend on column order. */
function cell(row: ReturnType<typeof toLocationExportRows>[number], header: string) {
  return locationsExportColumns()
    .find((c) => c.header === header)!
    .value(row);
}

describe('toLocationExportRows', () => {
  it('resolves the full path and the immediate parent', () => {
    const rows = toLocationExportRows(TREE);
    const drawer = rows.find((r) => r.location.id === 'd')!;
    expect(drawer.path).toBe('Workshop / Cabinet A / Drawer 3');
    expect(drawer.parentName).toBe('Cabinet A');
  });

  it('leaves a top-level location as its own path, with no parent', () => {
    const garage = toLocationExportRows(TREE).find((r) => r.location.id === 'g')!;
    expect(garage.path).toBe('Garage');
    expect(garage.parentName).toBeNull();
  });

  // The ceiling on the read-everything walk can leave an ancestor unread; a path that stops
  // short is better than an export that throws.
  it('degrades to what it can see when an ancestor is missing', () => {
    const orphan = toLocationExportRows([makeLocation({ id: 'd', name: 'Drawer 3', parentId: 'gone' })]);
    expect(orphan[0]!.path).toBe('Drawer 3');
    expect(orphan[0]!.parentName).toBeNull();
  });

  // `locationPath` is cycle-safe; the export must not hang on a malformed parent chain.
  it('survives a cyclic parent chain', () => {
    const rows = toLocationExportRows([
      makeLocation({ id: 'a', name: 'A', parentId: 'b' }),
      makeLocation({ id: 'b', name: 'B', parentId: 'a' }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.path).toContain('A');
  });
});

describe('locationsExportColumns', () => {
  it('carries what nothing else exported — description, kind, capacity, size and walk order', () => {
    const [row] = toLocationExportRows([
      makeLocation({
        name: 'Cabinet A',
        kind: 'cabinet',
        description: 'No solvents here, unventilated.',
        capacity: 40,
        width: 600,
        height: 900,
        depth: 400,
        usableVolume: 200_000_000,
        packingFactor: 0.6,
        walkOrder: 2,
        itemCount: 7,
      }),
    ]);
    expect(cell(row!, 'Description')).toBe('No solvents here, unventilated.');
    // The stored key is a semantic token; the file shows the label a person reads.
    expect(cell(row!, 'Kind')).toBe('Cabinet');
    expect(cell(row!, 'Capacity')).toBe(40);
    expect(cell(row!, 'Width (mm)')).toBe(600);
    expect(cell(row!, 'Usable volume (mm³)')).toBe(200_000_000);
    expect(cell(row!, 'Packing factor')).toBe(0.6);
    expect(cell(row!, 'Walk order')).toBe(2);
    expect(cell(row!, 'Items')).toBe(7);
  });

  it('leaves an unknown kind blank rather than leaking the raw stored token', () => {
    const [row] = toLocationExportRows([makeLocation({ kind: 'spaceship' })]);
    expect(cell(row!, 'Kind')).toBeNull();
  });

  it('writes the archive and last-counted instants in ISO, blank when unset', () => {
    const [archived] = toLocationExportRows([makeLocation({ archivedAt: 0, lastCountedAt: null })]);
    expect(cell(archived!, 'Archived')).toBe('1970-01-01T00:00:00.000Z');
    expect(cell(archived!, 'Last counted')).toBeNull();
  });

  // The same guarantee the vault's folder note makes, because both go through `isoTimestamp`:
  // one unreadable stored timestamp blanks its own cell rather than failing the whole file.
  it('blanks an unreadable stored timestamp rather than throwing the export away', () => {
    const [broken] = toLocationExportRows([makeLocation({ archivedAt: Number.NaN })]);
    expect(cell(broken!, 'Archived')).toBeNull();
  });

  it('spells the default flag out for a reader', () => {
    const [yes] = toLocationExportRows([makeLocation({ isDefault: true })]);
    const [no] = toLocationExportRows([makeLocation({ isDefault: false })]);
    expect(cell(yes!, 'Default')).toBe('Yes');
    expect(cell(no!, 'Default')).toBe('No');
  });
});

describe('buildLocationsExport', () => {
  it('serialises through the shared tabular seam, quoting a path that carries a comma', async () => {
    const { content, extension, mimeType } = await buildLocationsExport('csv', [
      makeLocation({ id: 'w', name: 'Workshop, rear' }),
      makeLocation({ id: 'c', name: 'Cabinet A', parentId: 'w' }),
    ]);
    expect(extension).toBe('csv');
    expect(mimeType).toContain('text/csv');
    const text = content as string;
    expect(text.split('\r\n')).toHaveLength(3); // header + two rows
    expect(text).toContain('"Workshop, rear / Cabinet A"');
  });

  it('names the file like every other list export', () => {
    expect(locationsExportFilename('csv', new Date('2026-07-31T12:00:00Z'))).toBe(
      'gubbins-locations-2026-07-31.csv',
    );
  });
});
