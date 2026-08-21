/**
 * The §4 no-overwrite scrape merge — the CRITICAL integrity safeguard.
 *
 * "Scraping must NEVER overwrite or remove a user-created field unless the user
 * explicitly opts into that specific overwrite." This module computes, purely, what
 * a {@link ScrapeResultPayload} *proposes* to change against an item's current
 * fields, classifying each mappable field as:
 *
 *  - `FILL`      — the current value is empty, so the scraped value is applied freely;
 *  - `CONFLICT`  — the current value is user-populated and differs, so the change is
 *                  withheld unless the user explicitly opts into overwriting it;
 *  - `UNCHANGED` — the values already match (nothing to do);
 *  - `FOREIGN`   — the scrape offers a unit cost quoted in another currency, which the item's
 *                  currency-less `unit_cost` column cannot record honestly (issue #666);
 *  - `SKIP`      — the scrape offers nothing for this field.
 *
 * It also derives the Universal Alias Mapping additions (§4): the supplier MPN is
 * recorded as an alias linking the supplier part number to the local item, so future
 * look-ups resolve even if the user later edits the canonical `mpn` field.
 *
 * Pure and framework-free so it is exhaustively unit-tested (§8.2); the repository
 * layer turns {@link applyScrapeMerge}'s output into the atomic write.
 */
import { isCurrencyMismatch, normaliseCurrencyCode } from '@/lib/money';
import { foldName } from '@/lib/name-fold';
import type { ScrapeResultPayload } from './protocol';

/** The item fields a scrape can populate. */
export type ScrapeField = 'mpn' | 'manufacturer' | 'description' | 'unitCost';

/** Disposition of one field in a proposed merge. */
export type FieldStatus = 'FILL' | 'CONFLICT' | 'UNCHANGED' | 'FOREIGN' | 'SKIP';

/** The current (pre-scrape) item fields the merge diffs against. */
export interface ExistingItemFields {
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  readonly description: string | null;
  readonly unitCost: number | null;
  /** Existing supplier aliases (any case), to de-duplicate alias additions. */
  readonly aliases: readonly string[];
}

/** One field's proposed change, surfaced to the user for review. */
export interface FieldProposal {
  readonly field: ScrapeField;
  readonly current: string | number | null;
  readonly scraped: string | number | null;
  readonly status: FieldStatus;
}

/** The full, reviewable plan a scrape produces against an item. */
export interface ScrapeMergePlan {
  readonly proposals: readonly FieldProposal[];
  /** Supplier MPNs to add as aliases (deduped, not already mapped to this item). */
  readonly aliasAdditions: readonly string[];
  /** The scraped price currency, for display alongside the unit-cost proposal. */
  readonly currency: string | null;
  /**
   * The base currency the plan was judged against, normalised — `null` when it is unknown, in
   * which case no unit cost is withheld. Carried so the caller can name both codes when it
   * explains a withheld `FOREIGN` price.
   */
  readonly baseCurrency: string | null;
}

