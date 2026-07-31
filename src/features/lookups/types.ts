/**
 * Category data lookups — the provider descriptor (issue #616, phase L0).
 *
 * A **lookup provider** describes how to fill a category's fields from an open database.
 * It is the fourth instance of a shape this codebase already uses three times — a curated
 * registry in the app's own source, never something a user supplies (`CATEGORY_PRESETS`,
 * `HIDEABLE_CAPABILITIES`, `parsers/registry.ts`). Adding a provider is a source change,
 * reviewed like any other, which is what keeps the app free of an arbitrary-code-execution
 * surface and the companion extension's host permissions narrow.
 *
 * Everything here is **pure and DB-free**: a descriptor builds request URLs and parses
 * response bodies, and the runner does the fetching. That split is what makes a provider
 * exhaustively unit-testable against captured response bodies, with no network in the test.
 *
 * Three properties of the shape are load-bearing:
 *
 * 1. **Search never auto-applies.** {@link LookupProvider.buildSearchRequest} yields
 *    *candidates*, and the caller must have the user pick one before a detail fetch runs.
 *    This is not defensive over-engineering: searching Wikidata for "Blade Runner" returns
 *    Philip K. Dick's *novel* as a hit, so a provider that took the top result would
 *    confidently fill a film's fields from a book.
 * 2. **Output keys are bound to fields by name, at run time.** A provider names the field it
 *    expects (`Director`), not a field id it cannot know; `binding.ts` resolves that against
 *    the category's actual fields. An unbound key is *reported*, never dropped.
 * 3. **The host is the consent unit.** Agreeing to query an open film database is not
 *    agreement to query everything, so {@link LookupProvider.hosts} — not a global boolean —
 *    is what the user consents to.
 */
import type { FieldType } from '@/db/repositories';

/**
 * The reserved target ids addressing an item's **built-in** attributes rather than one of its
 * category's custom fields.
 *
 * Built-ins are addressed by id and not by name deliberately: `builtin-field-names.ts`
 * already establishes that a *custom* field may legitimately be named "Description", so a
 * name match could not tell the two apart. Kept to the two attributes a lookup has any
 * business filling — an item's identity and its prose — rather than every column an item has.
 */
export const BUILTIN_LOOKUP_TARGETS = ['builtin:name', 'builtin:description'] as const;

/** One of the reserved built-in item attributes a lookup output key may bind to. */
export type BuiltinLookupTarget = (typeof BUILTIN_LOOKUP_TARGETS)[number];

const BUILTIN_TARGET_SET: ReadonlySet<string> = new Set<string>(BUILTIN_LOOKUP_TARGETS);

/** Whether a target id addresses a built-in item attribute rather than a custom field. */
export function isBuiltinLookupTarget(target: string): target is BuiltinLookupTarget {
  return BUILTIN_TARGET_SET.has(target);
}

/**
 * One value a provider can produce, and the field it expects to land in.
 *
 * `key` is provider-scoped and stable (it is what a stored `fieldMap` keys on, so renaming
 * one silently orphans a user's override); `defaultTarget` is matched against the category's
 * field names, or is one of {@link BUILTIN_LOOKUP_TARGETS}.
 */
export interface LookupOutputDef {
  /** Stable, provider-scoped identifier. Never shown to the user. */
  readonly key: string;
  /**
   * The field type a value for this key is valid against. A key bound to a field of a
   * *different* type is reported as a mismatch rather than coerced (see `binding.ts`).
   */
  readonly type: FieldType;
  /**
   * The field this key binds to when the category has not overridden it: a **field name**
   * matched through `lib/name-fold`, or one of {@link BUILTIN_LOOKUP_TARGETS}.
   *
   * Provider default names are lifted verbatim from the shipped preset they serve, so an
   * untouched preset category binds every key with no configuration at all.
   */
  readonly defaultTarget: string;
}

/** What an item offers a provider to search with. */
export interface LookupQuery {
  /** The item's name — the search term. Blank when the item is unnamed. */
  readonly name: string;
  /**
   * A year narrowing the search, when the category has a bound year field holding one.
   * Null when unknown; a provider must still work without it.
   */
  readonly year: number | null;
}

