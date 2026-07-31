/**
 * The two steps of a lookup, composed (issue #616, phase L1).
 *
 * Each is *fetch, then parse* — the runner performs the request and the provider reads the body —
 * kept out of the component so the sequence is unit-testable with an injected fetcher and no
 * network at all.
 *
 * The **order is the safeguard**: {@link searchLookupCandidates} returns candidates and nothing
 * else, and {@link fetchLookupValues} takes a candidate id. There is no function here that goes
 * from a search term to values, because there is no path in this feature that skips the user's
 * choice — searching Wikidata for "Blade Runner" returns Philip K. Dick's novel first, so a
 * "search and apply" convenience would confidently fill a film's fields from a book.
 */
import type { LookupFetcher, LookupRunner } from './runner';
import type { LookupCandidate, LookupProvider, LookupQuery, LookupResult, LookupValues } from './types';

/** Search a provider for the candidates matching an item's query. Never throws. */
export async function searchLookupCandidates(
  provider: LookupProvider,
  query: LookupQuery,
  runner: LookupRunner,
  fetcher?: LookupFetcher,
): Promise<LookupResult<readonly LookupCandidate[]>> {
  const fetched = await runner.request(provider, provider.buildSearchRequest(query), fetcher);
  if (!fetched.ok) return fetched;
  return provider.parseSearchResponse(fetched.value);
}

/**
 * Fetch the values for the candidate the user picked. Never throws.
 *
 * A candidate id the provider will not build a request for yields `NOT_FOUND` rather than a
 * request built from an unvalidated string.
 */
export async function fetchLookupValues(
  provider: LookupProvider,
  candidateId: string,
  runner: LookupRunner,
  fetcher?: LookupFetcher,
): Promise<LookupResult<LookupValues>> {
  const request = provider.buildDetailRequest(candidateId);
  if (request === null) return { ok: false, failure: { code: 'NOT_FOUND' } };
  const fetched = await runner.request(provider, request, fetcher);
  if (!fetched.ok) return fetched;
  return provider.parseDetailResponse(fetched.value);
}
