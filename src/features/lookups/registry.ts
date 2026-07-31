/**
 * The curated lookup-provider registry (issue #616, phase L0).
 *
 * One list, in the app's own source — the same shape as `CATEGORY_PRESETS`,
 * `HIDEABLE_CAPABILITIES` and `parsers/registry.ts`. A category attaches a provider by **id**,
 * so nothing in the mechanism knows the word "Movie": a user who renames their `Movie`
 * category to "Films I own" keeps its lookup, and a user's own category attaches the same
 * provider from the picker.
 */
import { WIKIDATA_FILM_PROVIDER } from './providers/wikidata-film';
import type { LookupProvider } from './types';

/**
 * Every lookup provider this build ships, in registry order.
 *
 * Kept deliberately short: a provider must be **key-less and CORS-open** to work from a
 * backend-less public app, which rules out IMDb's own API (paid, via AWS Data Exchange) and
 * defers the bring-your-own-key sources (OMDb, TMDB) until a user-supplied credential has a
 * design of its own — one that keeps it out of the sync payload, every backup and every error
 * report. Wikidata carries the IMDb id, so the user still gets their IMDb link from an open
 * database rather than from IMDb.
 */
export const LOOKUP_PROVIDERS: readonly LookupProvider[] = [WIKIDATA_FILM_PROVIDER];

const BY_ID: ReadonlyMap<string, LookupProvider> = new Map(LOOKUP_PROVIDERS.map((p) => [p.id, p]));

/**
 * The provider with this id, or `undefined` when this build doesn't have one.
 *
 * Undefined is an ordinary answer rather than an error: a category's stored ids are kept
 * verbatim — including any written by a peer on a newer version — so an id this build cannot
 * resolve simply offers no lookup here, and survives the round-trip untouched.
 */
export function getLookupProvider(id: string): LookupProvider | undefined {
  return BY_ID.get(id);
}

/**
 * Every host any registered provider reaches, de-duplicated and sorted.
 *
 * The derived set the CSP `connect-src` and extension-manifest guard tests compare against, so
 * adding a provider whose host nobody allow-listed fails the build rather than failing silently
 * at the first fetch (a blocked request is indistinguishable, from JavaScript, from the host
 * being down).
 */
export const LOOKUP_PROVIDER_HOSTS: readonly string[] = [
  ...new Set(LOOKUP_PROVIDERS.flatMap((p) => p.hosts)),
].sort();
