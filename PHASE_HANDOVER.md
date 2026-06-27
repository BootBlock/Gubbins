# PHASE_HANDOVER.md — Phase 3 → Phase 4

**Project:** Gubbins — local-first inventory tracking PWA
**Phase completed:** Phase 3 — Category Schemas, Pointers & Dual-Tracking Levels
**Date:** 2026-06-27
**Status:** ✅ Complete. `tsc -b` clean · `vite build` passes · **136/136 unit tests pass** · **11/11 browser-smoke steps pass** (zero console/page errors).

> Protocol Alpha (§8.1.2): the incoming Phase 4 agent **must** read both the master
> specification (`docs/todo/_specification.md`, including the locked decisions in
> **§1.2 / §1.2.1**) and this document before writing any code, and must reuse the
> established Repository/driver, 3-tier state, Foundry, and testing patterns rather
> than inventing new ones.

---

## 1. Locked decisions & toolchain (spec §1.2 — binding, restated)

| Area | Decision |
| --- | --- |
| SQLite WASM | `@sqlite.org/sqlite-wasm` — official build, FTS5 + OPFS VFS |
| Package manager | **npm** (only `package-lock.json`) |
| Hosting | **GitHub Pages** → Vite `base: '/Gubbins/'` + service-worker COOP/COEP |
| Cloud sync | Provider-agnostic; concrete adapter deferred to **Phase 7** (no provider SDK before then) |
| Test runner | **Vitest** · UUIDs via native `crypto.randomUUID()` · formatting via `Intl` |
| E2E | **Playwright** (dev-only) driving **system Edge** (`channel: 'msedge'`, no download) |

**Installed majors:** React 19 · TS 6 · Vite 8 (Rolldown) · Vitest 4 · Tailwind 4 (CSS-first) ·
TanStack Router / Query / Virtual · Zustand 5 · React Hook Form 7 + Zod 4 · lucide-react ·
vite-plugin-pwa · react-error-boundary. **No new runtime deps added in Phase 3** (the image
pipeline uses native `<canvas>` + OPFS APIs; no image library).

**Commands:** `npm run dev` · `npm run build` (`tsc -b && vite build`) · `npm run type-check` ·
`npm run test:run` (unit/`:memory:`) · `npm run test:e2e` (real-browser smoke; needs a dev server up).
**Local run:** `run.bat` / `run.ps1` — probes port 5173, reuses a running server, else picks a free
port with `--strictPort`. **Phase 3 update:** the launcher now opens **system Edge** for the
auto-open (falling back to the OS default browser if Edge is absent), honouring a pre-set
`$env:BROWSER` override (`'none'` suppresses). Stop with **Ctrl+C**, not the window [X].
**E2E (§8.5.5):** `scripts/browser-smoke.mjs` validates the *real* OPFS/SharedArrayBuffer/worker
path; it now **fails on any console error too** (not just page errors). **Extend it each phase.**

---

## 2. Current database schema snapshot (`PRAGMA user_version = 3`)

Per-connection pragma on every open: `PRAGMA foreign_keys = ON;`. All tables `STRICT`.
`SQL_NOW_MS` (UNIX-ms) is exported from `@/db/migrations`. v1 = `app_meta`; v2 = core domain;
**v3 (`src/db/migrations/v3-schema.ts`)** adds category schemas, tags, images, attachments, and
the additive `items.serial_no`. Every syncable table keeps the §7.1 UUID PK + `updated_at`
auto-stamp trigger (the `WHEN NEW.updated_at = OLD.updated_at` LWW pass-through guard).

