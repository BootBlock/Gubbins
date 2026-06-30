# Phase 80 — Global activity feed

> Wave 3, add-on #6 of the third feature-gap audit (`feature-gap-audit-2026-06-30c`).
> **Read-only — no migration** (`user_version` stays 2). Living plan doc — decisions,
> seams, surfaces, verification.

## Problem

The §4 Activity Log (Phase 52) is **per-item only** — it lives inside `ItemDetailDialog`
and reads `item_history` filtered to one `item_id`. There is no way to see "what happened
across the whole inventory lately" — every checkout, gauge update, reconciliation, move,
rename, etc. folded into one chronological stream. Every asset/grocery tool has this. This
phase adds a single cross-item, newest-first, virtualised feed that composes the existing
immutable `item_history` ledger (joined to `items` for the name), with an optional
action-kind filter and a per-row jump-to-item link.

## Scope decisions (recommended defaults)

- **Events:** **all** `item_history` actions (the same 21 the per-item log renders) — reuse
  the Phase-52 `describeHistoryEntry` / `historyActionLabel` pure seams verbatim; do **not**
  fork them.
- **Ordering:** newest-first (`created_at DESC, rowid DESC` — the same deterministic
  tiebreaker `getHistory` uses for same-millisecond inserts).
- **Filter:** an optional **action-kind** chip row (mirroring the agenda's kind filter).
  21 raw actions is too many chips, so a new pure seam groups them into a handful of
  semantic **activity kinds** (created / stock / movement / loan / lifecycle / supplier).
  The screen maps the enabled kinds → the flat list of included `HistoryAction`s, and the
  repository filters in **SQL** (`action IN (…)`) so pagination stays correct (a client-side
  filter could empty a whole page and stall the infinite scroll).
- **Jump-to-item:** a per-row "View item" link to `/inventory` (matches the agenda's
  established jump-to-source pattern — the inventory screen has no item deep-open route, so
  adding one would be scope creep).
- **Virtualised + bounded:** the Phase-37 `list-window.ts` absolute-index window + the
  `MAX_LIST_PAGES` cap, exactly like the per-item log, so the feed stays light with
  100,000+ history rows.
- **Surface:** a new `/activity` screen + a dashboard nav entry (`HistoryIcon`).
- **Prune watermark (§7.6.3-A):** pruned rows are **physically DELETEd** from `item_history`
  by `StorageRepository.pruneHistoryBefore`, so reading the table directly already excludes
  them — the watermark is a *sync* concern (don't re-import old remote rows), not a read
  filter. No extra handling needed; mirrors `getHistory`.

## No migration

`item_history` has been synced since Phase 11 and `items` since v1; the feed is a pure
read-only JOIN projection. `user_version` stays **2**.

## Pure seam (new, unit-tested)

`src/features/activity/activity-kind.ts`

- `ACTIVITY_KINDS` — ordered kind ids `['created','stock','movement','loan','lifecycle','supplier']`.
- `ACTIVITY_KIND_LABEL: Record<ActivityKind, string>` — British-English labels.
- `activityKindForAction(action): ActivityKind` — total mapping of every `HistoryAction`
  (forward-compat default → `'lifecycle'` for an unknown action a newer peer synced).
- `actionsForKinds(enabled: ReadonlySet<ActivityKind>): HistoryAction[]` — flatten enabled
  kinds to the action list the repo filter takes; returns **all** actions when every kind is
  enabled (so the screen can pass `undefined` = no WHERE for the common "show everything").

The Phase-52 `describeHistoryEntry` / `historyActionLabel` and the Phase-37 `list-window.ts`
helpers are **reused as-is**.

## Repository — `getHistoryFeed` (in `item/feeds.ts`)

A new bounded, paginated, newest-first read on `ItemRepository` joining `item_history` to
`items` for the name:

```sql
SELECT h.*, i.name AS item_name, i.is_active AS item_is_active
FROM item_history h
JOIN items i ON i.id = h.item_id
[WHERE h.action IN (?, …)]            -- only when a kind subset is selected
ORDER BY h.created_at DESC, h.rowid DESC
LIMIT ? OFFSET ?;
```

- DTO `ActivityFeedEntry = ItemHistoryEntry & { itemName: string; itemIsActive: boolean }`
  (new `ActivityFeedRow` row type + `rowToActivityFeedEntry` mapper).
- Filters: `{ actions?: readonly HistoryAction[] } & PageParams`; an empty/omitted `actions`
  means no `WHERE` (the full feed). Strict pagination via `resolvePage` / `toPage`.
- Real `:memory:` SQL test: ordering across items, the action filter, the name join,
  pagination envelope, empty-history.

## Query hook

`src/features/activity/queries.ts` → `useActivityFeed(enabledKinds)` — an `useInfiniteQuery`
mirroring `useItemHistory` (initialPageParam 0, `getNextPageParam`/`getPreviousPageParam`,
`maxPages: MAX_LIST_PAGES`). The query key includes the resolved action list so toggling a
kind refetches.

## Screen

`src/features/activity/ActivityFeedScreen.tsx`

- Header (BrandMark + title + an Inventory link), a kind-filter chip row (token-styled,
  `role="group"`, `aria-pressed`), and the virtualised feed list (`list-window.ts`, single
  column, `ROW_HEIGHT` placeholder) reusing `describeHistoryEntry` for each row's
  label/detail/delta badge — plus the item name + a "View item" link + a `<time>` stamp.
- `<main id={MAIN_CONTENT_ID} tabIndex={-1}>` for the skip-link (Phase 40).
- A Phase-63 always-mounted `<LiveRegion>` announcing the loaded-count once loading settles.
- Empty/loading/error states.

`src/routes/activity.tsx` → `createFileRoute('/activity')`. Regenerate `routeTree.gen.ts`
via `npx vite build` **before** tsc (the `build` script runs `tsc -b` first; no `tsr` bin).

Dashboard nav: an `/activity` `<Link>` with `HistoryIcon`, beside Upcoming/Bookings.

## Verification

- `npx vite build` (regenerate route tree) → `npx tsc -p tsconfig.app.json --noEmit` →
  `npm run test:run` → `npm run build`, all green.
- New tests: `activity-kind.test.ts` (mapping totality + `actionsForKinds`), the
  `getHistoryFeed` `:memory:` SQL test.
- Self-audit `git diff --cached` for secrets; design-token-only colours; British English.
