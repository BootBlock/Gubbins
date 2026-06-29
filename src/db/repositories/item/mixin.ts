/**
 * Mixin plumbing for composing {@link ItemRepository} from focused concern modules.
 *
 * The repository was historically a single ~1500-line class spanning a dozen
 * concerns. It is now split into an {@link ItemCoreRepository} base (CRUD + the
 * shared `getById`/`require` internals) plus one mixin per concern (stock, gauge,
 * capabilities, …). Each mixin is `(Base) => class extends Base { … }`, so the final
 * composed class exposes the identical public surface and `new ItemRepository(driver)`
 * behaves exactly as before — only the source is now navigable per concern.
 */
import type { ItemCoreRepository } from './core';

// The documented TS mixin constraint: a constructor producing the core repository.
// `any[]` args are required so the mixin can forward BaseRepository's constructor —
// this is the one place the codebase uses `any`, per the standard mixin pattern.
export type Constructor<T = object> = new (...args: any[]) => T;

/** A mixin layers extra item-repository methods onto a core-repository base. */
export type ItemRepositoryMixin = Constructor<ItemCoreRepository>;
