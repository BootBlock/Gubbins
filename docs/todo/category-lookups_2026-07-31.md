# Category data lookups — filling a category's fields from an open database

> **Status:** 🟢 ACTIVE — design agreed, nothing implemented yet; phase L0 is next.

Issue [#616](https://github.com/BootBlock/Gubbins/issues/616) asks for "Get from IMDb" on the
`Movie` category, and correctly identifies why that is awkward: a `Category` is *just a
collection of custom fields*, with nowhere for behaviour to live. Hard-coding a button that
knows about the category named "Movie" would be a bodge — it would break the moment a user
renamed the category to "Films", and it would not help the `Book` or `Vinyl record` categories
sitting next to it with exactly the same problem.

This document answers the three questions the issue raises, records the provider research (the
IMDb finding is the significant one), and phases the work.

## The three questions, and the answers

### 1. Where does the runnable code live?

**In a curated registry in the app's own source — users never write code.** This is a solved
shape in this codebase, used three times already:

- `CATEGORY_PRESETS` (`src/features/inventory/category-presets.ts`) — a pool of ready-made
  category schemas a category can be *created from*.
- `HIDEABLE_CAPABILITIES` (`src/features/inventory/category-capabilities.ts`) — a pool of
  capability ids a category can *reference*.
- `parsers/registry.ts` (`src/features/scraping/parsers/`) — a pool of site parsers, each a
  pure `parse(doc, url) => payload` function selected by host.

A **lookup provider** is the fourth: a pure, DB-free descriptor plus a parse function, listed in
one registry. Adding a provider is a source change (registry entry + parser module + host
allow-list entry), reviewed like any other — never something a user supplies. That constraint is
not a limitation to design around; it is what keeps the app free of an arbitrary-code-execution
surface and keeps the extension's host permissions narrow.

### 2. How is a provider reconciled to a category, generically?

**A category stores a list of provider ids — the exact shape `hidden_capabilities` already
uses** (issue #618, shipped). Nothing in the mechanism knows the word "Movie":

```ts
// categories.lookup_sources — opaque TEXT, tolerant parse, nullable (no lookups).
[{ providerId: 'wikidata-film' }]
```

The `Movie` **preset** seeds `['wikidata-film']`, the `Book` preset `['open-library-book']`, the
`Vinyl record` preset `['musicbrainz-release']` — but a user's own "Films I own" category
attaches the same provider from a picker in the category manager, and a user who renames `Movie`
to anything at all keeps it. The binding is category-id → provider-id, never name → behaviour.

The storage conventions carry over verbatim from `hidden_capabilities`, and for the same
reasons: opaque `TEXT` with no `json_valid()` CHECK, parsed tolerantly, unknown ids preserved on
round-trip but ignored by this build (so a peer on a newer version cannot have its choice
discarded by an older device).

### 3. How does fetched data land in *arbitrary* custom fields?

This is the part with no existing precedent, and the part worth getting right.

A provider declares **output keys**, each with a `FieldType` and a **default field name**:

| Output key | Type | Default field name |
| --- | --- | --- |
| `director` | `TEXT` | Director |
| `cast` | `LONG_TEXT` | Cast |
| `genre` | `TEXT` | Genre |
| `releaseYear` | `NUMBER` | Release year |
| `runtimeMinutes` | `NUMBER` | Runtime (min) |
| `studio` | `TEXT` | Studio |
| `imdbUrl` | `URL` | Reference (IMDb/TMDB) |

Binding happens in two layers, so the common case is zero-config and the awkward case is still
fixable:

1. **By name, resolved at run time.** Each output key's default name is matched against the
   category's actual field names through `lib/name-fold` — the same fold the field dictionary
   uses, so "Director" and "director" are one name here exactly as they are there. The default
   names above are lifted verbatim from the shipped `Movie` preset, so an untouched preset
   category binds every key with no configuration at all.
2. **By an explicit stored map, when the user has renamed or re-purposed a field.** The optional
   `fieldMap` on the stored entry (`{ providerId, fieldMap: { director: '<fieldId>' } }`)
   overrides the name match. One column, still one tolerant parse.

An output key that binds to nothing is **reported, never silently dropped** — the review dialog
lists it as "no field for this" with an offer to add the field to the category. (This mirrors
the import pipeline's rule from #350: readers report why a value is unusable rather than
substituting something.) A type mismatch — a `NUMBER` key bound to a `TEXT` field — is likewise
surfaced rather than coerced.

Built-in item attributes are addressed with reserved target ids (`builtin:name`,
`builtin:description`) rather than by name, since `builtin-field-names.ts` already establishes
that a *custom* field may legitimately share a built-in's name.

## Never overwrite the user's data

The §4 safeguard is not renegotiated for this feature; it is generalised. A lookup produces a
**reviewable plan** classifying each target field, exactly as `scraping/merge.ts` does today:

- `FILL` — the field is empty, so the value applies freely;
- `CONFLICT` — the field holds a differing user value, so the change is withheld unless the user
  explicitly opts into *that specific* overwrite;
- `UNCHANGED` / `SKIP` — nothing to do.

`merge.ts` is fixed to four hard-coded item fields, so this needs a sibling that works over a
dynamic target set rather than a widening of it. Nothing auto-commits, ever.

## Choosing *which* film — the disambiguation step is mandatory

A provider declares its **inputs** in priority order: an exact identifier where the source
supports one (a barcode, an existing IMDb id already in the item's reference field), otherwise a
**search** over the item's name and any year field.

Search results must go through an explicit **match picker**. This is not defensive
over-engineering — it is what the research actually showed. Searching Wikidata for
`Blade Runner` returns, as its *first* hit:

```
Q605249 — "Do Androids Dream of Electric Sheep?" (science fiction novel by Philip K. Dick)
```

…because "Blade Runner" is a registered alias of the novel. A provider that took the top hit
would confidently fill a film's fields from a book. So: candidates are shown with label,
description and year; the user picks; only then does the detail fetch run. A single candidate is
still shown, not auto-applied.

## Provider research — and the IMDb finding

**IMDb itself cannot be called.** This is the headline result and it shapes the whole feature.
Verified directly:

| Source | Key required? | Verdict |
| --- | --- | --- |
| IMDb official API | Paid, via AWS Data Exchange | ✗ Not viable — commercial licence, needs a backend. |
| IMDb bulk datasets | No key | ✗ Not viable — hundreds of MB of TSV, non-commercial licence, not a browser lookup. |
| Scraping `imdb.com` | n/a | ✗ Declined — against their terms, brittle, and would widen the extension's deliberately-narrow fetch allow-list (the same reasoning that kept Amazon off it). |
| OMDb | **Yes** (`{"Error":"No API key provided."}`) | ✗ Deferred — see below. |
| TMDB | **Yes** (`{"status_message":"Invalid API key…"}`) | ✗ Deferred — see below. |
| **Wikidata** | **No** | ✓ **Chosen.** `access-control-allow-origin: *` on both the search and SPARQL endpoints. |

Wikidata returns everything the `Movie` preset asks for, **including the IMDb id** — so the user
still gets their IMDb link, sourced from an open database rather than from IMDb. A live query for
`Q184843` returned:

```
title "Blade Runner" · imdb "tt0083658" · year 1982 · duration 112 · directors "Ridley Scott"
· genres "science fiction film, film noir, cyberpunk, …"
```

`tt0083658` → `https://www.imdb.com/title/tt0083658/`, which populates the preset's existing
**Reference (IMDb/TMDB)** `URL` field. The honest framing for the UI and the wiki is *"fill from
an open film database, including its IMDb link"* — never *"from IMDb"*, which would misdescribe
where the data came from.

The design generalises immediately, which is the point of doing it this way — both verified
keyless and CORS-open:

- **Open Library** (`openlibrary.org`) → the `Book` preset.
- **MusicBrainz** (`musicbrainz.org`) → the `Vinyl record` preset.
- **Open Food Facts** — already integrated for barcode lookup; becomes a provider under the same
  registry rather than staying a special case, once the seam exists.

### Deferred: bring-your-own-key providers

OMDb and TMDB have richer film coverage than Wikidata, and a user pasting their own free key is
not a *repository* secret — the no-secrets rule is about the repo, and would not be broken by
it. It is deferred anyway, deliberately, because it opens a surface this app does not currently
have: a user-supplied credential that must be stored, kept out of the sync payload and out of
every backup/export/snapshot, and kept out of error reports. That is its own design, not a
detail of this one. Revisit only if Wikidata's coverage proves inadequate in practice.

## Network policy, licensing and rate limits

- **Two fetch paths, unchanged from product lookup**: the companion extension performs the
  request when present (host allow-list, `isAllowedLookupUrl`-style gate), otherwise the app
  fetches directly after **one-time consent**. A provider origin must be added in **two**
  independent places, each with its own guard test: the extension manifest, via the
  `parsers/suppliers.ts` allow-list seam that `host-permissions.test.ts` pins, **and** CSP
  `connect-src`, which is its own hard-coded list in `src/csp.ts` pinned by `src/csp.test.ts`.
  Missing either one blocks the fetch on that path.
- **Consent is per provider host, not one global yes.** The existing `allowOnlineProductLookup`
  boolean does not generalise; this needs a stored set, with a `merge` reconcile on read (a
  persisted-state change — see the persisted-state-reconcile-on-read convention). Agreeing to
  query an open film database is not agreement to query everything.
- **Rate limits belong in the descriptor.** MusicBrainz asks for ≤1 request/second and Wikidata
  throttles SPARQL; a `minIntervalMs` on the provider, honoured by a serialising runner, keeps
  that a property of the provider rather than of each call site.
- **Open risk — the User-Agent header.** Wikidata and MusicBrainz both ask callers to identify
  themselves, and a browser `fetch` cannot set `User-Agent` (it is a forbidden header). Wikidata
  accepts `Api-User-Agent` as a substitute, which *is* settable; MusicBrainz's policy is written
  around `User-Agent`. Confirm MusicBrainz's stance before phase L3 rather than assuming it.
- **Show provenance.** The review dialog names the source the values came from. Wikidata and
  MusicBrainz core data are CC0; attribution is courtesy rather than obligation, but a user
  should never be left guessing where a value on their item originated.

## Where it appears

Under the **existing `scraping` capability** ("Product & supplier lookup") — no new module.
The affordance renders only when the capability is on, the item has a category, that category
has at least one provider attached, and the provider's inputs are satisfiable; otherwise nothing
renders at all, exactly as `ProductLookupPanel` degrades today.

## Phases

| Phase | Scope |
| --- | --- |
| **L0** | The pure seam: provider descriptor + registry, the `lookup_sources` column and its tolerant parse, name/`fieldMap` binding, and the generic no-overwrite plan builder. No UI, no network. Fully unit-tested. |
| **L1** | The runner and the UI: match picker → detail fetch → review dialog → apply. One provider (`wikidata-film`). CSP + extension host allow-list + per-host consent. |
| **L2** | Attach it: the category manager's provider picker, the `Movie` preset seeding `wikidata-film`, i18n for `en` **and** `de`, and the wiki page. |
| **L3** | Generalise: Open Library (`Book`), MusicBrainz (`Vinyl record`); fold the existing Open Food Facts barcode lookup into the same registry. |
| **L4** | Optional follow-ons: barcode → disc release lookup; re-running a lookup to refresh stale fields. |

## Declined — do not re-litigate

- **A "Get from IMDb" button that knows the category is named "Movie".** The issue rules this
  out itself, and renaming the category would break it.
- **User-authored scripts, expressions, or any evaluated string.** The app ships a CSP with no
  `unsafe-eval` and no inline scripts; a user-supplied code surface would undo that for a
  convenience feature.
- **Auto-applying a search result.** The Blade Runner case above is the concrete reason.
- **Auto-running a lookup on item create.** Every lookup is an explicit gesture, like every
  other network call this app makes.
