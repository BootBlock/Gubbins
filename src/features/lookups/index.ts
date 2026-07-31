/**
 * Public surface of the category data-lookups feature (issue #616).
 *
 * Components import the panel; everything else here is the pure seam the panel and the tests
 * drive. The provider modules themselves stay internal — a call site names a provider by **id**
 * through the registry, never by importing its descriptor.
 */
export { CategoryLookupPanel } from './components/CategoryLookupPanel';
export {
  bindLookupOutputs,
  type BindableField,
  type LookupBinding,
  type LookupBindingProblem,
  type LookupBindingSet,
  type LookupTarget,
} from './binding';
export {
  applyLookupFillPlan,
  buildLookupFillPlan,
  planHasChanges,
  type LookupCurrentValues,
  type LookupFillPlan,
  type LookupFillProblem,
  type LookupFillProposal,
  type LookupFillStatus,
  type LookupFillWrite,
} from './fill-plan';
export { fetchLookupValues, searchLookupCandidates } from './flow';
export { getLookupProvider, LOOKUP_PROVIDERS, LOOKUP_PROVIDER_HOSTS } from './registry';
export { getLookupRunner, isProviderUrl, LookupRunner, type LookupFetcher } from './runner';
export { hasRunnableLookup, resolveLookupSources, type ResolvedLookupSource } from './sources';
export {
  BUILTIN_LOOKUP_TARGETS,
  isBuiltinLookupTarget,
  type BuiltinLookupTarget,
  type LookupCandidate,
  type LookupFailure,
  type LookupFailureCode,
  type LookupOutputDef,
  type LookupProvider,
  type LookupQuery,
  type LookupRequest,
  type LookupResult,
  type LookupValues,
} from './types';