/** One request a provider wants performed — built purely, fetched by the runner. */
export interface LookupRequest {
  /** Absolute https URL. Must be within the provider's declared {@link LookupProvider.hosts}. */
  readonly url: string;
  /**
   * Request headers. Wikidata and MusicBrainz both ask callers to identify themselves, and a
   * browser `fetch` cannot set `User-Agent` (it is a forbidden header), so identification
   * rides `Api-User-Agent` instead — which is settable, and which Wikidata accepts.
   */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Why a lookup could not produce a result.
 *
 * An enumerated code rather than a prose string, so the copy the user reads is translated at
 * the UI (`lookup.error.*`) instead of being an English literal buried in a provider — the
 * same reason `useErrorMessage` exists for database errors.
 */
export type LookupFailureCode =
  /** The host could not be reached at all (offline, DNS, CSP-blocked). */
  | 'NETWORK'
  /** The host answered with a non-OK status. */
  | 'HTTP'
  /**
   * The host refused or failed the request, without a status this app can quote — the shape the
   * companion extension reports, since it classifies the outcome itself and returns a category
   * rather than the raw code. Kept distinct from `NETWORK` so a rate limit or a refusal never
   * reads back to the user as "check your connection".
   */
  | 'REFUSED'
  /** The body could not be read, or was not the shape the provider expects. */
  | 'UNREADABLE'
  /** The search ran and matched nothing. */
  | 'NO_MATCHES'
  /** The chosen candidate yielded no usable values. */
  | 'NOT_FOUND';

/** A lookup failure, carrying the HTTP status where there was one. */
export interface LookupFailure {
  readonly code: LookupFailureCode;
  /** The HTTP status, for `HTTP` only — shown to the user so a 429 reads as a rate limit. */
  readonly status?: number;
}

/** The result of a parse or a fetch: a value, or the reason there isn't one. Never throws. */
export type LookupResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: LookupFailure };

/** A candidate match the user chooses between. Never applied without that choice. */
export interface LookupCandidate {
  /**
   * The provider's own identifier for this candidate, passed back to
   * {@link LookupProvider.buildDetailRequest}. Opaque to everything but the provider.
   */
  readonly id: string;
  /** The candidate's name, as the source has it. */
  readonly label: string;
  /** A one-line disambiguator ("1982 film by Ridley Scott"); null when the source has none. */
  readonly description: string | null;
  /** The candidate's year, where the source exposes one; null otherwise. */
  readonly year: number | null;
}

/**
 * The values a detail fetch produced, keyed by output key.
 *
 * A key the source had nothing for is **absent or null**, never an empty string — "the source
 * doesn't know" and "the source says it is blank" are different answers, and only the first
 * is true here.
 */
export type LookupValues = Readonly<Record<string, string | number | null>>;

/**
 * A curated lookup provider: what it can fill, where it fetches from, and how to read the
 * answer. Pure — it builds URLs and parses bodies, and never performs a request itself.
 */
export interface LookupProvider {
  /** Stable slug (`wikidata-film`) — what a category stores, and a durable identifier. */
  readonly id: string;
  /**
   * The hosts this provider's requests reach. **The consent unit**: the user agrees to these
   * hosts, not to online lookups in general. Every host here must also appear in the
   * extension manifest allow-list (`parsers/suppliers.ts`) *and* in CSP `connect-src`
   * (`src/csp.ts`) — two independent lists, each with its own guard test, and missing either
   * blocks the fetch on that path.
   */
  readonly hosts: readonly string[];
  /**
   * Minimum gap between two requests to this provider, honoured by the serialising runner.
   * A property of the provider rather than of each call site, because it is the *source's*
   * policy: MusicBrainz asks for at most one request a second, and Wikidata throttles SPARQL.
   */
  readonly minIntervalMs: number;
  /**
   * The database the values come from, named in the review dialog. A user should never be
   * left guessing where a value on their item originated — and for a film this is
   * emphatically *not* "IMDb", even though the IMDb link is among the values.
   */
  readonly sourceName: string;
  /** A human-visitable page for {@link sourceName}, shown alongside it. */
  readonly sourceUrl: string;
  /** Everything this provider can fill, in the order the review dialog lists it. */
  readonly outputs: readonly LookupOutputDef[];
  /**
   * Which of this provider's own {@link outputs} holds a **year**, when one does.
   *
   * Declared rather than inferred, so the caller can read the item's current year out of the
   * field that key binds to without guessing which `NUMBER` field means "year". That year reaches
   * {@link LookupQuery.year} and helps the user pick the right match; omit it for a provider whose
   * subject has no year.
   */
  readonly yearOutputKey?: string;
  /**
   * Whether `query` carries enough for a search to be worth running. The affordance renders
   * nothing when this is false, exactly as `ProductLookupPanel` shows nothing without a
   * barcode — an offer that can only fail is worse than no offer.
   */
  readonly canSearch: (query: LookupQuery) => boolean;
  /** The search request for `query`. Only called when {@link canSearch} passed. */
  readonly buildSearchRequest: (query: LookupQuery) => LookupRequest;
  /** Read a search response body into candidates. Pure; never throws. */
  readonly parseSearchResponse: (body: string) => LookupResult<readonly LookupCandidate[]>;
  /**
   * The detail request for a candidate the user picked, or null when the id is not one this
   * provider issued (so a malformed id can never be spliced into a request).
   */
  readonly buildDetailRequest: (candidateId: string) => LookupRequest | null;
  /** Read a detail response body into per-output-key values. Pure; never throws. */
  readonly parseDetailResponse: (body: string) => LookupResult<LookupValues>;
}
