/**
 * The ordered migration registry (spec §2.3).
 *
 * Append new migrations here in ascending version order. The target schema
 * version Gubbins expects is simply the highest registered version.
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
