/**
 * Repository layer barrel + production wiring (spec §2.1.1, §8.5.1).
 *
 * Repositories are injected with the shared worker driver and the storage
 * Hard-Stop write-gate. Tests construct repositories directly against the
 * in-memory driver instead (§8.5.2), so this module is the *only* place the
 * production worker and the Zustand storage store meet the repository layer.
 */
import { getDatabaseDriver } from '../client';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { isWriteSuspended } from '@/features/storage/tiers';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { AssetBookingRepository } from './AssetBookingRepository';
import { AttachmentRepository } from './AttachmentRepository';
import { CategoryRepository } from './CategoryRepository';
import { CheckoutRepository } from './CheckoutRepository';
import { ContactRepository } from './ContactRepository';
import { DiagnosticsRepository } from './DiagnosticsRepository';
import { ImageRepository } from './ImageRepository';
import { ItemRepository } from './ItemRepository';
import { LocationPhotoRepository } from './LocationPhotoRepository';
import { LocationRepository } from './LocationRepository';
import { MaintenanceRepository } from './MaintenanceRepository';
import { ProjectRepository } from './ProjectRepository';
import { PurchaseOrderRepository } from './PurchaseOrderRepository';
import { ReportRepository } from './ReportRepository';
import { ApiTokenRepository } from './ApiTokenRepository';
import { RoleRepository } from './RoleRepository';
import { StorageRepository } from './StorageRepository';
import { SuggestionRepository } from './SuggestionRepository';
import { SupplierPartRepository } from './SupplierPartRepository';
import { SupplierRepository } from './SupplierRepository';
import { TagRepository } from './TagRepository';
import { TarePresetRepository } from './TarePresetRepository';
import { UserRepository } from './UserRepository';
import { WebhookRepository } from './WebhookRepository';
import { WishlistRepository } from './WishlistRepository';
import type { RepositoryOptions } from './base';

export { ItemRepository } from './ItemRepository';
export { LocationRepository } from './LocationRepository';
export { LocationPhotoRepository } from './LocationPhotoRepository';
export { MaintenanceRepository } from './MaintenanceRepository';
export { CategoryRepository, INHERIT_VALUE } from './CategoryRepository';
export { TagRepository, TagNameInUseError } from './TagRepository';
export { ImageRepository } from './ImageRepository';
export { AttachmentRepository } from './AttachmentRepository';
export { ProjectRepository } from './ProjectRepository';
export { PurchaseOrderRepository } from './PurchaseOrderRepository';
export { ReportRepository } from './ReportRepository';
export { StorageRepository } from './StorageRepository';
export { ContactRepository } from './ContactRepository';
export { UserRepository } from './UserRepository';
export { RoleRepository } from './RoleRepository';
export { ApiTokenRepository } from './ApiTokenRepository';
export {
  DiagnosticsRepository,
  type DiagnosticsSnapshot,
  type DiagnosticCounts,
} from './DiagnosticsRepository';
export { CheckoutRepository, type CheckInOptions } from './CheckoutRepository';
export { AssetBookingRepository } from './AssetBookingRepository';
export { SuggestionRepository, type SuggestionField } from './SuggestionRepository';
export { SupplierPartRepository } from './SupplierPartRepository';
export { SupplierRepository } from './SupplierRepository';
export { WishlistRepository } from './WishlistRepository';
export { TarePresetRepository } from './TarePresetRepository';
export { WebhookRepository } from './WebhookRepository';
export {
  TombstoneRepository,
  tombstoneStatement,
  SYNC_TABLES,
  ITEM_TAGS_TABLE,
  LOCATION_TAGS_TABLE,
  ITEM_REGIONS_TABLE,
  ITEM_HISTORY_TABLE,
  STOCK_DELTAS_TABLE,
  TOMBSTONE_TABLES,
  isTombstoneTable,
  SYNC_EXCLUDED_COLUMNS,
  itemTagEdgeId,
  parseItemTagEdgeId,
  itemTagTombstoneStatement,
  clearItemTagTombstoneStatement,
  locationTagEdgeId,
  parseLocationTagEdgeId,
  itemRegionEdgeId,
  parseItemRegionEdgeId,
  itemRegionTombstoneStatement,
  clearItemRegionTombstoneStatement,
  locationTagTombstoneStatement,
  clearLocationTagTombstoneStatement,
} from './tombstone';
export type { Tombstone, SyncTable } from './tombstone';
export type {
  ItemListFilters,
  ItemSort,
  ItemSortField,
  ItemStatusFilter,
  SearchByAstParams,
  LocationStockLine,
  ItemBatchPlacement,
  LocationBatchLine,
  KitComponent,
  ItemStatusCount,
} from './ItemRepository';
export {
  ITEM_SORT_FIELDS,
  ITEM_STATUS_FILTERS,
  STATUS_FILTER_FEATURE,
  STOCK_DEPENDENT_STATUSES,
  isItemStatusFilter,
  isStockDependentStatus,
} from './ItemRepository';
export type { UpdateAttachmentInput } from './AttachmentRepository';
export type { AssemblyResult } from './ProjectRepository';
export type { RepositoryOptions } from './base';
export * from './constants';
export * from './types';

