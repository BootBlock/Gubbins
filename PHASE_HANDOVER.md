# PHASE_HANDOVER.md — Phase 1 → Phase 2

**Project:** Gubbins — local-first inventory tracking PWA
**Phase completed:** Phase 1 — Project Scaffolding, PWA & WASM SQL (FTS5)
**Date:** 2026-06-27
**Status:** ✅ Complete. `tsc -b` clean · `vite build` passes · 30/30 unit tests pass · dev server serves with COOP/COEP.

> Protocol Alpha (§8.1.2): the incoming Phase 2 agent **must** read both the master
> specification (`docs/todo/_specification.md`, including the locked decisions in
> **§1.2 / §1.2.1**) and this document before writing any code, and must reuse the
> established Repository/driver and state patterns rather than inventing new ones.

---

## 1. Locked decisions & toolchain (already in spec §1.2)

| Area | Decision |
| --- | --- |
| SQLite WASM | `@sqlite.org/sqlite-wasm` 3.53 — official build, FTS5 + OPFS VFS |
| Package manager | **npm** (only `package-lock.json`) |
| Hosting | **GitHub Pages** → Vite `base: '/Gubbins/'` + service-worker COOP/COEP |
| Cloud sync | Provider-agnostic; concrete adapter deferred to **Phase 7** |

**Installed majors:** React 19.2 · TypeScript 6 · Vite 8 (Rolldown) · Vitest 4 ·
Tailwind CSS 4 (`@tailwindcss/vite`, CSS-first) · TanStack Router 1.170 / Query 5.101 /
Virtual 3.14 · Zustand 5 · React Hook Form 7 + Zod 4 (installed, **not yet used**) ·
lucide-react 1 · vite-plugin-pwa 1.3 · react-error-boundary 6.

**Commands:** `npm run dev` · `npm run build` (`tsc -b && vite build`) ·
`npm run type-check` (`tsc -b --noEmit`) · `npm run test` / `test:run` (Vitest).

---

## 2. Current database schema snapshot (`PRAGMA user_version = 1`)

Per-connection pragma set on every open: `PRAGMA foreign_keys = ON;`

```sql
CREATE TABLE app_meta (
  key        TEXT    PRIMARY KEY NOT NULL,
  value      TEXT,
  updated_at INTEGER NOT NULL DEFAULT (CAST(ROUND(unixepoch('now', 'subsec') * 1000) AS INTEGER))
) STRICT;

CREATE TRIGGER trg_app_meta_updated_at
AFTER UPDATE ON app_meta
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at          -- only auto-stamp when caller left it unchanged
BEGIN
  UPDATE app_meta
  SET updated_at = (CAST(ROUND(unixepoch('now', 'subsec') * 1000) AS INTEGER))
  WHERE key = NEW.key;
END;
```

**Canonical patterns to replicate for every Phase 2 syncable domain table (§7.1):**
- `id TEXT PRIMARY KEY` populated with `crypto.randomUUID()` (UUIDv4) — **not** autoincrement.
- `updated_at INTEGER` (UNIX ms) with the `DEFAULT (${SQL_NOW_MS})` and an `AFTER UPDATE`
  auto-stamp trigger exactly like `trg_app_meta_updated_at` (the `WHEN NEW.updated_at =
  OLD.updated_at` guard is deliberate — it lets the Phase 7 sync engine apply a remote
  LWW timestamp without the trigger clobbering it, and prevents trigger recursion).
- Use `STRICT` tables. `SQL_NOW_MS` is exported from `@/db/migrations`.
- `app_meta` is an intentional **local-only key/value** exception to the UUID rule.

**To add the Phase 2 schema:** create `src/db/migrations/v2-*.ts` (version `2`), register it in
`src/db/migrations/index.ts`. The engine runs it atomically and bumps `user_version`. Never
edit a shipped migration; never `DROP TABLE` without the §2.3.3 12-step preserve pattern.

---

## 3. Data layer / active interfaces

All SQL goes through the driver — **React components must never write raw SQL** (§2.1.1).
Phase 2 introduces the Repository layer (`ItemRepository.ts`, `LocationRepository.ts`) that
wraps these driver calls; repositories receive an `IDatabaseDriver` by injection (§8.5.1).

