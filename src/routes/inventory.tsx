import { createFileRoute } from '@tanstack/react-router';
import { InventoryScreen } from '@/features/inventory/InventoryScreen';
import { parseInventorySearch } from '@/features/inventory/view-params';

/**
 * The Inventory workspace. Its whole view state — location scope, quick search, attention chips,
 * category/tag facets, "Show removed" and the current page — lives in the URL (issue #574), so
 * the list survives a navigation or a reload and a filtered view can be shared. The schema and
 * both conversions are in `view-params.ts`.
 */
export const Route = createFileRoute('/inventory')({
  validateSearch: parseInventorySearch,
  component: InventoryScreen,
});
