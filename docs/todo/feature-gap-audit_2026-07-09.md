# Feature-gap audit — backlog (living plan)

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

- [ ] **G2 — On-device receipt / label OCR prefill.** *Medium; opt-in, fully offline.* Attachments
  exist but nothing extracts data from them. Add an **opt-in** OCR (Tesseract.js WASM — keyless,
  no cloud, runs in a worker like the scanner) that reads a photographed **receipt or product
  label** and pre-fills a *reviewable* Create/Edit-item draft (price, date, model/MPN, serial).
  Never auto-writes. Lazy-loaded + **precache-excluded** so it never bloats the base bundle.
  Grounding: Sortly cloud OCR + 2026 receipt-scanning cohort — but do it **on-device** to keep the
  secret-free/offline promise (the cloud-AI versions are a deliberate non-goal, below).

- [ ] **G3 — Local reminder notifications.** *Medium; PWA-native.* The alert/agenda engine already
  computes overdue loans, expiring warranties, due maintenance, and low stock — but the only
  delivery surface is in-app. For an **installed** PWA, surface them via the Notification API +
  service worker (and Periodic Background Sync where present) as OS notifications. **No server**
  (local notifications only; not Web Push). Degrade silently where absent/denied (iOS Safari) —
  same injectable-seam + feature-detect pattern as `useWakeLock` / `useInstallPrompt`.

- [ ] **G4 — UI internationalization (multi-language).** *Medium value, large effort.* Only
  number/date/currency formatting is locale-aware (`lib/format.ts`); **all UI copy is
  English-only**. Extract strings behind a lightweight typed `t()` over JSON message catalogs (no
  heavy dep — avoid a framework unless justified) so additional languages can ship. Big sweep;
  stage it (seam + English catalog first, then one pilot language). Real breadth gap vs. mature
  tools.

- [ ] **G5 — In-app natural-language → query.** *Low-medium.* The NL path exists only for external
  agents (MCP / HA "where are my…"). Add a **rule-based, no-LLM** NL layer over the existing
  `parseTextQuery` → AST so "low stock screws in the garage" resolves without learning the
  `field:value` / `cap:key>n` syntax. Extends the existing parser (§5.1); produce the AST, never
  hand-build SQL.

- [ ] **G6 — Related-items cross-links ("works with" / accessory / spare-for).** *Low / niche.* A
  synced M:N relation between items, surfaced on the item detail — distinct from **variants** (same
  product) and **kits** (assemblies). Follow the `item_tags` M:N + LWW-leaf sync pattern.
  Maker/collection value; only if wanted.

- [ ] **G7 — Per-instance test / calibration / service records (InvenTree parity).** *Low / niche.*
  Structured pass/fail + reading logs per **serialised** unit, beyond free-form maintenance
  history. Model on the existing history/maintenance seams. Narrow audience (lab/maker QA).

- [ ] **G8 — Manual "to-buy" / wishlist.** *Low.* Reorder automation covers *stock-driven* buying;
  a manual list of **wanted-but-not-owned** items is a separate small surface. Marginal — likely
  fold into an existing list rather than a new screen.

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
