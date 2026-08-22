/**
 * Public surface of the Phase 9 lifecycle feature (spec §4, §4.3, §4.4):
 * perishables/condition, Parent/Child variants, tool maintenance schedules, and the
 * cycle-counting / reconciliation workflow. Pure scheduling/variance maths live in
 * the sibling modules and are unit-tested in isolation.
 *
 * This barrel exports hooks, stores and pure logic — deliberately **nothing from
 * `./components`** (the lightweight `CycleCountProvider` context is the one component
 * here, and it renders no UI of its own). The dialogs and editors (`AuditDayDialog`,
 * `CycleCountDialog`, `KitEditor`, `LifecycleEditor`, `MaintenanceEditor`) import back
 * from `@/components/foundry`, so re-exporting them here closed an import cycle that
 * dragged all of them into the eagerly-preloaded entry chunk as soon as anything on
 * the boot path (`AppNav` -> `useAlerts`) reached for a hook. Import a component
 * from its own module — `@/features/lifecycle/components/<Name>` — and keep this
 * barrel free of them.
 */
export { expiryStatus, daysUntilExpiry, type ExpiryStatus } from './expiry';
export { fieldDueStatus, clampFieldDueLeadDays, type FieldDueStatus } from './field-due';
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
export { useAuditSessionStore } from './useAuditSessionStore';
export { useCountDraftStore } from './useCountDraftStore';
export {
  useItemVariants,
  useCreateVariant,
  useSetParent,
  useItemKit,
  useAddKitComponent,
  useUpdateKitComponentQty,
  useRemoveKitComponent,
  useExpiringItems,
  useLowStockItems,
  useInTransitLines,
  useInTransitQty,
  useAuthoriseCount,
  useItemMaintenance,
  useDueMaintenance,
  useCreateMaintenance,
  useLogMaintenance,
  useAddMaintenanceUsage,
  useRemoveMaintenance,
} from './hooks';
