# Phase 77 — Data-hygiene / quality report (living plan)

Third feature-gap audit (`feature-gap-audit-2026-06-30c`) **Wave 1, candidate #4** — the **last**
Wave-1 phase. Read-only; **no migration** (`user_version` stays 1). A "tidy up" report that
surfaces records needing attention, each with a jump-to-fix link. Extends the Phase-61/74
`ReportRepository` + the Reports screen, exactly as Phase 74 did (pure seam + repo method + a new
Reports-screen section + its own aria-live region + an optional CSV via the Export Wizard).

## Hygiene checks (each = a section with a count + sample list + jump-to-fix)

| Kind | Definition (active, non-parent items) |
| --- | --- |
| `missing-category` | `category_id IS NULL` |
| `missing-location` | `location_id = UNASSIGNED_LOCATION_ID` (still in the holding pen) |
| `missing-price` | unpriced — no `unit_cost` **and** no preferred supplier cost |
| `missing-photo` | no `item_images` row |
| `never-counted` | no `item_history` `RECONCILED` entry (stock never verified by a cycle count) |
| `stale` | newest `item_history` activity (else `created_at`) older than **N days** |
| `duplicate-mpn` | shares a non-empty MPN (case-insensitively) with ≥1 other item |

Checks chosen to match the audit ("missing photo/location/price/category, possible duplicates
(same MPN), never-counted stock, stale records"). Duplicate-by-serial is **out** — serial numbers
are unique *within* a serialised group by construction (1..N), so a global serial collision is not
a meaningful signal; MPN duplication is the useful one (the same part entered twice).

## Pure seam — `src/features/reports/data-hygiene.ts` (+ `data-hygiene.test.ts`)

- `HygieneIssueKind`, `HygieneItemFlags` (one input row per item: id/name/mpn + the boolean flags
  + `lastActivityAt`), `HygieneSample` (`{id, name, detail?}`), `HygieneSection`
  (`{kind, label, description, count, samples}`), `HygieneReport`
  (`{sections, totalItems, flaggedItems}`).
- `buildHygieneReport(items, { now, staleDays, sampleLimit })`:
  - one section per kind (always present — a 0-count section reads as a green tick);
  - `duplicate-mpn` groups by normalised MPN, keeps groups ≥2, sample `detail` = `MPN x · shared`;
  - `flaggedItems` = distinct items hitting ≥1 issue; samples capped + name-sorted; `now` injected.

## Repository — `ReportRepository.dataHygiene(staleDays, now?)`

One read over `items` with correlated sub-queries for: preferred-supplier cost (reuse
`preferredSupplierCostSql`), `EXISTS item_images`, `EXISTS item_history RECONCILED`, and
`MAX(item_history.created_at)`. Active, non-parent items only (reuse `notAVariantParent`). Hands
the raw flag rows to `buildHygieneReport`. No schema change.

## Glue

- `queries.ts`: `useDataHygiene()` + `DATA_HYGIENE_STALE_DAYS` (180). (The sample cap uses the
  seam's `DEFAULT_SAMPLE_LIMIT` of 100; no separate constant is wired.)
- `report-csv.ts`: `buildDataHygieneCsv` (one row per flagged item: kind, item, detail) +
  `'DATA_HYGIENE'` in `ReportCsvKind`; wired through the Export Wizard (`useExportStore`
  `ReportExportKind`, `run-export` slug+case, `ExportWizard` option) — the Phase-74 pattern.
- `ReportsScreen.tsx`: a **Data hygiene** section (a `HygieneChecklist` of token-styled rows, each
  expandable to its sample items with `/inventory` jump links) + its own Phase-63 aria-live region.

## Verification

`npx tsc -p tsconfig.app.json --noEmit`, `npm run test:run`, `npm run build` — all green.

## Out of scope / deferred (tracked)

- One-click fixes (bulk-assign a category from the report) — Backlog (the jump-to-fix link +
  Phase-76 bulk edit cover the workflow). 
- Duplicate-by-name / fuzzy duplicate detection — Backlog (MPN is the precise signal).
- Item-level deep links from the checklist — Backlog (the jump links go to `/inventory`, which
  defines no search params yet, matching every other cross-screen link in the app; deep-linking
  to a pre-filtered/opened item needs route `validateSearch` work).
