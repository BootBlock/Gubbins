/**
 * The ordered migration registry (spec §2.3).
 *
 * The Phase 69 migration-baseline consolidation collapsed the historical v1…v24 chain
 * into a single `v1-initial` migration that builds the entire baseline schema in one step
 * (Gubbins is pre-release, so no incremental upgrade path from an *older* on-disk version
 * is needed). Three forward steps (v2 `asset_bookings`, v3 `supplier_part_price_history`,
 * v4 location-metadata) accumulated on top of that baseline and have since been
 * re-squashed into it by the Add-item enrichment work, which needed two non-additive
 * schema changes (the widened `tracking_mode` CHECK and the `notes` column in the FTS
 * index) that a forward `ALTER TABLE` cannot express. Future forward migrations are
 * appended here in ascending version order; the target schema version Gubbins expects is
 * simply the highest registered version. A pre-squash database (user_version 2–4) is
 * refused at boot with `SCHEMA_TOO_NEW`, whose rescue screen offers the local-data reset.
 */
import type { Migration } from './migration';
import { v1Initial } from './v1-initial';

export const migrations: readonly Migration[] = [v1Initial];

/** The schema version the current build expects after boot migrations complete. */
export const TARGET_SCHEMA_VERSION = migrations.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

export { runMigrations, getUserVersion } from './engine';
export { SQL_NOW_MS } from './migration';
export type { Migration, MigrationReport } from './migration';
