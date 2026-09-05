# Location photos & item regions — implementation plan

> **Status:** 🟢 ACTIVE — plan drafted and fact-checked for issue #81; implementation in progress.

Lets a user attach photos to a `Location` and draw named **regions** (rectangle, circle,
polygon) onto them, then associate items with those regions so "where is it, exactly?" is
answered by a picture rather than prose.

> This plan was drafted, then verified line-by-line against the codebase and revised. The
> revision notes at the end of each section record what the first draft got wrong, because
> those mistakes are the ones most likely to be repeated.

## 1. The cardinality decision

The issue was explicitly undecided between "positional pool" and "strictly one-to-one".
**Resolved: a named region pool with a many-to-many item link.**

A region is a *place* — "Top shelf", "Drawer 2", "the bin behind the door" — that exists
independently of what is in it. Items reference it. This is strictly more expressive than
one-to-one (nothing stops a region holding exactly one item), and it matches the model
already in the database: `item_stock` lets one item sit in several locations at once
(`UNIQUE (item_id, location_id)` is per *pair*, `v1-initial.ts:812`), so a model that forced
one position per item would contradict the layer beneath it.

Consequences we accept:

- A region can be empty. That is a feature — you can map a shelf out before filling it.
- An item can appear in two regions on the same photo. Rare, but legitimate (a long part
  spanning two bins), and forbidding it costs a constraint that buys nothing.
- Deleting a region does **not** delete items; it only unlinks them.

## 2. Data model

Three tables, folded into the single squashed `v1-initial` baseline per
[[migration-baseline-squashed]] — there is no incremental upgrade path, and editing the
baseline *is* the version bump (the FNV-1a fingerprint in `migration.ts:36` derives from the
statements themselves and stamps `app_meta.baseline_revision`).

**Timestamps are epoch-millis `INTEGER`, defaulted from the shared `SQL_NOW_MS` constant**
(`migration.ts:9`) — *not* ISO `TEXT`. Under `STRICT` the wrong type is a hard error. The
auto-stamp trigger comes from the `updatedAtTrigger(table)` helper (`v1-initial.ts:76-86`),
which fires only `WHEN NEW.updated_at = OLD.updated_at` and stamps
`MAX(SQL_NOW_MS, OLD.updated_at + 1)` — forcing an edit strictly past what it derived from so
a same-millisecond edit is not silently discarded by LWW.

### `location_photos`

```sql
CREATE TABLE location_photos (
  id                     TEXT    PRIMARY KEY NOT NULL,
  location_id            TEXT    NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  caption                TEXT,
  thumbnail_blob         BLOB,
  full_res_opfs_path     TEXT    NOT NULL,
  full_res_downgraded_at INTEGER,
  natural_width          INTEGER NOT NULL,
  natural_height         INTEGER NOT NULL,
  position               INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
  updated_at             INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
) STRICT;
```

Deliberate choices:

- **Mirrors `item_images` (`v1-initial.ts:480-488`) column-for-column**, including the §4.2.1
  Anti-Base64 split: full-res WebP as a raw OPFS file, tiny WebP thumbnail as a SQLite
  `BLOB`. Reuses `features/images/compression.ts` and `opfs-images.ts` untouched.
- **The blob column is named `thumbnail_blob`, byte-for-byte.** `blob-codec.ts` hardcodes that
  column name (`:35`, `:45`); a differently-named column would not error, it would silently
  sync a corrupt `{"0":…}` object. Adding the table to `BLOB_TABLES` (`:51`) is then the only
  codec change.
- **`natural_width` / `natural_height` are stored, not derived.** Region geometry is
  normalised, so rendering needs the aspect ratio *before* the full-res file loads — and on a
  peer device that file may never arrive at all. Without this the overlay jumps on load.
- **`full_res_downgraded_at`** so location photos join Storage Triage Workflow B. It is
  per-device state and **must** be excluded from sync — see §4.

### `location_regions`

