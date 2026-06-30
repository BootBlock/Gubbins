# PHASE_HANDOVER.md — Phase 72 (CSV import/export of custom fields) — ✅ COMPLETE

**Project:** Gubbins — local-first inventory-tracking PWA
**Phase completed:** **Phase 72 — CSV import/export of custom fields.** Extends the Phase-67 catalogue CSV
so category **custom fields** import and export alongside the core item fields, built **entirely on the
existing** `category_fields` (definitions) + `item_field_values` (EAV values) system owned by
`CategoryRepository`. **No migration, no new tables, no second write/validation path** — imports validate
through the **Phase-70** `validateFieldValue` seam and persist through `CategoryRepository.setItemFieldValues`;
exports read through `resolveItemFields`. `user_version` is unchanged.
**Date:** 2026-06-30
**Status:** ✅ **Implemented in an isolated worktree; NOT merged (awaiting the orchestrator's code-review
gate).** `npx tsc -p tsconfig.app.json --noEmit` **clean (exit 0)**. **Unit tests 1533 pass across 136
files** (was 1515; **+18 tests, no new files** — extended `catalog-import.test.ts` and `export-data.test.ts`).
`npm run build` **clean** (precache 62 entries / 3230.94 KiB; the informational bundle-size line reports no
budget — no breach). `node --check scripts/browser-smoke.mjs` **parses**. **No dependency change.**

### What changed (files)
- **`src/features/inventory/catalog-import.ts`** — IMPORT seam. New `CustomFieldTarget` (`{ fieldId }`)
  mapping variant + `isCustomFieldTarget` guard; `ColumnMapping` widened to
  `ReadonlyArray<CatalogField | CustomFieldTarget | null>`. `inferColumnMapping(headers, customFields?)`
  resolves a non-core header to a custom field by normalised name (or raw field id). `extractRow` now
  partitions core vs custom cells. New `resolveCustomFieldValues` validates each custom cell through the
  **Phase-70** `validateFieldValue` seam — an invalid value or unknown field id is **collected as a row
  error (never thrown)**, required is enforced by the seam, blank-non-required coerces to `null` (clear).
  `CatalogCreate`/`CatalogUpdate` gained an optional `fieldValues` (only present when a custom column was
  mapped). `applyCatalogImportPlan(plan, repo, categories?)` persists those values via the supplied
  `CatalogCategoryRepository.setItemFieldValues` (the **only** write path) immediately after create/update;
  a custom-field write failure is recorded on the row's `error` without rolling back the item.
- **`src/features/inventory/catalog-import.test.ts`** — +14 tests: custom-field header inference (by name,
  by raw id, core-synonym-wins, first-wins dedup); plan coercion (valid create/update, canonical NUMBER,
  SELECT, invalid-collected-not-thrown, required-enforced, blank→null clear, unknown-field-id, absent
  `fieldValues` when unmapped); a `:memory:` apply test proving an imported value **lands on the item** via
  `resolveItemFields`, plus a `:memory:` test that a category-mismatch custom write is recorded as a row
  error while the item still imports.
- **`src/features/export/export-data.ts`** — EXPORT seam. New `CatalogCustomFieldColumn` (`{ fieldId,
  header }`). `buildCatalogCsv(items, customFields?, valuesByItem?)` appends one column per definition
  (header = field name), dedup by field id (first wins), per-item value from `valuesByItem` (blank when
  absent), RFC-4180 quoting on headers and values.
- **`src/features/export/export-data.test.ts`** — +5 tests: appends columns + values, blank cell for a
  missing value, dedup by field id, RFC-4180 quoting of a comma-bearing custom header/value, unchanged when
  no custom fields are supplied.
- **`src/features/export/run-export.ts`** — orchestration. New `collectCustomFieldColumns(items)` resolves
  each item's fields via `CategoryRepository.resolveItemFields` (the existing lenient-defaulting read path,
  never raw SQL), accumulating one column per definition encountered (first-seen order) + a value map keyed
  by item id; only **stored** values contribute (lenient defaults left blank so a re-import never pins a
  default into a stored row). The `CATALOG_CSV` branch threads these into `buildCatalogCsv`.
- **`src/features/inventory/components/CatalogImportWizard.tsx`** — wires the import UI to the new seam:
  loads every category's `listFields` into a ref, passes them to `inferColumnMapping` + `buildCatalogImportPlan`,
  and passes `getCategoryRepository()` into `applyCatalogImportPlan` so custom-field values actually persist.
  The map-step `<select>` value binding narrows away a `CustomFieldTarget` (the dropdown still lists core
  fields only). British English, Foundry primitives, design tokens unchanged.
- **`src/features/export/ExportWizard.tsx`** — Catalogue CSV hint now notes a column is included per
  category custom field. (Text only; no token/markup change.)
- **`scripts/browser-smoke.mjs`** — **+1 step** (see below).

### Browser-smoke step appended (merge-conflict resolution note for the orchestrator)
Inserted immediately **after** the Phase-67 catalogue-import step, **before** the Phase-68 alert-centre
step. Exact label:

> `imports a CSV custom-field column and the value lands on the item (Phase 72)`

It builds on the Phase-70 item `Smoke Custom ${stamp}` (already in the smoke category carrying the NUMBER
field `fieldName`): imports a CSV that **updates** that item by name with a column headed by the field name
and value `47.0`, applies it through the real import wizard, then reopens the item's Classification tab and
asserts the value persisted as the canonical `47`. Phase 71 appends its own `await step(...)` to the same
file; when merging the two reviewed branches, **keep both steps**, each closed with its own `});`.

### Key design decisions
- **No second write/validation path (binding).** Custom-field columns flow through the *same* Phase-70
  `validateFieldValue` seam and the *same* `CategoryRepository.setItemFieldValues` persistence as the
  in-app editor. The importer never inserts `item_field_values` rows itself; `setItemFieldValues`
  re-validates and enforces category membership.
- **Errors collected, never thrown.** An invalid custom value, an unknown field id, or a required-blank
  appends to `plan.errors` and skips the row — matching the Phase-67 dry-run contract.
