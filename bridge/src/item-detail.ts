/**
 * Shared item-detail loader: an {@link Item} plus its relations, projected into the public
 * {@link ItemDetailDto}. Single-sourced so both the versioned HTTP API (`api/v1.ts`
 * `GET /api/v1/items/{id}`) and the MCP `gubbins_get_item` tool return the *same* shape from
 * the *same* read path — never a fork. Strictly read-only: it only ever reads through the
 * app's repositories.
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { CategoryRepository } from '@/db/repositories/CategoryRepository.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { toCapability, toItemSummary, type ItemDetailDto } from './api/dto.ts';

/**
 * Load one item by id with its per-location `placements` and `capabilities`, mapped to the
 * stable {@link ItemDetailDto}. Returns `null` when no item has that id (the caller decides
 * how to surface "not found" for its transport).
 */
export async function loadItemDetail(
  driver: IDatabaseDriver,
  id: string,
): Promise<ItemDetailDto | null> {
  const items = new ItemRepository(driver);
  const item = await items.getById(id);
  if (item === undefined) return null;

  const locations = new LocationRepository(driver);
  const categories = new CategoryRepository(driver);
  const [location, placements, capabilities] = await Promise.all([
    locations.getById(item.locationId),
    items.listStock(item.id),
    items.listCapabilities(item.id),
  ]);
  const category = item.categoryId ? await categories.getById(item.categoryId) : undefined;

  return {
    ...toItemSummary(item, location?.name ?? null),
    description: item.description,
    categoryName: category?.name ?? null,
    unitCost: item.unitCost,
    condition: item.condition,
    serialNo: item.serialNo,
    parentId: item.parentId,
    expiryDate: item.expiryDate,
    batchNumber: item.batchNumber,
    lotNumber: item.lotNumber,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    placements: placements.map((p) => ({
      locationId: p.locationId,
      locationName: p.locationName,
      quantity: p.quantity,
    })),
    capabilities: capabilities.map(toCapability),
  };
}
