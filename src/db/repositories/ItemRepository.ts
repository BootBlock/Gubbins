/**
 * ItemRepository (spec §2.1.1, §4, §4.1).
 *
 * Encapsulates all SQL for items, including the inline Consumable-Gauge primitive.
 * Every mutation records an entry in the immutable Activity Log (`item_history`)
 * within the same atomic transaction, so the ledger can never drift from the item
 * state. Reads are strictly paginated (§2.1). Storage-growing writes are gated by
 * the Hard Stop; deletions are always permitted (they free space).
 *
 * The implementation is composed from one focused module per concern under `./item/`
 * (CRUD core, stock/batches, gauge, aliases/scrape, capabilities, AST search, variants,
 * dashboard feeds, cycle-count) plus pure helpers. They are layered onto the core via
 * mixins so the public surface — and `new ItemRepository(driver)` — is identical to the
 * original single class; only the source is now navigable per concern.
 */
import { ItemCoreRepository } from './item/core';
import { withStock } from './item/stock';
import { withGauge } from './item/gauge';
import { withAliases } from './item/aliases';
import { withCapabilities } from './item/capabilities';
import { withSearch } from './item/search';
import { withVariants } from './item/variants';
import { withKits } from './item/kits';
import { withDashboardFeeds } from './item/feeds';
import { withCycleCount } from './item/cycle-count';
import { withRevaluations } from './item/revaluations';
import { withRelations } from './item/relations';
import { withTestRecords } from './item/test-records';
import { withSectionPresence } from './item/section-presence';

export type { ItemListFilters, ItemSeek } from './item/core';
export type { ItemSort, ItemSortField } from './item/sql';
export { ITEM_SORT_FIELDS } from './item/sql';
export {
  ITEM_STATUS_FILTERS,
  STATUS_FILTER_FEATURE,
  STOCK_DEPENDENT_STATUSES,
  isItemStatusFilter,
  isStockDependentStatus,
  buildStatusFilter,
  type ItemStatusFilter,
} from './item/status-filter';
export type { SearchByAstParams } from './item/search';
export type { LocationStockLine, ItemBatchPlacement, LocationBatchLine } from './item/stock';
export type { KitComponent, AssembleOptions } from './item/kits';
export type { ItemStatusCount } from './item/feeds';
export { NO_SECTION_PRESENCE, type ItemSectionPresence } from './item/section-presence';

/**
 * The complete item repository: the CRUD core with every concern mixin layered on.
 * Each mixin only *adds* methods (none override another), so the composition order is
 * immaterial. The constructor `(driver, options)` is inherited from `BaseRepository`.
 */
export class ItemRepository extends withStock(
  withGauge(
    withAliases(
      withCapabilities(
        withSearch(
          withVariants(
            withKits(
              withDashboardFeeds(
                withCycleCount(
                  withRevaluations(withRelations(withTestRecords(withSectionPresence(ItemCoreRepository)))),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
) {}
