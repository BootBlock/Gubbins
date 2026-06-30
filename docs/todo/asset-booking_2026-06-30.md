# Phase 78 — Time-based asset booking / reservations

> Wave 2, candidate #2 of the third feature-gap audit (`feature-gap-audit-2026-06-30c`).
> The wave's **one** migration: `user_version` 1 → **2** (new synced `asset_bookings` table).
> Living plan doc — decisions, seams, surfaces, verification.

## Problem

There is no way to reserve a **specific serialised / single-unit asset for a future date
range** ("book the 3D printer Tue–Thu") and prevent double-booking. The existing project
*quantity* reservation (`RESERVED` / `reserved_qty` on `project_bom_lines`) is a **stock
annotation** — "N units are spoken for" — not a **calendar reservation of one identified
asset**. This phase adds the latter, deliberately distinct from the former.

## Scope decisions (recommended defaults — all load-bearing ones confirmed)

- **Granularity:** whole-day date ranges (§2.4.3 simpler, mobile-first). `start_date` /
  `end_date` are stored as UNIX-ms **day-start instants**; a booking covers whole days
  `[start_date, end_date]` inclusive. No time-of-day.
- **Bookable assets:** `SERIALISED` + single-unit `DISCRETE` (quantity ≤ 1). Excludes
  `CONSUMABLE_GAUGE` and multi-unit DISCRETE — mirroring the checkout single-instance model
  (a calendar reservation only makes sense for *one* identifiable unit).
- **Double-booking policy:** hard-prevent **any** day-range overlap for the same asset among
  *active* (non-cancelled, non-converted) bookings, via a pure overlap seam.
- **Lifecycle:** the calendar states **upcoming / active / overdue / converted / cancelled**
  are **derived** from the dates + two nullable stored columns (`cancelled_at`,
  `converted_checkout_id`), mirroring how a checkout derives OPEN/RETURNED from nullable
  `returned_at` (keeps the §7.1 LWW model a simple last-write-wins; no stored enum to drift).
- **UI:** a new `/bookings` screen + nav entry + a "Book" action; a booking→checkout convert
  button; plus a 6th `'booking'` lane in the Phase-75 `/upcoming` calendar.

## Migration — v2 (additive, forward, no wipe)

New file `src/db/migrations/v2-asset-bookings.ts`, appended to `migrations/index.ts`. The
engine requires contiguous versions (1, 2) and runs only steps `> from`, so an existing
**v1 DB migrates cleanly** (no local-DB wipe — unlike the Phase-69 squash, which *reset*
user_version 24→1). `TARGET_SCHEMA_VERSION` becomes 2.

```sql
CREATE TABLE asset_bookings (
  id                     TEXT    PRIMARY KEY NOT NULL,
  item_id                TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  contact_id             TEXT    REFERENCES contacts(id) ON DELETE SET NULL,
  start_date             INTEGER NOT NULL,            -- day-start UNIX-ms (inclusive)
  end_date               INTEGER NOT NULL,            -- day-start UNIX-ms (inclusive)
  note                   TEXT,
  cancelled_at           INTEGER,                     -- set ⇒ 'cancelled'
  converted_checkout_id  TEXT,                        -- set ⇒ 'converted' (soft pointer, not FK)
  created_at             INTEGER NOT NULL DEFAULT (now),
  updated_at             INTEGER NOT NULL DEFAULT (now),
  CHECK (end_date >= start_date)
) STRICT;
CREATE INDEX idx_asset_bookings_item_id ON asset_bookings(item_id, start_date);
CREATE INDEX idx_asset_bookings_start_date ON asset_bookings(start_date);
-- + updated_at auto-stamp trigger (the canonical §7.1 LWW trigger)
```

`converted_checkout_id` is a **nullable plain TEXT pointer, not a FK** (mirrors the Phase-29
`source_batch_key` "nullable, not FK" decision) — a dangling pointer after a checkout delete
is harmless (it only drives the derived 'converted' label) and avoids extra reconcile rules.

### Sync plumbing (a booking is a real synced row)

- Add `'asset_bookings'` to `SYNC_TABLES` (after `checkouts`; its FK parents `items` +
  `contacts` precede it, so an UPSERT batch is FK-safe). This automatically wires snapshot
  read, LWW reconcile, schema-dictionary sanitisation, and the tombstone-delete apply.
