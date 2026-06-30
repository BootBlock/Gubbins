/**
 * The ordered migration registry (spec §2.3).
 *
 * The Phase 69 migration-baseline consolidation collapsed the historical v1…v24 chain
 * into a single `v1-initial` migration that builds the entire baseline schema in one step
 * (Gubbins is pre-release, so no incremental upgrade path from an *older* on-disk version
 * is needed). Forward migrations resume on top of that baseline and are appended here in
 * ascending version order; the target schema version Gubbins expects is simply the highest
 * registered version. `v2-asset-bookings` (Phase 78) was the first such forward step;
 * `v3-supplier-price-history` (Phase 81) is the second.
 */
import type { Migration } from './migration';
import { v1Initial } from './v1-initial';
import { v2AssetBookings } from './v2-asset-bookings';
import { v3SupplierPriceHistory } from './v3-supplier-price-history';

export const migrations: readonly Migration[] = [
  v1Initial,
  v2AssetBookings,
  v3SupplierPriceHistory,
];

/** The schema version the current build expects after boot migrations complete. */
export const TARGET_SCHEMA_VERSION = migrations.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

export { runMigrations, getUserVersion } from './engine';
export { SQL_NOW_MS } from './migration';
export type { Migration, MigrationReport } from './migration';
