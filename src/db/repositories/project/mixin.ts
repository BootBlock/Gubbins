/**
 * Mixin plumbing for composing {@link ProjectRepository} from focused concern modules.
 *
 * Mirrors the item-repository decomposition: the historically single ~700-line class
 * is split into a {@link ProjectCoreRepository} base (projects CRUD + the shared
 * `requireProject`/`requireLine` internals) plus one mixin per concern (BOM lines,
 * reservations/procurement, costing/shopping-list, assembly). Each mixin is
 * `(Base) => class extends Base { … }`, so the final composed class exposes the
 * identical public surface and `new ProjectRepository(driver)` behaves exactly as
 * before — only the source is now navigable per concern.
 */
import type { Constructor } from '../item/mixin';
import type { ProjectCoreRepository } from './core';

// Reuse the documented TS mixin constructor constraint from the item decomposition.
export type { Constructor };

/** A mixin layers extra project-repository methods onto a core-repository base. */
export type ProjectRepositoryMixin = Constructor<ProjectCoreRepository>;
