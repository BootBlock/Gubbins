/**
 * Persisting a scrape's per-supplier pricing as a supplier part (spec §4, §9; Phase 60).
 *
 * The §9 scraper fetches `scraped_pricing` (currency + unit cost) and a `distributor_url`
 * it previously had nowhere to fully store. This pure module turns a {@link ScrapeResultPayload}
 * into a proposed supplier-part write, **honouring the §4 no-overwrite safeguard** exactly as
 * the field-merge does: a scrape may freely *create* a supplier row or *fill an empty* field,
 * but it must never overwrite a user-populated supplier field unless the user explicitly opts in.
 *
 * Matching: a scrape is associated with an existing supplier part when their `distributor_url`
 * hosts match (the same distributor for the same item). With no match a brand-new row is
 * proposed; with a match the scrape only fills blanks (cost/order-code/url) and surfaces a
 * conflict where it would change a user value, leaving the decision to the caller.
 *
 * Pure and framework-free so it is exhaustively unit-tested; the mutation layer turns
 * {@link resolveSupplierPartWrite}'s output into the atomic create/update.
 */
import type { CreateSupplierPartInput, UpdateSupplierPartInput } from '@/db/repositories';
import { hostOf } from './parsers/types';
import type { ScrapeResultPayload } from './protocol';

/** The minimal existing supplier-part shape this planner diffs against. */
export interface ExistingSupplierPart {
  readonly id: string;
  readonly supplierName: string;
  readonly orderCode: string | null;
  readonly unitCost: number | null;
  readonly currency: string | null;
  readonly url: string | null;
}

/** A field the scrape can populate on a supplier part. */
export type SupplierPartField = 'orderCode' | 'unitCost' | 'currency' | 'url';

export type SupplierFieldStatus = 'FILL' | 'CONFLICT' | 'UNCHANGED' | 'SKIP';

/** One field's proposed change for review. */
export interface SupplierFieldProposal {
  readonly field: SupplierPartField;
  readonly current: string | number | null;
  readonly scraped: string | number | null;
  readonly status: SupplierFieldStatus;
}

/** The reviewable plan a scrape produces for an item's supplier parts. */
export interface SupplierPartPlan {
  /** The supplier name derived from the distributor host (e.g. `digikey.com`). */
  readonly supplierName: string;
  /** The id of the matched existing supplier part, or null to create a new row. */
  readonly matchedId: string | null;
  readonly proposals: readonly SupplierFieldProposal[];
}

function cleanString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function isBlank(value: string | null): boolean {
  return value === null || value.trim().length === 0;
}

function classifyString(current: string | null, scraped: string | null): SupplierFieldStatus {
  if (scraped === null) return 'SKIP';
  if (isBlank(current)) return 'FILL';
  if (current!.trim().toLowerCase() === scraped.toLowerCase()) return 'UNCHANGED';
  return 'CONFLICT';
}

function classifyNumber(current: number | null, scraped: number | null): SupplierFieldStatus {
  if (scraped === null) return 'SKIP';
  if (current === null) return 'FILL';
  if (current === scraped) return 'UNCHANGED';
  return 'CONFLICT';
}

/**
 * Second-level public-suffix labels that sit *under* a two-letter country-code TLD — the
 * `co` in `amazon.co.uk`, `com` in `amazon.com.au`, `co` in `amazon.co.jp`. These are
 * registry labels, not the site's own name, so when one appears just before a ccTLD the
 * real registrable label is one segment further left. Without this, `amazon.co.uk` would
 * yield the meaningless supplier name "Co". A curated set (rather than a full public-suffix
 * list) keeps the module dependency-free while covering the marketplaces we actually meet.
 */
const SECOND_LEVEL_TLD_LABELS: ReadonlySet<string> = new Set([
  'co',
  'com',
  'org',
  'net',
  'gov',
  'ac',
  'edu',
  'ltd',
  'plc',
  'me',
]);

/**
 * Derive a human supplier name from a distributor host: take the **registrable label** (the
 * site's own name, ignoring any regional subdomain and the public suffix), so
 * `www.digikey.com` → `Digikey`, `uk.rs-online.com` → `Rs-online`, and — crucially —
 * `www.amazon.co.uk` → `Amazon` rather than `Co`. Two-part country suffixes (`.co.uk`,
 * `.com.au`, `.co.jp`) are handled via {@link SECOND_LEVEL_TLD_LABELS}. Title-cases the
 * label. Falls back to a generic name when the host cannot be parsed.
 *
 * This deliberately stays a **name** rather than a supplier id (issue #384): a scrape knows a
 * hostname and nothing more, so the name is resolved onto an existing supplier — or used to
 * create one — at write time by `SupplierRepository.resolveOrCreate`.
 */