### `IDatabaseDriver` — `src/db/rpc/driver.ts`
```ts
query<TRow>(sql: string, params?: SqlParams): Promise<TRow[]>
queryOne<TRow>(sql: string, params?: SqlParams): Promise<TRow | undefined>
execute(sql: string, params?: SqlParams): Promise<SqlExecuteResult>   // { rowsModified, lastInsertRowId }
transaction(statements: readonly SqlStatement[]): Promise<void>        // atomic BEGIN…COMMIT, auto-ROLLBACK
close(): Promise<void>
```
Supporting types: `SqlValue` (string | number | bigint | boolean | null | Uint8Array),
`SqlParams` (positional array **or** named record), `SqlRow`, `SqlStatement { sql, params? }`.

### Implementations
- **Production:** `WorkerDatabaseDriver` (`src/db/rpc/worker-driver.ts`) — also exposes
  `init()`, `diagnostics()` → `DbDiagnostics`, `exportBinary()` → `Uint8Array`, `dispose()`.
- **Tests:** `createMemoryDriver()` (`src/test/drivers/memory-driver.ts`) — synchronous,
  backed by Node's `node:sqlite`. This is the §8.5.2 `:memory:` injection seam. **Inject this
  into Phase 2 repositories in unit tests** instead of the worker.

### Client / boot — `src/db/client.ts`
```ts
getDatabaseDriver(): WorkerDatabaseDriver        // app-wide singleton
bootDatabase(): Promise<DbBootResult>            // init + migrate; { diagnostics, migration }
disposeDatabase(): Promise<void>                 // Safe-Mode hard reset
```

### Migrations — `src/db/migrations/`
```ts
runMigrations(driver, migrations): Promise<MigrationReport>   // { from, to, applied }
getUserVersion(driver): Promise<number>
migrations: readonly Migration[]                              // the ordered registry
TARGET_SCHEMA_VERSION: number
SQL_NOW_MS: string                                            // UNIX-ms expression
```

### Errors — `src/db/errors.ts`
`DbError { code: DbErrorCode, resultCode?, sql?, isRetryable }` with `toSerialized()` /
`fromSerialized()` / `fromUnknown()` and `mapResultCode()`. Codes include `SQLITE_BUSY`,
`SQLITE_CONSTRAINT_FOREIGNKEY` (needed for §7.5 re-parenting later), `FTS5_UNAVAILABLE`,
`OPFS_UNAVAILABLE`, `INIT_FAILED`, etc. Errors marshal across the worker bridge intact.

### Worker — `src/db/worker/`
`database.worker.ts` (FIFO-serialised RPC loop, §2.2.4) + `sqlite-bootstrap.ts` (opens
`OpfsDb('/gubbins.sqlite3','c')`, sets `foreign_keys`, **runtime-probes FTS5** by creating a
temp FTS5 table). RPC protocol/envelopes in `src/db/rpc/protocol.ts`. The main thread never
imports the WASM binary. To add a worker op: extend the `DbRequest` union + the worker
`dispatch` switch + a `WorkerDatabaseDriver` method.

---

## 4. State management roster

### Tier 1 — TanStack Query
- `createQueryClient()` (`src/state/query/queryClient.ts`); `<QueryClientProvider>` mounted in `App.tsx`.
- **No query keys or hooks yet.** Phase 2 adds them: wrap each repository read in a hook
  (`useInventoryItems(filters)`, `useLocationTree()`), enforce **LIMIT/OFFSET ≤ 100 per page**
  (§2.1), and use `onMutate`/`onError` optimistic-update + rollback for writes.

### Tier 2 — Zustand (`src/state/stores/`)
- **`useStorageStore`** — live storage telemetry: `{ persisted, estimate, ratio, tier,
  warningDismissed }` + `refresh()`, `requestPersistence()`, `dismissWarning()`,
  `startMonitoring()` (5-min poll), `stopMonitoring()`. **Not persisted** (runtime telemetry).
- **Not yet created (Phase 2+):** `usePreferencesStore` (base currency `GBP`/locale `en-GB`/
  theme), `useLayoutStore` (Data-Heavy vs Visual-Heavy toggle, sidebar), `useAuthStore`
  (Phase 7 cloud). Split per-domain; do **not** create one mega-store.

### Tier 3 — Context / hooks (`src/app/boot/`)
- `useDatabaseBoot()` — boot state machine: `starting | unsupported | multi-tab | error | ready`.
- `BootResultProvider` / `useBootResult()` — exposes `DbBootResult` to ready routes.

---

## 5. Component tree topography

