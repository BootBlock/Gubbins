# Research — adding an Item from an Amazon listing or invoice

> Investigation only (no code shipped in this doc). Answers the question: *can Gubbins add
> an item to the inventory from an Amazon listing URL (or bare ASIN), or from an Amazon
> invoice PDF?* Records what the existing infrastructure already gives us, what each path
> would cost, where it is fragile, and a recommended phased approach. Living plan doc — when
> a path is chosen and built, fold the durable decisions into the code and retire the
> corresponding section here.

## The ask

Two related entry points the user wants:

1. **From an Amazon product listing** — e.g. `https://www.amazon.co.uk/dp/B0F3XF5ZKF`.
2. **From an Amazon invoice PDF** — which also carries each line's **ASIN**
   (e.g. `B0F3XF5ZKF`).

The common thread is the **ASIN** (Amazon Standard Identification Number): a 10-character
identifier (modern products are `B0…`; older book-style products are the numeric ISBN-10).
An ASIN maps 1:1 to a canonical listing URL:

```
https://www.amazon.<tld>/dp/<ASIN>
```

So "add from a listing URL", "add from a bare ASIN", and "add a line off an invoice" all
reduce to the **same core problem: turn an ASIN (or its URL) into a populated Item**. That
is the useful framing — solve the ASIN→Item step once and every entry point reuses it.

## What already exists (and fits this almost perfectly)

Gubbins already has a supplier-scraping subsystem (spec §9) that is 80% of what a listing
importer needs. Adding Amazon is mostly *configuration + one parser*, not new architecture.