let itemRepository: ItemRepository | null = null;
let locationRepository: LocationRepository | null = null;
let maintenanceRepository: MaintenanceRepository | null = null;
let categoryRepository: CategoryRepository | null = null;
let tagRepository: TagRepository | null = null;
let imageRepository: ImageRepository | null = null;
let locationPhotoRepository: LocationPhotoRepository | null = null;
let attachmentRepository: AttachmentRepository | null = null;
let projectRepository: ProjectRepository | null = null;
let purchaseOrderRepository: PurchaseOrderRepository | null = null;
let reportRepository: ReportRepository | null = null;
let storageRepository: StorageRepository | null = null;
let contactRepository: ContactRepository | null = null;
let diagnosticsRepository: DiagnosticsRepository | null = null;
let checkoutRepository: CheckoutRepository | null = null;
let assetBookingRepository: AssetBookingRepository | null = null;
let supplierPartRepository: SupplierPartRepository | null = null;
let supplierRepository: SupplierRepository | null = null;
let suggestionRepository: SuggestionRepository | null = null;
let wishlistRepository: WishlistRepository | null = null;
let tarePresetRepository: TarePresetRepository | null = null;
let webhookRepository: WebhookRepository | null = null;
let userRepository: UserRepository | null = null;
let roleRepository: RoleRepository | null = null;
let apiTokenRepository: ApiTokenRepository | null = null;

/**
 * Production repository options: the §7.6.1 write-gate, plus the actor every write is
 * attributed to (issue #79, plan §2.4).
 *
 * Both the actor and the authority now come from the **session store** (issue #79, phase 3),
 * which is the single arrow phases 1 and 2 were built to leave swappable — no repository
 * signature and no call site changed to make this happen.
 *
 * The store's defaults are `Admin` and unrestricted, and `authority-refresh.ts` returns them
 * unchanged while the users module is off. So with the module off — the state Gubbins ships in
 * — this resolves exactly as it did before sessions existed: every action attributed to Admin,
 * every guard inert.
 *
 * Read per call, never captured: signing in or out must take effect immediately, without
 * rebuilding the repository graph or reloading the page.
 */
const productionOptions: RepositoryOptions = {
  isWriteSuspended: () => isWriteSuspended(useStorageStore.getState().tier),
  resolveActor: () => useSessionStore.getState().actorId,
  resolveBaseCurrency: () => usePreferencesStore.getState().baseCurrency,
  resolveAuthority: () => useSessionStore.getState().authority,
};

export function getUserRepository(): UserRepository {
  userRepository ??= new UserRepository(getDatabaseDriver(), productionOptions);
  return userRepository;
}

export function getRoleRepository(): RoleRepository {
  roleRepository ??= new RoleRepository(getDatabaseDriver(), productionOptions);
  return roleRepository;
}

export function getApiTokenRepository(): ApiTokenRepository {
  apiTokenRepository ??= new ApiTokenRepository(getDatabaseDriver(), productionOptions);
  return apiTokenRepository;
}