```sql
CREATE TABLE location_regions (
  id         TEXT    PRIMARY KEY NOT NULL,
  photo_id   TEXT    NOT NULL REFERENCES location_photos(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  shape      TEXT    NOT NULL CHECK (shape IN ('rect','circle','polygon')),
  geometry   TEXT    NOT NULL,
  color      TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
  updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
) STRICT;
```

The `shape` CHECK list is built from a shared application constant the same way
`trackingModeList` is (`v1-initial.ts:~90`), so a constant edit can never drift from the
schema's constraint.

`geometry` is a JSON string in **normalised image space**, never pixels — a photo re-encoded
at a different size must not move its regions:

| shape | JSON |
| --- | --- |
| `rect` | `{"x":0.1,"y":0.2,"w":0.3,"h":0.15}` |
| `circle` | `{"cx":0.5,"cy":0.5,"r":0.2}` |
| `polygon` | `{"points":[{"x":..,"y":..}, …]}` (≥3) |

**The aspect-ratio trap:** `x` and `y` are each normalised against their own axis (0–1 of
width, 0–1 of height). That is right for rectangles and polygons, but a circle stored that way
renders as an *ellipse* on a non-square photo. So **`r` is normalised against the image width
only**, and the renderer derives `ry = r * (naturalWidth / naturalHeight)` in normalised units
so it stays visually circular at any display size. Subtle enough that it gets its own pure
module and unit tests (§5).

`color` holds a `--loc-*` palette key (`index.css:149-160`) — the existing, dark-mode-correct
location swatch palette — not a hex literal.

### `item_regions`

```sql
CREATE TABLE item_regions (
  item_id   TEXT NOT NULL REFERENCES items(id)            ON DELETE CASCADE,
  region_id TEXT NOT NULL REFERENCES location_regions(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, region_id)
) STRICT;
```

**No timestamps at all** — this exactly mirrors `location_tags` (`v1-initial.ts:470-474`),
which is the membership-reconciled pattern being copied. A `created_at` here would look
harmless but would silently re-default on every peer apply, since the membership path writes
`INSERT OR IGNORE` over the key columns only.

Indexes: `idx_location_photos_location_id`, `idx_location_regions_photo_id`, and
`idx_item_regions_region_id` (the reverse lookup — "which regions hold this item?" — drives
the item-side panel and would otherwise scan).

Triggers: `updatedAtTrigger('location_photos')` and `updatedAtTrigger('location_regions')`.
None on `item_regions` (no `updated_at` to stamp).

**Snapshot regeneration is mandatory**, and its blast radius is wider than one assertion.
`v1-initial.test.ts` asserts `migrations` has length 1 (`:33` — fold into v1, never append),
compares `objects`/`tables` byte-for-byte (`:46-47`), compares the sorted object-name set
(`:55`), and asserts `userVersion === TARGET_SCHEMA_VERSION` (`:91`). There is no npm script
to regenerate the fixture, so the plan adds one: `scripts/regen-schema-snapshot.mjs`, running
`captureSchemaSnapshot` against the in-memory `node:sqlite` driver. Regenerating by hand is
how the fixture drifts.

> *Revision note:* the first draft specified `strftime('%Y-%m-%dT%H:%M:%fZ','now')` TEXT
> timestamps. That pattern appears **zero times** in this schema and would not compile under
> `STRICT`. It also put a `created_at` on `item_regions`, contradicting the very pattern it
> claimed to copy.

## 3. The OPFS orphan-sweep trap (highest risk in the change)

`sweepOrphanImages` (`db-maintenance-actions.ts:203-230`) lists every file in the flat OPFS
`images/` directory, builds the referenced set from **`SELECT full_res_opfs_path FROM
item_images`** alone (`:209-211`), and deletes everything else. Location photos written into
that same directory would be seen as unreferenced and **silently deleted** the next time a
user ran database maintenance.

