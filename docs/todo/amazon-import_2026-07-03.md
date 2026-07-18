# Adding an Item from an Amazon listing or invoice — decision record

> **Status:** 📘 REFERENCE — the work shipped; kept as the durable reference for the import format.

> **Status: shipped.** The Amazon-import work is complete; this file is now the durable
> decision record (what was built, what was declined, and where the code lives). The original
> investigation prose has been folded into the code it produced. Nothing here is actionable.

## The problem (unchanged framing)

"Add from an Amazon listing URL", "add from a bare ASIN", and "add a line off an invoice" all
reduce to the same core: **turn an ASIN (Amazon Standard Identification Number — a 10-char
`[A-Z0-9]` id) into a populated Item.** An ASIN maps 1:1 to a canonical listing URL
(`https://www.amazon.<tld>/dp/<ASIN>`). Amazon is treated as a **supplier** and the ASIN as
that supplier part's **order code** — not a manufacturer part number — so the existing
supplier-part plumbing stores it with no persistence changes.

## What shipped

- **Path B — add by ASIN / Amazon URL (pure seam).** `src/features/inventory/asin.ts`:
  `parseAsin` / `normaliseAsin` / `findAsin` / `isAmazonHost` / `ASIN_RE`, plus
  `asinToUrl(asin, marketplace)` + `marketplaceFromHost` + `DEFAULT_AMAZON_MARKETPLACE`. A bare
  ASIN or a listing URL resolves to the canonical `/dp/<ASIN>`. Reused by the share-target
  draft mapping (`src/features/share/share-draft.ts`) and the invoice importer below.
- **Path C2 — invoice *paste* import.** `src/features/inventory/text-import.ts` recognises an
  ASIN / listing URL as a line's SKU and a currency token as its unit cost, flowing through the
  existing `buildImportPlanFromRows` → `applyCatalogImportPlan` pipeline (surfaced in
  `ImportDataDialog`). No new heavy dependency; **in-app PDF decoding (`pdf.js`) was declined**
  in favour of paste.
- **Path A2 — active-tab listing enrichment.** The robust Amazon path: instead of a
  background fetch, the companion extension reads the **live DOM of the Amazon tab the user
  already has open**, on an explicit gesture (toolbar button or "Add to Gubbins" context menu).
  - Parser: `src/features/scraping/parsers/amazon-parser.ts` (hand-written — the ASIN comes
    from the URL/`#ASIN`, not a CSS text node). Emits the **ASIN as `mpn`**, `#productTitle` as
    `description`, the byline/brand as `manufacturer`, the buy-box `.a-offscreen` as
    `scraped_pricing`, and the canonical `/dp/<ASIN>` (on the live tab's marketplace) as
    `distributor_url`. Registered in `registry.ts` before the generic parser; excluded from
    `SUPPORTED_SUPPLIER_LABELS` (it is not URL-pasteable — see below).
  - Extension (`extension/`): the `activeTab` + `scripting` permissions inject
    `active-tab-scrape.ts` into the Amazon tab, which parses the DOM with the shared `runParser`
    and hands the outcome to the background worker; the worker routes it to an open Gubbins PWA
    tab (or queues it in `storage.session` for the next `PWA_READY`). New §9 wire messages
    `ACTIVE_TAB_RESULT` / `ACTIVE_TAB_ERROR` (`protocol.ts`) carry it into the page, still
    origin- and schema-validated by `parseExtensionMessage`.
  - PWA: `ScrapeBridgeContext` routes those into a deduped `incoming` map
    (`bridge-reducer.ts`); `ActiveTabScrapeListener` opens the **reviewable** `CreateItemDialog`
    pre-filled from the payload, and on confirm persists an **Amazon supplier part** (ASIN →
    order code, buy-box price → unit cost) through the §4 no-overwrite-safe
    `resolveSupplierPartWrite`. Enrichment never auto-commits and never clobbers a user value.

## Host-permission decision (A2 vs. A1)

A2 reads the active tab under the **`activeTab`** permission on a user gesture; it does **not**
add any Amazon host to the background-fetch allow-list (`EXTENSION_HOST_PERMISSIONS` /
`manifest.json` `host_permissions`). That fetch allow-list governs **Path A1**, which is
declined — so Amazon stays off it, and `host-permissions.test.ts` asserts Amazon can never leak
in. This is why the Amazon parser, though registered, is excluded from the URL-paste supplier
hint: a pasted Amazon URL is (correctly) refused by the fetch gate.

## Declined — do not re-litigate

- **Path A1 (background-fetch Amazon scraping).** Amazon aggressively defeats cookieless
  server-side fetches (Robot Check / CAPTCHA / stripped pages); non-deterministic and
  ToS-hostile. A2 (active-tab) supersedes it.
- **PA-API (Product Advertising API).** Requires an approved Associates account with qualifying
  sales, request signing, and a **client secret** — impossible in this public, backend-less,
  `.env`-only repo.
- **In-app PDF decoding (`pdf.js`).** Too heavy against the bundle budget; the paste-text
  importer (C2) delivers the value without the dependency.

## ToS / hygiene

Active-tab only, on explicit user action; no Amazon credentials or cookies are ever stored;
reading a page the user is already viewing is materially more defensible than server-side
crawling. All parser fixtures/tests are **synthetic** (made-up ASINs, `example`-style titles) —
a real Amazon listing/invoice is personal data and must never enter this public repo.
