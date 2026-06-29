/**
 * Public surface of the Phase 9 lifecycle feature (spec §4, §4.3, §4.4):
 * perishables/condition, Parent/Child variants, tool maintenance schedules, and the
 * cycle-counting / reconciliation workflow. Pure scheduling/variance maths live in
 * the sibling modules and are unit-tested in isolation.
 */
export { expiryStatus, daysUntilExpiry, type ExpiryStatus } from './expiry';
export { maintenanceStatus, maintenancePerformedNote, type MaintenanceScheduleState } from './maintenance';
export {
  variances,
  varianceCount,
  lineVariance,
  reconciliationNote,
  type CycleCountLine,
  type CycleCountVariance,
} from './cycle-count';
export { validateVariantLink, variantRejectionMessage, type VariantRejection } from './variants';
export { CycleCountProvider, useCycleCount } from './CycleCountContext';
export { LifecycleEditor } from './components/LifecycleEditor';
export { MaintenanceEditor } from './components/MaintenanceEditor';
export { CycleCountDialog } from './components/CycleCountDialog';
export {
  useItemVariants,
  useCreateVariant,
  useSetParent,
  useExpiringItems,
  useLowStockItems,
  useInTransitLines,
  useInTransitQty,
  useReconcile,
  useItemMaintenance,
  useDueMaintenance,
  useCreateMaintenance,
  useLogMaintenance,
  useAddMaintenanceUsage,
  useRemoveMaintenance,
} from './hooks';
