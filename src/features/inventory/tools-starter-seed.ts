/**
 * "Tools" starter template (backlog T4) — a pure, DB-free seed descriptor plus a small
 * orchestrator that materialises it through the ordinary create-category / add-field
 * mutation path (no bespoke repository method).
 *
 * The point is convenience & discoverability: a user setting up tool tracking gets a
 * category pre-wired with the T1/T2 facet **defaults** (serialised tracking, a sensible
 * starting condition, a calibration-friendly warranty window) and a couple of tool-ish
 * custom fields, instead of hand-assembling all of that. The defaults are still just
 * *starting points* the user overrides per item — exactly what the category-template
 * feature (T1–T3) already provides.
 *
 * The seed data is deliberately synthetic and generic (public-repo hygiene): no real
 * names, URLs, or product-specific values.
 */
import type { CreateCategoryFieldInput, CreateCategoryInput } from '@/db/repositories';

/** A category-template starter: the category (with its facet defaults) + its custom fields. */
export interface CategoryStarterSeed {
  /** The category to create, carrying its T1/T2 facet defaults. */
  readonly category: CreateCategoryInput;
  /** The custom fields to attach, in declared order. */
  readonly fields: readonly CreateCategoryFieldInput[];
}

/** The canonical name of the "Tools" starter category (used for the idempotency guard). */
export const TOOLS_STARTER_CATEGORY_NAME = 'Tools';

/**
 * The "Tools" starter descriptor. A tool is the canonical serialised, loanable asset:
 * tracked one-by-one (`SERIALISED`), starting in good order (`GOOD`), with a 12-month
 * warranty/calibration window. Its two custom fields cover the two things a tool
 * record most often needs beyond the built-in facets — a serial number and a link to
 * its calibration certificate.
 */
export const TOOLS_STARTER_SEED: CategoryStarterSeed = {
  category: {
    name: TOOLS_STARTER_CATEGORY_NAME,
    defaultTrackingMode: 'SERIALISED',
    defaultCondition: 'GOOD',
    defaultWarrantyMonths: 12,
  },
  fields: [
    { name: 'Serial number', fieldType: 'TEXT', position: 0 },
    { name: 'Calibration certificate', fieldType: 'URL', position: 1 },
  ],
};

/**
 * True when a category matching the starter's name (case-insensitive, trimmed) already
 * exists — the idempotency guard that keeps a second tap from creating a duplicate
 * "Tools" category (and lets the affordance hide itself once one exists).
 */
export function hasCategoryNamed(names: readonly string[], name: string): boolean {
  const target = name.trim().toLowerCase();
  return names.some((n) => n.trim().toLowerCase() === target);
}

/** Mutation-path operations `applyCategoryStarterSeed` drives (kept abstract so it stays DB-free/testable). */
export interface CategoryStarterSeedOps {
  /** Create a category, resolving to at least its new id (the ordinary create path). */
  readonly createCategory: (input: CreateCategoryInput) => Promise<{ readonly id: string }>;
  /** Attach one custom field to the given category (the ordinary add-field path). */
  readonly addField: (categoryId: string, input: CreateCategoryFieldInput) => Promise<unknown>;
}

/**
 * Materialise a starter seed through the supplied create/add-field operations, in
 * declared order, and resolve to the new category's id. Pure orchestration: it makes
 * no assumption about *where* the ops come from (React-Query mutations in the app, the
 * real repository in a test), so it needs no DB of its own.
 */
export async function applyCategoryStarterSeed(
  seed: CategoryStarterSeed,
  ops: CategoryStarterSeedOps,
): Promise<string> {
  const category = await ops.createCategory(seed.category);
  for (const field of seed.fields) {
    await ops.addField(category.id, field);
  }
  return category.id;
}
