/**
 * The ordered migration registry (spec §2.3).
 *
 * Gubbins is pre-release with disposable developer-only data, so the entire schema lives in
 * a single `v1-initial` migration — every historical step (the original v1…v24 chain and the
 * later forward steps v2…v7) has been folded into that one baseline. There is no incremental
 * upgrade path from an older on-disk version. The target schema version Gubbins expects is
 * simply the highest registered version (1). Any future non-trivial schema change is likewise
 * folded into the baseline while pre-release; once released, forward migrations would instead
 * be appended here in ascending version order. A database left ahead of the highest registered
 * version is refused at boot with `SCHEMA_TOO_NEW`, whose rescue screen offers the local-data
 * reset.
 */
import type { Migration } from './migration';
import { v1Initial } from './v1-initial';

export const migrations: readonly Migration[] = [v1Initial];

/** The schema version the current build expects after boot migrations complete. */
export const TARGET_SCHEMA_VERSION = migrations.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

export { runMigrations, getUserVersion, assertBaselineCurrent } from './engine';
export { SQL_NOW_MS, BASELINE_REVISION, BASELINE_REVISION_KEY } from './migration';
export type { Migration, MigrationReport } from './migration';
