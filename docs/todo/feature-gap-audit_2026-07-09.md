# Feature-gap audit — backlog (living plan)

> ✅ **COMPLETE (2026-07-10).** Every actionable item G1–G9 has shipped and passed review; **G4 (UI
> internationalization) was the last.** This file is retained as the record of the audit — the
> deliberate non-goals below remain non-goals. No open items remain.

A grounded backlog of genuine feature gaps, to be implemented **one task at a time** in
separate sessions. Each task has a stable ID (`G1`, `G2`, …) so a session can be kicked off with
just "implement `G1`". This is the single source of truth for the audit backlog; the matching
memory note (`feature-gap-audit-2026-07-09`) is a pointer to this file.

**Origin.** Fourth grounded audit benchmarking Gubbins against current comparable tools — Sortly,
Encircle, HomeZada, Homebox, Grocy, Snipe-IT, InvenTree/PartKeepr, and the 2026 "AI home
inventory" / collection-tracker cohort (Scanlily, NestEgg, HomeProof, Kolekto) — with web
grounding, cross-checked against the code. Three prior audits plus the ecosystem build-out already
closed the large gaps: reorder points, supplier parts + price breaks + price history, formal POs +
procurement automation, ABC / turnover / aging / dead-stock / valuation + spend analytics, asset
bookings, kits/assemblies, variants, custom-field templates, bulk edit/clone, data-hygiene report,
warranty + straight-line depreciation, barcode → Open Food Facts product lookup, loans-to-contacts,
location capacity/fullness gauge, label/QR customisation, structured **condition grading**
(`condition` enum: Mint / Good / Needs Repair / Out for Calibration), and the whole
HA / MCP / iCal / webhook / MQTT ecosystem. So the verified, against-the-code residue below is
short.

**Process (mandatory).** Implement one item at a time, in a fresh session, in a **git worktree**
(concurrent agents edit this repo). Every item is **complete only after `/code-review` passes** —
no item counts as done on merge alone. Respect **DRY**, **no god-objects / monolith files**, and
**no AI-trope / junior-level code**: extend the established "pure logic seam out of glue" pattern
(`reorder-policy.ts`, `cycle-count.ts`, `asset-lifecycle.ts`). Honour design-token / Foundry / a11y
discipline (see `CLAUDE.md`): tokens only, reach for a Foundry primitive before hand-rolling, keep
the a11y wiring, and verify token-based Tailwind utilities actually emit. No time constraints —
do the thorough thing. When a task ships and its review passes, tick its box here **and** in the
memory note.

**Deliberate non-goals** (recorded so they are not re-proposed) are at the bottom.

---

## Actionable gaps (open) — ranked by value × fit

- [x] **G1 — Insurance / estate schedule export (print + PDF).** ✅ **Shipped 2026-07-10.**
  *High value; strong local-first
  fit.* The Reports suite emits CSV + on-screen only — there is **no formatted, printable
  document** for an insurer / estate / claim. Add a room-by-room (location-grouped) inventory
  *schedule*: photo thumbnail, name, serial, purchase price, acquired date, warranty, condition,
  and a **total replacement value**. Render as a print-styled HTML view + native `window.print()`
  (→ "Save as PDF"), **no PDF dependency** (native-first). Pure aggregation extends
  `ReportRepository` / `reports.ts`; a new print route/dialog reuses the existing value seam
  (`effectiveUnitCost`), and should consume G9's current-value once that lands. Grounding:
  Sortly / Encircle / NestEgg / HomeProof all sell a "one-tap insurance PDF" / schedule of loss.

- [x] **G2 — On-device receipt / label OCR prefill.** ✅ **Shipped 2026-07-10.** *Medium; opt-in,
  fully offline.* Attachments
  exist but nothing extracts data from them. Add an **opt-in** OCR (Tesseract.js WASM — keyless,
  no cloud, runs in a worker like the scanner) that reads a photographed **receipt or product
  label** and pre-fills a *reviewable* Create/Edit-item draft (price, date, model/MPN, serial).
  Never auto-writes. Lazy-loaded + **precache-excluded** so it never bloats the base bundle.
  Grounding: Sortly cloud OCR + 2026 receipt-scanning cohort — but do it **on-device** to keep the
  secret-free/offline promise (the cloud-AI versions are a deliberate non-goal, below).

