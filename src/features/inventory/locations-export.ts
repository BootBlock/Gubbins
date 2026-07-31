/**
 * Location list export (issue #617, `N7`).
 *
 * Locations were the one substantial list in the app with no export at all: the shared tabular
 * seam covered a dozen lists from Contacts to the insurance schedule and had no location list, so
 * nothing anywhere carried a location's description, kind, capacity, dimensions or walk order out
 * of the app. A note you can write and never get back out is a note you stop writing — the same
 * argument `N1`/`N2` made for showing and finding one.
 *
 * Pure: it maps the repository DTOs onto the shared tabular column model and hands them to the
 * generic serialisers in `@/features/export/tabular-export`. Kept free of React and repositories;
 * the sidebar reads every page and passes the rows in.
 *
 * The hierarchy is the one thing a flat table can't show, so each row carries both its immediate
 * parent and its full path — the file is read outside the app, where "Drawer 3" on its own names
 * nothing.
 */
import type { LocationWithCount } from '@/db/repositories';
import {
  buildTabularExport,
  type TabularColumn,
  type TabularExportFormat,
  type TabularExportResult,
} from '@/features/export/tabular-export';
import { isoTimestamp, listExportFilename } from '@/features/export/export-every-page';
import { locationKindLabel } from './location-kind';
import { locationPath } from './labels/location-label';

/** The separator between path levels, matching the one the printed location label uses. */
const PATH_SEPARATOR = ' / ';

/**
 * One exported row: the location, plus the ancestry a flat table would otherwise lose.
 *
 * The Markdown vault's folder notes take the same shape (`VaultLocation` in
 * `@/features/export/export-data`), so the export orchestrator resolves ancestry once through
 * {@link toLocationExportRows} and feeds both surfaces from it.
 */
export interface LocationExportRow {
  readonly location: LocationWithCount;
  /** The immediate parent's name, or `null` for a top-level location. */
  readonly parentName: string | null;
  /** The full path **including** this location, e.g. `Workshop / Cabinet A / Drawer 3`. */
  readonly path: string;
}

/**
 * Resolve each location's parent name and full path from the complete set.
 *
 * Takes the whole list rather than one row because ancestry cannot be derived from a location
 * alone — `parentId` is an id, and the path is the chain above it. Anything the set doesn't
 * contain (a parent past a truncated read) simply drops out of the path rather than failing the
 * export; `locationPath` is itself cycle-safe.
 *
 * @internal Exported for unit tests only.
 */
export function toLocationExportRows(locations: readonly LocationWithCount[]): readonly LocationExportRow[] {
  const byId = new Map(locations.map((l) => [l.id, l]));
  return locations.map((location) => {
    const ancestors = locationPath(location.id, locations, PATH_SEPARATOR);
    return {
      location,
      parentName: location.parentId ? (byId.get(location.parentId)?.name ?? null) : null,
      path: ancestors ? `${ancestors}${PATH_SEPARATOR}${location.name}` : location.name,
    };
  });
}

/**
 * The location-list export columns.
 *
 * Measurements are written in the **canonical stored units** — millimetres and cubic millimetres —
 * rather than the reader's `dimensionUnit` preference, exactly as the items file writes weights in
 * grams: the file outlives the session that produced it and may be opened by a spreadsheet or in
 * another install, where a silently-converted figure with no unit is worse than a plain one whose
 * header names its unit.
 *
 * `Default` is spelled Yes/No (the loans export's convention for a flag a person reads), while
 * `Archived` and `Last counted` carry their ISO timestamps — blank means "not archived" / "never
 * counted", which says both things in one cell.
 *
 * The opaque `ID` is last, after everything readable: it is what an item's `locationId` refers to,
 * so it is worth carrying, but it is never the column someone opens the file to read.
 *
 * @internal Exported for unit tests only.
 */
export function locationsExportColumns(): readonly TabularColumn<LocationExportRow>[] {
  return [
    { header: 'Name', value: (r) => r.location.name },
    { header: 'Parent', value: (r) => r.parentName },
    { header: 'Path', value: (r) => r.path },
    // The stored key is a semantic token ('drawer'); the label is what the app shows. An unknown
    // key — one a newer peer synced — resolves to nothing rather than leaking the raw token.
    { header: 'Kind', value: (r) => locationKindLabel(r.location.kind) ?? null },
    { header: 'Description', value: (r) => r.location.description },
    { header: 'Items', value: (r) => r.location.itemCount },
    { header: 'Capacity', value: (r) => r.location.capacity },
    { header: 'Width (mm)', value: (r) => r.location.width },
    { header: 'Height (mm)', value: (r) => r.location.height },
    { header: 'Depth (mm)', value: (r) => r.location.depth },
    { header: 'Usable volume (mm³)', value: (r) => r.location.usableVolume },
    { header: 'Packing factor', value: (r) => r.location.packingFactor },
    { header: 'Walk order', value: (r) => r.location.walkOrder },
    { header: 'Default', value: (r) => (r.location.isDefault ? 'Yes' : 'No') },
    { header: 'Archived', value: (r) => isoTimestamp(r.location.archivedAt) },
    { header: 'Last counted', value: (r) => isoTimestamp(r.location.lastCountedAt) },
    { header: 'Dead stock', value: (r) => r.location.deadStockMode },
    { header: 'Dead-stock days', value: (r) => r.location.deadStockDays },
    { header: 'Colour', value: (r) => r.location.color },
    { header: 'ID', value: (r) => r.location.id },
  ];
}

/** Serialise the location list to the chosen format via the shared exporter. */
export function buildLocationsExport(
  format: TabularExportFormat,
  locations: readonly LocationWithCount[],
): Promise<TabularExportResult> {
  const rows = toLocationExportRows(locations);
  return buildTabularExport(format, locationsExportColumns(), rows, {
    title: 'Locations',
    caption: `${rows.length} location${rows.length === 1 ? '' : 's'}`,
  });
}

/** Download file name for the location list, e.g. `gubbins-locations-2026-07-31.csv`. */
export function locationsExportFilename(extension: string, date = new Date()): string {
  return listExportFilename('locations', extension, date);
}
