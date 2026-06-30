/**
 * External Data Scraping via Extension (spec §4, §9, Phase 8) — public surface.
 *
 * The pure protocol/merge/parser logic is unit-tested in isolation; the bridge and
 * UI are feature-detected and degrade gracefully when the companion extension is
 * absent (§9.3). Components import from here.
 */
export {
  EXTENSION_SOURCE,
  parseExtensionMessage,
  makeMessage,
  extensionMessageSchema,
  scrapeResultPayloadSchema,
  scrapeErrorPayloadSchema,
  SCRAPE_ERROR_TYPES,
  type ExtensionMessage,
  type ScrapeResultPayload,
  type ScrapeErrorPayload,
  type ScrapeErrorType,
} from './protocol';
export {
  buildScrapeMergePlan,
  applyScrapeMerge,
  type ScrapeMergePlan,
  type ScrapeWrite,
  type ScrapeField,
  type FieldProposal,
  type FieldStatus,
  type ExistingItemFields,
} from './merge';
export {
  buildSupplierPartPlan,
  resolveSupplierPartWrite,
  supplierNameFromUrl,
  type SupplierPartPlan,
  type SupplierPartWrite,
  type SupplierPartField,
  type SupplierFieldProposal,
  type SupplierFieldStatus,
  type ExistingSupplierPart,
} from './supplier-part-plan';
export { ScrapeBridgeProvider, useScrapeBridge } from './ScrapeBridgeContext';
export { ScrapeSupplierPanel } from './components/ScrapeSupplierPanel';
export { ScrapeReviewDialog } from './components/ScrapeReviewDialog';
export { useScrapeNotifier } from './useScrapeNotifier';