```sql
-- categories (name only; custom-field DEFINITIONS live in category_fields)
CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>)
) STRICT;

-- locations (self-referential, infinitely nestable; system-locked "Unassigned")
CREATE TABLE locations (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
  parent_id TEXT REFERENCES locations(id),
  is_system INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>),
  CHECK (parent_id IS NULL OR parent_id <> id), CHECK (is_system IN (0,1))
) STRICT;
CREATE INDEX idx_locations_parent_id ON locations(parent_id);

-- items (inline Consumable-Gauge primitive §4.1.1; serial_no added in v3)
CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT,
  location_id TEXT NOT NULL REFERENCES locations(id),
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  tracking_mode TEXT NOT NULL DEFAULT 'DISCRETE',
  quantity INTEGER NOT NULL DEFAULT 0,
  unit_of_measure TEXT, gross_capacity REAL, tare_weight REAL,
  current_net_value REAL, operational_metadata TEXT,
  serial_no INTEGER,                                   -- v3: SERIALISED instance # (1..N), else NULL
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

-- v3: category custom-field DEFINITIONS (§4 Categories & Schema Evolution)
CREATE TABLE category_fields (
  id TEXT PRIMARY KEY NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  field_type TEXT NOT NULL,        -- TEXT|NUMBER|BOOLEAN|DATE|SELECT
  options TEXT,                    -- JSON array for SELECT fields
  is_required INTEGER NOT NULL DEFAULT 0,
  default_value TEXT,              -- powers lenient defaulting (§4)
  position INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>),
  CHECK (field_type IN ('TEXT','NUMBER','BOOLEAN','DATE','SELECT')), CHECK (is_required IN (0,1))
) STRICT;
CREATE INDEX idx_category_fields_category_id ON category_fields(category_id);

-- v3: per-item custom-field VALUES (normalised EAV; absent row ⇒ field default, lenient defaulting)
CREATE TABLE item_field_values (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES category_fields(id) ON DELETE CASCADE,
  value TEXT, updated_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>),
  UNIQUE (item_id, field_id)
) STRICT;
CREATE INDEX idx_item_field_values_item_id ON item_field_values(item_id);
CREATE INDEX idx_item_field_values_field_id ON item_field_values(field_id);

-- v3: freeform tags + item join (§5). Case-insensitively de-duplicated.
CREATE TABLE tags (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>)
) STRICT;
CREATE UNIQUE INDEX idx_tags_name ON tags(name COLLATE NOCASE);
CREATE TABLE item_tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
) STRICT;
CREATE INDEX idx_item_tags_tag_id ON item_tags(tag_id);

-- v3: item images (§4.2.2 — Anti-Base64 Directive). Thumbnail BLOB + OPFS path only.
CREATE TABLE item_images (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  thumbnail_blob BLOB,             -- tiny ≤150px WebP for list rendering
  full_res_opfs_path TEXT NOT NULL,-- pointer to the raw WebP file in OPFS (never the bytes)
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>),
  updated_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>)
) STRICT;
CREATE INDEX idx_item_images_item_id ON item_images(item_id, position);

-- v3: datasheet attachments (§4). URL or sync-safe LOCAL_POINTER path string.
CREATE TABLE item_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- URL|LOCAL_POINTER
  value TEXT NOT NULL, label TEXT, position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>),
  updated_at INTEGER NOT NULL DEFAULT (<SQL_NOW_MS>),
  CHECK (kind IN ('URL','LOCAL_POINTER'))
) STRICT;
CREATE INDEX idx_item_attachments_item_id ON item_attachments(item_id, position);
```

**Triggers:** `trg_<table>_updated_at` AFTER UPDATE auto-stamp on every syncable table (now also
`category_fields`, `item_field_values`, `tags`, `item_images`, `item_attachments`); the
`trg_locations_protect_system_*` guards; `trg_item_history_immutable` (append-only ledger).
**Unassigned location** sentinel id **`00000000-0000-4000-8000-000000000001`** (`UNASSIGNED_LOCATION_ID`).

**Adding Phase 4 schema:** create `src/db/migrations/v4-*.ts` (version `4`), register in
`src/db/migrations/index.ts`. Never edit shipped migrations; use the §2.3.3 12-step pattern for
non-additive changes. New syncable tables replicate the UUID PK + `updated_at` trigger pattern.

---

## 3. Repository layer (`src/db/repositories/`)

All SQL lives here over the injected `IDatabaseDriver` (§2.1.1) — **components never write SQL**.
Construct `new XRepository(driver, { isWriteSuspended? })`. **Tests inject `createMemoryDriver()`**
(`node:sqlite`, §8.5.2); production singletons (`getItemRepository`, `getLocationRepository`,
`getCategoryRepository`, `getTagRepository`, `getImageRepository`, `getAttachmentRepository`) wire
the worker driver + the storage Hard-Stop gate. Reads paginate (`Page<T>`, LIMIT/OFFSET ≤ 100).
Growth-writes call `assertWritable()`; deletes/soft-deletes bypass it (they free space).

### ItemRepository (gauge maths in `gauge.ts`)
```ts
getById(id)                         // JOINs primary thumbnail_blob (§4.2.4); never full-res path
list(filters?) : Page<Item>         // {locationId?,categoryId?,search(LIKE),includeInactive?}+page; carries thumbnailBlob
count(filters?) : number
create(input) : Item                // logs CREATED; SERIALISED→qty 1, serial_no NULL; gauge defaults
createSerialised(input) : Item[]    // NEW §4 auto-clone: N records share a name, serial_no 1..N
update(id,{name?,description?,categoryId?}) : Item    // logs RENAMED on name change
move(id,locationId) : Item          // logs MOVED
adjustQuantity(id,delta,note?) : Item   // DISCRETE only; logs QUANTITY_CHANGE
adjustGauge(id,{delta,note?}) : Item    // gauge only; clamps ≥0; logs GAUGE_UPDATE (relative delta)
weighInGauge(id,grossWeightOnScale) : Item   // absolute→delta then adjustGauge (§4.1.2)
softDelete(id,note?) / restore(id) / hardDelete(id)
getHistory(itemId,params?) : Page<ItemHistoryEntry>  // newest first
```