export function getItemRepository(): ItemRepository {
  itemRepository ??= new ItemRepository(getDatabaseDriver(), productionOptions);
  return itemRepository;
}

export function getLocationRepository(): LocationRepository {
  locationRepository ??= new LocationRepository(getDatabaseDriver(), productionOptions);
  return locationRepository;
}

export function getMaintenanceRepository(): MaintenanceRepository {
  maintenanceRepository ??= new MaintenanceRepository(getDatabaseDriver(), productionOptions);
  return maintenanceRepository;
}

export function getCategoryRepository(): CategoryRepository {
  categoryRepository ??= new CategoryRepository(getDatabaseDriver(), productionOptions);
  return categoryRepository;
}

export function getTagRepository(): TagRepository {
  tagRepository ??= new TagRepository(getDatabaseDriver(), productionOptions);
  return tagRepository;
}

export function getImageRepository(): ImageRepository {
  imageRepository ??= new ImageRepository(getDatabaseDriver(), productionOptions);
  return imageRepository;
}

export function getLocationPhotoRepository(): LocationPhotoRepository {
  locationPhotoRepository ??= new LocationPhotoRepository(getDatabaseDriver(), productionOptions);
  return locationPhotoRepository;
}

export function getAttachmentRepository(): AttachmentRepository {
  attachmentRepository ??= new AttachmentRepository(getDatabaseDriver(), productionOptions);
  return attachmentRepository;
}

export function getProjectRepository(): ProjectRepository {
  projectRepository ??= new ProjectRepository(getDatabaseDriver(), productionOptions);
  return projectRepository;
}

export function getPurchaseOrderRepository(): PurchaseOrderRepository {
  purchaseOrderRepository ??= new PurchaseOrderRepository(getDatabaseDriver(), productionOptions);
  return purchaseOrderRepository;
}

export function getReportRepository(): ReportRepository {
  reportRepository ??= new ReportRepository(getDatabaseDriver(), productionOptions);
  return reportRepository;
}

export function getStorageRepository(): StorageRepository {
  storageRepository ??= new StorageRepository(getDatabaseDriver(), productionOptions);
  return storageRepository;
}

export function getContactRepository(): ContactRepository {
  contactRepository ??= new ContactRepository(getDatabaseDriver(), productionOptions);
  return contactRepository;
}

export function getCheckoutRepository(): CheckoutRepository {
  checkoutRepository ??= new CheckoutRepository(getDatabaseDriver(), productionOptions);
  return checkoutRepository;
}

export function getDiagnosticsRepository(): DiagnosticsRepository {
  diagnosticsRepository ??= new DiagnosticsRepository(getDatabaseDriver(), productionOptions);
  return diagnosticsRepository;
}

export function getAssetBookingRepository(): AssetBookingRepository {
  assetBookingRepository ??= new AssetBookingRepository(getDatabaseDriver(), productionOptions);
  return assetBookingRepository;
}

export function getSupplierPartRepository(): SupplierPartRepository {
  supplierPartRepository ??= new SupplierPartRepository(getDatabaseDriver(), productionOptions);
  return supplierPartRepository;
}

export function getSupplierRepository(): SupplierRepository {
  supplierRepository ??= new SupplierRepository(getDatabaseDriver(), productionOptions);
  return supplierRepository;
}

export function getSuggestionRepository(): SuggestionRepository {
  suggestionRepository ??= new SuggestionRepository(getDatabaseDriver(), productionOptions);
  return suggestionRepository;
}

export function getWishlistRepository(): WishlistRepository {
  wishlistRepository ??= new WishlistRepository(getDatabaseDriver(), productionOptions);
  return wishlistRepository;
}

export function getTarePresetRepository(): TarePresetRepository {
  tarePresetRepository ??= new TarePresetRepository(getDatabaseDriver(), productionOptions);
  return tarePresetRepository;
}

export function getWebhookRepository(): WebhookRepository {
  webhookRepository ??= new WebhookRepository(getDatabaseDriver(), productionOptions);
  return webhookRepository;
}
