/**
 * Repository layer barrel + production wiring (spec §2.1.1, §8.5.1).
 *
 * Repositories are injected with the shared worker driver and the storage
 * Hard-Stop write-gate. Tests construct repositories directly against the
 * in-memory driver instead (§8.5.2), so this module is the *only* place the
 * production worker and the Zustand storage store meet the repository layer.
 */
import { getDatabaseDriver } from '../client';
import { isWriteSuspended } from '@/features/storage/tiers';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import type { RepositoryOptions } from './base';

export { ItemRepository } from './ItemRepository';
export { LocationRepository } from './LocationRepository';
export type { ItemListFilters } from './ItemRepository';
export type { RepositoryOptions } from './base';
export * from './constants';
export * from './types';

let itemRepository: ItemRepository | null = null;
let locationRepository: LocationRepository | null = null;

/** Production write-gate: refuse growth-writes while storage is locked (§7.6.1). */
const productionOptions: RepositoryOptions = {
  isWriteSuspended: () => isWriteSuspended(useStorageStore.getState().tier),
};

export function getItemRepository(): ItemRepository {
  itemRepository ??= new ItemRepository(getDatabaseDriver(), productionOptions);
  return itemRepository;
}

export function getLocationRepository(): LocationRepository {
  locationRepository ??= new LocationRepository(getDatabaseDriver(), productionOptions);
  return locationRepository;
}