- **A companion browser extension** ([extension/](../../extension/)) with a background
  service worker ([background.ts](../../extension/src/background.ts)) that fetches supplier
  HTML (bypassing the PWA's CORS constraints) and a content script
  ([content-script.ts](../../extension/src/content-script.ts)) that parses it and bridges the
  result to the PWA over the origin-verified, schema-validated §9 `postMessage` protocol
  ([protocol.ts](../../src/features/scraping/protocol.ts)).
- **A Strategy-pattern parser registry**
  ([registry.ts](../../src/features/scraping/parsers/registry.ts)): each supplier is one
  file (`digikey`, `mouser`, `farnell`, `lcsc`, `rs`, `adafruit`, `sparkfun`) built from a
  declarative selector config via
  [`makeSupplierParser`](../../src/features/scraping/parsers/metadata.ts), with a generic
  structured-metadata fallback (Open Graph / schema.org microdata). Adding a supplier is
  "write the parser, import it, list it, add its host to the allow-list".
- **A hardened host allow-list**
  ([suppliers.ts](../../src/features/scraping/parsers/suppliers.ts)) — the background worker
  refuses to fetch anything that is not an `https` URL on a registered supplier domain
  (`isAllowedSupplierUrl`), and a test pins `extension/manifest.json`'s `host_permissions` to
  this list so they can never drift. **Amazon is not currently on it.**
- **A UI surface** — [`ScrapeSupplierPanel`](../../src/features/scraping/components/ScrapeSupplierPanel.tsx)
  ("Scrape supplier": paste a URL → typed payload), and a supplier-part planner
  ([supplier-part-plan.ts](../../src/features/scraping/supplier-part-plan.ts)) that turns a
  scrape into a create/update of a **supplier part** honouring the §4 no-overwrite safeguard.
- **A generalised import dialog**
  ([ImportDataDialog](../../src/features/inventory/components/ImportDataDialog.tsx)) over a
  pure parse→map→preview→apply engine
  ([text-import.ts](../../src/features/inventory/text-import.ts)) that already ingests pasted
  text / files (csv/tsv/json/markdown/line-list) into item create/update plans — the natural
  home for an invoice paste.
- **An error taxonomy that already anticipates anti-bot pages** — `CHALLENGE` (a 200-OK
  Cloudflare/DataDome/etc. interstitial) is a first-class `ScrapeErrorType`, detected by
  [`detectChallengePage`](../../src/features/scraping/scrape-errors.ts) before parsing. This
  is directly relevant to Amazon (see below).

**Data-model fit.** A scrape currently produces a `ScrapeResultPayload`
(`mpn, manufacturer, description, distributor_url, scraped_pricing`) and is stored as a
**supplier part**. Amazon maps onto this cleanly *if we pick the right semantics*:

| Payload field | Amazon source | Note |
| --- | --- | --- |
| `distributor_url` | `https://www.amazon.<tld>/dp/<ASIN>` | canonical, ASIN-derived |
| `scraped_pricing` | the buy-box price (`.a-price .a-offscreen`) | volatile; see caveats |
| `manufacturer` | the brand (`#bylineInfo` "Visit the X Store" / brand row) | Amazon "brand" ≠ true MPN maker, but close enough |
| `description` | `#productTitle` | the listing title |
| `mpn` | **the ASIN** | Amazon has no MPN concept; ASIN is the stable order code |

The key semantic decision: **Amazon is a *supplier*, and the ASIN is that supplier part's
order code** (it is *not* a manufacturer part number). `supplier-part-plan.ts` already writes
`payload.mpn` into the supplier part's `orderCode` and `supplierNameFromUrl` would derive
`Amazon` from the host — so with an Amazon parser emitting the ASIN as `mpn`, the existing
plumbing stores it correctly with **no changes to the persistence layer**. A listing where
Amazon surfaces a real brand MPN (some tech products list it in the details table) could fill
the item's own `mpn`, but the ASIN belongs on the supplier row.

## Path A — Amazon listing URL via the extension scraper

**Verdict: technically a one-file addition, but Amazon is a hostile target for the current
*background-fetch* model. Reliable only via an active-tab variant (Path A2).**

### A1 — the minimal "just add Amazon like any other supplier" change

Purely mechanical, mirrors every existing supplier:

1. `amazon-parser.ts` via `makeSupplierParser` — `hostPattern:
   /(^|\.)amazon\.[a-z.]+$/i`, selectors:
   - `mpn`: derive the **ASIN**, not a DOM MPN — from the URL (`/dp/(\w{10})`,
     `/gp/product/(\w{10})`) or `input#ASIN[value]` / `[data-asin]`. (This needs a tiny
     parser tweak: `makeSupplierParser` reads MPN from CSS text, whereas the ASIN is best
     taken from the URL — so Amazon likely wants a hand-written parser rather than the
     factory, or a small `mpnFromUrl` hook added to the factory.)
   - `description`: `#productTitle`.
   - `manufacturer`: `#bylineInfo`, `a#bylineInfo`, brand row in
     `#productDetails_techSpec_section_1` / `#detailBullets_feature_div`.
   - `price`: `#corePrice_feature_div .a-offscreen`, `.a-price .a-offscreen`,
     `#priceblock_ourprice` (legacy).
2. Register it in `registry.ts` (before `genericMetaParser`).
3. Add `https://*.amazon.co.uk/*`, `https://*.amazon.com/*`, `https://*.amazon.de/*`, … to
   `EXTENSION_HOST_PERMISSIONS` in `suppliers.ts` (the manifest test then requires the same
   entries in `manifest.json`).
4. Add `Amazon` to the supported-supplier UI hint (derived automatically from the registry).
5. `npm run build:extension` and reinstall the unpacked extension.

### A1's problem: Amazon actively defeats server-side fetches

The background worker fetches with `credentials: 'omit'` and no browser session. Amazon is
one of the most aggressively bot-protected sites on the web. An unauthenticated,
cookieless server-style fetch of a product page very frequently returns:

- a **"Robot Check" / CAPTCHA interstitial** (often HTTP 200 with a challenge body — exactly
  the `CHALLENGE` case, though `detectChallengePage` currently keys off Cloudflare/DataDome
  markers and would need an Amazon-specific signature added), or
- a **stripped/region-redirected page** missing the price (the buy-box is frequently rendered
  client-side and absent from the initial HTML), or
- an outright **`503`/`BLOCKED`**.

So A1 will *sometimes* work and *often* fail — a frustrating, non-deterministic experience,
and one that leans on scraping Amazon in a way its ToS discourages. It also can't see
prices that only render after JS. **Not recommended as the primary path.**

### A2 — active-tab scrape (the robust variant)

The much more reliable design for Amazon: instead of the background worker fetching the URL,
have the extension read the **Amazon tab the user already has open** — the fully-rendered,
session-authenticated DOM in their own browser. The user is on the listing, clicks the
extension (or a context-menu "Add to Gubbins"), and the content script scrapes the live DOM
and hands the payload to the PWA.

This dodges every A1 failure mode (no bot challenge — it's the user's real page; price is
present because it's rendered; correct locale/currency). It is, however, a **new capability**
for this extension, which today only injects into the PWA origin
(`content_scripts.matches` = localhost / 127.0.0.1 / github.io) and only *fetches* suppliers.
Active-tab scraping needs: an Amazon content-script match (or `activeTab` + programmatic
injection), a new "scrape the current tab" message path, and a way to route the payload back
to an open PWA tab (or queue it for the next open). The §9 parsers themselves are reused
verbatim — they already operate on a `Document`.

**Recommendation for Path A: build A2, reuse the A1 parser.** The parser + ASIN extraction is
shared; the difference is *where the Document comes from* (live tab vs. background fetch).

### No clean API alternative

Amazon's Product Advertising API (PA-API 5.0) is the "correct" way to resolve an ASIN, but it
requires an approved Associates/affiliate account **with qualifying sales**, request signing,
and per-region hosts — far too heavy and gated for a local-first, backend-less PWA, and it
would need a secret (forbidden in this public, `.env`-only repo). Discount it.

## Path B — add by bare ASIN

Trivial and worth doing regardless of A/C, because **the invoice path produces ASINs**, not
URLs. A bare ASIN (`B0F3XF5ZKF`) → canonical URL (`/dp/<ASIN>`) → feed the same scrape/parse
as Path A. Even with *no* enrichment, "create an item with the ASIN recorded as the Amazon
supplier order code + a `/dp/ASIN` link" is immediately useful and 100% reliable (no network).

- A pure `parseAsin(input): string | null` (accept a raw ASIN *or* extract it from a pasted
  `/dp/…` / `/gp/product/…` URL) — 10-char `[A-Z0-9]{10}` validation.
- An `asinToUrl(asin, marketplace)` helper (default `.co.uk` from the user's locale; the
  marketplace is a preference).
- Surface: a small "Add by ASIN / Amazon URL" affordance in the add-item flow that pre-fills
  the supplier part (`supplierName: 'Amazon'`, `orderCode: <ASIN>`, `url: /dp/ASIN`) and, if
  the extension is present, kicks off an enrichment scrape to fill title/brand/price.

## Path C — Amazon invoice PDF

**Verdict: possible but the weakest link. Recommend the *paste-text* variant over true PDF
parsing.**

Two sub-problems: (1) get text out of the PDF, (2) find ASIN + description + qty + unit price
in that text.

### C1 — parse the PDF in-app

- **Extraction dependency.** Gubbins has no PDF library today, and the CSP forbids external
  scripts (everything must be bundled) while CLAUDE.md mandates a minimal, vetted dependency
  surface and there's a hard bundle-size gate (`scripts/check-bundle-size.mjs`). `pdf.js` is
  the realistic option but is heavy (hundreds of KB + a worker) and MIT-licensed (compatible)
  — adding it purely for invoice import is a poor trade against the bundle budget. It could be
  **lazy-loaded** (dynamic `import()` only when the user opens invoice import) to keep it out
  of the main bundle, which softens but doesn't remove the cost.
- **Layout fragility.** Amazon invoice/order-summary PDFs vary by **marketplace and account
  type**, and — importantly — a *standard consumer* invoice usually shows the **product title
  and price but not always the ASIN**; ASIN is reliably present on **Amazon Business** invoices
  and in the "Order Reports"/"Request my data" exports. The user's premise (the invoice carries
  the ASIN) holds for Business invoices; for consumer invoices we'd fall back to matching on
  title, which is fuzzier. Any text-position parser here is inherently brittle and needs
  fixtures per invoice variant.

### C2 — paste invoice text into the existing import dialog (preferred)

Rather than own PDF decoding, lean on what exists: the user selects-all in their PDF viewer
and pastes into [`ImportDataDialog`](../../src/features/inventory/components/ImportDataDialog.tsx)'s
"Import text" tab. We add an **ASIN-aware line/invoice extractor** to
[text-import.ts](../../src/features/inventory/text-import.ts):

- Detect ASINs anywhere in a line (`\bB0[A-Z0-9]{8}\b` plus the ISBN-10 numeric form) and,
  when found, treat that line's leading text as the item name and any trailing currency token
  as the unit price — reusing the existing `parsePrice` and the `extractLabelledFields`
  machinery the line-list importer already has.
- Each extracted row flows through the existing `buildImportPlanFromRows` →
  `applyCatalogImportPlan` pipeline (create/update, supplier-part write), so an invoice becomes
  N items with `Amazon` supplier parts carrying their ASINs — **no new persistence code**.

This gives 90% of the value (bulk-add a whole order's items with ASINs + prices) with **zero
new heavy dependency** and reuses a tested pipeline. Optional enrichment (title/brand/price
per ASIN via Path A2) can run afterwards on the created rows.

## Cross-cutting considerations

- **Legal / ToS / hygiene (public repo).** Scraping Amazon is contrary to its ToS; the
  *active-tab* model (A2) — reading a page the user is already viewing in their own session,
  on demand — is materially more defensible than server-side crawling (A1) and avoids
  hammering Amazon. Keep all fixtures synthetic (no real order data, names, or addresses in
  tests/docs — a real invoice is personal data and must never enter the repo). Store no Amazon
  credentials or cookies anywhere. Rate-limit/gate any fetch path behind explicit user action.
- **Currency & locale.** Marketplace determines currency (`.co.uk`→GBP, `.com`→USD, …); derive
  the default from the user's locale and let it be overridden. `parsePrice` already infers
  currency from the symbol.
- **`detectChallengePage`** needs an Amazon "Robot Check" signature if A1 is ever built.
- **No overwrite.** Enrichment must keep flowing through the §4 safeguard
  (`resolveSupplierPartWrite`) so a scrape never clobbers a user-entered value.

## Recommendation (phased)

1. **Path B first — "Add by ASIN / Amazon URL" (small, reliable, no network dependency).**
   Pure `parseAsin` / `asinToUrl` seams + an add-item affordance that records the ASIN as an
   `Amazon` supplier part. Immediately useful and unblocks the invoice path's output.
2. **Path C2 — invoice *paste* import.** ASIN-aware extractor added to the existing
   `text-import.ts` line/invoice path; reuses the whole import pipeline. Bulk-adds an order.
   (Explicitly **not** in-app PDF decoding — recommend against pulling in `pdf.js` unless a
   later need justifies it, and then only lazy-loaded.)
3. **Path A2 — active-tab Amazon enrichment.** The Amazon `Document` parser (shared ASIN
   extraction) driven from the user's live Amazon tab, filling title/brand/price on demand.
   The genuinely new capability; do it once B and C2 have shipped the reliable, offline core.
4. **Explicitly declined:** A1 (background-fetch Amazon scraping — non-deterministic, ToS-
   hostile) and the PA-API (gated, secret-requiring). Record here so they aren't re-litigated.

## Where the code would land (for whoever builds it)

- ASIN seams: `src/features/inventory/asin.ts` (`parseAsin`, `asinToUrl`, `ASIN_RE`) + tests.
- Amazon parser: `src/features/scraping/parsers/amazon-parser.ts` (hand-written — ASIN comes
  from the URL/`#ASIN`, not a CSS text node), registered in `registry.ts`; hosts added to
  `EXTENSION_HOST_PERMISSIONS` (+ `manifest.json`, pinned by `host-permissions.test.ts`).
- Invoice extractor: extend `text-import.ts` (`extractInvoiceRows` / ASIN detection in the
  line path); reuse `buildImportPlanFromRows` → `applyCatalogImportPlan`.
- Active-tab (Path A2): new extension message kind + an Amazon `content_scripts` match /
  `activeTab` injection; the §9 parsers are reused unchanged.
- Supplier semantics: none needed — `supplier-part-plan.ts` already writes `mpn`→`orderCode`
  and derives `Amazon` from the host.