- [x] **G3 — Local reminder notifications.** ✅ **Shipped 2026-07-10.** *Medium; PWA-native.* The
  alert/agenda engine already
  computes overdue loans, expiring warranties, due maintenance, and low stock — but the only
  delivery surface is in-app. For an **installed** PWA, surface them via the Notification API +
  service worker (and Periodic Background Sync where present) as OS notifications. **No server**
  (local notifications only; not Web Push). Degrade silently where absent/denied (iOS Safari) —
  same injectable-seam + feature-detect pattern as `useWakeLock` / `useInstallPrompt`.

- [x] **G4 — UI internationalization (multi-language).** ✅ **Shipped 2026-07-10.** *Medium value,
  large effort.* Was: only number/date/currency formatting was locale-aware (`lib/format.ts`); all
  UI copy was English-only. Landed a lightweight, dependency-free typed `t()` over JSON message
  catalogs and converted a first slice (staged with the user). **Last open item — this audit is now
  complete.** See the Shipped section below.

- [x] **G5 — In-app natural-language → query.** ✅ **Shipped 2026-07-10.** *Low-medium.* The NL path
  existed only for external agents (MCP / HA "where are my…"). Added a **rule-based, no-LLM** NL
  layer over the existing `parseTextQuery` → AST so "low stock screws in the garage" resolves
  without learning the `field:value` / `cap:key>n` syntax. Extends the existing parser (§5.1);
  produces the AST, never hand-builds SQL.

- [x] **G6 — Related-items cross-links ("works with" / accessory / spare-for).** ✅ **Shipped
  2026-07-10.** *Low / niche.* A
  synced M:N relation between items, surfaced on the item detail — distinct from **variants** (same
  product) and **kits** (assemblies). Follow the `item_tags` M:N + LWW-leaf sync pattern.
  Maker/collection value; only if wanted.

- [x] **G7 — Per-instance test / calibration / service records (InvenTree parity).** ✅ **Shipped
  2026-07-10.** *Low / niche.*
  Structured pass/fail + reading logs per **serialised** unit, beyond free-form maintenance
  history. Model on the existing history/maintenance seams. Narrow audience (lab/maker QA).

- [x] **G8 — Manual "to-buy" / wishlist.** ✅ **Shipped 2026-07-10.** *Low.* Reorder automation
  covers *stock-driven* buying; a manual list of **wanted-but-not-owned** items is a separate small
  surface. Folded into the Purchase Orders screen as a third **Wishlist** tab (beside Orders and the
  stock-driven Reorder / Shopping list) rather than a new screen.

