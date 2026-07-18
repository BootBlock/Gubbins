# Modular UI — implementation plan

> **Status:** planning complete, phases not yet started.
> **Branch/worktree:** `feat/modular-ui` at `.claude/worktrees/modular-ui`.
> **Goal:** let users hide top-level pages and cross-cutting sub-features they don't use,
> for a leaner interface — while the underlying features stay fully functional and reachable.

This plan is the single source of truth for the feature. Each phase is implemented in its own
chat session by an agent working in the `feat/modular-ui` worktree. **After every phase:** run
`/code-review high`, fix all findings, run the type-check + test suite, then hand back a
continuation prompt (raw markdown block) for the next phase. When all phases are done, merge
`feat/modular-ui` into `main` and clean up the worktree/branch.

---

## 1. Decisions (locked, from the requirements interview)

| Topic | Decision |
| --- | --- |
| **Granularity** | Top-level **page** modules **and** cross-cutting **capability** sub-features, built on a general feature-flag registry so more can be added. |
| **Cascade depth** | **Deep & consistent.** Hiding a feature removes *every* entry point: nav menu row, dashboard tile, dashboard widgets, command-palette screen-jump, cross-links, related item-detail tabs/actions, and its contributions to the Alerts/Upcoming aggregate feeds. Data + integrations stay intact underneath. |
| **Direct URL to a hidden page** | Render a gentle **"module hidden" interstitial** with **"Show this module"** (re-enables) and **"Continue anyway"** (renders the screen this once). |
| **Presets + granular + first-run** | Ship curated presets **and** a full granular toggle list, **plus** a skippable first-run chooser (re-runnable from the Modules screen). |
| **Dependencies** | **Auto-cascade with clear messaging.** Turning a feature off also hides its dependents (with a "this will also hide X, Y" confirmation); turning it on offers to enable missing dependencies. Re-enabling a parent restores children to their previous intent. |
| **Persistence** | **Per-device** (localStorage), consistent with theme/locale/kiosk. A kiosk tablet can show only Inventory while a desktop shows everything. No sync-schema work. |
| **Always-on core** | **Dashboard, Inventory, Settings, About** can never be hidden. Everything else is optional. |
| **Manager UI** | A dedicated **"Modules"** manager **screen** (`/modules`), reached from Settings and the first-run chooser. |
| **Apply behaviour** | **Instant** (live) — flipping a toggle reshapes the app immediately. A module being off **force-hides its dashboard widgets** and drops them from the widget "Customise" picker; turning it back on restores the user's prior widget layout. |
| **First-run default** | Skippable wizard; **until a choice is made, everything is ON** (today's behaviour) so nothing is ever hidden by surprise. |

---

## 2. Architecture

Everything hangs off a **feature registry** (the SSOT) + a **per-device modules store** + a
**pure dependency engine**. This mirrors the codebase's established "extract the logic out of
the DOM glue" seam (`dashboard-layout.ts`, `alerts.ts`, `agenda.ts`): the pure graph maths is
unit-tested in isolation; the store and React hooks are thin shells over it.

### 2.1 Feature registry — `src/features/modules/feature-registry.ts` (new, SSOT)

```ts
export type FeatureKind = 'page' | 'capability';

export interface FeatureDef {
  readonly id: FeatureId;              // stable key, e.g. 'projects', 'maintenance'
  readonly kind: FeatureKind;
  readonly label: string;              // "Projects", "Maintenance & servicing"
  readonly description: string;        // one-line, shown in the manager + interstitial
  readonly Icon: LucideIcon;
  readonly group: FeatureGroup;        // grouping in the manager UI
  readonly route?: AppRoutePath;       // page features only
  readonly dependsOn?: readonly FeatureId[];
  readonly alwaysOn?: boolean;         // core: dashboard/inventory/settings/about
}
```

**Feature IDs (v1):**

- **Core (`alwaysOn`):** `dashboard`, `inventory`, `settings`, `about`.
- **Page modules (optional):** `projects`, `purchase-orders`, `contacts`, `bookings`,
  `upcoming`, `activity`, `reports`, `alerts`, `sync`, `home-assistant`.
- **Capabilities (optional):** `maintenance` (maintenance & servicing), `warranty` (warranty &
  depreciation / asset lifecycle), `batches` (batches/lots, FEFO), `scanner` (live camera
  scanning — printed QR labels stay), `custom-fields` (custom fields & capabilities),
  `perishables` (expiry-date tracking), `cycle-counts`, `tags-attachments` (item tags +
  datasheet/attachment linking).

**Dependency edges:**

- `purchase-orders` → `contacts` (needs suppliers)
- `bookings` → `contacts` (bookings are made to a contact)
- Budgets live inside **Projects** (no separate flag in v1).
- `upcoming`, `alerts`, `reports` are **aggregators** — no hard dependency; their internal
  lanes/report-cards gate individually on the relevant feature.

The graph is acyclic — validated by a unit test that also asserts every `dependsOn` id exists,
every page `route` is a real `AppRoutePath`, and every `NAV_DESTINATIONS` optional entry maps to
a registered feature.

### 2.2 Modules store — `src/state/stores/useModulesStore.ts` (new, `gubbins:modules`)

Zustand + `persist`, device-local (mirrors `usePreferencesStore`). Stores **user intent**, not
effective state, so re-enabling a parent restores children:

```ts
interface ModulesStore {
  readonly intent: Readonly<Record<string, boolean>>;  // explicit per-feature choice
  readonly firstRunComplete: boolean;
  setFeatureIntent(id: FeatureId, on: boolean): void;   // no cascade mutation — see §2.3
  applyPreset(presetId: PresetId): void;
  resetToEverything(): void;
  completeFirstRun(): void;
}
```

Missing key ⇒ **on** (default everything-on). Core ids are always effectively on regardless of
stored intent.

### 2.3 Pure engine — `src/features/modules/modules-graph.ts` (new, side-effect-free, unit-tested)

- `resolveEnabled(intent, registry): ReadonlySet<FeatureId>` — effective set. A feature is
  effective iff it is core, **or** `intent !== false` **and** every `dependsOn` is effective.
  Computed as a fixpoint over the acyclic graph. This closure means reads are always consistent
  even if persisted intent is stale (a child whose parent is off reads as off without mutating
  storage).
- `dependentsOf(id)` / `dependenciesOf(id)` (transitive) — drive the confirmation copy.
- `closureToDisable(id)` = `{id} ∪ transitive dependents that are currently effective` — "turning
  this off will also hide…".
- `closureToEnable(id)` = `{id} ∪ transitive dependencies currently off` — "turning this on will
  also show…".

### 2.4 Read API — `src/features/modules/useFeature.ts` (new)

- `useFeature(id): boolean` — subscribes to the store, returns effective-enabled (memoised).
- `useEnabledFeatures(): ReadonlySet<FeatureId>`.
- `isFeatureEnabled(id)` — non-React read via `useModulesStore.getState()` for the rare
  imperative caller.

### 2.5 Presets — `src/features/modules/presets.ts` (new)

`Preset { id, label, description, Icon, featureIds }`. Applying a preset sets `intent` to
`true` for `featureIds` and `false` for every other optional feature, then relies on
`resolveEnabled` for the dependency closure.

- **`everything`** — all optional on (the full default).
- **`minimal`** — none optional (core only).
- **`home-hobby`** — `reports`, `scanner`, `perishables`, `tags-attachments`, `alerts`, `upcoming`.
- **`maker-workshop`** — `projects`, `purchase-orders`, `contacts`, `reports`, `scanner`,
  `maintenance`, `custom-fields`, `alerts`, `upcoming`.
- **`asset-equipment`** — `contacts`, `bookings`, `maintenance`, `warranty`, `reports`, `alerts`,
  `upcoming`.

---

## 3. The deep-cascade touch-point map

Every place a hidden feature must disappear from. Each is wired in the phase noted.

| Surface | File(s) | Phase |
| --- | --- | --- |
| Nav menu rows | `AppNav.tsx` (+ `nav-destinations.ts` gains `feature?`) | 2 |
| Dashboard nav tiles (+ empty-group collapse) | `DashboardNav.tsx` | 2 |
| Command-palette screen-jump | `CommandPalette.tsx` | 2 |
| Modules manager screen + route + Settings entry | `ModulesScreen.tsx`, `routes/modules.tsx`, `SettingsScreen.tsx` | 3 |
| Dashboard widgets (+ Customise picker) | `widgets.tsx`, `DashboardGrid.tsx`, `useLayoutStore` | 4 |
| Route guard + "module hidden" interstitial | `ModuleGuard.tsx`, each optional `routes/*.tsx` | 5 |
| Item-detail tabs (Maintenance, Warranty/asset, Custom fields/capabilities, Tags/attachments, Batches) | `ItemDetailDialog.tsx` (`buildTabs`) | 6 |
| Item actions (checkout→contacts, reserve→projects, book→bookings, add-to-PO→purchase-orders, scan→scanner) | inventory action components | 6 |
| Alerts lanes (maintenance/warranty/expiry) | `useAlerts.ts` | 7 |
| Upcoming/Agenda lanes (bookings/checkouts/maintenance/warranty/expiry/reorder) | `useAgenda.ts` | 7 |
| Reports sub-report cards that need an off module | `reports` screen | 7 |
| Settings groups (Scanner, "expiring soon" window, budget-warn) | `SettingsScreen.tsx` | 7 |
| First-run chooser | `FirstRunModules.tsx` + root wiring | 8 |

---

## 4. Phases

Each phase leaves the app compiling, type-clean and green. **After each:** `/code-review high` →
fix findings → `npm run type-check` + `vitest run` (see §5 for running tests inside the worktree) →
continuation prompt for the next phase.

### Phase 1 — Foundation (registry + store + pure engine)
- Add `feature-registry.ts`, `modules-graph.ts`, `useModulesStore.ts`, `useFeature.ts`,
  `presets.ts`. No visible UI wiring yet.
- Full unit tests for `modules-graph` (effective resolution, dependency closure, dependents,
  preset application, acyclicity/registry-integrity guards) and the store (intent, preset,
  reset, first-run flag, default-on for missing keys).
- **Exit:** the SSOT + engine exist and are exercised; app behaviour unchanged.

### Phase 2 — Navigation gating
- Annotate `NAV_DESTINATIONS` entries with `feature?: FeatureId`; filter `AppNav`,
  `DashboardNav`, and `CommandPalette` screen-jump by `useEnabledFeatures()`.
- Collapse empty nav groups (DashboardNav already returns `null` for an empty group; verify).
- Tests: hiding a feature (via store) removes its row/tile/jump entry; core always present.
- **Exit:** with a flag flipped, the three nav surfaces hide the module.

### Phase 3 — Modules manager screen
- New `/modules` route (not in `NAV_DESTINATIONS`; reached from Settings + first-run +
  interstitial). Add `'/modules'` to the `AppRoutePath` union and **regenerate
  `routeTree.gen.ts`** (see §5 — no dev server). `ModulesScreen` with `PageHeader`, preset cards,
  grouped feature toggles
  (Foundry primitives + field-gap/colour/motion tokens — no bodges), rich descriptions, and a
  search/filter box.
- Dependency UX: toggling off a feature with effective dependents opens a `Modal` confirming
  "this will also hide X, Y"; toggling on a feature with off dependencies confirms "this will
  also show A, B". Uses `closureToDisable`/`closureToEnable`.
- Settings entry-point row → navigates to `/modules` (mirrors the Storage-triage button).
- Tests: preset apply, toggle + dependency confirmation, live reflection.
- **Exit:** users can configure everything from a first-class screen.

### Phase 4 — Dashboard widget gating
- Add `feature?: FeatureId` to `WidgetDefinition`; map each widget (low-stock→core/perishables,
  expiring→perishables, overdue→contacts, maintenance→maintenance, in-transit→purchase-orders,
  projects→projects, budget-alerts→projects, recent-activity→activity, etc.).
- The grid filters placements whose feature is off; the "Customise" picker omits them. Turning a
  module back on restores the user's prior layout (intent preserved in `useLayoutStore`; the
  feature filter is applied on top, never mutating stored coords).