- **Column→field resolution by name/key.** Headers auto-map to a custom field by normalised field name (or
  exact field id); a core synonym always wins a name clash; each custom field maps at most once.
- **Export reads stored values only.** Lenient-default values are exported blank, so an export→import round
  trip never converts a default into a pinned stored row.
- **Apply-time custom-field failure is non-fatal to the item.** If `setItemFieldValues` throws (e.g. the
  field is not on the item's category), the item create/update still counts and the row carries the field
  error — the import is not aborted.

### Verification & limitations (read this)
- In **this** worktree the `vite.config.ts` `**/.claude/worktrees/**` exclusion does **not** match the
  suite's own files (the glob is matched relative to the worktree root, so paths read as `src/…`). Result:
  `npm run test:run` here **did** sweep the new tests — **1533/1533 across 136 files, all green** —
  confirmed by `vitest -t "custom-field"` (2 files / 16 tests pass, rest skipped). The new files were also
  run directly: `vitest run src/features/inventory/catalog-import.test.ts src/features/export/export-data.test.ts`
  → **72/72**. `tsc` exit 0; `build` clean.
- The browser smoke step is **parse-validated only** (`node --check` passes) — the standing worktree
  limitation applies (Vite `server.fs.allow` won't serve the `sqlite-wasm` binary from outside the worktree
  root through the `node_modules` junction). The step is authored against the real wizard selectors/flow and
  follows the existing `await step(...)` structure.

---

# PHASE_HANDOVER.md — Phase 70 (custom-field validation seam + save-time hardening) — ✅ COMPLETE

**Project:** Gubbins — local-first inventory-tracking PWA
**Phase completed:** **Phase 70 — Custom-field validation seam + save-time hardening.** Makes per-item
custom-field *values* **typed-valid at the point of save**, built **on the existing** `category_fields`
(definitions) + `item_field_values` (EAV values, TEXT, `UNIQUE(item_id, field_id)`) system owned by
`CategoryRepository`. **No migration, no new tables, no second write path** — `user_version` is unchanged.
The pure seam is the same one the CSV import path (Phase 72) will validate through.
**Date:** 2026-06-30
**Status:** ✅ **Implemented in an isolated worktree; NOT merged (awaiting the orchestrator's code-review
gate).** `npx tsc -p tsconfig.app.json --noEmit` **clean (exit 0)**. **Unit tests 1515 pass across 136
files** (was 1492/135: +1 new file `custom-fields.test.ts`; +18 new tests — the pure seam plus 5 new
`CategoryRepository` `:memory:` validation tests). `npm run build` **clean** (precache 62 entries /
3228.89 KiB; the informational bundle-size line reports no budget — no breach). `node --check
scripts/browser-smoke.mjs` **parses**. **No dependency change.**

### What changed (files)
- **`src/features/inventory/custom-fields.ts`** *(new — the pure seam)* — `validateFieldValue(def, raw,
  opts?)` (never throws; returns `{ ok: true; value: string | null } | { ok: false; error }`) and
  `fieldsForCategory(defs, categoryId)`. Pure, injectable (clock via `opts.now`), **no DB**. Mirrors the
  sibling `operational-metadata.ts` / `cycle-count.ts` seams.
- **`src/features/inventory/custom-fields.test.ts`** *(new)* — every field type, required-blank → error,
  required-satisfied, optional-blank → null, NUMBER malformed + canonical re-serialise (+ hex literal),
  DATE malformed + leap-year + canonical, SELECT not-in-options, BOOLEAN normalisation, TEXT trim; plus
  `fieldsForCategory` filtering / ordering / no-mutation.
- **`src/db/repositories/CategoryRepository.ts`** — `setItemFieldValues` now widens the `category_fields`
  SELECT to fetch the **full** definitions (reusing `rowToCategoryField` into a `Map<fieldId,
  CategoryField>`) and validates each incoming value through `validateFieldValue`: a failure throws
  `DbError('SQLITE_CONSTRAINT', <error>)`; a pass persists the **canonical/coerced** value (so `'1.50'` is
  stored as `'1.5'`); a value that validates to `null` takes the existing tombstone-on-clear path. The
  UUID-id + `UNIQUE(item_id, field_id)` upsert is unchanged (no deterministic-id switch).
- **`src/db/repositories/CategoryRepository.test.ts`** — +5 `:memory:` tests: reject invalid NUMBER /
  SELECT-not-in-options / required-blank; canonical round-trip (`'1.50'` → resolves `'1.5'`); clear-to-null
  still tombstones (asserts a `tombstones` row for `item_field_values`).
- **`src/features/inventory/components/CustomFieldsEditor.tsx`** — validates each *changed* field via the
  seam before save; the "Save N changes" button is disabled while any field is required-but-empty or
  invalid; each field error is surfaced accessibly as a `role="alert"` node that is a **sibling** of its
  `<label>` (Phase-51 pattern) wired via the pure `fieldAria` seam (`aria-invalid` + `aria-describedby` on
  the control). The lenient-default display + tooltip behaviour is preserved. `CategoryManagerDialog.tsx`
  was **not** touched (no in-surface need). Foundry primitives, design tokens, British English.
- **`scripts/browser-smoke.mjs`** — +1 step (*"validates & round-trips a category custom field on an item
  (Phase 70)"*): creates an item in the smoke category, opens the Classification tab, asserts a non-numeric
  value keeps the save button disabled, then saves `'12.50'` and on reopen asserts it round-trips as the
  canonical `'12.5'`.

### Key design decisions
- **NUMBER canonicalisation** = `String(Number(text))` after a `Number.isFinite` gate. `'1.50'` → `'1.5'`,
  `'01'` → `'1'`, `'-0'` → `'0'`, `'1e3'` → `'1000'`. `Number('0x10')` is a *legitimate* finite 16, so a
  hex literal is **accepted** and stored as decimal `'16'` (documented + tested) — only NaN/±Infinity are
  rejected.
- **DATE** is parsed by hand from `YYYY-MM-DD` (regex + explicit month/day bounds with a Gregorian
  leap-year check) rather than `new Date(str)`, because the `Date` constructor silently rolls overflow over
  and is timezone-sensitive — so `2026-02-30` / `2026-13-01` are correctly rejected, not coerced. Output is
  the canonical zero-padded ISO form.
- **Threading defs into `setItemFieldValues`** — the SELECT at the field-membership check was widened from
  `SELECT id` to `SELECT *` and mapped via the existing `rowToCategoryField`, so the same query that proves
  field-belongs-to-category also yields the full type/options/required/name the seam needs. One query, one
  mapper, no extra round-trip.
- **Editor a11y** — reused the `fieldAria` pure seam directly (rather than wrapping each control in
  `FormField`) because the editor's label carries the required-`*` marker and the default-value tooltip
  badge; keeping the bespoke `<label>` + a sibling `role="alert"` + `aria-describedby` matched the existing
  markup with the least churn while satisfying WCAG 3.3.1.

### Verification & limitations (read this)
- The full suite **cannot be run from inside the worktree via `npm run test:run`**: `vite.config.ts`
  excludes `**/.claude/worktrees/**`, which matches this worktree's *own* absolute path, so it self-excludes
  every test here (a `node:sqlite`/duplicate-React safety measure for *parallel* worktrees — see the
  Phase-69 note). It was verified with a **throwaway** `vitest.verify.config.ts` (created in the worktree,
  run, then **deleted** — not committed) that replaced only the `exclude` list: **1515/1515 across 136
  files**, all green, including all 33 new/touched assertions. `tsc` and `build` run unaffected.
- The browser smoke step is **parse-validated only** (`node --check`), not run end-to-end — the same
  Phase-69 limitation applies (Vite `server.fs.allow` won't serve the `sqlite-wasm` binary from outside the
  worktree root through the junction). The step is authored against the real selectors/flow and follows the
  existing `await step(...)` structure.
- **Path gotcha encountered & recovered:** the implementer's tools initially edited the *main* checkout
  (the Read calls had used `P:\Source\TypeScript\Gubbins\src\…` paths); those edits were copied into the
  worktree and the main checkout was reverted to pristine before committing. All committed changes live in
  the worktree only.

---

# PHASE_HANDOVER.md — Phase 69 (migration baseline consolidation) — ✅ COMPLETE

**Project:** Gubbins — local-first inventory-tracking PWA
**Phase completed:** **Phase 69 — Migration baseline consolidation.** Collapsed the 24-step migration
history (`v1-initial` … `v24-item-asset-lifecycle`) into a **single `v1-initial` baseline** that builds the
entire current schema in one step. Gubbins is **pre-release with disposable developer-only data**, so no
incremental upgrade path from an older on-disk version is needed. The migration **engine** and all its
supporting machinery are **untouched**: `runMigrations` / `getUserVersion` / the strict-contiguity
`assertValidSequence` guard (`engine.ts`), the `Migration` type + `SQL_NOW_MS` (`migration.ts`), the
`run-unit-tests.mjs` cold-start retry wrapper, and the sync wiring (`tombstone.ts` `SYNC_TABLES`,
`reconcile.ts` `FK_REFS`) — no schema change, so the sync surface is identical.
**Date:** 2026-06-30
**Status:** ✅ **Implemented in an isolated worktree; NOT merged (awaiting the orchestrator's code-review
gate).** `npx tsc -p tsconfig.app.json --noEmit` **clean (exit 0)**. **Unit tests 1492/1492 pass across 135
files** (was 1626/157; −23 per-step migration test files for v2…v24, +1 new equivalence test
`v1-initial.test.ts` ⇒ −22 files net; the 134 fewer individual tests are the removed per-step migration
assertions). **No dependency change. No runtime schema or behaviour change** — the squashed schema is
byte-for-byte identical to the v24 head, proven by the golden-equivalence test.

### What changed (files)
- **`src/db/migrations/v1-initial.ts`** — rewritten as the single consolidated baseline (`version: 1`,
  `name: 'initial-baseline'`). Its `statements` are the **exact, ordered concatenation** of the original
  v1…v24 `statements` (minus the per-step `user_version` bumps — the engine still appends one, for v1).
  Reuses the `updatedAtTrigger()` helper, the `SQL_NOW_MS` epoch expression, and the CHECK-list constants
  (`FIELD_TYPES`, `ATTACHMENT_KINDS`, `TRACKING_MODES`, …) from `repositories/constants.ts`, so the enum
  CHECKs stay in lock-step with the application constants. Tables precede the children that reference them,
  triggers follow their tables, the v5 FTS5 index follows its `items` content table, and the v13
  `item_stock` / v15 `stock_batches` recompute triggers follow their ledgers — the dependency order the
  chain already ran in.
- **`src/db/migrations/index.ts`** — registry pruned to `[v1Initial]`; v2…v24 imports/entries removed.
  `TARGET_SCHEMA_VERSION` derives from the registry max ⇒ now **1** (verified by test).
- **`src/db/migrations/v1-initial.test.ts`** *(new)* — the golden-equivalence proof.
- **`src/db/migrations/__fixtures__/schema-baseline.snapshot.json`** *(new, the GOLDEN CONTRACT)* — the full
  deterministic schema dump (every `sqlite_master.sql` object; per-table `table_info` / `foreign_key_list` /
  `index_list`; `user_version`) of the **original v1…v24 chain**, captured once.
- **`src/db/migrations/__fixtures__/schema-snapshot.ts`** *(new)* — the `captureSchemaSnapshot` helper used to
  dump that shape (test-only; depends on the in-memory `node:sqlite` driver, never imported by production).
- **Deleted:** `v2-*.ts … v24-*.ts` and their `*.test.ts` (46 files).
- **`scripts/browser-smoke.mjs`** — +1 step (*"a clean boot migrates to the consolidated v1 baseline and
  serves a queryable DB (Phase 69)"*): reloads the app and asserts it reaches the workspace and its
  DB-backed inventory result-count region renders — proving a fresh boot migrates to v1 and the DB is
  queryable.

### Why a composed statement stream (key decision — scrutinise this)
The golden snapshot's `sqlite_master.sql` is the **stored** schema text. SQLite stores an `ALTER TABLE ADD
COLUMN` by appending the column verbatim at the *tail* of the original table's stored `CREATE` (after the
last declared column, before the table-level CHECKs), preserving the original whitespace. So hand-folding
those ALTER-added columns into a clean `CREATE` would **not** reproduce the stored text byte-for-byte. The
only method that satisfies the hard "byte-for-byte identical" contract is to **re-issue the original
statement stream** (original CREATE + original ALTERs, in order). That is what the new `v1-initial` does —
it is genuinely one baseline that builds the whole schema in dependency order, and the equivalence test
proves zero drift. (This is the one place the spec's "fold into each CREATE" wording was superseded by its
overriding "must be byte-for-byte identical" constraint.)

### Proof of zero drift
`v1-initial.test.ts` builds a fresh DB from the new baseline, dumps the same snapshot, and asserts
`snapshot.objects` and `snapshot.tables` **deep-equal** the committed golden fixture (all 107
`sqlite_master` objects across 32 tables — every table, index, trigger, FK and column). `user_version` is
the one intentional difference (the squashed schema re-baselines to **1**; the fixture records the original
**24**), asserted separately: the new baseline boots `0 → 1`, `applied = [1]`.

### ⚠️ Developer action required — WIPE the disposable dev DB
A developer's existing dev database sits at `user_version = 24` and **cannot "upgrade" to a v1 baseline** —
the engine only applies migrations *newer* than the current version, so against an existing v24 DB the new
v1 baseline is a no-op (nothing runs) and a *fresh* DB now lands at v1. This is intended (pre-release,
disposable data): **delete/clear the local OPFS database** (the app's "wipe" / storage-reset path, or clear
site data) so it re-creates cleanly from the consolidated baseline. New installs are unaffected.

### Browser smoke — could not run end-to-end in this worktree (environment limitation)
The smoke harness needs a live dev server serving the `@sqlite.org/sqlite-wasm` WASM. In this **isolated
worktree**, `node_modules` is a **junction** to the main checkout, and Vite's `server.fs.allow` will not
serve the WASM binary from outside the worktree root — the `.wasm` request falls through to the SPA
`index.html` (HTTP 200 `text/html`), so `WebAssembly.instantiate` fails ("expected magic word … found `0a
20 20 20`") and the app never boots. Consequently the very first, pre-existing step ("loads and reaches the
inventory workspace") — which I did not modify — already fails, and every DB-dependent step cascades; only
the DB-independent "cross-origin isolated" step passes. This is **purely a junctioned-worktree artifact**,
unrelated to the migration squash (my change touches only `src/db/migrations/**` and one smoke step). The
added smoke step **parses cleanly** (`node --check scripts/browser-smoke.mjs` OK) and follows the existing
`await step('label', async () => { … })` structure exactly; it should pass on a normal checkout where the
WASM is served. The migration squash itself is fully validated by the **1492 passing unit tests**, which
run the real `node:sqlite` engine (FTS5-capable) and include the byte-identical equivalence proof.

---

# PHASE_HANDOVER.md — inventory-breadth plan (Phases 64–68) — ✅ COMPLETE · no next phase

**Project:** Gubbins — local-first inventory-tracking PWA
**Plan completed:** **The combined a11y + inventory-breadth plan (Phases 64–68) is COMPLETE.** Phase 64
(aria-live Tier B) finished the accessibility arc; Phases 65–68 closed the second feature-gap audit —
65 procurement automation, 66 asset lifecycle (migration **v24**), 67 bulk CSV import, 68 alert centre.
Run as Wave 1 {64} → Wave 2 {65,66,67} (three parallel worktrees) → Wave 3 {68} alone; **one worktree +
implementation sub-agent per phase, each through its mandatory pre-merge code-review gate** (all CLEAN
with NITs — fixes applied, waived findings recorded in the per-phase Outcome notes in
`docs/todo/inventory-breadth_2026-06-30.md`).
**Date:** 2026-06-30
**Status:** ✅ **All merged to `main` (final merge `32c0c7f`).** `npx tsc -p tsconfig.app.json --noEmit`
clean · **1626/1626 unit tests** (157 files, +156 over the 1470 post-Phase-63 baseline) · `npm run build`
clean (precache **3230.27 KiB**, no budget) · +5 browser-smoke steps (one per phase). **Schema:
`user_version = 24`** (Phase 66's `v24-item-asset-lifecycle`; 64/65/67/68 add no migration; registry
contiguous v1…v24, strict guard intact). **No dependency change.** `build:extension` NOT re-run (no
§9/extension edit in any phase).

> **No next phase in this plan.** Future inventory work starts a fresh plan document. The second
> feature-gap audit's remaining in-scope candidates (category custom-field templates; advanced analytics
> / ABC / turnover / aging; label customisation) are parked in `docs/dev/deferred-features.md` and the
> plan doc's *Deferred* section for a possible later wave. Web push for the alert centre is a Backlog
> trigger (backend-less PWA).

---

## Reference — Phase 64 (aria-live Tier B) — ✅ COMPLETE

**Project:** Gubbins — local-first inventory-tracking PWA
**Phase completed:** **Phase 64 — aria-live Tier B** (accessibility, §3 / WCAG 4.1.3). Finished the carried
"Further aria-live" backlog item: always-mounted `aria-live="polite"` result-count regions on the **Projects**,
**Contacts** (contacts count + on-loan/overdue) and **Purchase-order MASTER list** screens, mirroring the
Phase-40 Inventory pattern. Reused the existing **P42 `LiveRegion`/`role="status"` seam** — **no new primitive,
no dependency, no migration** (`user_version` stays **23**). The `ActivityLog` `isFetchingNextPage` spinner swap
was **deferred** (no count ⇒ not a WCAG 4.1.3 status message) and re-scheduled to Backlog in
`docs/dev/deferred-features.md`.
**Date:** 2026-06-30
**Status:** ✅ **Merged to `main` (`5560550`).** `npx tsc -p tsconfig.app.json --noEmit` clean · **1493/1493
unit tests** (152 files, +23) · 1 new browser-smoke step.
**Execution model:** one implementation sub-agent in an isolated git worktree + a **mandatory code-review
sub-agent gate** before merge. Review verdict **CLEAN with NITs**: two fixed by the orchestrator pre-merge
(contacts smoke `aria-live` assertions; contacts count region gated on `data == null` not `isLoading` for
"don't-know-yet" precision); one waived (the `isLoading`-vs-`isSuccess` divergence from the Inventory pattern —
both correct, informational). Full detail in auto-memory [[phase-64-scope-decisions]].

**In flight — Wave 2 of the inventory-breadth plan ({65 procurement automation, 66 asset lifecycle v24, 67
bulk CSV import}, three parallel worktrees)**, then Wave 3 {68 alert centre} alone. Plan doc:
`docs/todo/inventory-breadth_2026-06-30.md`. Only Phase 66 touches schema (**v24**).

> **Numbering note.** This a11y lineage owns Phases **63–64**. The **"inventory-breadth"** plan (auto-memory
> `feature-gap-audit-2026-06-30b`) **renumbers to follow it (≥ 65)** and lives in its own plan doc
> (`docs/todo/inventory-breadth_2026-06-30.md`).

---

## Reference — prior plan: Inventory-depth Phases 59–62 — ✅ COMPLETE

**Project:** Gubbins — local-first inventory tracking PWA
**Plan completed:** **Inventory-depth Phases 59–62** — competitor-gap closure. Wave 1 ({59, 60, 61})
ran as three parallel git worktrees; Wave 2 ({62}, the final phase) ran alone after Phase 60 merged.
Each phase had its own worktree + implementation sub-agent, a **mandatory code-review gate before
merge**, and was merged to `main` in ascending migration order by the orchestrator.
**Date:** 2026-06-30
**Status:** ✅ **Plan complete — no Wave 3, no next phase.** `npm run type-check` clean (exit 0) ·
`npm run build` passes (bundle reporter prints **~3079 KiB, no budget — informational only**) ·
**1436/1436 unit tests pass** across **145 test files** on the **`threads`** pool · the browser
smoke gained **4 new steps** (one per phase) · `test:e2e` **102/102** (Phase 62 worktree run).
**Schema: `PRAGMA user_version = 23`** (v21 reorder points, v22 supplier-parts, v23 purchase orders;
Phase 61 added no migration). **No dependency change.** **`build:extension` NOT re-run** (no §9 /
`extension/` edit in any phase).

> ℹ️ **Plan & execution model (now closed).** This was `docs/todo/inventory-depth_2026-06-30.md`
> (Phases 59–62), a parallelised competitor-gap closure with **pre-allocated migration versions**
> (59→v21, 60→v22, 61→none, 62→v23) so concurrent worktrees never claimed the same `user_version`.
> All four phases are merged and reviewed; the plan doc's "Plan complete — no continuation" section
> records the final state. **There is no next phase in this plan** — future inventory work starts a
> fresh plan document. The one tracked follow-up (adopt the Phase-60 `supplier-cost.ts`
> `effectiveUnitCost` in the Phase-61 report cost seam) is now **done** (2026-06-30): the reports
> `effectiveUnitCost` delegates precedence to `supplier-cost.ts` and `ReportRepository` feeds it the
> preferred supplier cost. The **tier-2 monolith decomposition is also complete** —
> `ProjectRepository` (`0e8d251`), `reconcile()` (`12e47cb`) and `LocationSidebar` (`51945ce`) were all
> split & merged on 2026-06-29 and re-verified on 2026-06-30 (tsc clean, 1441 tests green, design
> tokens / APG tree contract / public API all intact). The only standing tech debt is now the
> trigger-gated Backlog (no item carries a live trigger today).

---

## 0. Wave-1 orchestration notes the Phase-62 agent should know

- **Migration-engine contiguity guard.** Phase 60's worktree (run before Phase 59 merged)
  legitimately lacked `v21`, so its agent temporarily relaxed `assertValidSequence`
  (`src/db/migrations/engine.ts`) from strict-contiguity to ascending-unique to boot. On merge the
  registry is contiguous again (v20→v21→v22), so the **strict-contiguity guard was restored**
  (commit `730e93e`). **Phase 62 branches from a `main` already at v22 and appends v23 — that is
  contiguous, so no engine change is needed or wanted.** Just append v23.
- **Merge-conflict surface (as the plan predicted).** The only merge conflicts were trivial:
  array-append clashes in `src/db/migrations/index.ts` and three new `scripts/browser-smoke.mjs`
  steps inserted at the same spot. `mappers.ts`, `src/db/repositories/index.ts`, the icon registry,
  `SYNC_TABLES`, and `FK_REFS` auto-merged. Expect the same shape for Phase 62 (resolve by keeping
  both lines, ascending order; keep all smoke steps, each fully `})`-closed before the next).
- **Worktree dir cleanup on Windows.** `git worktree remove --force` can hit `Permission denied`
  if a file handle lingers; the branch still deletes and `git worktree prune` clears the admin
  record. A leftover dir under `.claude/worktrees/` is harmless.
- **Carried smoke flag (pre-existing, NOT a Wave-1 regression).** The §4 multi-level variants step
  *"nests a sub-variant beneath a variant (Phase 18)"* was reported failing on `main`'s baseline by
  the Phase-61 agent (a `locator.waitFor` timeout in the variants path; untouched by any Wave-1
  diff). Verify and close this during Phase 62. The long-standing **"adds a weighted capability"
  `press('Enter')` flake** also persists — **re-run the smoke once** before investigating a red.

---

## 1. Locked decisions & toolchain (spec §1.2 — binding, unchanged)

| Area | Decision |
| --- | --- |
| SQLite WASM | `@sqlite.org/sqlite-wasm` — official build, FTS5 + **OPFS VFS** (`/gubbins.sqlite3`). FTS5 verified at boot via `probeFts5`. |
| Package manager | **npm** (only `package-lock.json`). |
| Hosting | **GitHub Pages** → Vite `base: '/Gubbins/'` + coi-serviceworker COOP/COEP (`src/sw.ts` injectManifest). PWA `registerType: 'prompt'` — a waiting worker installs but holds until the in-app `PwaUpdatePrompt` "Reload now". |
| Cloud sync | **Provider-agnostic** `CloudProvider` interface; in-memory + File System Access adapters. **No provider SDK** in the dep tree. |
| Conflict resolution | Row-level **LWW** + tombstones (§7.2, 180-day TTL); **Delta-CRDT** gauge replay (§7.3); §7.5 orphan re-parent + cycle rejection + child-FK guard. |
| Extension bridge | **`window.postMessage`** Content-Script bridge (§9); seven-member `SCRAPE_ERROR` set. **Untouched since P36** (and untouched by Wave 1). |
| Test runner | **Vitest**, native `crypto.randomUUID()`, `Intl`, **`test.pool: 'threads'`**, `npm run test:run` wraps `vitest run` with a single auto-retry of the Node-25 cold-start flake (`scripts/run-unit-tests.mjs`). |
| E2E | **Playwright** driving system **Edge** (`channel: 'msedge'`); fake camera; `setOffline` for connectivity; a second device via `localStorage['gubbins:device-id']` + reload. Custom `LocationSelect` combobox driven by role+click, never `selectOption`. |
| Bundle size | **No budget (P44).** `scripts/check-bundle-size.mjs` is informational only. |
| Native-first | Web APIs over NPM bloat; virtualised bounded lists; native BarcodeDetector → off-thread zxing; `Intl` via `makeFormatters`/`useFormatters`; design tokens only. |
| Base currency / locale | **GBP / en-GB** defaults, user-configurable. |

**Installed majors (unchanged by Wave 1):** React 19 · TS 6 · Vite 8 (Rolldown) · Vitest 4 · Tailwind 4 ·
TanStack Router/Query/Virtual · Zustand 5 · React Hook Form 7 + Zod 4 · lucide-react · vite-plugin-pwa ·
react-error-boundary · `fflate` · `@zxing/library`. Node **v25.2.1**.

**Commands:** `npm run dev` · `npm run build` · `npm run type-check` · **`npm run test:run`** (1395) ·
`npm run test:e2e` (live dev server) · `npm run check:bundle` · `npm run build:extension`. Launch the dev
server in a persistent background process (Bash `run_in_background`, or `cmd.exe /c "npm run dev"` —
`Start-Process npm` fails); pass `SMOKE_BASE=http://localhost:<port>/Gubbins/` if not on 5173; stop via PID.
`$pid` is a read-only PowerShell automatic variable — use another loop variable.

> ⚠️ **`npm run type-check` pipe trap:** capture `${PIPESTATUS[0]}` / `$LASTEXITCODE`; piping `tsc` through
> `tail`/`head` masks the exit code. **Route-tree** (`src/routeTree.gen.ts`) is generated by Vite, not `tsc` —
> if you add a `src/routes/*` file (Phase 61 added `reports.tsx`), run `npx vite build` once before type-check.
> `noUnusedLocals` + `noUncheckedIndexedAccess` are on. A pure `.ts` and a component `.tsx` must not share a
> basename (P42). Design tokens only — never raw hex / Tailwind palette classes.

---

## 2. Database schema snapshot — `PRAGMA user_version = 23`

Migration registry (`src/db/migrations/index.ts`) is contiguous **v1 … v23**; `TARGET_SCHEMA_VERSION` is
derived as the max registered version. The engine strict-contiguity guard is intact. New since the
previous handover (v19/v20):

- **v20 `v20-project-budgets`** (Phase 58, pre-existing at the start of this wave): §4 project budgeting.
- **v21 `v21-item-reorder-point`** (Phase 59): additive **nullable** `items` columns `reorder_point`
  (INTEGER), `reorder_gauge_percent` (REAL), `reorder_qty` (INTEGER). NULL = "use the global default".
  `items` already syncs, so these auto-join the LWW payload — **no** `SYNC_TABLES`/`FK_REFS` edit. They
  round-trip through `mappers.rowToItem`, the `Item`/`ItemRow`/create/update types, and the item
  create/update paths (all `items` reads use `SELECT items.*`, so no explicit read-column list needed).
- **v22 `v22-supplier-parts`** (Phase 60): new **synced** table `supplier_parts` — `id` (UUID TEXT PK),
  `item_id` (TEXT FK → items **ON DELETE CASCADE**), `supplier_name`, `order_code`, `unit_cost` (REAL
  nullable), `currency` (TEXT nullable), `pack_qty`/`min_order_qty` (INTEGER nullable), `price_breaks`
  (TEXT JSON nullable — `[{qty,unitCost}]`), `url` (nullable), `is_preferred` (0/1), `updated_at` + the
  canonical §7.1 `WHEN NEW.updated_at = OLD.updated_at` auto-stamp trigger; STRICT + sane CHECKs. Added to
  `SYNC_TABLES` immediately **after `items`** and to `FK_REFS` (`item_id → items`, non-nullable → an
  incoming orphan is dropped, matching CASCADE). Covered by a two-device LWW + orphan-drop round-trip test.
- **v23 `v23-purchase-orders`** (Phase 62): two new **synced** tables. `purchase_orders` — `id` (UUID
  TEXT PK), `supplier_name`, `reference` (nullable), `status` TEXT (`DRAFT|ORDERED|PARTIAL|RECEIVED|
  CANCELLED` CHECK), `currency` (nullable), `created_at`, `ordered_at` (nullable), `updated_at` + the
  §7.1 auto-stamp trigger. `purchase_order_lines` — `id` (UUID), `po_id` (FK → purchase_orders **ON
  DELETE CASCADE**, NOT NULL), `item_id` (FK → items **ON DELETE SET NULL**, nullable),
  `supplier_part_id` (FK → supplier_parts **ON DELETE SET NULL**, nullable — the Phase-60 link),
  `description`, `ordered_qty` (`> 0`), `received_qty` (accumulates, `>= 0`, default 0), `unit_cost`
  (REAL nullable, `≥ 0`), `created_at`, `updated_at` + auto-stamp; indexes on `po_id` and `item_id`.
  Both joined `SYNC_TABLES` (**`purchase_orders` before `purchase_order_lines`**, both after
  `items`/`supplier_parts`) with `FK_REFS` (`po_id` non-nullable→orphan-drop; `item_id` /
  `supplier_part_id` nullable→orphan-NULL). LWW + orphan-NULL + orphan-drop round-trip tested.

The `items` auto-stamp + FTS triggers, and all earlier seams (v13 `item_stock`, v15 `stock_batches`,
v12 `received_qty`, etc.), remain untouched.

> ⚠️ `LocationRepository.SELECT_WITH_COUNT` still lists `locations` columns explicitly — any future
> additive `locations` column must be added there. `ItemRepository` item reads use `SELECT items.*`.

---

## 3. What shipped in Wave 1 (new repositories, seams, UI)

### Phase 59 — Per-item reorder points (v21)
- **Pure seam** `src/features/inventory/reorder-policy.ts` (`isLow`, `shortfall`, `effectiveQtyThreshold`,
  `effectiveGaugePercent`) — no DB/clock; unit-tested.
- **`ItemRepository.listLowStock`** (`src/db/repositories/item/feeds.ts`) now `COALESCE`s the per-row
  override over the global default (`MAX(COALESCE(reorder_point, :qty), 1)` zero-floor guard; gauge path
  `current_net_value <= gross_capacity * COALESCE(pct, :pct) / 100.0`, `gross_capacity > 0` filtered).
- **UI:** `ReorderPointEditor.tsx` on the item-detail "Supplier & ops" tab (with `InfoHint`); the Low
  Stock dashboard widget surfaces "reorder N"; Settings relabels the globals as the **default**.

### Phase 60 — Supplier-parts (v22)
- **`SupplierPartRepository`** (`src/db/repositories/SupplierPartRepository.ts`): CRUD + `listForItem` +
  `getPreferred` + `setPreferred` (atomic single-winner per item). Registered in the barrel as
  `getSupplierPartRepository()`. Types in `src/db/repositories/types/supplier-parts.ts` (incl. `PriceBreak`).
- **Pure cost-precedence helper** `src/features/inventory/supplier-cost.ts` → `effectiveUnitCost(item,
  supplierParts)`: manual `items.unitCost` wins, else the preferred supplier-part's `unit_cost`, else null.
  **This is the canonical cost source — Phase 62 valuation/line-cost defaults should reuse it** (and
  Phase 61's report cost seam is the place to later adopt it; see below).
- **Pure scrape-persist planner** `src/features/scraping/supplier-part-plan.ts`: §4 **no-overwrite** —
  only FILLs blank fields or overwrites a CONFLICT field when explicitly opted in.
- **UI:** `SupplierPartsTable.tsx` + `SupplierPartFormDialog.tsx` replace the read-only supplier `<dl>` in
  `SupplierDataEditor.tsx`. The form **validates on submit** (positive-integer pack/MOQ, non-negative cost)
  and renders an accessible `role="alert"` (`data-testid="supplier-part-error"`) rather than letting the
  repository CHECK throw silently.

### Phase 61 — Reporting & valuation (no migration)
- **`ReportRepository`** (`src/db/repositories/ReportRepository.ts`, `getReportRepository()`): read-only
  `inventoryValue()` (overall + by category + by location, reading the `item_stock` ledger for the
  location split), `consumptionRate(window)`, `movement(window)`, `lowStockCount()`, `deadStock(sinceDays)`.
- **Pure aggregation** in `src/features/reports/reports.ts` (grouping, consumption windows, movement
  bucketing, dead-stock boundary) + `report-csv.ts` (RFC-4180 builders). Cost funnels through one internal
  `effectiveUnitCost` seam using **`items.unitCost`** today (Phase 60 ran in parallel, so its
  preferred-supplier helper is not yet wired here — **a worthwhile follow-up is to adopt
  `supplier-cost.ts`'s `effectiveUnitCost` in the report cost seam now that both are on `main`**).
- **UI:** `/reports` route (`src/routes/reports.tsx`) + `ReportsScreen.tsx` (headline value cards,
  `ValueBreakdown` + `MovementChart` token-styled Tailwind/SVG, **no new chart dep**), `useFormatters()`,
  a `<main id={MAIN_CONTENT_ID} tabIndex={-1}>` skip target, and nav entries on Dashboard + Inventory. CSV
  export routes through the existing Export Wizard's remembered-settings path (new `reportKind`).

---

## 4. Testing (TDD-first) — 1395 unit / smoke +3 steps

- **+~91 unit tests** across the wave (reorder-policy + listLowStock override; supplier-part repo +
  single-preferred + cost precedence + no-overwrite planner + sync round-trip; report aggregations + CSV +
  `:memory:` ReportRepository). All over `createMemoryDriver()` (`:memory:`, §8.5.2).
- **Smoke (+3 steps):** set a per-item reorder point and assert the Low Stock widget reacts (P59); add an
  editable supplier part + star it preferred + persist round-trip (P60); open `/reports` and assert a
  non-zero inventory value + the Export-Wizard "Report CSV" format (P61). Each is placed **before** the
  Phase-53 datasheet step (which does a mid-suite `page.reload()` + device-id swap).
- **Established seams unchanged:** Repository/driver; pure helpers out of glue; injectable `lib/env/*` +
  `apiOverride`; the v13/v15 guarded-recompute stock pattern; the Phase-24 `planReceipt` /
  `ProjectRepository.receiveLine` partial-receipt seam and Phase-28 batch landing (**Phase 62 must reuse
  these for PO receiving — do not hand-roll a second stock-mutation path**); the Phase-20 derived
  In-Transit projection pattern (**reuse for on-order qty**).

---

## 5. Files added/changed in Wave 1 (orientation map)

- **New (Phase 59):** `src/db/migrations/v21-item-reorder-point.ts` (+ test),
  `src/features/inventory/reorder-policy.ts` (+ test), `ItemRepository.phase59.test.ts`,
  `src/features/inventory/components/ReorderPointEditor.tsx`.
- **New (Phase 60):** `src/db/migrations/v22-supplier-parts.ts` (+ test),
  `src/db/repositories/SupplierPartRepository.ts` (+ test), `src/db/repositories/types/supplier-parts.ts`,
  `src/features/inventory/supplier-cost.ts` (+ test), `src/features/scraping/supplier-part-plan.ts`
  (+ test), `src/features/inventory/components/SupplierPartsTable.tsx` + `SupplierPartFormDialog.tsx`.
- **New (Phase 61):** `src/db/repositories/ReportRepository.ts`, `src/features/reports/reports.ts` +
  `report-csv.ts` (+ tests), `src/routes/reports.tsx`, `ReportsScreen.tsx` + `ValueBreakdown.tsx` +
  `MovementChart.tsx`.
- **Edited (shared):** `src/db/migrations/index.ts` (v21+v22 appended); `engine.ts`/`engine.test.ts`
  (strict-contiguity guard restored post-merge); `mappers.ts`, `types/items.ts`, `types.ts`, repo barrel
  `index.ts`; `item/{core,create,normalise,feeds}.ts`; `tombstone.ts` (SYNC_TABLES), `reconcile.ts`
  (FK_REFS), `sync-engine.test.ts` (round-trip); `ItemDetailDialog.tsx`, `SupplierDataEditor.tsx`,
  `dashboard/widgets.tsx`, `SettingsScreen.tsx`, the icon registry, the Export Wizard store/screen, nav
  headers; `scripts/browser-smoke.mjs` (+3 steps).
- **Unchanged:** every pre-v20 migration; `protocol.ts`/`scrape-errors.ts`/the §9 path; `extension/dist/*`;
  `package.json`; `vite.config.ts`; the flake-retry runner.

---

## 6. Technical debt, stubs & deferrals

> Tracked in `docs/dev/deferred-features.md` and the plan doc's per-phase Outcome notes.

- **Adopt the Phase-60 cost helper in Phase-61 reports** — ✅ **done (2026-06-30).** The reports
  `effectiveUnitCost` now delegates its precedence rule to `supplier-cost.ts` (single authority), and
  `ReportRepository`'s valuation queries feed the preferred supplier cost via a shared
  `preferredSupplierCostSql` correlated subquery. +5 tests (1441 green), `tsc` clean, no migration.
- **Waived NITs (recorded):** P59 — curly-vs-straight apostrophe in the InfoHint copy; `shortfall` returns
  0 for gauges by design. P60 — a redundant `getById` round-trip in `SupplierPartRepository.update`; no
  explicit malformed-`price_breaks`-JSON repository test (the mapper is defensively covered). P61 — add the
  explicit `notAVariantParent` predicate to the per-location valuation query for visible consistency
  (already correct via the `item_stock`/`quantity>0` SSOT invariant); a one-line comment on the
  `consumptionRate` per-row delta assumption.
- **Carried smoke flag — CLOSED:** the §4 multi-level variants step ("nests a sub-variant beneath a
  variant", Phase 18) re-verified **passing** on the Phase-62 `test:e2e` run (102/102, single run) — an
  environmental flake, not a defect; no plan diff touched the variants path.
- **Carried LWW/attachment notes** (unchanged): concurrent location-delete vs offline stock edit can
  transiently over-count until reconcile; a legacy pre-v18 `LOCAL_POINTER` (NULL origin) stays `local`.

---

## 7. Phase 62 — Formal Purchase Orders (v23) — ✅ shipped, plan complete

Phase 62 is merged to `main` (`535bba6`), closing the inventory-depth plan (Phases 59–62). **There is
no next phase.** What shipped:

- **`PurchaseOrderRepository`** (`src/db/repositories/PurchaseOrderRepository.ts`,
  `getPurchaseOrderRepository()`): PO + line CRUD, `setStatus` (DRAFT/ORDERED/CANCELLED), `receiveLine`
  (a faithful mirror of `ProjectRepository.receiveLine` — reuses `planReceipt`,
  `addStockStatement`/`addBatchStatement`, `historyStatement`, `batchKeyOf`/`BatchIdentity`; **no second
  stock-mutation path**), and the derived `onOrderQtyForItem` projection (Phase-20 In-Transit pattern).
  Types in `src/db/repositories/types/purchase-orders.ts`.
- **Pure seams** `src/features/purchasing/`: `po-status.ts` (`derivePoStatus` — ORDERED/PARTIAL/RECEIVED
  derived from receipt totals; DRAFT/CANCELLED authoritative), `po-receipt.ts` (`planPoReceipt` wrapping
  the Phase-24 `planReceipt`), `po-presentation.ts` (status→`text-glyph-*` token mapping). Plus
  `queries.ts` (TanStack Query hooks) and the UI: `PurchaseOrdersScreen.tsx` + `components/`
  (`CreatePurchaseOrderDialog`, `PurchaseOrderLineDialog`, `ReceiveLineDialog`), route
  `src/routes/purchase-orders.tsx` with a `<main id>` skip target, nav entry on the dashboard.
- **Schema/sync wiring:** see §2 (v23 tables) — `SYNC_TABLES` +2, `FK_REFS` for `purchase_order_lines`,
  `mappers.ts` + `types.ts`, the barrel. `reconcile.ts` `computeRemovedParents` extended for
  `supplier_parts`/`purchase_orders`.
- **Tests:** `:memory:` repo tests (partial→PARTIAL, full→RECEIVED, on-hand rises, on-order projection),
  pure `po-status`/`po-receipt`/`po-presentation` tests, a sync LWW + orphan-NULL + orphan-drop
  round-trip, and one browser-smoke step (creates a PO, receives a line, asserts on-hand rose).
- **Review:** CLEAN — no blockers/SHOULDs; three NITs waived (see the plan-doc Outcome note). Merged with
  the lockfile kept pristine. Post-merge `npm run test:run` green (1436/1436).

The **carried §4 multi-level variants smoke flag is CLOSED** — re-verified passing on the Phase-62
`test:e2e` run (102/102, single run); it was an environmental flake, untouched by any plan diff.
