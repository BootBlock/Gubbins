/**
 * Domain row + DTO types for the inventory model — re-export barrel.
 *
 * `*Row` types mirror the raw SQLite columns exactly (booleans arrive as 0/1
 * integers, `operational_metadata` as a JSON string). The repository layer maps
 * these into the friendlier camelCase domain objects (`Location`, `Item`,
 * `ItemHistoryEntry`) that the rest of the app consumes, computing the derived
 * gauge values that spec §4.1.1 forbids storing in the database.
 *
 * The definitions are grouped by domain under `./types/`; this barrel re-exports
 * them so every consumer can keep importing from `./types` (or the repositories
 * barrel) unchanged.
 */
export type * from './types/pagination';
export type * from './types/locations';
export type * from './types/items';
export type * from './types/reconciliation';
export type * from './types/stock';
export type * from './types/history';
export type * from './types/categories';
export type * from './types/tags';
export type * from './types/images';
export type * from './types/attachments';
export type * from './types/aliases';
export type * from './types/supplier-parts';
export type * from './types/purchase-orders';
export type * from './types/capabilities';
export type * from './types/projects';
export type * from './types/contacts';
export type * from './types/maintenance';