- **Surviving widget with a link into a hidden module:** a widget that stays visible but whose
  `to` points at a now-hidden route (e.g. `inventory-totals` → `/reports`) must drop its link
  (render non-clickable) rather than navigate into the interstitial. Resolve each widget's `to`
  through the enabled set at render.
- Tests: off module ⇒ widget absent from board + picker; on ⇒ restored; surviving widget's dead
  link is dropped.
- **Exit:** the dashboard reflects the module set.

### Phase 5 — Route guard + "module hidden" interstitial
- `ModuleGuard` wrapper: for an optional page route whose feature is off, render the interstitial
  (`PageHeader` + explanation + **Show this module** [flips intent] + **Continue anyway** [local
  override state renders the real screen once]). When on, render the screen normally.
- Wire the guard into each optional page route (`projects`, `purchase-orders`, `contacts`,
  `bookings`, `upcoming`, `activity`, `reports`, `alerts`, `sync`, `home-assistant`).
- `deep-link`, `share-target`, `import` stay always reachable (not nav; they target core
  Inventory) — confirm they aren't gated.
- Tests: hidden route → interstitial; Show → screen; Continue anyway → screen.
- **Exit:** direct URLs to hidden modules behave per spec.

### Phase 6 — Item-detail tabs & item actions
- `buildTabs` filters tabs/sections by feature: Maintenance (Lifecycle tab), Warranty/Asset
  (Lifecycle tab), Custom fields + Capabilities (Classification tab), Tags + Attachments (across
  Classification/Media tabs), Batches (stock breakdown). A tab with no remaining sections is
  dropped; the default `activeId` guard already tolerates a changing tab set.