- Add an `FK_REFS` entry: `item_id → items` (nullable:false, CASCADE) and
  `contact_id → contacts` (nullable:true, SET NULL). The `converted_checkout_id` soft
  pointer needs no guard.
- Deletes go through `tombstoneStatement('asset_bookings', id)` batched with the DELETE.
- Regenerate `__fixtures__/schema-baseline.snapshot.json` (script, not hand-edit) and update
  `v1-initial.test.ts` meta-assertions (length 2, TARGET 2, boots to 2). The golden remains a
  committed tripwire against accidental schema edits.

## Pure seams (independent → sub-agents)

1. `src/features/bookings/booking-overlap.ts` — date-range maths:
   - `startOfDayMs(ms)` / day-range normalisation,
   - `rangesOverlap(aStart, aEnd, bStart, bEnd)` (inclusive whole-day overlap:
     `aStart <= bEnd && bStart <= aEnd`),
   - `findFirstOverlap(candidate, existing[])` → the clashing booking or null.
   Exhaustive unit tests (boundary-touching ranges, adjacent days, single-day, reversed).
2. `src/features/bookings/booking-status.ts` — lifecycle derivation:
   - `deriveBookingStatus(b, now)` → `'cancelled' | 'converted' | 'overdue' | 'active' | 'upcoming'`
     (cancelled/converted from the stored columns first, then date-based vs `now`),
   - `BOOKING_STATUS_LABEL` + a token-only tone map (no raw colours),
   - `isBookableTrackingMode(mode, quantity)`.
   Unit tests for each branch + the boundary instants.

## Repository — `AssetBookingRepository`

`src/db/repositories/AssetBookingRepository.ts` (+ registered in the barrel as
`getAssetBookingRepository`). Methods:
- `create({ itemId, contactId?/contactName?, startDate, endDate, note? })` — validates the
  asset is bookable, normalises the day range, runs the overlap check against active bookings
  for the item, inserts. Resolves a contact name low-friction via `ContactRepository`.
- `cancel(id)` — stamps `cancelled_at` (LWW update).
- `convertToCheckout(id, { dueDate? })` — creates a checkout via `CheckoutRepository`,
  stamps `converted_checkout_id`, atomic. Best-effort: a serialised item already out blocks.
- `listForItem(itemId)`, `listUpcoming(now, params)` (for the agenda + screen),
  `getById`, `remove(id)` (tombstoned).
- Real `:memory:` SQL tests (the Phase-77 lesson) **and** the pure-seam tests.

## Calendar lane (Phase 75)

- `agenda.ts`: add `'booking'` to `AgendaKind` + `AGENDA_KINDS`, a `BookingAgendaSource`,
  and `buildBookingEvents(sources, now)` (a booking's `dueAt` = its `start_date`; overdue
  bookings whose window has passed still surface). **Thread the single `now`** (hook→screen).
- `useAgenda.ts`: fetch `getAssetBookingRepository().listUpcoming(now, …)`, map to source.
- `CalendarScreen.tsx`: `KIND_LABEL.booking` + `KindIcon` case (BookingIcon).

## Surfaces

- `src/features/bookings/BookingsScreen.tsx` — list grouped by derived status, a "Book"
  form (asset picker limited to bookable items, date range, optional contact), cancel +
  convert actions, a Phase-63 aria-live completion region for each async result.
- `src/routes/bookings.tsx` — `createFileRoute('/bookings')`.
- `DashboardScreen.tsx` — a "Bookings" nav `Link` (BookingIcon).
- `src/components/icons/index.ts` — `CalendarRange as BookingIcon`.

## Design tokens

No new token: status pills reuse `primary` (active), `muted-foreground` (upcoming),
`destructive` (overdue), `glyph-*`/success (converted), `muted` (cancelled). Confirm none is
a raw colour.

## Verification

- `npx tsc -p tsconfig.app.json --noEmit`, `npm run test:run`, `npm run build` — all green.
- Migration round-trip test: v2 applies on a v1 DB (forward, no data loss); a booking row
  syncs + reconciles (LWW) and tombstone-deletes.
- Overlap maths + status derivation unit tests.
- British English, design tokens, no secrets.
