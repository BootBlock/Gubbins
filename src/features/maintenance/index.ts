/** Database Maintenance feature barrel (Settings → Database maintenance). */
export { DatabaseMaintenance } from './DatabaseMaintenance';
export { DatabaseMaintenanceDialog } from './DatabaseMaintenanceDialog';
export { OrphanImageSweeper } from './OrphanImageSweeper';
export {
  isOrphanSweepDue,
  runAutoOrphanSweep,
  runAutoOrphanSweepInBrowser,
  ORPHAN_SWEEP_INTERVAL_MS,
  SWEEP_MIN_FILE_AGE_MS,
  type AutoSweepDeps,
} from './auto-orphan-sweep';
export {
  browserMaintenancePorts,
  checkDatabaseHealth,
  checkSearchIndex,
  compactDatabase,
  databaseBytes,
  findMissingImageFiles,
  gatherDatabaseStats,
  sweepOrphanImages,
  verifyStockTotals,
  type CompactResult,
  type DatabaseStats,
  type HealthResult,
  type MaintenancePorts,
  type MissingImagesResult,
  type OrphanSweepResult,
  type SearchIndexResult,
  type StockDrift,
  type StockTotalsResult,
  type TableRowCount,
} from './db-maintenance-actions';
