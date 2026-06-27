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
import { AttachmentRepository } from './AttachmentRepository';
import { CategoryRepository } from './CategoryRepository';
import { CheckoutRepository } from './CheckoutRepository';
import { ContactRepository } from './ContactRepository';
import { ImageRepository } from './ImageRepository';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { ProjectRepository } from './ProjectRepository';
import { TagRepository } from './TagRepository';
import type { RepositoryOptions } from './base';

export { ItemRepository } from './ItemRepository';
export { LocationRepository } from './LocationRepository';
export { CategoryRepository } from './CategoryRepository';
export { TagRepository } from './TagRepository';
export { ImageRepository } from './ImageRepository';
export { AttachmentRepository } from './AttachmentRepository';
export { ProjectRepository } from './ProjectRepository';
export { ContactRepository } from './ContactRepository';
export { CheckoutRepository } from './CheckoutRepository';
export type { ItemListFilters, SearchByAstParams } from './ItemRepository';
export type { UpdateAttachmentInput } from './AttachmentRepository';
export type { AssemblyResult } from './ProjectRepository';
export type { RepositoryOptions } from './base';
export * from './constants';
export * from './types';

let itemRepository: ItemRepository | null = null;
let locationRepository: LocationRepository | null = null;
let categoryRepository: CategoryRepository | null = null;
let tagRepository: TagRepository | null = null;
let imageRepository: ImageRepository | null = null;
let attachmentRepository: AttachmentRepository | null = null;
let projectRepository: ProjectRepository | null = null;
let contactRepository: ContactRepository | null = null;
let checkoutRepository: CheckoutRepository | null = null;

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

export function getAttachmentRepository(): AttachmentRepository {
  attachmentRepository ??= new AttachmentRepository(getDatabaseDriver(), productionOptions);
  return attachmentRepository;
}

export function getProjectRepository(): ProjectRepository {
  projectRepository ??= new ProjectRepository(getDatabaseDriver(), productionOptions);
  return projectRepository;
}

export function getContactRepository(): ContactRepository {
  contactRepository ??= new ContactRepository(getDatabaseDriver(), productionOptions);
  return contactRepository;
}

export function getCheckoutRepository(): CheckoutRepository {
  checkoutRepository ??= new CheckoutRepository(getDatabaseDriver(), productionOptions);
  return checkoutRepository;
}
