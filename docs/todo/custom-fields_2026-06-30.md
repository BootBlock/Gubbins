# Custom-field templates phases (69–72) — migration squash + custom-field depth (2026-06-30)

> **Living document.** Each phase is implemented in its own worktree/session. Tick the
> `[ ]` boxes as work lands, append a one-paragraph **Outcome** note under each phase when it
> completes (mirroring `docs/dev/deferred-features.md`), and re-schedule — never silently
> drop — any deferred item (tag it → a concrete later phase in `docs/dev/deferred-features.md`).
>
> **Continuation-prompt rule (mandatory).** When a phase (or a parallel wave) completes you
> **must** do **both** before ending the session:
>
> 1. **Emit the next wave's kick-off prompt directly in the chat reply** as a **raw, fenced
>    Markdown code block** (a ```` ```text ```` block the user can copy verbatim into a new
>    chat). It is the **last thing** in the reply. Do not merely say "added it to the doc".
> 2. **Record that same prompt** under [Continuation prompt](#continuation-prompt) at the foot
>    of this doc (replacing the previous one).
>
> The two must be **identical**. When the final wave completes, emit a "**Plan complete — no
> continuation**" note as a raw fenced block instead.

## Why these phases exist

The second 2026-06-30 feature audit (auto-memory `feature-gap-audit-2026-06-30b`) named
**category custom-field templates** the highest-leverage remaining gap vs. InvenTree parameter
templates / Sortly custom fields. **On entry to this plan the foundation was found already
shipped** (verified 2026-06-30):

| Capability | Already exists as |
| --- | --- |
| Typed field *definitions*, category-scoped | `category_fields` table (migration **v3**), STRICT, synced; `field_type ∈ {TEXT, NUMBER, BOOLEAN, DATE, SELECT}` (`repositories/constants.ts`) |
| Per-item field *values* (EAV, lenient-defaulting) | `item_field_values` (v3), `UNIQUE (item_id, field_id)`, synced, tombstoned |
| Definitions CRUD + reorder + value get/set/resolve | `CategoryRepository` (`addField`/`updateField`/`deleteField` with `position`; `resolveItemFields`/`setItemFieldValues`) |
| Sync wiring | `SYNC_TABLES` + `FK_REFS` (CASCADE) already carry both tables; §7.5 cascade-of-cascade handled in `reconcile.ts`; HA bridge exposes them |
| Definitions-management UI | `CategoryManagerDialog.tsx` |
| Per-item editor UI | `CustomFieldsEditor.tsx` (one typed input per `field_type`, wired into item detail) |

Building the originally-specced `custom_field_definitions`/`custom_field_values` tables +
a `CustomFieldRepository` would have been a **second parallel synced EAV system** — a
"second write path" the standing protocols forbid. **Developer decision (2026-06-30): build on
the existing tables.** This plan therefore drops the redundant "new schema + new repo + per-item
editor" phases and targets only the genuine residual gaps, confirmed absent by search:

1. **No typed-validation seam.** `setItemFieldValues` stores raw strings; NUMBER/DATE are not
   validated, `SELECT ∈ options` and `is_required` are not enforced at save. There is no pure
   `validateFieldValue`. This is the foundation the CSV import path must validate through.
2. **No search / filter on custom fields.** Nothing in `src/features/search/` touches
   `item_field_values`; a `field:value` predicate cannot be expressed.
3. **No CSV import/export of custom fields.** The Phase-67 `catalog-import.ts` and the Export
   Wizard map only core item fields, not custom-field columns.

Orthogonally, the app is **pre-release with disposable developer-only data**, so the 24-step
migration history carries no upgrade-path value — **Phase 69 squashes it to a single `v1`
baseline** (the migration *engine* stays; it is the load-bearing release upgrade path / fresh-device
sync-clone / backup-restore mechanism).

Everything else from the audit that is out of scope for a local-first single-user PWA
(multi-user/roles, FX, AI forecasting, POS/RFID, accounting, generic REST/webhook beyond the HA
bridge) remains unpursued. Advanced analytics (ABC / turnover / aging) and label customisation
stay parked for a possible later plan.

## Numbering note

The inventory-depth (59–62) and combined a11y + inventory-breadth (64–68) plans are **COMPLETE**
and merged; `main` enters this plan at **`user_version` 24, 1626 unit tests / 157 files**,
`test.pool = 'threads'`. This plan continues the sequence at **Phase 69**. After Phase 69's squash
the schema-version *number* resets to **1**, but the phase numbering continues monotonically.

## Execution model — worktrees, sub-agents, code-review gates

These phases obey the standing protocols (§8): strict phasing, autonomous TDD (§8.2),
`:memory:` node:sqlite unit tests + a real-browser smoke step (§8.5), derive-don't-store seams,
pure `.ts` logic split out of glue (mirror `cycle-count.ts` / `reorder-policy.ts` /
`asset-lifecycle.ts` / `operational-metadata.ts`), **British English**, **design tokens only**
(CLAUDE.md — reach for Foundry primitives first; no raw colour/easing literals), a PHASE_HANDOVER
per phase (§8.1), and **NEVER COMMIT SECRETS** (public repo). On top of that, this plan is
**parallelised**:

- **One git worktree per phase**, implemented by a dedicated **implementation sub-agent**
  (`Agent`, `isolation: "worktree"`), so concurrent phases never share a working tree. Each agent,
  **before any work**, MUST: (1) verify its worktree base is current `main` and `git rebase main`
  if not (the harness may branch from an old commit); (2) if `node_modules` is absent, junction it
  from the main checkout via PowerShell `New-Item -ItemType Junction -Path node_modules -Target
  P:\Source\TypeScript\Gubbins\node_modules` (Git Bash `mklink /J` mangles the flag); (3) confirm
  the toolchain with `npx tsc -p tsconfig.app.json --noEmit` (build-mode `tsc -b` cannot write
  `.tsbuildinfo` through a junction). Strict file isolation: each agent touches **only** its
  surface files + their tests, and runs its own browser smoke step.
- **Code-review gate after every phase (mandatory).** When an implementation sub-agent reports
  done, run a **review sub-agent** against *that worktree's diff* **before merge**. Every finding
  is fixed or explicitly waived in the Outcome note. No phase merges to `main` un-reviewed.
- **Merge discipline.** Octopus/sequential-merge a wave's reviewed branches onto an integration
  branch (disjoint files merge cleanly), junction `node_modules`, run `npx tsc -p tsconfig.app.json
  --noEmit` + the full `npm run test:run`, then merge to `main`. **GOTCHA:** every phase appends a
  step to `scripts/browser-smoke.mjs`; the conflicting blocks each open `await step(async () => {`
  sharing ONE trailing `});` — resolve by **closing each step explicitly** (a blind "delete the
  markers" union leaves the first step unclosed). **Remove each worktree's `node_modules` junction
  (`cmd /c rmdir …\node_modules`) BEFORE `git worktree remove`**; then `git worktree prune` and
  delete merged branches. Later waves branch from updated `main`.
- **Test gotcha.** A Vitest-4 + `QueryClientProvider` `unhandledRejection` interception blocks
  end-to-end rejected-promise error tests — assert on success/empty, or test the error path in a
  QueryClient-free component.

### Migration-version allocation (collision-avoidance)

| Phase | Migration | `user_version` after |
| --- | --- | --- |
| 69 — Migration baseline consolidation | **squash v1…v24 → single `v1-initial`**; engine kept | **1** |
| 70 — Custom-field validation seam + save-time hardening | **none** (tables already exist) | 1 |
| 71 — Search / filter on custom fields | **none** | 1 |
| 72 — CSV import/export of custom fields | **none** | 1 |

Only Phase 69 touches the migration registry (it *replaces* it). Phases 70–72 add no schema. After
the squash the strict-contiguity guard is trivially satisfied (single v1). Trivial merge clashes
(`index.ts` / `SYNC_TABLES` in `tombstone.ts` / `FK_REFS` in `reconcile.ts` / the repository
barrel) resolve by keeping both lines in ascending order — but note Phases 70–72 should not need to
touch any of those.

### Dependency graph & waves

```
Wave 1:            69 (migration squash — run ALONE first; merge before any feature work).
Wave 2:            70 (validation seam + save-time hardening — the foundation the CSV path
                      validates through; run alone).
Wave 3 (parallel): 71 (search / filter on custom fields)   72 (CSV import/export of custom fields)
```

- **69** rewrites the migration registry — must land alone and first, so every later worktree
  branches from a `main` that already carries the single `v1` baseline.
- **70** introduces the pure `validateFieldValue` seam that **72**'s import path validates through,
  so it merges before Wave 3.
- **71 ⟂ 72** — independent surfaces (search vs CSV); safe to run concurrently. Only the shared
  `scripts/browser-smoke.mjs` append conflicts (resolve per the GOTCHA above).

So: run **Wave 1 = {69}**, review + merge; **Wave 2 = {70}**, review + merge; then
**Wave 3 = {71, 72}** in two parallel worktrees, review + merge each. Code review after *every*
phase regardless of wave. After every merge run `npm run test:run` (+ `npm run build` where
relevant) and report the result plainly.

---

## Phase 69 — Migration baseline consolidation (squash v1…v24 → single `v1`; engine KEPT)

* **Objective.** Collapse the 24-step history into **one** baseline migration that builds the
  entire current schema, removing the accumulated per-step files/tests. Pre-release + disposable
  data ⇒ no upgrade path from old versions is needed. The migration **engine, registry,
  contiguity guard, cold-start retry wrapper, `SYNC_TABLES` and `FK_REFS` all STAY** — only the
  historical step files are consolidated.
* **Method.**
  1. From a freshly-migrated `:memory:` DB on current `main`, dump the canonical schema —
     `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name`, plus
     per-table `PRAGMA table_info` / `foreign_key_list` / `index_list`, and `user_version` — and
     commit it as a **GOLDEN snapshot fixture**.
  2. Author a single `v1-initial` (version 1) whose statements recreate **exactly** that schema
     (all tables, indexes, the §7.1 auto-stamp triggers, FTS, the `item_stock`/`stock_batches`
     projection triggers, etc.) in dependency order.
  3. Delete `v2…v24` migration + test files and their imports from `index.ts`;
     `TARGET_SCHEMA_VERSION` becomes 1.
  4. **Golden-equivalence test:** a fresh DB built by the new baseline reproduces the committed
     snapshot byte-for-byte (tables, indexes, triggers, FKs, `user_version = 1`).
  5. Ensure a fresh OPFS DB boots cleanly at v1; note in the Outcome that the developer wipes
     their disposable dev DB (it currently sits at v24 and **cannot** upgrade to a v1 baseline —
     that is fine and intended).
* **Constraints.** Do **NOT** change runtime schema/behaviour (the snapshot is the contract). Keep
  the engine, the contiguity guard, the `run-unit-tests.mjs` cold-start retry wrapper. No feature
  change.
* **Tests.** The golden-equivalence test; all surviving feature/repository tests still green (the
  deleted files are only the per-step migration tests). Expect the unit-test **COUNT to DROP**
  (≈ −23 migration tests, +1 equivalence test) — **report the new baseline**. +1 smoke step: a
  clean boot reaches the app.
* **Deliverables checklist.**
  - [x] golden schema snapshot fixture committed
  - [x] single `v1-initial` baseline recreating the full current schema in dependency order
  - [x] `v2…v24` migration + test files removed; `index.ts` imports/registry pruned; `TARGET_SCHEMA_VERSION` → 1
  - [x] golden-equivalence test (fresh build ≡ snapshot, byte-for-byte; `user_version = 1`)
  - [x] engine / contiguity guard / cold-start retry wrapper / `SYNC_TABLES` / `FK_REFS` intact
  - [x] new unit-test baseline reported; +1 boot smoke step
  - [x] code review passed; PHASE_HANDOVER updated; Outcome note appended; auto-memory updated

> **Outcome (2026-06-30, Wave 1 — merged `6275c36`).** Shipped as specified. The 24-step history is
> collapsed into a single `v1-initial` (`version: 1`, `name: 'initial-baseline'`); `v2…v24` migration
> + test files (46 files) are deleted and `index.ts` is pruned to `[v1Initial]` so `TARGET_SCHEMA_VERSION`
> derives to **1**. **Method decision (reviewer-scrutinised, sound):** rather than hand-folding the
> v2…v24 `ALTER`s into clean `CREATE`s, the baseline **re-issues the exact original ordered statement
> stream** (all CREATE + ALTER statements, minus the per-step `user_version` bumps). SQLite stores an
> `ALTER TABLE ADD COLUMN` by appending the column to the *tail* of the table's original stored `CREATE`,
> so only re-issuing the original stream reproduces `sqlite_master.sql` **byte-for-byte** — which the
> hard zero-drift contract requires. A committed golden fixture
> (`src/db/migrations/__fixtures__/schema-baseline.snapshot.json`, generated from the **original v1…v24
> chain**) + `v1-initial.test.ts` deep-equal all 107 `sqlite_master` objects and every table's
> `table_info`/`foreign_key_list`/`index_list`; the fresh baseline boots `0→1`, `applied=[1]`. The
> engine, `assertValidSequence` contiguity guard, `migration.ts`, the `run-unit-tests.mjs` cold-start
> retry wrapper, `SYNC_TABLES` and `FK_REFS` are **untouched**. The two SELECT-based backfills
> (`item_stock`←items, `stock_batches`←item_stock) and the system-location/`sync_meta` seeds are correct
> no-ops/seeds on a fresh empty DB. **Test baseline: 1626/157 → 1492/135** (−46 deleted migration test
> files net of the deletions, +1 equivalence test; the lower count is the removed per-step assertions);
> `npx tsc -p tsconfig.app.json --noEmit` clean; `npm run build` clean (precache 3227.19 KiB, no budget).
> **Code review: CLEAN-WITH-NITS**, verified zero-drift **bidirectionally** (new baseline ≡ fixture, and
> the original chain ≡ fixture — proving the fixture is a genuine contract, not self-proving). **Two NITs
> waived:** (1) the +1 browser-smoke step asserts the always-mounted Inventory result-count region, which
> proves the workspace painted but is slightly weaker than a completed-query assertion — the preceding
> "Add item" wait already proves a clean migrated boot; (2) the retained backfill `INSERT`s are dead
> weight on an empty DB — kept deliberately so the stream is a faithful re-issue (documented in the file
> header). **Developer action:** existing dev DBs sit at `user_version = 24` and **cannot** "upgrade" to
> a v1 baseline (the engine only applies migrations *newer* than current) — developers must **wipe** their
> disposable local OPFS DB so it re-creates from the baseline. Intended, pre-release. The browser smoke
> could not run end-to-end in the junctioned worktree (Vite `server.fs.allow` won't serve the
> `sqlite-wasm` binary from outside the worktree root) — the squash is fully validated by the 1492 unit
> tests on the real FTS5-capable `node:sqlite` engine + the byte-identical equivalence proof; the added
> step parses (`node --check`) and follows the existing `await step(...)` structure.

## Phase 70 — Custom-field validation seam + save-time hardening (no migration)

* **Objective.** Make custom-field values **typed-valid at the point of save**, on the existing
  `category_fields`/`item_field_values` system — the foundation the CSV import path (Phase 72)
  validates through. No new tables, no second write path.
* **Pure seam.** `src/features/inventory/custom-fields.ts` —
  - `validateFieldValue(def, raw)` → `{ ok: true; value: string | null } | { ok: false; error: string }`
    (never throws): coerce/normalise by `field_type` — NUMBER → finite number (re-serialised
    canonically), BOOLEAN → `'true'`/`'false'`, DATE → ISO `YYYY-MM-DD`, SELECT → must be ∈
    `options`, TEXT → trimmed; empty/blank ⇒ `value: null` (clears the row, never stores `''`);
    `is_required` enforced (blank → error). Returns the **storage string** (values persist as TEXT).
  - `fieldsForCategory(defs, categoryId)` → the category's defs in `position` order. **Categories
    are flat** (`CategoryRow` has no `parent_id`) — document "no ancestor resolution; flat model".
  - Pure, injectable, **no DB**. Unit-tested across every type + required + boundary.
* **Repository.** Wire validation into `CategoryRepository.setItemFieldValues` so a bad value is
  rejected with a `DbError` (or the caller validates first) — keep the existing UUID-id +
  `UNIQUE (item_id, field_id)` upsert / tombstone-on-clear path; **do not** switch to a deterministic
  id (needless churn; the UNIQUE constraint already gives LWW-correct sync). `:memory:` tests.
* **UI.** Harden `CustomFieldsEditor.tsx`: validate each field via `validateFieldValue` before save,
  block save on a required-but-empty or invalid field, surface errors accessibly
  (`role="alert"` sibling of the label, per the Phase-51 pattern). Foundry primitives, design
  tokens, British English. (The definitions-management `CategoryManagerDialog` may also adopt the
  seam where it validates option lists — keep changes minimal and in-surface.)
* **Tests.** pure-seam (every type + required + coercion + SELECT-not-in-options + DATE/NUMBER
  malformed) + repository `:memory:` (reject invalid, clear-to-null, round-trip); smoke: set a
  NUMBER custom field on an item, reopen, assert it persisted (and a bad value is blocked).
* **Deliverables checklist.**
  - [x] `custom-fields.ts` pure seam (`validateFieldValue` + `fieldsForCategory`) + tests
  - [x] validation wired into `CategoryRepository.setItemFieldValues` + `:memory:` tests
  - [x] `CustomFieldsEditor` hardening (required/typed validation, `role="alert"` errors)
  - [x] +1 browser smoke step
  - [x] code review passed; PHASE_HANDOVER updated; Outcome note appended; auto-memory updated

> **Outcome (2026-06-30, Wave 2 — merged `0f5c694`).** Shipped as specified, on the existing
> `category_fields`/`item_field_values` tables — **no migration, no second write path**. The pure seam
> `src/features/inventory/custom-fields.ts` exports `validateFieldValue(def, raw)` (never throws —
> returns `{ ok:true; value:string|null } | { ok:false; error }`) and `fieldsForCategory(defs, categoryId)`
> (filter + `position`-then-name order, mirroring the repo's `ORDER BY`; documents the **flat, no-ancestor**
> model). Coercion is **canonical**: NUMBER via `String(Number(text))` behind a `Number.isFinite` gate
> (`'1.50'`→`'1.5'`, `'01'`→`'1'`, `'1e3'`→`'1000'`; `'1.2.3'`/`'abc'`/`±Infinity`/`NaN` rejected) — hex
> (`'0x10'`→`'16'`) and exponent forms are accepted as the finite numbers they denote (documented + tested);
> DATE is **hand-parsed** from `YYYY-MM-DD` with explicit month/day bounds + a Gregorian leap-year check
> (rejects `2026-02-30`/`2026-13-40`/`2025-02-29`), never the lenient `Date` constructor; BOOLEAN
> normalises case-insensitively to `'true'`/`'false'`; SELECT enforces `∈ options`; blank ⇒ `null` (clears
> the row, never stores `''`), `is_required` blank ⇒ error. Anything time-related is injected (`opts.now`,
> reserved). **Repository:** `setItemFieldValues` now widens its one field-membership query from
> `SELECT id` to `SELECT *` → `Map<fieldId, CategoryField>` via the existing `rowToCategoryField`, validates
> each value, throws `DbError('SQLITE_CONSTRAINT', …)` on failure and **persists the coerced value**; the
> UUID-id + `UNIQUE(item_id, field_id)` upsert / tombstone-on-clear path is unchanged (no deterministic-id
> churn). **UI:** `CustomFieldsEditor` validates every changed field through the same seam, disables Save
> while any field is invalid/required-empty, and renders a `role="alert"` error as a **sibling of the
> label** wired via the existing `fieldAria` seam (Phase-51 a11y) across all control types; design tokens
> (`text-destructive`) + British English throughout; `CategoryManagerDialog` untouched. **Tests: 1492/135
> → 1515/136** (+1 file, +18 tests: full pure-seam matrix + 5 repo `:memory:` tests — reject-invalid,
> canonical-persist `'1.50'`→`'1.5'`, clear-to-null still tombstones); `npx tsc -p tsconfig.app.json
> --noEmit` clean; `npm run build` clean (precache 3228.89 KiB, no budget). **Code review: CLEAN-WITH-NITS.**
> **Two findings fixed pre-merge:** (1) the browser-smoke "invalid value blocks save" sub-assertion was
> unreliable — a native `<input type=number>` drops non-numeric text before the seam sees it, so it proved
> nothing; replaced with the reliable end-to-end fact (a valid `'12.50'` coerces to `'12.5'` and round-trips
> from the worker DB), with the block path left to the pure-seam + `:memory:` tests; (2) the
> exhaustiveness-guard `void _never` was unreachable after the `return` — reordered above it. **Three NITs
> waived:** the reserved-but-unused `opts.now` clock seam (forward-looking, matches sibling modules); the
> documented hex/exponent NUMBER acceptance (harmless for an inventory field, tested); and the sanctioned
> layering import (`CategoryRepository` imports the pure `validateFieldValue`) — no runtime cycle, since
> `custom-fields.ts` imports only the `CategoryField` **type** from `@/db/repositories`. **Smoke status:**
> parse-validated only (`node --check`), not run end-to-end — same known Phase-69 limitation (Vite
> `server.fs.allow` won't serve the `sqlite-wasm` binary from outside the worktree root through the
> junction); the step is authored against real selectors and follows the existing `await step(...)`
> structure. The validation paths are fully proven by the 1515 unit/`:memory:` tests on the real
> FTS5-capable `node:sqlite` engine.

## Phase 71 — Search / filter on custom fields (no migration) — Wave 3, parallel with 72

* **Objective.** Let users filter the inventory by a custom-field value via the existing §5.1
  search.
* **Seam.** Extend `parseTextQuery` / the SearchAST (`src/features/search/`) so a `field:value`
  style token resolves to a custom-field predicate, lowered through the **existing**
  `parseASTtoSQL` (join `item_field_values` / `category_fields` by field name or key). **PRODUCE
  THE AST — never hand-build SQL at the call site** (Phase 47/48 rule). Pure, unit-tested.
* **UI.** Surface custom fields in the filter affordance (`SearchBuilderContext` / builder
  components) where appropriate; the result-count `aria-live` region stays intact.
* **Tests.** parser/AST unit tests (text / number / choice / date predicates, missing-field) + a
  `:memory:` query test (the join returns the right items); smoke: filter by a custom field and
  assert the list narrows.
* **Deliverables checklist.**
  - [x] `field:value` token → SearchAST predicate, lowered through existing `parseASTtoSQL` + tests
  - [x] `:memory:` query test (join `item_field_values` returns expected items)
  - [x] filter-affordance UI surfacing custom fields; result-count `aria-live` intact
  - [x] +1 browser smoke step
  - [x] code review passed; PHASE_HANDOVER updated; Outcome note appended; auto-memory updated

> **Outcome (Phase 71 — Search / filter on custom fields).** Shipped a `field:<name>` search
> predicate that lets the existing §5.1 search filter the inventory by a category custom-field value,
> **with no migration and no new SQL call-site** — the predicate is produced as a `FilterCondition` in
> the §5.1 SearchAST and lowered through the **existing** `parseASTtoSQL`, exactly mirroring the
> `capability:<key>` seam (the Phase 47/48 "produce the AST, never hand-build SQL" rule). A
> custom-field condition lowers to an `EXISTS` over the join `item_field_values ⋈ category_fields`,
> resolving the field by **definition name** (`cf.name` COLLATE NOCASE); since all values persist as
> TEXT in the EAV table, numeric `>`/`<`/`=` cast `ifv.value` to REAL so they order numerically, not
> lexically; CONTAINS escapes LIKE wildcards; presence reuses `HAS_CAPABILITY` ("has any value"). A
> **missing/unknown field name resolves inside the subquery and so matches no rows — no-match, never an
> error**, as required. The hybrid text parser gained the `field:<name>[op<value>]` form (plus the
> `cf:` alias: `:` → CONTAINS, `=` → EQUALS/numeric, `>`/`<` → numeric), still gated through the real
> `parseASTtoSQL` so it can never emit a tree it would reject. The Visual Builder surfaces a new
> **"Custom field"** field option with a free-text "Custom field name" input (mirroring the capability
> key affordance), and the inventory result-count `aria-live` region is untouched. British English,
> Foundry primitives + design tokens only. **Tests +34 (1515→1549) across +1 new file (136→137):**
> parseASTtoSQL AST + `:memory:` join tests (text/number/presence predicates, **case-insensitive name
> resolution**, **unknown-field → no-match**, no-SQL-injection), parse-text-query parser + round-trip
> tests, and a new `fields.test.ts` for the helper/label seam. `npx tsc -p tsconfig.app.json --noEmit`
> **clean**; `npm run build` **clean** (precache 62 entries / 3231.57 KiB, no budget breach). +1 browser
> smoke step (*"filters the inventory by a custom-field value (§5.1, Phase 71)"*) — **parse-validated
> only** (`node --check` passes): run end-to-end it fails like every dev-server step because Vite's
> `server.fs.allow` rejects the junctioned `sqlite-wasm` binary (resolved to the main checkout, outside
> the worktree root) so the app's DB never boots — the documented Phase-69/70 worktree limitation, not a
> Phase-71 defect. **Code review: CLEAN-WITH-NITS** — verified parameterisation (field name + value are
> bound `?` params, no SQL interpolation/injection), the AST-produced-then-lowered discipline, scope
> isolation, and that the `:memory:` tests meaningfully prove the join + numeric REAL-cast + no-match
> behaviour. **Two review nits, both observations (no code change):** (1) `category_fields.name` is not
> UNIQUE, so `field:Rating` is **name-scoped, not category-scoped** — intended "resolve by name" behaviour,
> and `EXISTS` makes duplicate joins harmless; (2) the smoke step is parse-only per the standing worktree
> limitation above. Merged to `main` (`4b84410`).

## Phase 72 — CSV import/export of custom fields (no migration) — Wave 3, parallel with 71

* **Objective.** Extend the Phase-67 catalogue CSV so custom fields import/export alongside core
  fields.
* **Seam.** Extend `catalog-import.ts`'s column-mapping + Zod dry-run so a CSV column can target a
  custom field (validated via the **Phase-70** `validateFieldValue`), applied **through** the
  existing batch-apply + `CategoryRepository.setItemFieldValues` (no second write path). Export adds
  the defined custom-field columns (header = field name/key; one column per definition encountered).
* **Tests.** pure mapping/coercion/error tests (column → field resolution, invalid value collected
  not thrown, required enforced) + `:memory:` batch-apply (the value lands on the item via the
  existing path); smoke: import a CSV with a custom-field column and assert the value lands on the
  item.
* **Deliverables checklist.**
  - [x] `catalog-import.ts` custom-field column mapping + Zod dry-run (validates via Phase-70 seam) + tests
  - [x] batch-apply persists via existing `setItemFieldValues` (no second path) + `:memory:` test
  - [x] Export Wizard catalogue CSV gains custom-field columns
  - [x] +1 browser smoke step
  - [x] code review passed; PHASE_HANDOVER updated; Outcome note appended; auto-memory updated

> **Outcome (shipped).** Phase 72 extends the Phase-67 catalogue CSV so category custom fields import and
> export alongside core fields, entirely on the existing `category_fields` + `item_field_values` tables —
> **no migration, no new tables, no second write/validation path**. IMPORT: `catalog-import.ts` gained a
> `CustomFieldTarget` (`{ fieldId }`) mapping variant; `inferColumnMapping(headers, customFields?)`
> auto-maps a non-core header to a custom field by normalised name (or raw field id, core synonyms winning a
> clash); each custom cell is validated + canonically coerced through the **Phase-70** `validateFieldValue`
> seam, with an invalid value / unknown field id / required-blank **collected as a row error (never
> thrown)** and a non-required blank coercing to `null` (clear); the plan carries an optional `fieldValues`
> per create/update, persisted by `applyCatalogImportPlan(plan, repo, categories?)` through the existing
> `CategoryRepository.setItemFieldValues` (the only write path) — a custom-field write failure (e.g. the
> field is not on the item's category) is recorded on the row without rolling back the item.
> `CatalogImportWizard.tsx` loads every category's `listFields` and threads the defs through inference,
> plan-building and apply. EXPORT: `buildCatalogCsv(items, customFields?, valuesByItem?)` appends one column
> per definition (header = field name, dedup by field id, RFC-4180-quoted), fed by a new
> `collectCustomFieldColumns` in `run-export.ts` that resolves each item's fields via the existing
> `resolveItemFields` read path and exports **stored** values only (lenient defaults left blank so an
> export→import round-trip never pins a default). +18 unit tests (1515 → **1533**, no new files: 14 added to
> `catalog-import.test.ts` incl. a `:memory:` apply test proving the value lands, 5 to `export-data.test.ts`);
> +1 browser-smoke step (*"imports a CSV custom-field column and the value lands on the item (Phase 72)"*).
> `tsc -p tsconfig.app.json --noEmit` **clean**; `npm run build` **clean** (precache 3230.94 KiB, no
> budget); `node --check scripts/browser-smoke.mjs` parses. Smoke parse-validated only (the standing
> worktree `sqlite-wasm` `server.fs.allow` limitation); all unit tests run green in-worktree. **Code
> review: CLEAN-WITH-NITS** — verified the two load-bearing constraints hold: import persists **only**
> through `CategoryRepository.setItemFieldValues` (no second write path) and validation is the imported
> Phase-70 `validateFieldValue` (not re-implemented); export RFC-4180 quoting, dedup-by-field-id, and the
> category-mismatch-records-an-error case are all covered by meaningful tests. **One nit waived → deferred:**
> in the import wizard's MapStep, an *auto-mapped* custom-field column renders its select as `''`
> ("(ignore)") and the dropdown lists only core fields, so it looks identical to an ignored column and
> can't be manually (re)assigned — cosmetic/UX only (the inferred mapping still applies; correctness
> unaffected). Logged in `docs/dev/deferred-features.md` (Phase 72) as a backlog UX-cue follow-up. Merged
> to `main` (`<this merge>`).

## Deferred / explicitly out of scope

- **New `custom_field_definitions`/`custom_field_values` tables + `CustomFieldRepository`** — the
  feature already exists as `category_fields`/`item_field_values` + `CategoryRepository`; building a
  parallel system was explicitly rejected (no second write path). Closed.
- **Deterministic `${itemId}|${fieldId}` value ids** — the existing UUID + `UNIQUE (item_id,
  field_id)` upsert already gives LWW-correct sync; the change would be needless churn. Not pursued.
- **Hierarchical category field inheritance (ancestor resolution)** — categories are flat
  (`CategoryRow` has no `parent_id`); revisit only if a category tree is introduced.
- Multi-user/roles, FX, AI forecasting, POS/RFID, accounting, generic REST/webhook beyond the HA
  bridge — enterprise-only; not pursued.
- **Advanced analytics (ABC / turnover / aging)** and **label customisation** — confirmed audit
  candidates, parked for a possible later plan.

## Continuation prompt

```text
Continue the Gubbins custom-field-templates plan (docs/todo/custom-fields_2026-06-30.md). Waves 1 & 2
are COMPLETE and merged to main: Phase 69 (migration squash → single v1-initial baseline, 6275c36) and
Phase 70 (custom-field validation seam + save-time hardening, 0f5c694). main now sits at user_version 1,
1515 unit tests / 136 files, tsc + build clean (precache 3228.89 KiB, no budget). The pure seam
src/features/inventory/custom-fields.ts exports validateFieldValue(def, raw) → { ok:true; value:string|
null } | { ok:false; error } (NEVER throws; canonical coercion per field_type) and fieldsForCategory;
CategoryRepository.setItemFieldValues now validates+coerces through it. Now run WAVE 3 = {Phase 71 +
Phase 72} in TWO PARALLEL worktrees.

IMPORTANT CONTEXT (verified across the plan): category custom-field *templates already ship* — do NOT
build new custom_field_* tables or a CustomFieldRepository. The foundation is `category_fields`
(definitions) + `item_field_values` (values, EAV, lenient-defaulting, UNIQUE(item_id, field_id)) since
the v1 baseline, synced (SYNC_TABLES + FK_REFS), owned by `CategoryRepository` (addField/updateField/
deleteField + position reorder; resolveItemFields/setItemFieldValues, which now enforces the Phase-70
validateFieldValue seam). FIELD_TYPES = TEXT|NUMBER|BOOLEAN|DATE|SELECT (src/db/repositories/
constants.ts). Categories are FLAT (no parent_id) → no ancestor resolution. Phases 71 & 72 build ON
these existing tables — NO migration.

OBEY THE STANDING PROTOCOLS (§8) AND CLAUDE.md: strict phasing, autonomous TDD (§8.2), :memory:
node:sqlite unit tests + a real-browser smoke step per phase (§8.5), derive-don't-store seams, pure
.ts logic split out of glue (mirror cycle-count.ts / asset-lifecycle.ts / operational-metadata.ts /
the Phase-70 custom-fields.ts), British English, design tokens only — no raw colour/easing literals
(reach for Foundry primitives first), a PHASE_HANDOVER per phase (§8.1), and NEVER COMMIT SECRETS
(public repo).

EXECUTION MODEL (proven across phases 59–70): launch TWO implementation sub-agents CONCURRENTLY via the
Agent tool, isolation: "worktree" — one for Phase 71, one for Phase 72 (independent surfaces: search vs
CSV). Each agent, BEFORE any work, MUST: (1) verify its worktree base is current main and `git rebase
main` if not (the harness may branch from an OLD commit); (2) if node_modules is absent, junction it
from the main checkout via PowerShell `New-Item -ItemType Junction -Path node_modules -Target
P:\Source\TypeScript\Gubbins\node_modules` (Git Bash mklink /J mangles the flag); (3) confirm the
toolchain with `npx tsc -p tsconfig.app.json --noEmit` (build-mode tsc -b cannot write .tsbuildinfo
through a junction). Strict file isolation: each agent touches ONLY its own phase's surface files +
their tests. NOTE the worktree self-exclusion gotcha: `npm run test:run` from inside a worktree skips
its own test files (vite.config.ts excludes **/.claude/worktrees/**); the full suite is authoritatively
run on main AFTER merge.

SHARED-FILE CONFLICT (the ONLY overlap): both phases append one `await step('label', async () => { … });`
to scripts/browser-smoke.mjs. When you sequentially merge the two reviewed branches, the appends
conflict — resolve by KEEPING BOTH steps, each explicitly closed with its own `});` (a blind
delete-the-markers union leaves the first step unclosed). `node --check scripts/browser-smoke.mjs` after
resolving.

CODE-REVIEW GATE AFTER EACH PHASE (hard requirement): when an implementation agent reports done, run a
review sub-agent against THAT worktree's diff BEFORE merge. Fix every finding or explicitly waive it in
that phase's Outcome note. No phase merges to main unreviewed. Merge the two reviewed branches
sequentially to main (--no-ff "Merge Phase 71 …" / "Merge Phase 72 …", resolving the browser-smoke
append per above), junction node_modules, run `npx tsc -p tsconfig.app.json --noEmit` + full `npm run
test:run` (+ `npm run build`), report results plainly. Remove each worktree's node_modules junction
(cmd /c rmdir …\node_modules) BEFORE `git worktree remove`; then `git worktree prune` and delete the
merged branches.

PHASE 71 — Search / filter on custom fields (no migration)
* Objective. Let users filter the inventory by a custom-field value via the existing §5.1 search.
* Seam. Extend parse-text-query (src/features/search/parse-text-query.ts) + the SearchAST (src/db/
  search/ast.ts) so a `field:value`-style token resolves to a custom-field predicate, lowered through
  the EXISTING src/db/search/parseASTtoSQL.ts (join item_field_values / category_fields by field name
  or key; the §6.6 item search lives in src/db/repositories/item/search.ts). PRODUCE THE AST — never
  hand-build SQL at the call site (the Phase 47/48 rule). Pure, unit-tested. Watch field-name
  ambiguity/escaping and a missing/unknown field (resolve to no-match, not an error).
* UI. Surface custom fields in the filter affordance where appropriate (src/features/search/
  SearchBuilderContext.tsx + components/VisualBuilder.tsx / ConditionEditor.tsx / fields.ts); the
  result-count aria-live region stays intact.
* Tests. parser/AST unit tests (text / number / choice / date predicates, missing-field) + a :memory:
  query test (the join returns the right items); smoke: filter by a custom field and assert the list
  narrows.
* Deliverables: field:value token → SearchAST predicate lowered through existing parseASTtoSQL + tests;
  :memory: join query test; filter-affordance UI; result-count aria-live intact; +1 smoke step; review
  passed; PHASE_HANDOVER + Outcome note + auto-memory (phase-71-scope-decisions).

PHASE 72 — CSV import/export of custom fields (no migration)
* Objective. Extend the Phase-67 catalogue CSV so custom fields import/export alongside core fields.
* Seam. Extend src/features/inventory/catalog-import.ts's column-mapping + Zod dry-run so a CSV column
  can target a custom field (validated via the Phase-70 validateFieldValue — import that seam; do NOT
  re-implement validation), applied THROUGH the existing batch-apply + CategoryRepository.
  setItemFieldValues (NO second write path). Export (src/features/export/export-data.ts / ExportWizard.
  tsx) adds the defined custom-field columns (header = field name/key; one column per definition
  encountered).
* Tests. pure mapping/coercion/error tests (column → field resolution, invalid value collected not
  thrown, required enforced) + :memory: batch-apply (the value lands on the item via the existing
  path); smoke: import a CSV with a custom-field column and assert the value lands on the item.
* Deliverables: catalog-import custom-field column mapping + Zod dry-run (validates via Phase-70 seam)
  + tests; batch-apply persists via existing setItemFieldValues (no second path) + :memory: test;
  Export Wizard catalogue CSV gains custom-field columns; +1 smoke step; review passed; PHASE_HANDOVER
  + Outcome note + auto-memory (phase-72-scope-decisions).

WHEN BOTH PHASES ARE REVIEWED, MERGED AND THEIR WORKTREES REMOVED, this is the FINAL wave — do BOTH
before ending the session: (1) emit a "Plan complete — no continuation" note directly in the chat reply
as a RAW, FENCED Markdown code block (the LAST thing in the reply), summarising the four-phase plan's
end state (user_version 1, the final test count, tsc+build clean); (2) record that same note verbatim
under the "Continuation prompt" heading at the foot of the plan doc (replacing this one), and update
auto-memory (custom-fields-plan-69-72) to PLAN COMPLETE. After the merges run npm run test:run (+ npm
run build) and report plainly.
```
</content>
</invoke>