- Gate item action buttons: checkout (contacts), reserve (projects), book (bookings), add-to-PO
  (purchase-orders), scan (scanner).
- Tests: off feature ⇒ tab/section/action absent; item data untouched.
- **Exit:** the item dialog only shows facets for enabled features.

### Phase 7 — Aggregate lanes, Reports & Settings groups
> **Rules-of-hooks:** never conditionally call a source query hook. Instead pass
> `enabled: isFeatureEnabled(...)` to each gated `useQuery` (skips the fetch) **and** feed an
> empty array into the pure `buildAlerts`/`buildAgenda` seam for a disabled lane, so the lane
> simply produces nothing.
- `useAlerts`: gate the maintenance/warranty/expiry lanes by `maintenance`/`warranty`/
  `perishables`.
- `useAgenda`: gate bookings/checkouts/maintenance/warranty/expiry/reorder lanes by their
  features (bookings→bookings, checkouts→contacts, maintenance→maintenance, warranty→warranty,
  expiry→perishables; reorder stays — it's core inventory).
- Reports screen: hide sub-report cards needing an off module (e.g. supplier costs→contacts,
  spend/PO→purchase-orders).
- Settings screen: hide the Scanner group (scanner), the "expiring soon" window (perishables) and
  the budget-warn threshold (projects) when their feature is off.
- Tests for each gated aggregate/report/setting.
- **Exit:** no hidden feature leaks into an aggregate, report or setting.

### Phase 8 — First-run chooser
- `FirstRunModules` modal shown once when `!firstRunComplete` (default everything ON until a
  choice/skip). Offers the presets with descriptions; **Skip** and any choice both set
  `firstRunComplete`. Re-runnable via a "Run setup again" action on the Modules screen.
- Tests: shows once; preset applies; skip keeps everything on; never re-shows after completion.
- **Exit:** new users get guided setup; existing behaviour preserved on skip.

### Phase 9 — Polish, verify, docs, merge
- End-to-end `/verify` with two contrasting configs (e.g. `minimal` and `asset-equipment`):
  confirm nav, dashboard, item dialog, alerts, upcoming, reports, settings, routes and the
  interstitial all behave.
- Design-token/a11y sweep of every new surface (Foundry primitives, field-gap tokens, aria,
  reduced-motion). Verify any new token-based Tailwind utility actually emits (build CSS + grep).
- Update the wiki/README note on modularity if warranted; keep copy neutral/public-safe.
- Final `/code-review high`; then **merge `feat/modular-ui` → `main`** and remove the worktree +
  branch (per the worktree-cleanup order: delete the node_modules junction *if any* before
  `git worktree remove --force`, then `git branch -d`).

---

## 5. Working notes / gotchas (from project memory)

- **Design system is mandatory:** Foundry primitives + field-gap/colour/motion tokens, never
  hand-rolled controls or raw sub-token gaps; full a11y wiring; unknown Tailwind utilities fail
  silently — verify via built CSS.
- **Running tests inside the worktree:** `vite.config` self-excludes `.claude/worktrees/**`, and
  linking `node_modules` triggers a dual-Vitest-instance error. **Don't** link node_modules
  (upward resolution finds `Gubbins/node_modules`); run via a temp config that drops the worktree
  exclude.
- **Adding a route without the dev server:** regenerate `routeTree.gen.ts` via
  `@tanstack/router-generator` (`Generator({config,root}).run()` + `getConfig(...)`); `tsc -b`
  runs before `vite build`, so the tree must exist first. `autoCodeSplitting: true` code-splits
  every route.
- **No backwards-compat needed:** the DB is disposable test data; no migrations required.
- **No secrets / public-repo hygiene:** everything world-readable and permanent; neutral copy.
- **Foundry patterns:** `Select`/`SelectField` (custom listbox), `Modal` (+ modal-stack: nested
  opens after parent), `FormField`, `PageHeader` (+ mock `@/components/nav/AppNav` in
  screen-render tests), `Menu`.
