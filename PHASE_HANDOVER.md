# PHASE_HANDOVER.md — Phase 2 → Phase 3

**Project:** Gubbins — local-first inventory tracking PWA
**Phase completed:** Phase 2 — Core Domain Models (Items, Quantity, Locations & Logging)
**Date:** 2026-06-27
**Status:** ✅ Complete. `tsc -b` clean · `vite build` passes · **90/90 unit tests pass** · dev server serves cross-origin-isolated.

> Protocol Alpha (§8.1.2): the incoming Phase 3 agent **must** read both the master
> specification (`docs/todo/_specification.md`, including the locked decisions in
> **§1.2 / §1.2.1**) and this document before writing any code, and must reuse the
> established Repository/driver, 3-tier state, and Foundry patterns rather than
> inventing new ones.

---

## 1. Locked decisions & toolchain (spec §1.2 — binding, restated)

| Area | Decision |
| --- | --- |
| SQLite WASM | `@sqlite.org/sqlite-wasm` 3.53 — official build, FTS5 + OPFS VFS |
| Package manager | **npm** (only `package-lock.json`) |
| Hosting | **GitHub Pages** → Vite `base: '/Gubbins/'` + service-worker COOP/COEP |
| Cloud sync | Provider-agnostic; concrete adapter deferred to **Phase 7** (no provider SDK before then) |
| Test runner | **Vitest** · UUIDs via native `crypto.randomUUID()` · formatting via `Intl` |

**Installed majors:** React 19.2 · TS 6 · Vite 8 (Rolldown) · Vitest 4 · Tailwind 4 (CSS-first) ·
TanStack Router 1.170 / Query 5.101 / Virtual 3.14 · Zustand 5 · React Hook Form 7 + Zod 4 (**now in use**) ·
lucide-react 1 · vite-plugin-pwa 1.3 · react-error-boundary 6. **No new deps added in Phase 2.**

**Commands:** `npm run dev` · `npm run build` (`tsc -b && vite build`) · `npm run type-check` · `npm run test:run` ·
`npm run test:e2e` (real-browser smoke; needs a dev server up).
**Local run:** `run.bat` (or `run.ps1`) — probes port 5173, reuses an already-running server, else picks a
free port and pins `--strictPort` so the opened URL always matches. Stop with **Ctrl+C**, not the window [X]
(the [X] orphans the node/vite child).
**E2E (spec §8.5.5):** **Playwright** (dev-only) drives the system **Edge** (`channel: 'msedge'`, no Chromium
download) against the cross-origin-isolated dev server — `scripts/browser-smoke.mjs`. It validates the *real*
OPFS/SharedArrayBuffer/worker path the `:memory:` unit tests bypass, and fails on any console/page error.
**Extend it with each phase's new flows.** Phase 2 run: 7/7 steps, zero console/page errors.

---

## 2. Current database schema snapshot (`PRAGMA user_version = 2`)

Per-connection pragma on every open: `PRAGMA foreign_keys = ON;`. All tables `STRICT`.
`SQL_NOW_MS` (UNIX-ms) is exported from `@/db/migrations`. v1 = `app_meta` (+ its trigger); v2 adds the domain.

