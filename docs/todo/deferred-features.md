# Deferred features tracker

Functionality intentionally deferred from a completed/active phase to a later one, so nothing is
silently dropped. Each entry cites its spec section and the phase that should pick it up.

## Deferred out of Phase 7 (Cloud Sync) — agreed 2026-06-27

Phase 7 ships "Core sync + File System Access" (the full reconciliation engine, tombstones, NTP
offset guard, §7.4 pre-flight Hard Stop, FS Access auto-save, versioned-JSON import/restore, the
Initial-Handshake wizard). The following §7.6 OPFS-quota-recovery pieces are **deferred, not
dropped** — the developer was explicit that they must be delivered in a later phase:

- [ ] **§7.6.2 Storage Triage Dashboard** — a UI breaking down OPFS consumption by table
      (`item_images`, `item_history`, `items`) estimated from row counts × average byte-size, surfaced
      when the user enters the Critical/Locked storage tier. (Storage telemetry + tier state already
      exist from Phase 1 `useStorageStore`; only the dashboard UI is outstanding.)
- [ ] **§7.6.3 Workflow A — Action History Pruning** — "Purge History Older Than X Months" that first
      downloads a JSON cold-storage archive of the targeted `item_history` rows, then deletes them.
- [ ] **§7.6.3 Workflow B — Image Downgrading** — drop `full_res` image data for older items, retaining
      thumbnails, to reclaim local OPFS space **without** propagating the deletion to the cloud.

Suggested home: a later storage/maintenance phase (or folded into Phase 9 logistics). Revisit once the
core sync engine has landed and real OPFS pressure can be exercised.

### Sync-set expansion (the synced/backed-up table set)

Phase 7's sync engine, versioned-JSON backup and import cover the **six core entity tables**
(`locations`, `categories`, `items`, `capabilities`, `contacts`, `checkouts` — the §7.1-named tables
plus the Phase 6 borrowing entities). They are all scalar-column, JSON-safe and LWW-simple. The
following tables are **not yet in the synced/backup set** and must be added later so a sync/backup is
genuinely whole (`SYNC_TABLES` in `src/db/repositories/tombstone.ts` is the single point to extend):

- [x] **`item_aliases`** — **done in Phase 8.** It carries its own `updated_at` + auto-stamp trigger,
      so it joined `SYNC_TABLES` (after `items`, FK-safe) and resolves by row-level LWW like the entity
      tables; `setAliases` is now a tombstone-aware diff (stable ids for retained aliases) and the
      reconcile engine resolves the §4 alias-text UNIQUE collision by LWW. So scraped supplier↔item
      mappings now propagate across devices.
- [ ] **M:N joins & leaf rows** — `tags` + `item_tags`, `category_fields` + `item_field_values`,
      `projects` + `bom_lines`. Needs join-row LWW semantics (a join row has no `updated_at` of its
      own; resolve by membership) and FK-safe ordering.
- [ ] **Activity Ledger** — `item_history`. Append-only; should union by id rather than LWW. The §7.3
      Delta-CRDT *already reads* the gauge deltas from it via the snapshot's `gaugeHistory`, but the
      full ledger is not yet synced/restored.
- [ ] **Images** — `item_images` carries a `thumbnail_blob` BLOB and an OPFS `full_res` path. Per §4
      "Strict Sync Isolation" heavy blobs/local files are excluded from cloud sync; image metadata +
      thumbnails want base64 encoding in the JSON payload (or the §4.5 vault / §3 raw-binary export).
      Until added, **a wipe-and-clone (the §7.2 TTL path) or any future replace-restore can lose local
      images**; the Phase-7 manual import is deliberately a non-destructive *merge* to avoid this.

Until the set is expanded, structured-data backup/restore is full for the six tables; images and the
Activity Ledger are preserved locally and via the §4.5 Markdown-vault / raw-`.sqlite` exports.

## Deferred out of Phase 8 (External Data Scraping) — agreed 2026-06-27

