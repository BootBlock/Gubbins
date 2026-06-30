/**
 * The ordered migration registry (spec §2.3).
 *
 * Append new migrations here in ascending version order. The target schema
 * version Gubbins expects is simply the highest registered version.
 */
import type { Migration } from './migration';
import { v1Initial } from './v1-initial';
import { v2Domain } from './v2-domain';
import { v3Schema } from './v3-schema';
import { v4Projects } from './v4-projects';
import { v5CapabilitiesFts } from './v5-capabilities-fts';
import { v6ContactsCheckouts } from './v6-contacts-checkouts';
import { v7Sync } from './v7-sync';
import { v8Lifecycle } from './v8-lifecycle';
import { v9ImageDowngrade } from './v9-image-downgrade';
import { v10HistoryWatermark } from './v10-history-watermark';
import { v11MaintenanceUsageTelemetry } from './v11-maintenance-usage-telemetry';
import { v12BomReceivedQty } from './v12-bom-received-qty';
import { v13ItemStock } from './v13-item-stock';
import { v14CheckoutSourceLocation } from './v14-checkout-source-location';
import { v15StockBatches } from './v15-stock-batches';
import { v16CheckoutSourceBatch } from './v16-checkout-source-batch';
import { v17MaintenanceLocation } from './v17-maintenance-location';
import { v18AttachmentOriginDevice } from './v18-attachment-origin-device';
import { v19LocationDescriptionColor } from './v19-location-description-color';
import { v20ProjectBudgets } from './v20-project-budgets';
// v21 (item reorder points) is pre-allocated to a parallel inventory-depth phase; this
// worktree appends only its own v22. The gap is intentional — `runMigrations` walks the
// registry in ascending order, so a missing intermediate version is filled when v21 merges.
import { v22SupplierParts } from './v22-supplier-parts';

export const migrations: readonly Migration[] = [
  v1Initial,
  v2Domain,
  v3Schema,
  v4Projects,
  v5CapabilitiesFts,
  v6ContactsCheckouts,
  v7Sync,
  v8Lifecycle,
  v9ImageDowngrade,
  v10HistoryWatermark,
  v11MaintenanceUsageTelemetry,
  v12BomReceivedQty,
  v13ItemStock,
  v14CheckoutSourceLocation,
  v15StockBatches,
  v16CheckoutSourceBatch,
  v17MaintenanceLocation,
  v18AttachmentOriginDevice,
  v19LocationDescriptionColor,
  v20ProjectBudgets,
  v22SupplierParts,
];

/** The schema version the current build expects after boot migrations complete. */
export const TARGET_SCHEMA_VERSION = migrations.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

export { runMigrations, getUserVersion } from './engine';
export { SQL_NOW_MS } from './migration';
export type { Migration, MigrationReport } from './migration';