/** The concrete writes a merge yields once overwrite opt-ins are resolved. */
export interface ScrapeWrite {
  readonly fields: {
    mpn?: string;
    manufacturer?: string;
    description?: string;
    unitCost?: number;
  };
  readonly aliasAdditions: readonly string[];
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

/** Normalise a scraped string field; an all-whitespace scrape offers nothing. */
function cleanString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function classifyString(current: string | null, scraped: string | null): FieldStatus {
  if (scraped === null) return 'SKIP';
  if (isBlank(current)) return 'FILL';
  if (current!.trim().toLowerCase() === scraped.toLowerCase()) return 'UNCHANGED';
  return 'CONFLICT';
}

function classifyNumber(current: number | null, scraped: number | null): FieldStatus {
  if (scraped === null) return 'SKIP';
  if (current === null) return 'FILL';
  if (current === scraped) return 'UNCHANGED';
  return 'CONFLICT';
}

/**
 * Build the reviewable merge plan for a scrape against an item's current fields.
 * Computes per-field dispositions and the alias additions, without deciding any
 * overwrite — that is the user's explicit choice, resolved by {@link applyScrapeMerge}.
 *
 * @param baseCurrency The user's base currency, which is what a bare `items.unit_cost` means.
 * A scraped price in any other currency is classified `FOREIGN` and withheld (issue #666);
 * an unknown (`null`) base withholds nothing, matching the fail-open rule the rest of the app
 * applies when it cannot tell one currency from another.
 */
export function buildScrapeMergePlan(
  existing: ExistingItemFields,
  payload: ScrapeResultPayload,
  baseCurrency: string | null | undefined = null,
): ScrapeMergePlan {
  const scrapedMpn = cleanString(payload.mpn);
  const scrapedMfr = cleanString(payload.manufacturer);
  const scrapedDesc = cleanString(payload.description);
  const scrapedCost = payload.scraped_pricing
    ? // A finite, non-negative number is already guaranteed by the protocol schema.
      payload.scraped_pricing.value
    : null;
  const scrapedCurrency = payload.scraped_pricing?.currency ?? null;
  // `items.unit_cost` is a bare number with no currency column of its own, so it can only ever
  // mean the base currency. A price quoted in another currency therefore cannot be recorded
  // there without silently restating it as base-currency money, and Gubbins holds no exchange
  // rates to convert with — so the proposal is withheld and explained rather than applied
  // (issue #666). A caller that also files the payload as a supplier part keeps the price there,
  // under its own currency column; a caller that does not must tell the user it was withheld.
  const foreignCost = isCurrencyMismatch(scrapedCurrency, null, baseCurrency);
  const costStatus = classifyNumber(existing.unitCost, scrapedCost);
  // Only an otherwise-actionable proposal is withheld. `UNCHANGED` and `SKIP` write nothing
  // either way, so flagging them would raise a warning about a change that was never offered.
  const unitCostStatus: FieldStatus =
    foreignCost && (costStatus === 'FILL' || costStatus === 'CONFLICT') ? 'FOREIGN' : costStatus;

  const proposals: FieldProposal[] = [
    {
      field: 'mpn',
      current: existing.mpn,
      scraped: scrapedMpn,
      status: classifyString(existing.mpn, scrapedMpn),
    },
    {
      field: 'manufacturer',
      current: existing.manufacturer,
      scraped: scrapedMfr,
      status: classifyString(existing.manufacturer, scrapedMfr),
    },
    {
      field: 'description',
      current: existing.description,
      scraped: scrapedDesc,
      status: classifyString(existing.description, scrapedDesc),
    },
    {
      field: 'unitCost',
      current: existing.unitCost,
      scraped: scrapedCost,
      status: unitCostStatus,
    },
  ];

  // §4 Universal Alias Mapping: map the supplier MPN to this local item. Skip blanks
  // and anything already aliased (case-insensitive). Case-insensitive means `lib/name-fold`'s
  // fold — the one the alias table's identity lives under: `toLowerCase()` leaves `ß` alone, so
  // it would propose adding `GRÖSSE` beside an existing `Größe`, which the writer then has to
  // refuse (issue #679). Deciding it the same way here keeps the plan honest about what will
  // actually be written.
  const haveAlias = new Set(existing.aliases.map(foldName));
  const aliasAdditions: string[] = [];
  if (scrapedMpn && !haveAlias.has(foldName(scrapedMpn))) aliasAdditions.push(scrapedMpn);

  return {
    proposals,
    aliasAdditions,
    currency: scrapedCurrency,
    baseCurrency: normaliseCurrencyCode(baseCurrency),
  };
}

/**
 * Resolve a merge plan into the concrete writes, honouring the §4 safeguard:
 *
 *  - `FILL` fields are always written (no user data is at risk);
 *  - `CONFLICT` fields are written **only** when the user has explicitly opted into
 *    overwriting that specific field (its name is in `overwriteFields`);
 *  - `UNCHANGED`, `FOREIGN` and `SKIP` fields are never written — a `FOREIGN` unit cost has no
 *    opt-in, because there is no rate to restate it in the base currency with.
 *
 * A field present in `overwriteFields` that is not actually a `CONFLICT` is ignored,
 * so an opt-in can never *introduce* an unintended change.
 */
export function applyScrapeMerge(
  plan: ScrapeMergePlan,
  overwriteFields: ReadonlySet<ScrapeField> = new Set(),
): ScrapeWrite {
  const fields: Mutable<ScrapeWrite['fields']> = {};

  for (const p of plan.proposals) {
    const include = p.status === 'FILL' || (p.status === 'CONFLICT' && overwriteFields.has(p.field));
    if (!include || p.scraped === null) continue;
    switch (p.field) {
      case 'mpn':
        fields.mpn = p.scraped as string;
        break;
      case 'manufacturer':
        fields.manufacturer = p.scraped as string;
        break;
      case 'description':
        fields.description = p.scraped as string;
        break;
      case 'unitCost':
        fields.unitCost = p.scraped as number;
        break;
    }
  }

  return { fields, aliasAdditions: plan.aliasAdditions };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