The fix is to make the referenced set a UNION across both owning tables, and likewise teach
`findMissingImageFiles` (`:264-268`) about location photos. Storage accounting is three
touchpoints, not one — `StorageRepository.ts:96` (`countDowngradableBefore`), `:110`
(`listDowngradableBefore`) and `:130` (`markImageDowngraded`) — plus `:34`, where
`this.count('item_images')` feeds the fixed `StorageRowCounts` shape; location photos stay
invisible in the storage breakdown unless that type and its consumers change too.

Other call sites that assume item-only image ownership, each audited:

- `build-backup.ts:52` / `restore-backup.ts` — filename-based via `readAllImages()`, so photos
  ride along for free; verified by test rather than changed.
- `safe-mode-actions.ts` — `removeImagesDirectory()` wipes the whole directory. That stays
  correct: the Safe-Mode hard reset deletes the database file first, so no photo row survives
  for a directory wipe to strand.
- `erase-actions.ts` did the same, and that was **wrong** for a per-kind target — erasing item
  photos destroyed every location photo's full-resolution file, and erasing location photos
  destroyed every item photo's (issue #820). Each target now names the photo table it empties
  (`EraseTarget.imageTable`) and the executor deletes only those rows' files. The confirmation
  copy therefore says each entry leaves the other kind alone; do **not** widen it back.
- **`erase-targets.ts` is the real per-table erase registry** and needs genuine work: the
  `item-photos` target (`:205-220`) with its `countSql` and `tombstoneSelect`, the items
  target's cascade tombstone list (`:176-190`), and the `locations` target (`:383-389`), which
  deletes empty locations and now needs photo/region child tombstones — **cascade deletes do
  not record their own** (see the comment at `:174`).
- `auto-archive.ts:78` — confirm photos are included in the archive.
- `ReportRepository.ts:977` — `has_photo` is `EXISTS (… FROM item_images …)`. Left item-only
  **deliberately**: it reports whether the *item* has a picture, which a photo of its shelf
  does not satisfy. Recorded here so it reads as a decision, not an oversight.

A regression test asserts a location photo file survives a sweep. Without it this bug returns
the next time someone adds a fourth image-owning table.

## 4. Sync

`location_photos` and `location_regions` are ordinary LWW tables. `item_regions` is a
membership edge set. Both paths touch more registries than "add to `SYNC_TABLES`":

**LWW tables** — `location_photos`, `location_regions`:

1. `SYNC_TABLES` (`tombstone.ts:45-77`), ordered **after `locations` and `items`**, preserving
   parents-before-children so an UPSERT batch never trips an FK.
2. **`SYNC_EXCLUDED_COLUMNS` (`tombstone.ts:175-177`)** — add
   `location_photos: ['full_res_downgraded_at']`. Without it, a peer's per-device downgrade
   state propagates and a device still holding its full-res file wrongly believes it was
   dropped. This is precisely the bug the existing `item_images` entry exists to prevent.
3. **`FK_REFS` (`reconcile.ts:436`)** — both new tables carry NOT NULL cascade FKs, so both
   need entries (`location_photos.location_id → locations`,
   `location_regions.photo_id → location_photos`), marked `nullable: false` so an incoming row
   whose parent did not survive the merge is dropped rather than tripping the FK.
4. **`BLOB_TABLES` (`blob-codec.ts:51`)** — `location_photos`, so its `thumbnail_blob`
   base64-transcodes for JSON-safety.

**Membership edges** — `item_regions` follows the `location_tags` path, which is nine files,
not one constant:

- `tombstone.ts` — the table const, `itemRegionEdgeId(itemId, regionId)` composite, its parse,
  and the tombstone/clear statements (mirroring `:97`, `:142`, `:146`, `:156`, `:164`).
- **`types.ts:72-84` — `SyncSnapshot` names membership edges as top-level fields**
  (`itemTags`, `locationTags`), so a new `itemRegions` field is a snapshot *shape* change and
  needs a `formatVersion` decision.
- `snapshot.ts` — read, delete-dispatch, apply and full-replace paths.
- `reconcile.ts` — rekey + edge-tombstone union.
- `sync-engine.ts`, `backup.ts` (`locationTags: obj.locationTags ?? []` has an `itemRegions`
  sibling), `repositories/index.ts` re-exports.