- [x] **G9 — Manual current-value / revaluation history (appreciating assets).** ✅ **Shipped 2026-07-10.**
  *Medium; strong
  collector + insurance fit.* Today an item's worth is derived only from `purchase_price` minus
  **straight-line depreciation** (`asset-lifecycle.ts`) — a book value that only ever *decreases*
  to a salvage floor. Collectibles, tools, and property **appreciate**, and an insurance
  replacement schedule needs *today's* value, not a depreciated one. Add an optional manual
  **current value** with a small append-only **revaluation log** (date + amount + optional note),
  so value can move up or down independently of the depreciation curve. Pure valuation seam
  alongside `asset-lifecycle.ts` (don't fold into it); `effectiveUnitCost` gains an override, and
  G1 / the valuation reports consume it. Grounding: every 2026 collection tracker (Kolekto, vinyl /
  TCG / comic apps) and Encircle/NestEgg centre on *current market value*, not purchase price —
  we keep it **manual** (live-price scraping needs a keyed cloud API; see non-goals).

## Shipped (tick + date as they land)

- **G4 — UI internationalization (multi-language)** — shipped 2026-07-10. **The last open item; this
  audit is complete.** Was: only number/date/currency formatting was locale-aware (`lib/format.ts`),
  all UI copy English-only. New pure `features/i18n/i18n.ts` seam owns all non-trivial logic — dotted
  key lookup, `{name}` interpolation (numeric vars grouped through the same locale as the rest of the
  app), CLDR pluralization via `Intl.PluralRules` (`key.<category>` variants), and fallback (active →
  base English → caller fallback → key) — exhaustively unit-tested, no React/DOM/catalog files.
  `catalogs/en.json` is the source of truth for every converted English string; `de.json` is the
  **German pilot**, lazy-imported into its own chunk so a language costs nothing in the base bundle
  until selected (a coverage test asserts de ⊆ en, full de coverage, and placeholder preservation; a
  drift test asserts `NAV_DESTINATIONS[].label`/`DASHBOARD_WIDGETS[].title` equal their catalog
  English). **Integration:** the UI language derives from the existing `locale` preference (base
  subtag: `de-DE` → German), so text and number/date/currency share **one** locale — no new
  preference; the Settings "Locale" control became "Language & region". `useT()` is the React seam
  (typed to the catalog keys incl. pluralized bases, mirroring `useFormatters`); `useApplyLanguage()`
  lazy-loads the active catalog beside `useApplyTheme`. **Staged slice** (confirmed with the user):
  global chrome (`AppNav` + nav labels) + the Settings language control + the **Dashboard** (screen,
  hero, actions, nav tiles + announcements/tooltips, getting-started, backup nudge, WIP banner,
  version, the whole 12-widget board + grid) and **About** screens, fully; the other 16 screens keep
  working in English via base-catalog fallback (no regression). **Deliberate seam boundary** (next
  increment): SR-only aria strings that interpolate nav-count metric nouns keep the noun English (it
  is owned by the separate Settings metric-config subsystem); the owned parts are translated. No
  schema/migration/dependency change. `/code-review` (high): one low-severity finding (dead/unguarded
  English-reference field → added the drift test). tsc + full suite (3610) + 46 new i18n tests green;
  prod build clean; verified end-to-end in the built app under Edge (`vite preview`, real OPFS):
  switching to `de-DE` renders chrome/Dashboard/About in German with no console errors.

- **G7 — Per-instance test / calibration / service records** — shipped 2026-07-10. A structured
  pass/fail + reading log per **SERIALISED** unit (InvenTree "test result" parity) — the QA audit
  trail a lab / maker / calibration house keeps against a serial number, beyond the free-form
  maintenance history. New pure `features/inventory/test-records.ts` seam owns all non-trivial logic:
  the closed **result** (`PASS`/`FAIL`/`LIMIT`/`NA`) and **kind** (`TEST`/`CALIBRATION`/`SERVICE`)
  vocabularies (free TEXT, no DB CHECK, app-enforced like `item_relations.kind` — a future value
  syncs forward), `planTestRecord` (the write choke-point: rejects a blank name / non-finite reading,
  drops a unit with no reading), `sortTestRecords` (newest-first) and `summariseTestRecords` —
  dependency-free, exhaustively unit-tested. New **v7** migration adds an append-only `test_records`
  LWW-leaf table (`item_id` → items **ON DELETE CASCADE**, a numeric `reading` deliberately
  unconstrained — may be negative), added to `SYNC_TABLES` + reconcile `FK_REFS` (an item FK guard,
  exactly like G9's `revaluations`); golden baseline snapshot regenerated (user_version 7). Thin
  `withTestRecords` ItemRepository mixin: `recordTestResult` appends the row + a `TESTED` Activity-Log
  entry in one transaction, `listTestRecords` (newest-first, its SQL order asserted equivalent to the
  seam's `sortTestRecords`), `removeTestRecord` DELETE + tombstone (no-op for an unknown id). New
  `TESTED` history action wired through **every** `Record<HistoryAction>` map (activity-kind,
  history-format, and the bridge event-type map). `TestRecordsEditor` on the ItemDetailDialog
  **Lifecycle** tab, gated to `SERIALISED` items (a bulk/consumable line has no single instance to
  audit); Foundry primitives, design tokens, a11y live regions, field-anchored errors.
  `/code-review` (high): no correctness bugs in the app diff; fixed the bridge `ACTION_EVENT_TYPE`
  `Record<HistoryAction>` map (newly non-exhaustive for `TESTED` — mapped `TESTED`/`REVALUED` to the
  generic `item.changed`, the prior fallback, so no OpenAPI-enum drift) and a **pre-existing G9** gap
  in the bridge item-DTO test fixture (missing `currentValue`) so `type-check:bridge` is green again.
  ~180 new tests (seam intents/robustness + repo CRUD incl. cascade + tombstone + a repo↔seam
  order-equivalence check + a two-device sync round-trip incl. the FK guard + the migration-lock v7
  additions + a component affordance test); merged-`main` app + bridge (444) suites and both
  typechecks green; production `vite build` clean. Verified end-to-end in the built app (vite preview,
  real OPFS sqlite-wasm): a SERIALISED item records a result that renders and persists across a full
  reload with no console errors.

- **G8 — Manual "to-buy" / wishlist** — shipped 2026-07-10. A manual list of
  **wanted-but-not-owned** things to buy — the counterpart to the *stock-driven* Reorder /
  Shopping list — folded into the Purchase Orders screen as a third **Wishlist** tab (no new
  top-level screen). Each entry is free-standing (references no item): a name plus an optional
  note, `http(s)` link, target price and priority. New pure `features/purchasing/wishlist.ts` seam
  owns all non-trivial logic — the priority vocabulary (free TEXT, app-enforced like
  `item_relations.kind`) + ordering, XSS-safe link sanitisation (a non-`http(s)` scheme such as
  `javascript:` is rejected, a scheme-less host defaults to `https://`), the `planWishlistEntry`
  write choke-point, the display sort and the summary aggregation — dependency-free and
  exhaustively unit-tested. New **v6** migration adds a standalone `wishlist` table: an independent
  LWW leaf (own `updated_at` + auto-stamp trigger, random-UUID PK, **no FK**), added to
  `SYNC_TABLES` so it publishes / reconciles / deletes through the generic engine — **no `FK_REFS`
  reconcile entry** needed (it references nothing and nothing references it, so there is no FK
  guard to add, unlike G6/G9); golden baseline snapshot regenerated (user_version 6). Thin
  `WishlistRepository` (create / update / delete + tombstone / list) funnels every write through
  the seam and builds its list ORDER BY from the seam's priority SSOT so SQL can't drift from
  `sortWishlist`. `WishlistTab` + `WishlistEntryDialog` (Foundry primitives, design tokens, a11y
  live regions) add / edit / remove entries with reviewable, field-anchored errors. `/code-review`
  (high): no correctness bugs; one simplification applied (a redundant NaN ternary). 55 new tests
  (pure-seam intents / robustness + repo CRUD + a repo↔`sortWishlist` order-equivalence check + a
  two-device sync round-trip + a component affordance test); typecheck + purchasing / sync / backup
  suites green in merged `main`; production `vite build` clean.

- **G5 — In-app natural-language → query** — shipped 2026-07-10. New pure
  `features/search/nl-query.ts` seam (`interpretNaturalLanguage`) lowers a plain-English phrase to
  the **exact** §5.1 `SearchAST` the Visual Builder edits and `parseASTtoSQL` translates — never
  hand-building SQL — so, like `parseTextQuery`, the box merely *loads* the builder. A fixed
  no-LLM lexicon recognises **stock level** ("out of stock"/"none left" → `quantity = 0`; "low
  stock"/"running low" → `quantity < N`, N = the user's low-stock threshold with a friendly floor
  when that pref is off; "in stock"/"available" → `quantity > 0`), **quantity comparisons** ("more
  than 10", "fewer than 5", inclusive "at least 10"/"10 or more" → strict on integer counts,
  "exactly 3", "5 in stock"; digit or spelled-out numbers), **location phrases** ("in the garage",
  "on shelf 2" → `location = <id>`, resolved against caller-supplied location names, longest match
  wins, determiner-prefixed names still match), **category mentions** (→ `category = <id>`), and
  **residual words** minus filler (→ `name CONTAINS`). The time/loan attention statuses (expiring,
  on-loan, warranty, overdue, maintenance-due) are deliberately **out of scope for the AST path** —
  they need a runtime clock, tunable windows and correlated joins the context-free `parseASTtoSQL`
  can't express, so forcing them in would mean hand-building SQL; they stay reachable via the
  status-filter chips (the tooltip points there). Surfaced as an opt-in "ask in plain English" box
  (`NaturalLanguageInput`) in the Visual Builder panel — a friendlier sibling to the power-user
  `TextQueryInput`, same "fill the builder" `load`-action contract, plus an echo of what was
  understood and a gentle miss note; Foundry primitives, design tokens and a11y throughout. No
  migration, no schema change, no new dependency. `/code-review` (high): no correctness bugs; one
  low-severity robustness gap fixed (a location name beginning with a determiner, e.g. "The Shed").
  69 new tests (pure-seam intents/combinations/robustness + a `parseASTtoSQL` round-trip proving
  every emitted tree is translatable, plus a component test of the affordance); typecheck + full
  search suite green in merged `main`; production `vite build` clean.

- **G6 — Related-items cross-links ("works with" / accessory / spare-for)** — shipped 2026-07-10.
  A synced many-to-many relation *between items*, distinct from variants (same product) and kits
  (assemblies), surfaced on a new **Related** tab in the ItemDetailDialog. New v5 migration adds an
  `item_relations` join table — an LWW leaf (own `updated_at` + auto-stamp trigger) with a
  **deterministic primary key** (`from|to|kind` canonical triple, minted by `itemRelationId`), so two
  devices independently adding the same logical relation converge by ordinary LWW rather than
  colliding on a UNIQUE business key (no bespoke reconcile handling needed, unlike `item_aliases`).
  Both endpoints are `REFERENCES items(id) ON DELETE CASCADE` + a `from <> to` CHECK; `kind` is free
  TEXT (no CHECK, app-enforced by `normaliseRelationKind`) so a future kind syncs forward. Added to
  `SYNC_TABLES` + reconcile `FK_REFS` (both item FKs, non-null) and the golden baseline snapshot was
  regenerated (user_version 5). New pure `features/inventory/item-relations.ts` seam owns all the
  non-trivial logic — kind normalisation, pair canonicalisation (symmetric `WORKS_WITH` orders its
  endpoints), the deterministic id, dedupe, and the **reciprocal** label resolution ("Accessory for"
  ⇄ "Has accessory", "Spare for" ⇄ "Has spare") — dependency-free and exhaustively unit-tested. A
  small `withRelations` ItemRepository mixin (`addRelation`/`listRelations`/`removeRelation`) is thin
  SQL glue: add is idempotent (deterministic id) and validated via `planRelation`; remove DELETEs +
  tombstones only an id that existed (no stray peer-delete). `RelationsEditor` (Foundry
  `SelectField`/`Button`/`Input`/`InfoHint`, design tokens + a11y) lets you add/remove reviewable,
  reciprocal links. `/code-review` (high): 2 cleanup findings fixed, no correctness bugs. 102 new
  tests (pure seam + repo + two-device sync round-trip incl. reciprocity, deterministic-id
  convergence, tombstone propagation, and the FK guard); verified end-to-end in the built app (vite
  preview, real OPFS sqlite-wasm): fresh-boot applies v5, a relation adds, shows reciprocally,
  persists across reload and removes cleanly with no console errors.

- **G2 — On-device receipt / label OCR prefill** — shipped 2026-07-10. New pure
  `features/inventory/ocr/receipt-ocr.ts` seam (`parseReceiptText` → currency-aware price with
  UK/EU decimal handling + total-keyword ranking, day-first/US date disambiguation, labelled
  MPN/serial extraction) — dependency-free, no DOM/worker/Tesseract import, exhaustively
  unit-tested. Lazy, feature-detected `ocr-engine.ts` (`hasOcr`, injectable
  `OcrRecognizerFactory`, `runReceiptOcr`) runs **Tesseract.js WASM in a worker** (OEM 1 LSTM,
  `fast`/`best` model tiers) loaded from our own origin under `/ocr/` — keyless, CSP-compliant
  (`worker-src 'self' blob:` + `wasm-unsafe-eval` already present), no third-party CDN. The
  worker + WASM cores + language models are **precache-excluded** (`injectManifest.globIgnores`
  `**/ocr/**`) so the base offline shell never bloats; `scripts/setup-ocr-assets.mjs`
  (`npm run ocr:assets`) stages the worker/cores from `node_modules` and downloads the models
  into a **git-ignored** `public/ocr/` (no multi-MB binaries in the repo). Reviewable
  `OcrPrefillDialog` + `useReceiptOcr` wired into the Create-item form behind an opt-in
  `ocrEnabled` toggle (default off) with a `fast`/`best` accuracy choice in Settings; fills only
  blank fields, never auto-writes. Added an **Acquired date** field to the create form as a
  prefill target (serial, which has no field, goes to Notes). `/code-review` (high): 3 findings
  fixed (money-parse multi-separator decimal, a slash-date's year outranking the total, an
  unlabelled hidden file input). 46 new tests; verified end-to-end in the built app under vite
  preview (real WASM engine + production CSP): a rendered receipt yields price 12.99, date
  2024-03-15 and MPN NE555P with no console errors.

- **G3 — Local reminder notifications** — shipped 2026-07-10. The alert centre's four lanes
  (low stock, expiry, maintenance-due, warranty-due) now surface as **OS notifications** from an
  installed PWA, via the Notification API + the service-worker registration, plus best-effort
  Periodic Background Sync where present. **Local only — never Web Push** (backend-less PWA);
  degrades silently where notifications are unsupported/denied (iOS Safari). New pure
  `features/alerts/reminders.ts` seam (`planReminders`, `periodicSyncAction`,
  `normaliseReminderKinds`) decides "what fires now" out of glue — quiet when
  unsupported/denied/off, per-lane opt-in, dedupe via a device-local notified set reconciled to
  the live feed (a resolved-then-recurring condition re-fires), and a single summary above a
  small threshold so enabling never unleashes a storm — exhaustively unit-tested alongside a
  `useReminderFiring` glue test. Injectable `reminder-api.ts` seam over `showNotification` +
  periodic sync (the `useWakeLock`/`useInstallPrompt` `apiOverride` pattern), with
  `hasNotifications` / `hasPeriodicSync` feature detection. `useReminderFiring` fires from the
  live feed but is mounted **only while enabled**, so an off-by-default feature runs no queries;
  `useReminderPeriodicSync` reconciles the background wake; `useNotifiedRemindersStore` persists
  the set. App-wide `ReminderNotifications` (inside BootGate) deep-links a notification click
  (SW `notificationclick` focuses/opens + posts the target; `periodicsync` re-checks live
  clients) via an SW-safe shared `reminder-messages.ts` that keeps React/feature-detection out of
  the worker. Opt-in Settings controls (master + per-lane) request permission through the Foundry
  Select; new `remindersEnabled` / `reminderKinds` Tier-2 preferences. Verified in the built app
  (vite preview): the SW is ready with `showNotification` + `periodicSync`, the app boots with
  the mount present and no page errors, and the Settings control renders and gates on permission.

- **G9 — Manual current-value / revaluation history (appreciating assets)** — shipped
  2026-07-10. New v4 migration adds `items.current_value` (nullable, non-negative) and a
  syncable append-only `revaluations` log table (FK → items CASCADE, LWW leaf); a new pure
  `valuation.ts` seam beside `asset-lifecycle.ts` (`effectiveUnitValue` = manual value wins
  over the depreciated replacement cost, `describeValueChange`, `buildRevaluationSeries`,
  exhaustively unit-tested). `ItemRepository.recordRevaluation` appends a log point + sets the
  live value + logs a `REVALUED` activity entry in one transaction. The valuation reports and
  G1's insurance schedule value each line through `effectiveUnitValue`, so an appreciating
  asset is scheduled at today's worth. `RevaluationEditor` in the item Asset tab shows the
  current value + trend vs purchase, a sparkline, a record-revaluation form and the value
  history (the depreciated figure is relabelled "Book value" to disambiguate). Manual current
  value / revaluation stays **manual** — live secondary-market price feeds remain a non-goal.

- **G1 — Insurance / estate schedule export (print + PDF)** — shipped 2026-07-10. New
  `/insurance-schedule` route + `InsuranceScheduleScreen`: a room-by-room, print-styled
  schedule (photo, name, serial, purchase price, acquired, warranty, condition, per-item
  replacement value) with per-location subtotals + a grand total, printed natively via
  `window.print()` ("Save as PDF") — no PDF dep. Pure `insurance-schedule.ts` aggregation
  seam values each line through `effectiveUnitCost` with a clean `currentValuePerUnit` hook
  for G9; reached from the Reports screen. `@media print` drops app chrome, forces a legible
  white/black scheme, and paginates with a repeating table header.

## Deliberate non-goals (recorded so they are not re-proposed)

- **Cloud AI photo-recognition / auto-categorization / value-estimation** (Scanlily et al.) —
  requires a cloud model + key; violates offline / secret-free / local-first. On-device OCR (G2)
  is the aligned subset we *will* do.
- **Live secondary-market price feeds** (eBay / Discogs / StockX scraping for auto-valuation) —
  needs a keyed cloud API and continuous network access; conflicts with local-first / secret-free.
  G9 covers the aligned subset (manual current value + revaluation history).
- **Cloud receipt-OCR services** — same reason; G2 does it on-device instead.
- **Multi-user accounts, roles/permissions, chain-of-custody signatures, EULA-on-checkout**
  (Snipe-IT) — single-device local-first is the design, not a gap.
- **General UPC product DB needing an API key** (UPCitemdb etc.) — Open Food Facts (keyless,
  groceries-only) is the deliberate ceiling; a hardware-barcode miss is a `NOT_FOUND`, not a bug.
- **Grocy household extras** — battery tracking, chores, recipes/meal-planning: per-item recurring
  tasks are already covered by maintenance schedules; the rest is out of Gubbins' scope.

## Known small technical residue

Already tracked in `docs/dev/deferred-features.md` — not re-listed here (true NTP time source,
hard-failing bundle-size CI gate, leaner/precache-excluded WASM decoder, multi-scrape UI tray,
live distributor-selector maintenance, `useItemHistory` UI consumer). Leave them in that tracker.