```
main.tsx
└─ App.tsx
   └─ AppErrorBoundary            (react-error-boundary → SafeMode fallback)   src/app/error/
      └─ QueryClientProvider      (Tier-1)
         └─ BootGate              (useDatabaseBoot)                            src/app/boot/
            ├─ StartingScreen | UnsupportedScreen | MultiTabScreen | BootErrorScreen   (BootScreens.tsx)
            └─ [ready] BootResultProvider
               └─ RouterProvider                                              src/app/router.tsx
                  └─ __root (RootLayout)                                      src/routes/__root.tsx
                     ├─ StorageBanners   (persistence + quota tiers)          src/features/storage/
                     └─ index → DashboardScreen  (system-status board)        src/features/dashboard/
```
- **Foundry primitives** (`src/components/foundry/`): `Button`, `Banner`, `Surface`, `Spinner`.
  Feature code imports from here, **never** shadcn/lucide directly (§2.4.1).
- **Icon registry** (`src/components/icons/`): semantic re-exports of lucide-react.
- **Safe Mode rescue** (`src/app/error/`): `SafeMode` + `RescueActions` (download raw `.sqlite`,
  JSON dump, hard reset/purge) + `safe-mode-actions.ts`.
- **Feature detection** (`src/lib/env/feature-detection.ts`): all capability guards +
  `checkCriticalSupport()`. **Formatting** (`src/lib/format.ts`): `formatBytes`/`formatPercent`
  (native Intl, en-GB).

---

## 6. Technical debt, stubs & decisions to carry forward

1. **No domain models yet** — items/locations/categories/`Unassigned` location, the Repository
   layer, and TanStack Query hooks are **Phase 2**. v1 schema is just `app_meta`.
2. **shadcn/ui** — `components.json` is configured with `ui → @/components/foundry`, so
   `npx shadcn@latest add <component>` drops accessible primitives straight into the foundry.
   Phase 1's foundry primitives are hand-built (minimal surface); swap/augment as needed.
3. **Hard Stop enforcement** — `classifyStorageTier()` / `isWriteSuspended()` exist and are
   tested, but there are no domain writes yet to gate. **Phase 2 repositories must call
   `isWriteSuspended(useStorageStore.getState().tier)` before INSERT/UPDATE** and allow DELETE.
4. **Theme** — dark-only (`<html class="dark">`); the light palette + Dark/Light toggle
   (`usePreferencesStore`) is wired in CSS but not yet exposed in UI.
5. **PWA icon** — single brand SVG (`public/icons/gubbins.svg`, `any maskable`). Raster PNG
   192/512 + `apple-touch-icon` for legacy/iOS are a trivial deferred asset task.
6. **Service worker deviation (documented)** — used vite-plugin-pwa **`injectManifest`**
   (`src/sw.ts`) rather than `generateSW` + a standalone `coi-serviceworker`, because §2.2.6
   requires custom fetch logic (COOP/COEP injection) that `generateSW` cannot express, and two
   service workers cannot share one scope. One worker now does precaching **and** header
   injection. First production load reloads once (via the `index.html` bootstrap) to gain
   isolation — expected behaviour for SW header injection.
7. **Test engine** — the `:memory:` test driver uses `node:sqlite` (a real SQLite, but a
   different build from the production WASM). It validates SQL syntax/semantics; **FTS5 is not
   exercised** there. Phase 5 FTS5 tests should assert against the WASM path or guard on
   `diagnostics.fts5Available`.
8. **Bundle size** — main chunk ≈565 kB (≈175 kB gzip). Acceptable for the foundation; revisit
   `manualChunks`/route-level dynamic import if it grows (RHF/Zod are installed but tree-shaken
   out until used).
9. **Multi-tab guard** — Web Locks based; degrades to "sole tab" where unavailable (acceptable,
   as OPFS environments have Web Locks). `BroadcastChannel` fallback not implemented (unneeded).
10. **WAL** — not enabled (OPFS VFS is single-connection; default rollback journal is correct).

---

## 7. Phase 2 entry checklist (spec §5)

- [ ] `v2-*.ts` migration: `items`, `locations` (self-referential `parent_id`), the system-locked
      **`Unassigned`** location (immutable — §4), Consumable-Gauge fields (§4.1.1), `item_history`
      (immutable Activity Log). Use UUID PKs + `updated_at` trigger pattern from §2 above.
- [ ] `ItemRepository` / `LocationRepository` over `IDatabaseDriver`; **paginated** reads
      (LIMIT/OFFSET ≤ 100). TDD them with `createMemoryDriver()` first (Protocol Beta).
- [ ] TanStack Query hooks + keys; optimistic writes with rollback; `@tanstack/react-virtual` lists.
- [ ] `useLayoutStore` (Data-Heavy ↔ Visual-Heavy) + `usePreferencesStore`; engaging feedback.
- [ ] Gate writes on the storage Hard Stop (item 3 above).
