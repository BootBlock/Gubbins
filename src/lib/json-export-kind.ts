/**
 * The marker stamped into the export wizard's JSON data extract (issue #153).
 *
 * Its own leaf module because both sides of a boundary need it and neither may pull in the
 * other: the producer is the pure export builder (`features/export/export-data.ts`), and the
 * consumer is `parseBackupJson` (`features/sync/backup.ts`), which the bridge loads under
 * Node's strip-only loader and so must stay clear of the export feature's dependencies.
 */
export const JSON_EXPORT_KIND = 'gubbins-data-export';
