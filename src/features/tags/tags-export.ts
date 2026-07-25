/**
 * Tags export (issue #132): serialise the tag dictionary to a downloadable file — a vocabulary
 * list to review, tidy or share, with the usage counts that show which tags are pulling weight
 * and which are one-offs worth merging away.
 *
 * Pure — it maps {@link TagWithCount} rows onto the shared tabular column model and hands them
 * to the generic serialisers in `@/features/export/tabular-export`. Kept free of React and
 * repositories; the screen reads every page and passes the rows in.
 */
import type { TagWithCount } from '@/db/repositories';
import {
  buildTabularExport,
  type TabularColumn,
  type TabularExportFormat,
  type TabularExportResult,
} from '@/features/export/tabular-export';
import { listExportFilename } from '@/features/export/export-every-page';

/**
 * The export columns — the tag's name and the two usage counts the dictionary row shows. Counts
 * stay raw numbers so the file sorts and totals in a spreadsheet.
 *
 * @internal Exported for unit tests only.
 */
export function tagsExportColumns(): readonly TabularColumn<TagWithCount>[] {
  return [
    { header: 'Tag', value: (tag) => tag.name },
    { header: 'Items', value: (tag) => tag.itemCount },
    { header: 'Locations', value: (tag) => tag.locationCount },
  ];
}

/** Serialise the tag dictionary to the chosen format via the shared exporter. */
export function buildTagsExport(
  format: TabularExportFormat,
  tags: readonly TagWithCount[],
): Promise<TabularExportResult> {
  return buildTabularExport(format, tagsExportColumns(), tags, {
    title: 'Tags',
    caption: `${tags.length} tag${tags.length === 1 ? '' : 's'}`,
  });
}

/** Download file name for the tag dictionary, e.g. `gubbins-tags-2026-07-25.csv`. */
export function tagsExportFilename(extension: string, date = new Date()): string {
  return listExportFilename('tags', extension, date);
}