```sql
-- categories (Phase 2 stub; dynamic custom-field schemas are Phase 3)
CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>)
) STRICT;

-- locations (self-referential, infinitely nestable)
CREATE TABLE locations (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
  parent_id TEXT REFERENCES locations(id),
  is_system INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (is_system IN (0, 1))
) STRICT;
CREATE INDEX idx_locations_parent_id ON locations(parent_id);

-- items (inline Consumable-Gauge primitive, §4.1.1)
CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT,
  location_id TEXT NOT NULL REFERENCES locations(id),
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  tracking_mode TEXT NOT NULL DEFAULT 'DISCRETE',
  quantity INTEGER NOT NULL DEFAULT 0,
  unit_of_measure TEXT, gross_capacity REAL, tare_weight REAL,
  current_net_value REAL, operational_metadata TEXT,   -- JSON as TEXT
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>),
  updated_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>),
  CHECK (tracking_mode IN ('DISCRETE','SERIALISED','CONSUMABLE_GAUGE')),
  CHECK (is_active IN (0,1)), CHECK (quantity >= 0),
  CHECK (tracking_mode <> 'SERIALISED' OR quantity = 1),
  CHECK (tracking_mode <> 'CONSUMABLE_GAUGE' OR (
    unit_of_measure IS NOT NULL AND gross_capacity IS NOT NULL AND gross_capacity > 0
    AND tare_weight IS NOT NULL AND tare_weight >= 0
    AND current_net_value IS NOT NULL AND current_net_value >= 0))
) STRICT;
CREATE INDEX idx_items_location_id ON items(location_id);
CREATE INDEX idx_items_category_id ON items(category_id);
CREATE INDEX idx_items_is_active ON items(is_active);

-- item_history: immutable, append-only Activity Log (§4.1.3). No updated_at.
CREATE TABLE item_history (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  action TEXT NOT NULL,            -- CREATED|RENAMED|QUANTITY_CHANGE|GAUGE_UPDATE|MOVED|SOFT_DELETED|RESTORED|RE_PARENTED
  quantity_delta INTEGER, net_value_delta REAL, note TEXT, metadata TEXT,
  created_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>)
) STRICT;
CREATE INDEX idx_item_history_item_id ON item_history(item_id, created_at);
```

**Triggers:** `trg_<categories|locations|items>_updated_at` (AFTER UPDATE auto-stamp, with the
`WHEN NEW.updated_at = OLD.updated_at` LWW pass-through guard); `trg_locations_protect_system_update`
/ `trg_locations_protect_system_delete` (the system **Unassigned** location is immutable & undeletable);
`trg_item_history_immutable` (BEFORE UPDATE → RAISE; the ledger is append-only).

**Unassigned location:** seeded with fixed sentinel id **`00000000-0000-4000-8000-000000000001`**
(`UNASSIGNED_LOCATION_ID` in `@/db/repositories`). Shared across devices so Phase 7 §7.5.2 re-parenting works.

**Adding Phase 3 schema:** create `src/db/migrations/v3-*.ts` (version `3`), register in
`src/db/migrations/index.ts`. Never edit shipped migrations; use the §2.3.3 12-step pattern for non-additive
changes. For new syncable tables replicate the UUID PK + `updated_at` trigger pattern.

---

## 3. Repository layer (`src/db/repositories/`)

All SQL lives here over the injected `IDatabaseDriver` (§2.1.1) — **components never write SQL**.
Construct with `new XRepository(driver, { isWriteSuspended? })`. **Tests inject `createMemoryDriver()`**
(§8.5.2); production singletons `getItemRepository()` / `getLocationRepository()` wire the worker driver +
the storage Hard-Stop gate. Reads are paginated (`Page<T>`, LIMIT/OFFSET ≤ 100, `MAX_PAGE_SIZE`).
Domain types (`Item`, `Location`, `LocationTreeNode`, `ItemHistoryEntry`, `GaugeState`, DTOs) and
constants (`TRACKING_MODES`, `HISTORY_ACTIONS`, `UNASSIGNED_LOCATION_ID`) are exported from the barrel.

### LocationRepository
```ts
getById(id): Promise<Location | undefined>
list(params?): Promise<Page<LocationWithCount>>            // flat, live active-item counts
getTree(): Promise<LocationTreeNode[]>                      // nested; powers useLocationTree
create(input): Promise<Location>                            // write-gated; validates parent
update(id, { name?, parentId? }): Promise<Location>         // write-gated; system-locked & cycle (CTE) guarded
delete(id): Promise<void>                                   // re-parents items→Unassigned, promotes children, logs; delete allowed under Hard Stop
```