export function supplierNameFromUrl(url: string): string {
  const host = hostOf(url);
  if (host.length === 0) return 'Supplier';
  const labels = host.split('.').filter((l) => l.length > 0);
  if (labels.length === 0) return 'Supplier';
  // The registrable label normally sits just before the TLD. For a bare single label use it
  // directly. When the TLD is a two-letter ccTLD preceded by a second-level registry label
  // (`co.uk`, `com.au`, …), step one further left to reach the site's own name.
  let idx = labels.length >= 2 ? labels.length - 2 : 0;
  const tld = labels[labels.length - 1]!;
  if (tld.length === 2 && idx > 0 && SECOND_LEVEL_TLD_LABELS.has(labels[idx]!)) {
    idx -= 1;
  }
  const label = labels[idx]!;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Build the reviewable supplier-part plan for a scrape against an item's existing supplier
 * parts. Matches by distributor host; computes per-field dispositions without deciding any
 * overwrite — that is the caller's explicit choice, resolved by {@link resolveSupplierPartWrite}.
 */
export function buildSupplierPartPlan(
  payload: ScrapeResultPayload,
  existing: readonly ExistingSupplierPart[],
): SupplierPartPlan {
  const scrapedUrl = cleanString(payload.distributor_url);
  const scrapedOrderCode = cleanString(payload.mpn);
  const scrapedCost = payload.scraped_pricing ? payload.scraped_pricing.value : null;
  const scrapedCurrency = payload.scraped_pricing ? cleanString(payload.scraped_pricing.currency) : null;

  const supplierName = scrapedUrl ? supplierNameFromUrl(scrapedUrl) : 'Supplier';
  const scrapedHost = scrapedUrl ? hostOf(scrapedUrl) : '';
  const match =
    scrapedHost.length > 0
      ? existing.find((e) => e.url !== null && hostOf(e.url) === scrapedHost)
      : undefined;

  const current = match ?? {
    orderCode: null,
    unitCost: null,
    currency: null,
    url: null,
  };

  const proposals: SupplierFieldProposal[] = [
    {
      field: 'orderCode',
      current: current.orderCode,
      scraped: scrapedOrderCode,
      status: classifyString(current.orderCode, scrapedOrderCode),
    },
    {
      field: 'unitCost',
      current: current.unitCost,
      scraped: scrapedCost,
      status: classifyNumber(current.unitCost, scrapedCost),
    },
    {
      field: 'currency',
      current: current.currency,
      scraped: scrapedCurrency,
      status: classifyString(current.currency, scrapedCurrency),
    },
    {
      field: 'url',
      current: current.url,
      scraped: scrapedUrl,
      status: classifyString(current.url, scrapedUrl),
    },
  ];

  return { supplierName, matchedId: match?.id ?? null, proposals };
}

/** The concrete supplier-part write a plan yields once overwrite opt-ins are resolved. */
export type SupplierPartWrite =
  | { readonly kind: 'create'; readonly input: CreateSupplierPartInput }
  | { readonly kind: 'update'; readonly id: string; readonly input: UpdateSupplierPartInput }
  | { readonly kind: 'noop' };

/**
 * Resolve a supplier-part plan into a concrete create/update, honouring the §4 safeguard:
 *
 *  - a plan with no match creates a new supplier row from every non-SKIP field;
 *  - a matched plan fills only its `FILL` fields, and a `CONFLICT` field **only** when its
 *    name is in `overwriteFields`; `UNCHANGED`/`SKIP` fields are never written;
 *  - a matched plan that would change nothing is a `noop`.
 *
 * A field in `overwriteFields` that is not actually a `CONFLICT` is ignored, so an opt-in can
 * never introduce an unintended change.
 */
export function resolveSupplierPartWrite(
  plan: SupplierPartPlan,
  overwriteFields: ReadonlySet<SupplierPartField> = new Set(),
): SupplierPartWrite {
  const fields: {
    orderCode?: string | null;
    unitCost?: number | null;
    currency?: string | null;
    url?: string | null;
  } = {};
  let wrote = false;

  for (const p of plan.proposals) {
    const include = p.status === 'FILL' || (p.status === 'CONFLICT' && overwriteFields.has(p.field));
    if (!include || p.scraped === null) continue;
    wrote = true;
    switch (p.field) {
      case 'orderCode':
        fields.orderCode = p.scraped as string;
        break;
      case 'unitCost':
        fields.unitCost = p.scraped as number;
        break;
      case 'currency':
        fields.currency = p.scraped as string;
        break;
      case 'url':
        fields.url = p.scraped as string;
        break;
    }
  }

  if (plan.matchedId === null) {
    // A brand-new supplier row always carries the supplier even if no field was filled. It is
    // referenced by *name* rather than id because a scrape only ever knows a hostname — the
    // repository folds that name onto the matching supplier, or creates one (issue #384).
    // Tag the write as scrape-sourced so the Phase-81 price-history row is attributed correctly.
    return {
      kind: 'create',
      input: { supplier: { supplierName: plan.supplierName }, ...fields, source: 'SCRAPE' },
    };
  }
  if (!wrote) return { kind: 'noop' };
  return { kind: 'update', id: plan.matchedId, input: { ...fields, source: 'SCRAPE' } };
}