### LocationRepository  (unchanged from Phase 2)
`getById · list · getTree · create · update · delete` (re-parents items→Unassigned, cycle-guarded).

### CategoryRepository  (NEW)
```ts
getById(id) · list(params?) : Page<CategoryWithFieldCount> · create({name}) · update(id,{name?}) · delete(id)
listFields(categoryId) : CategoryField[]
addField(categoryId,input) · updateField(fieldId,input) · deleteField(fieldId)   // SELECT requires options
resolveItemFields(itemId) : ResolvedItemField[]   // LENIENT DEFAULTING at read time (§4)
setItemFieldValues(itemId, Record<fieldId, string|null>)   // upsert/clear; validates field∈category
```
Lenient defaulting is **read-time**: a missing value row resolves to the field default (or null) —
existing items are never back-filled when the schema changes.

### TagRepository  (NEW)
```ts
list(params?) : Page<TagWithCount> · getForItem(itemId) : Tag[] · suggest(prefix,limit?) : Tag[]
setForItem(itemId, names[])   // auto-creates unknown tags, reuses existing case-insensitively, diffs the set
```

### ImageRepository  (NEW)
```ts
listForItem(itemId) : ItemImage[]
add({itemId,thumbnailBlob,fullResOpfsPath,position?}) : ItemImage   // write-gated
remove(id) : string | undefined   // returns the OPFS path so the caller deletes the raw file
```

### AttachmentRepository  (NEW)
```ts
listForItem(itemId) : ItemAttachment[]
add({itemId,kind,value,label?,position?}) : ItemAttachment   // URL kind validated http(s)
update(id,{value?,label?,position?}) · remove(id)
```

Domain types + constants exported from the `@/db/repositories` barrel:
`FIELD_TYPES/FieldType`, `ATTACHMENT_KINDS/AttachmentKind`, `CategoryField`, `ResolvedItemField`,
`Tag/TagWithCount`, `ItemImage`, `ItemAttachment`, `Create*Input`, plus the Phase 2 set.

---

## 4. Image pipeline (`src/features/images/`) — §4.2, browser-only

- **`compression.ts`** — `processImageFile(blob)` → `{ fullRes: Blob (≤1080px WebP), thumbnailBytes: Uint8Array (≤150px WebP) }` via hidden `<canvas>` + `createImageBitmap`.
- **`opfs-images.ts`** — native main-thread OPFS raw-file API: `saveImageFile(blob)` → `images/<uuid>.webp` path, `readImageBlob(path)`, `deleteImageFile(path)`. **Bypasses SQLite entirely** for binary (Anti-Base64 §4.2.1); only the path + tiny thumbnail cross the worker bridge.
- Not unit-tested (needs canvas/OPFS) — validated by the browser smoke (§8.5.5).

---

## 5. State roster

### Tier 1 — TanStack Query (`src/features/inventory/`)
- Keys (`inventoryKeys`, in `queries.ts`): Phase 2 set **plus** `categories()/categoryList()/categoryFields(id)/itemFields(id)/tags()/tagList()/itemTags(id)/itemImages(id)/itemAttachments(id)`.
- Read hooks: `queries.ts` (items/locations); `categories.ts` (`useCategories/useCategoryFields/useItemFields`); `tags.ts` (`useTagDictionary/useItemTags/useTagSuggestions`); `media.ts` (`useItemImages/useItemAttachments`).
- Write hooks: `mutations.ts` (item ops **optimistic + onError rollback**; `useCreateSerialisedItems` is invalidation-based); category/tag/media mutations are invalidation-based. The image add-hook orchestrates compress→OPFS→DB and cleans up the orphan OPFS file on DB failure.

### Tier 2 — Zustand (`src/state/stores/`, persisted)
- `useStorageStore` (telemetry, not persisted) · `useLayoutStore` (`density`, `sidebarCollapsed`) ·
  **`usePreferencesStore`** — `{ baseCurrency:'GBP', locale:'en-GB', theme:'dark', attachmentMode:'URL_ONLY'|'HYBRID' }` (+`setAttachmentMode`). **`attachmentMode` is new** (Datasheet Option A/B, §4).

### Tier 3 — Context/local: boot context; per-card dialog state in inventory components.

---

## 6. Component tree (Phase 3 additions)