- `restore-backup.ts` / `snapshot.ts` build their schema dictionary from
  `[...SYNC_TABLES, ITEM_HISTORY_TABLE]`; a membership table is deliberately *not* in that
  list, so its restore path is bespoke — same as `location_tags`.

`item_regions` must **not** join the LWW list. It has no `updated_at`; LWW would silently
resolve every edge against a missing timestamp.

Full-res OPFS bytes never sync (unchanged rule). A peer renders from the thumbnail —
`readImageBlob` already returns `undefined` for a missing file (`opfs-images.ts:49-58`) — and
the overlay stays correct because geometry is normalised and the dimensions are stored.

Deletes tombstone in the same transaction as the row delete, mirroring `ImageRepository.remove`
(`:57-60`).

**Bridge:** §11 keeps region *exposure* out of scope, but `bridge/src/write.test.ts:18,31`
imports `SYNC_TABLES` and derives `DICTIONARY_TABLES` from it, so adding tables changes what
that test enumerates. Not opt-out — it gets updated and `npm run smoke:bridge` must pass.

> *Revision note:* the first draft named only `SYNC_TABLES` and `BLOB_TABLES`, described the
> membership path as a single line reference, and missed `SYNC_EXCLUDED_COLUMNS`, `FK_REFS`,
> the `SyncSnapshot` field and the bridge test entirely. Any one of those would have shipped a
> real sync bug.

## 5. Pure seams (the hard maths, kept out of the DOM)

House style is a pure, separately-unit-tested module beside the component (`roi.ts`,
`tree-keyboard.ts`, `pagination-window.ts`). Three new ones, under
**`src/features/inventory/regions/`** — there is no `src/features/locations` directory and
locations live inside the inventory feature (`EditLocationDialog`, `location-tree.ts`,
`location-color.ts` …), so inventing a new top-level feature dir would be inconsistent.

**`geometry.ts`**
- `normalisedToDisplay(geometry, box)` / `displayToNormalised(point, box)` — the
  `object-contain` letterbox transform. This **inverts** `roi.ts`'s `object-cover` maths: the
  photo must be shown whole to draw on, so it is `Math.min` scale with letterbox offsets, not
  `Math.max` with a crop.
- `circleRadii(r, naturalWidth, naturalHeight)` — the aspect correction from §2.
- `boundsOf(geometry)` — bounding box, for hit-test pre-filter and focus scroll.
- `clampGeometry(geometry)` — keeps a dragged shape inside 0–1.

**`hit-test.ts`**
- `hitTest(regions, point)` — topmost region containing a normalised point: point-in-rect,
  point-in-ellipse, and even-odd ray casting for polygons. Resolves in z-order (`position`
  desc) so overlapping shapes behave predictably.

**`draw-machine.ts`**
- A pure reducer over pointer events → draft geometry, so drawing is testable without a layout
  engine. Three tools plus move/resize/abort of an existing shape.

All three take plain rects and numbers as arguments and never read the DOM — because under
**jsdom** `getBoundingClientRect` returns zeros and `elementFromPoint` is absent
(`useBoardPointerDrag.tsx:135-136` guards for exactly this).

## 6. UI

### New Foundry primitive: `RegionCanvas`

Nothing in the repo does zoom/pan or shape drawing, so this is a genuinely new primitive and
belongs in `src/components/foundry/` per the no-bodges rule, not one-off at the call site.

- Renders an `<img>` plus an SVG overlay in the same letterboxed content box.
- Props: `src`, `naturalWidth`, `naturalHeight`, `regions`, `selectedId`, `tool`, `readOnly`,
  `onSelect`, `onCommit`.
- **Read-only is the default**, so the same primitive serves the item-side viewer and the
  editor.

