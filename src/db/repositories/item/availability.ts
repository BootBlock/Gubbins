/**
 * Stock availability concern (issue #653) — how much of an item is free, and who holds the rest.
 *
 * A thin mixin over the shared `../reservations` reader, so the item dialog can ask "what is
 * reserved of this item?" through the same repository it asks everything else through. The
 * definition of a live claim, and the backing arithmetic, live there and in the pure
 * `features/projects/reservations.ts` seam.
 */
import type { ItemAvailability } from '@/features/projects/reservations';
import { readAvailability } from '../reservations';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

export function withAvailability<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemAvailabilityRepository extends Base {
    /**
     * How much of each item is spoken for, and by which projects, in one round-trip. Every
     * requested id that names a real item gets an entry, claimed or not; an id matching no
     * item is absent.
     */
    async getAvailability(itemIds: readonly string[]): Promise<Map<string, ItemAvailability>> {
      return readAvailability(this.driver, itemIds);
    }

    /**
     * One item's availability, or `undefined` when the id matches no item — never an
     * unclaimed zero, which would read as "in stock, nothing reserved".
     */
    async getItemAvailability(itemId: string): Promise<ItemAvailability | undefined> {
      return (await readAvailability(this.driver, [itemId])).get(itemId);
    }
  };
}