### ItemRepository  (gauge maths in `src/db/repositories/gauge.ts`: `percentageRemaining`, `currentGrossWeight`, `weighInToDelta`, `weighInNote`)
```ts
getById(id): Promise<Item | undefined>
list(filters?): Promise<Page<Item>>        // {locationId?,categoryId?,search?,includeInactive?} + page; search is LIKE (FTS5 = Phase 5)
count(filters?): Promise<number>
create(input): Promise<Item>               // write-gated; logs CREATED; SERIALISED→qty 1; gauge defaults net=capacity, tare=0
update(id, {name?,description?,categoryId?}): Promise<Item>   // write-gated; logs RENAMED on name change
move(id, locationId): Promise<Item>        // write-gated; logs MOVED {fromLocationId,toLocationId}
adjustQuantity(id, delta, note?): Promise<Item>  // write-gated; DISCRETE only; rejects <0; logs QUANTITY_CHANGE
adjustGauge(id, { delta, note? }): Promise<Item> // write-gated; gauge only; clamps net≥0; logs GAUGE_UPDATE (relative delta)
weighInGauge(id, grossWeightOnScale): Promise<Item>  // converts absolute→delta then adjustGauge (§4.1.2)
softDelete(id, note?): Promise<Item>       // delete-class (allowed under Hard Stop); logs SOFT_DELETED
restore(id): Promise<Item>                 // write-gated; logs RESTORED
hardDelete(id): Promise<void>              // purge; cascades history (tombstones = Phase 7)
getHistory(itemId, params?): Promise<Page<ItemHistoryEntry>>  // newest first (created_at DESC, rowid DESC)
```
Hard Stop: growth writes throw `DbError('WRITE_SUSPENDED')` when `isWriteSuspended(tier)`; deletes/soft-deletes pass.

---

## 4. State roster

### Tier 1 — TanStack Query (`src/features/inventory/`)
- Keys: `inventoryKeys` — `items()/itemList(filters)/item(id)/itemHistory(id)/locations()/locationTree()/locationList()`.
- Read hooks (`queries.ts`): `useInventoryItems(filters,pageSize?)` (infinite, ≤100/page), `useItemCount`,
  `useItem`, `useItemHistory` (infinite), `useLocationTree`, `useLocations`.
- Write hooks (`mutations.ts`) — **optimistic + onError rollback** for item ops (snapshot list slices,
  patch, restore, invalidate onSettled): `useCreateItem`, `useUpdateItem`, `useMoveItem`, `useAdjustQuantity`,
  `useAdjustGauge`, `useSoftDeleteItem`, `useRestoreItem`, `useHardDeleteItem`. Location ops are
  invalidation-based (lower frequency, tree reshaping): `useCreateLocation`, `useUpdateLocation`, `useDeleteLocation`.
  Optimistic list filter matches **exactly** `['inventory','items','list',filters]` (excludes the count query).

### Tier 2 — Zustand (`src/state/stores/`, all persisted except storage telemetry)
- `useStorageStore` (Phase 1; telemetry, not persisted).
- **`useLayoutStore`** — `{ density: 'data'|'visual', sidebarCollapsed }` + `setDensity/toggleDensity/toggleSidebar`. Persisted `gubbins:layout`.
- **`usePreferencesStore`** — `{ baseCurrency:'GBP', locale:'en-GB', theme:'dark' }` + setters/`toggleTheme`. Persisted `gubbins:preferences`. (Theme toggle still not surfaced in UI — see debt.)

### Tier 3 — Context/local: boot context (Phase 1); per-card dialog state in inventory components.

---

## 5. Component tree (additions this phase)

```
__root → RootLayout (StorageBanners)
 ├─ index → DashboardScreen        (system status; StatusCard now supports a Markdown `info` Tooltip; links to /inventory)
 └─ inventory → InventoryScreen     src/features/inventory/
     ├─ header: brand · search (debounced) · LayoutToggle · "Add item"
     ├─ LocationSidebar             (nested tree, counts, add/delete, select-to-filter)
     ├─ ItemList                    (@tanstack/react-virtual; Visual=responsive cards / Data=dense rows; infinite)
     │   ├─ ItemCard / ItemRow → TrackingBadge, GaugeBar/GaugeRing, QuantityStepper, ItemActions
     │   └─ ItemActions → MoveItemDialog, GaugeAdjustDialog
     └─ CreateItemDialog (RHF+Zod), CreateLocationDialog
```
**Foundry (`src/components/foundry/`):** Button, Banner, Surface, Spinner, **Input, Select, Modal, Markdown, Tooltip**.
- **Markdown** — dependency-free, safe (no `dangerouslySetInnerHTML`) renderer: paragraphs, headings, lists,
  fenced code, `**bold**`/`*italic*`/`` `code` ``/`[links]`. `safeHref` allowlists http(s)/mailto/`/path`/`#`/`./`.