Pointer discipline is modelled on `item-drag.tsx`: long-press to arm on touch
(`TOUCH_LONG_PRESS_MS`), `AbortController` teardown, and above all **the non-passive
`touchmove` listener bound at `pointerdown`, not when the gesture arms**
(`item-drag.tsx:416-421`) — the browser fixes cancelability at gesture start, so a late
listener's `preventDefault()` is ignored. The canvas also sets `touch-action: none`, which is
new ground for this repo (no `touch-action` rule exists today) and so gets verified on a real
touch target rather than assumed.

### Accessibility — the part that is easy to skip

A pointer-drawn overlay is an *additive* affordance; it can never be the only path.

- The **region list is the primary interface**: every region is a row with name, shape, item
  count and numeric position/size fields. Anything achievable by dragging is achievable there.
- Arrow keys nudge a selected region; `Shift`+arrows resize. Resolution lives in a pure
  `resolveRegionKey` beside the others.
- SVG shapes are `role="button"` with an `aria-label` woven from name + item count — no
  interactive element without a role and key handler.
- Creation, selection and deletion announce through `LiveRegion`, strings via `t()`.
- Every icon-only tool button carries an `aria-label`; the tool picker is a
  `SegmentedRadioGroup` (existing primitive, roving tabindex already correct).

### Where it hangs

`EditLocationDialog` is a flat `Modal` (390 lines, `useState`/`useId`/`useRef` — **not**
react-hook-form) composing ~9 sub-components. It is **converted to `RailModal`**, mirroring
`ItemDetailDialog`, with its existing form becoming the first tab and **Photos** the second.
That is the consistent route and removes a divergence rather than adding one — but it is a
genuine 390-line restructure, not a wrapper swap, and it is the largest single-file risk in
the change. It gets its own commit and its own component test **written first**, since the
dialog currently has no test to protect the conversion.

- **Photos tab** — a thumbnail grid reusing `ImageManager`'s visual language. `ImageManager`
  (67 lines) is hardcoded to `itemId`; generalising the component is trivial, but it binds
  three hooks (`useItemImages` / `useAddItemImage` / `useRemoveItemImage`,
  `media.ts:23/32/58`) plus a query-key namespace, and **every string in it is hardcoded
  English** (`"Click the dashed tile to add a photo."`, `alt="Item image"`,
  `aria-label="Remove image"`). Generalising therefore drags an i18n conversion along with it.
  There is **no `ImageManager.test.tsx`** today — one is written as part of this, covering the
  item call site, before the generalisation lands.
- **Region editor** — opens from a photo; a `Modal` with the `RegionCanvas`, the tool picker
  and the region list side by side (stacked when narrow).
- **Item side** — an `ItemDetailDialog` section listing the regions an item belongs to, each
  with a read-only `RegionCanvas` thumbnail and a link to the location.
- **Linking** — from the region editor (pick items into a region) *and* from the item side
  (pick a region). Both drive the same repository call; the item picker reuses `Autocomplete`.

### Feature gating

There is no photos/media `FeatureId` today — item images are ungated. A new
**`'location-photos'`** member joins the *capabilities* group, which requires all of:
the `FeatureId` union (`feature-registry.ts:69`), a `FEATURE_DEFS` entry (`:134` — the
`Record<FeatureId, FeatureDef>` makes coverage a **compile-time** guarantee, so a union member
without a def fails typecheck), and its label in `en.json` + `de.json` (asserted byte-identical
by `catalog-drift.test.ts`).

### Tokens

Nothing today expresses "shape overlay". Four new tokens, added to **both** the `:root` and
`.dark` blocks and aliased in `@theme inline`: `--shape-stroke`, `--shape-stroke-selected`,
`--shape-fill` (a `color-mix` translucency, following `--color-item-count` at `index.css:909`)
and `--shape-handle`. Per-region hue reuses `--loc-*` rather than inventing a parallel palette.

Unknown Tailwind utilities emit no CSS and raise no error, so each new utility is verified by
building and grepping the output — not by eye.