Phase 8 ships the full §9 secure bridge (origin + Zod validation, silent-drop), the §4 no-overwrite
merge, the Strategy-pattern parsers with DOM-drift handling, the lean companion MV3 extension, and the
create + edit/refresh scrape UI. Deferred (not dropped):

- [ ] **Supplier parser coverage** — only a generic structured-metadata parser + a DigiKey example ship.
      Add a parser per supplier (Mouser, Farnell, LCSC, RS…) — the §9.4.1 Strategy pattern makes this a
      one-file change in `src/features/scraping/parsers/`, registered in `registry.ts`. A production
      extension build should also narrow `manifest.json` `host_permissions` from `<all_urls>`.
- [ ] **Scrape notification settings UI** — the `scrapeNotifications` preference (`TOAST` default |
      `SILENT`, §4) exists in `usePreferencesStore` but has no settings-screen control yet.
- [ ] **Multi-scrape correlation** — the bridge tracks one in-flight scrape at a time (sufficient: one
      scrape modal is open at once). If concurrent scrapes are ever needed, add a `requestId` to the
      `SCRAPE_REQUEST`/`SCRAPE_RESULT` envelope and correlate.

## Deferred out of Phase 9 (Procurement & Lifecycle Logistics) — agreed 2026-06-27

Phase 9 ships all six §5 deliverables: Expiry/Batch/Lot + Condition (additive v8 columns),
abstract single-level Parent/Child variants (self-FK + repository cycle guard), the In-Transit
dashboard tracker (surfacing Phase-4 `IN_TRANSIT` BOM lines), Tool Maintenance Schedules
(`maintenance_schedules` table, time- + manual-usage based), Borrowing-due + Soon-to-Expire +
Maintenance-due dashboard widgets, and the ephemeral-Tier-3 Cycle Counting / Reconciliation workflow.
Deferred (not dropped):

- [ ] **Nested / multi-level variants** — scope locked Phase 9 to a *single-level* abstract parent
      (a variant cannot itself be a parent). The repository guard + pure `validateVariantLink` already
      carry a generic ancestor-chain `CYCLE` check, so lifting the single-level rule later is a
      contained change. Revisit only if a real need appears (YAGNI).
- [ ] **Usage telemetry for maintenance** — usage-based schedules advance via a *manually-entered*
      counter (`addUsage`); there is no automatic usage accrual (e.g. incrementing hours on checkout/use).
      A future phase could drive `usage_since_service` from real events.
- [ ] **`maintenance_schedules` reconcile coverage** — the table joined `SYNC_TABLES` (row-level LWW +
      tombstone on delete), but the §7.5-style relational-integrity edge cases (a schedule whose `item_id`
      was concurrently hard-deleted on a peer) rely on the FK `ON DELETE CASCADE` + tombstone rather than a
      bespoke re-parent; confirm when the sync set is next audited.
- [ ] **In-Transit physical location** — Phase 4 modelled "In Transit" as a BOM-line *procurement status*
      (the `IN_TRANSIT_LOCATION_ID` system location exists and is seeded but stock is not physically moved
      into it). The Phase 9 tracker reads the status-based lines. If a dedicated incoming-stock quantity is
      ever wanted, model it explicitly rather than overloading on-hand `quantity`.
- [ ] **Cycle count of non-DISCRETE stock** — reconciliation covers DISCRETE items only (SERIALISED is
      qty-1 per record; gauges use the §4.1.2 weigh-in). Auditing serialised instances (which physical unit
      is missing?) is a separate, richer workflow if needed.
- [ ] **Settings UI for the expiry window** — `EXPIRY_SOON_WINDOW_DAYS` (30) is a constant; no user control
      yet (cf. the still-pending Phase-8 `scrapeNotifications` settings UI).

## Carried-over debt (pre-Phase-7)

See `PHASE_HANDOVER.md` §7 for the live technical-debt list (scanner WASM fallback, export
single-item/project scope + vault asset extraction, capability ranking, dashboard overdue widget,
theme application, bundle size).