- **Tooltip** — portaled, viewport-clamped, **Markdown body**, hover + keyboard focus + **touch tap**, Escape/outside-tap to close.
  **Use this everywhere instead of the HTML `title` attribute** (project convention from Phase 2).
**Icons (`src/components/icons/`):** add new glyphs here (semantic re-exports of lucide) — never import lucide directly.
**Styles:** `src/styles/index.css` adds `@utility animate-fade-in/zoom-in/rise/pulse-success` (reduced-motion aware).

---

## 6. Technical debt, stubs & deferrals

1. **Categories** — table is a bare stub (`id,name,updated_at`) + nullable `items.category_id`. Dynamic
   custom-field schemas, lenient defaulting, the Category UI, and serialised auto-clone are **Phase 3**.
2. **Images** — no `item_images` table yet; the §4.2 compression/OPFS pipeline is **Phase 3**.
3. **Search** — `ItemRepository.list({search})` is a `LIKE` scan. FTS5 + Visual Builder are **Phase 5**
   (the `:memory:` test driver doesn't exercise FTS5 — assert on the WASM path / `diagnostics.fts5Available` then).
4. **Lifecycle** — `is_active` soft-delete exists; the **Condition enum** (Mint/Good/…) is Phase 9; **tombstones**
   + all sync (LWW, NTP, delta-CRDT, re-parenting §7.5) are **Phase 7**. Schema is shaped to accept them.
5. **Theme toggle** — `usePreferencesStore.theme` persists but nothing applies `.dark`/light to `<html>` yet
   (dark-only). Wire a small effect + a toggle control when the settings UI is built.
6. **Production CSP** — injected by the service worker (`src/sw.ts`, prod-only). Permissive-but-hardened
   (`script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'`, `style-src 'self' 'unsafe-inline'` — required by
   inline `style` on gauges/virtual rows, `worker-src 'self' blob:`, `object-src/base-uri/frame-ancestors` locked).
   **Verify in a real browser on first GitHub Pages deploy** (untested headless). Broaden `connect-src` in Phase 7.
7. **Location count fallback** — `InventoryScreen` resolves location names from the first 100 locations; an item
   under the 101st+ location shows "Unassigned" as a label only. Revisit if deep hierarchies are common.
8. **Tooltip keyboard-link reach** — focus leaving the trigger closes the bubble, so a keyboard user can't Tab
   into a Markdown link inside a tooltip (mouse/touch can). Fine for current supplementary content.
9. **Bundle** — main chunk ≈577 kB (≈179 kB gzip); inventory route ≈166 kB. Acceptable; revisit `manualChunks`/
   route-level dynamic import if it grows.

---

## 7. Phase 3 entry checklist (spec §5 — Category Schemas, Pointers & Dual-Tracking Levels)

- [ ] `v3-*.ts` migration: Categories with **dynamic custom-field definitions** + **lenient defaulting** (§4);
      freeform **tags**; the `item_images` table (§4.2.2: `id`, `item_id`, `thumbnail_blob`, `full_res_opfs_path`).
- [ ] Serialised **auto-clone** logic (adding N serialised items → N distinct records) in `ItemRepository`.
- [ ] Client-side **image compression pipeline** (canvas → WebP, ≤1080px, thumbnail) → OPFS raw file; only the
      path crosses the worker bridge (§4.2.3). Anti-Base64 directive (§4.2.1) is absolute.
- [ ] Category UI, custom-field forms (RHF+Zod), freeform tagging UI, Datasheet **Pointer vs URL** config (§4 Attachments).
- [ ] Reuse: Repository-over-driver + TDD on `createMemoryDriver()`; TanStack hooks (paginated, optimistic+rollback);
      Foundry primitives & **Tooltip (not `title`)**; British English; gate growth-writes on the Hard Stop.
- [ ] Extend `scripts/browser-smoke.mjs` (§8.5.5) with the new Phase 3 flows (categories, tags, image upload),
      keeping it green with zero console/page errors.