> *Revision note:* the first draft claimed the `ImageManager` generalisation was protected by
> "its existing tests". There are none. It also cited `ItemDetailDialog:470-476` as a RailModal
> example — that range is a section def, not the modal usage — and understated the
> `EditLocationDialog` conversion as a tab addition.

## 7. i18n

All new strings go through `t()` under an `inventory.locationPhotos.*` / `inventory.regions.*`
namespace, including `aria-label`s, tooltips, placeholders and live-region announcements. Every
key is added to **`en.json` and `de.json` in the same change** — `catalogs.test.ts` fails the
build on a missing translation or a mismatched `{placeholder}` set — and item/region counts use
`.one`/`.other` plural variants rather than hand-rolled ternaries. The strings rescued from
`ImageManager` join the same namespace.

## 8. Wiki

User-facing surface changes, so `docs/wiki/` is updated in the same change:

- A new page covering photos, drawing regions and linking items, cross-linked `[[Locations]]`
  ↔ `[[Items]]`.
- The Locations page gains a section and a pointer.
- Storage/maintenance and backup pages: location photos count toward storage, ride along in
  backups, and are removed by "erase photos".
- Screenshots regenerated via `scripts/wiki-screenshots.mjs` with **synthetic** data only — an
  invented workshop, invented part names, a generated placeholder image. A photo of a real
  space is exactly the personal data the hygiene rule forbids.
- Sidebar + the page map in `docs/todo/wiki_2026-07-11.md`.

## 9. Test plan

| Layer | Coverage |
| --- | --- |
| Pure | `geometry` (letterbox transform both ways, circle aspect correction, clamping), `hit-test` (rect/ellipse/polygon incl. concave + on-edge), `draw-machine` (all tools, move, resize, abort) |
| Schema | Snapshot regenerated; the four `v1-initial.test.ts` assertions; FK cascade location → photo → region → link; the `shape` CHECK |
| Repository | Photo CRUD incl. OPFS path return on delete; region CRUD; link/unlink idempotency; reverse lookup |
| Sync | LWW round-trip for photos/regions; `full_res_downgraded_at` **not** propagated; FK-orphan drop; membership reconcile + edge tombstone for `item_regions`; base64 thumbnail transcode |
| Maintenance | **Regression: a location photo survives `sweepOrphanImages`**; missing-file report includes photos; erase-target counts |
| Component | `ImageManager` (new, before generalising); `EditLocationDialog` (new, before converting); Photos tab; region editor; item-side panel; keyboard region nav |
| i18n | Catalog parity + drift (already enforced) |

Verification beyond types: `npm run type-check`, the touched suites, **`npm run smoke:bridge`**
(the change reaches `src/db` and `SYNC_TABLES`, which the bridge imports, and only the smoke
test exercises Node's strip-only loader), and the `verify` skill to drive drawing in a real
browser — pointer geometry is precisely what types cannot confirm.

## 10. Order of work

1. Schema + snapshot regeneration script → tests green.
2. Pure geometry / hit-test / draw-machine + their tests (no UI yet).
3. Repositories + the full sync wiring (§4) + **the orphan-sweep fix** + erase targets.
4. Characterisation tests for `ImageManager` and `EditLocationDialog` (before touching either).
5. `RegionCanvas` primitive + tokens.
6. `EditLocationDialog` → `RailModal`; generalise `ImageManager`; Photos tab.
7. Region editor + linking; item-side panel; feature gating.
8. i18n, wiki, screenshots.
9. Full verification pass, `/code-review high`, fix findings, land.

## 11. Explicitly out of scope

- **Search over regions.** "Find items on the top shelf" is desirable but pulls in the
  SearchAST (`parseTextQuery` → `SearchAST` → `parseASTtoSQL`) and a new searchable column,
  which touches the parallel exhaustive lists in [[item-model-parallel-lists]]. Its own issue.
- **Bridge / Home Assistant exposure** of regions (the bridge *test* still gets updated, §4).
- **Auto-detection** of shelves or bins from the photo.
- **Nested regions.** The flat pool covers the stated need, and nesting can be added later
  without a data migration since parenthood would be a nullable column.
