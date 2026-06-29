/**
 * ProjectRepository (spec §2.1.1, §4 "Projects & BOMs", Phase 4).
 *
 * Owns projects, their BOM lines, reservations (Tentative vs Actual), the liminal
 * "In Transit" procurement lifecycle, BOM costing (Current Replacement Value vs
 * Point-in-Time Snapshot), the automated Shopping List, and the three terminal
 * assembly outcomes (Container / Singular Object / Permanent Consumption).
 *
 * All SQL lives over the injected driver (§2.1.1) — components never write SQL.
 * Multi-row writes go through `driver.transaction` for atomicity, and every change
 * that affects a *matched* inventory item also appends to the immutable Activity
 * Log (`item_history`) in the same transaction, so the ledger never drifts.
 *
 * The implementation is composed from one focused module per concern under `./project/`
 * (projects-CRUD core, BOM lines, reservations/procurement, costing/shopping-list,
 * assembly finalisation) plus reused pure helpers. They are layered onto the core via
 * mixins so the public surface — and `new ProjectRepository(driver)` — is identical to
 * the original single class; only the source is now navigable per concern.
 */
import { ProjectCoreRepository } from './project/core';
import { withBomLines } from './project/bom-lines';
import { withProcurement } from './project/procurement';
import { withCosting } from './project/costing';
import { withAssembly } from './project/assembly';

export type { AssemblyResult } from './project/assembly';

/**
 * The complete project repository: the projects-CRUD core with every concern mixin
 * layered on. Each mixin only *adds* methods (none override another), so the composition
 * order is immaterial. The constructor `(driver, options)` is inherited from
 * `BaseRepository`.
 */
export class ProjectRepository extends withBomLines(
  withProcurement(withCosting(withAssembly(ProjectCoreRepository))),
) {}