```
inventory → InventoryScreen
 ├─ header: brand · search · LayoutToggle · "Categories" (NEW) · "Add item"
 ├─ CategoryManagerDialog (NEW)   categories · custom-field editor (AddFieldForm) · datasheet-linking config (attachmentMode)
 ├─ CreateItemDialog              + Category select + serialised "How many" count (→ createSerialised)
 ├─ ItemList → ItemCard/ItemRow   ItemCard now shows Thumbnail + serial #
 │   └─ ItemActions → + "Item details" → ItemDetailDialog (NEW)
 │        └─ sections: ImageManager · TagEditor · CustomFieldsEditor · AttachmentManager (all NEW)
 └─ (existing) MoveItemDialog, GaugeAdjustDialog, CreateLocationDialog, LocationSidebar
```
- **Foundry (`@/components/foundry`):** Button, Banner, Surface, Spinner, Input, Select, Modal, Markdown, **Tooltip**. **Tooltip now opens after a 300 ms hover dwell** (immediate on keyboard focus & touch tap); use it everywhere instead of the HTML `title` attribute.
- **Icons (`@/components/icons`):** added CategoryIcon, TagIcon/TagsIcon, ImageIcon, UploadIcon, DatasheetIcon, LinkIcon, LocalFileIcon, SettingsIcon, CheckIcon. Never import lucide directly.
- **`Thumbnail.tsx`** renders a thumbnail BLOB via an object URL created in an effect (StrictMode-safe; copies bytes to a fresh ArrayBuffer because OPFS blobs can be SharedArrayBuffer-backed).

---

## 7. Technical debt, stubs & deferrals

1. **FTS5 / Visual Builder** — `ItemRepository.list({search})` is still a `LIKE` scan; FTS5 + the Visual-Builder AST (§5.1) are **Phase 5**. The `:memory:` driver doesn't exercise FTS5.
2. **Sync** — tombstones, LWW, NTP offset, delta-CRDT, re-parenting (§7) are **Phase 7**. Schema is shaped for them (UUID PKs, `updated_at`, system-locked Unassigned). `item_tags` is a bare composite-PK join with no `updated_at` — Phase 7 must decide how M:N joins sync.
3. **Attachments** — config + records only; persisting live `FileSystemFileHandle`s / re-prompting / "Unlinked Local File" cross-device resolution deferred (the path string is stored, which is the sync-safe half).
4. **Custom fields** — values stored as TEXT (EAV); typed validation lives in the form layer, not enforced in the DB. No per-field history logging (kept lean).
5. **Lifecycle** — Condition enum (Mint/Good/…), Parent/Child variants, maintenance schedules are **Phase 9**. `serial_no` lays groundwork but the full variant relation is not built.
6. **Theme toggle** — `usePreferencesStore.theme` persists but nothing applies `.dark`/light to `<html>` yet (dark-only).
7. **Bundle** — main chunk > 500 kB (warning only). Acceptable; revisit `manualChunks`/route-level dynamic import if it grows.
8. **Tooltip keyboard-link reach** — focus leaving the trigger closes the bubble, so a keyboard user can't Tab into a Markdown link inside it (mouse/touch can).

---

## 8. Phase 4 entry checklist (spec §5 — Projects, Reservations, Procurement & BOM Imports)

- [ ] Read the master spec (esp. §4 Composite Items & Assemblies, Projects & BOMs; §3 Export Wizard) and this handover; restate the locked decisions.
- [ ] `v4-*.ts` migration (version 4) registered in `migrations/index.ts`: projects, BOM lines, reservations (Tentative/Actual), the system-locked **"In Transit"** location/status (§4 procurement). UUID PKs + `updated_at` triggers; §2.3.3 12-step pattern for any non-additive change.
- [ ] TDD over `createMemoryDriver()` first (Protocol Beta): a `ProjectRepository` for create/BOM/reservations, **Current Replacement Value vs Point-in-Time Snapshot** costing, the three assembly outcomes (Container / Singular Object / **Permanent Consumption** = soft-delete parts), and automated Shopping-List views.
- [ ] Manual **and** CSV/KiCad BOM import (auto-match by MPN/aliases).
- [ ] Reuse: Repository-over-driver; TanStack hooks (paginated, optimistic + `onError` rollback); Foundry primitives & **Tooltip (not `title`)**; RHF + Zod forms; British English; gate growth-writes on the Hard Stop.
- [ ] Extend `scripts/browser-smoke.mjs` with the Phase 4 flows (create a project, add BOM lines, reserve stock, costing toggle), keeping it green with zero console/page errors.
- [ ] Verify three ways (`type-check`, `test:run`, `build`) **and** `test:e2e` against a live dev server before declaring the phase complete.
