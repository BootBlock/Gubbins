/**
 * Query keys for the projects domain, in their own module (the shape `features/calendar/keys.ts`
 * and `features/reports/keys.ts` already use).
 *
 * Split out of `./projects` so a *non-project* write seam can sweep them without importing the
 * hooks module. The inventory invalidation seam needs exactly that: a stock write now moves what
 * a project's shopping list says, because a reservation only counts against what it buys to the
 * extent stock actually backs it (issue #653) — and importing the hooks module from there would
 * close a cycle, since the hooks import the inventory invalidation helpers.
 */
import type { ProjectFilter, ProjectListParams } from '@/db/repositories';

/**
 * How the Projects master list is narrowed and ordered (issue #137) — the filter plus the sort,
 * with the page supplied separately. Named rather than inlined because it is both a query-key
 * fragment and the screen's own state shape.
 */
export type ProjectBrowse = Omit<ProjectListParams, 'limit' | 'offset'>;

export const projectKeys = {
  all: ['projects'] as const,
  list: () => [...projectKeys.all, 'list'] as const,
  /**
   * One page of the project list, for one filter and ordering. Nested **under**
   * {@link projectKeys.list} so every existing `invalidateQueries({ queryKey: projectKeys.list() })`
   * still refreshes every page, filter and count without each write having to learn about
   * pagination — or about the master list's search box.
   */
  page: (offset: number, limit: number, browse: ProjectBrowse = {}) =>
    [...projectKeys.list(), { offset, limit, ...browse }] as const,
  count: (filter: ProjectFilter = {}) => [...projectKeys.list(), 'count', filter] as const,
  budgetAlerts: () => [...projectKeys.all, 'budget-alerts'] as const,
  detail: (id: string) => [...projectKeys.all, 'detail', id] as const,
  lines: (id: string) => [...projectKeys.detail(id), 'lines'] as const,
  costing: (id: string) => [...projectKeys.detail(id), 'costing'] as const,
  shoppingList: (id: string) => [...projectKeys.detail(id), 'shopping-list'] as const,
  pickList: (id: string) => [...projectKeys.detail(id), 'pick-list'] as const,
  assemblyParts: (id: string) => [...projectKeys.detail(id), 'assembly-parts'] as const,
  budget: (id: string) => [...projectKeys.detail(id), 'budget'] as const,
  expenses: (id: string) => [...projectKeys.detail(id), 'expenses'] as const,
  budgetCategories: (id: string) => [...projectKeys.detail(id), 'budget-categories'] as const,
} as const;
