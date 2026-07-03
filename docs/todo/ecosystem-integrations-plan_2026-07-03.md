# Ecosystem integrations — phased build plan (2026-07-03)

> **Living document.** Each phase is implemented in its **own chat session** in its **own git
> worktree**. Tick the `[ ]` boxes as work lands, append a one-paragraph **Outcome** note
> under each phase when it completes (mirroring
> [`home-assistant_2026-06-29.md`](home-assistant_2026-06-29.md)), and re-schedule — never
> silently drop — any deferred item.
>
> **This plan builds out the recommendations in the companion research doc**
> [`ecosystem-integrations_2026-07-03.md`](ecosystem-integrations_2026-07-03.md). Read that
> first for the *why*; this doc is the *how*, phase by phase.
>
> **Continuation-prompt rule (mandatory).** When a phase completes you **must** do **both**
> before ending the session:
>
> 1. **Emit the next phase's kick-off prompt directly in your chat reply** as a **raw, fenced
>    Markdown code block** (a ```` ```text ```` block the user can copy verbatim into a new
>    chat). This is the **last thing** in your reply. Do **not** merely say "I've updated the
>    doc" — the user must be able to copy it straight from the chat.
> 2. That prompt is **already written** at the foot of each phase below ("Continuation prompt
>    — emit on completion"); keep it and the chat copy **identical**. If a phase's reality
>    diverged from the plan, update the next phase's embedded prompt before emitting it.
>
> Each kick-off prompt names this doc, the phase to run, and the context a **cold** session
> needs (it starts with no memory of prior phases beyond what the code and this doc record).
>
> **Status:** _EI-1, EI-2, EI-3, EI-4 & EI-5 complete & merged (2026-07-03). Next: EI-6._ Phase order: **EI-1 → EI-7**.
> EI-1 (the event model) is a hard prerequisite for EI-2 and EI-6; the rest are independent and
> could be reordered, but the embedded prompts assume this order.

---

## The invariants every phase must honour

These are load-bearing — they are *why* the bridge exists and *why* it is safe. Re-read
[`../../CLAUDE.md`](../../CLAUDE.md) at the start of every phase.

1. **The PWA never gets a server.** Any "serve to the network" capability lives in the
   **bridge** (`bridge/`), never in the browser bundle or the GitHub-Pages build. The PWA can
   only *read the OS* (share target, file handlers) and *write out* through user-chosen paths.
2. **Off by default, per-capability opt-in.** Every new outbound / write-capable surface gets
   its own `GUBBINS_BRIDGE_*` flag parsed by `bridge/src/config.ts` `parseBool` (default
   **off**), and is **logged at startup as a deliberate choice** — exactly like the existing
   `GUBBINS_BRIDGE_ALLOW_WRITES` / `_ALLOW_PUSH` / `_MDNS`.
3. **No secret is ever advertised, logged, or committed.** Webhook/MQTT secrets live only in
   the git-ignored `bridge/.env`; `.env.example` holds placeholders. mDNS-style
   advertisements never carry the token. Self-audit every diff (`git diff --cached`).
4. **Read-only unless the write is the explicit point**, and any write still round-trips
   through the app's own sync merge (§7.3 `reconcile`/`applyPlan`) — never bespoke SQL, never
   a forked merge. All SQL flows through the single `parseASTtoSQL`.
5. **Stdlib-first, minimal dependency surface.** The bridge is zero-runtime-dependency and
   build-free today. Prefer a small hand-rolled encoder (as we did for JSON-RPC, mDNS wire
   format, and the YAML emitter) over a dependency. The **one** place to genuinely re-evaluate
   this is MQTT (EI-5) — treat it as a decision-at-entry, and if a dep is taken, vet
   licence/maintenance/popularity per CLAUDE.md IP-hygiene.
6. **Design tokens + Foundry primitives for any PWA UI** (share target, importers) — never raw
   colour/spacing/motion literals or ad-hoc Tailwind palette classes. Add a token to
   `src/styles/index.css` if a genuinely new semantic role appears.
7. **Everything synthetic** in tests, fixtures, docs, and examples — `example.com` /
   `*.test` / `localhost` / `127.0.0.1` / made-up parts. No real or personal data anywhere.

---

## How every phase runs (the loop)

Follow this identically for EI-1 … EI-7:

1. **Worktree.** Create and enter a git worktree off local `HEAD` (not `origin/main`, which
   may be stale):
   `git worktree add .claude/worktrees/ecosystem-<phase> -b feat/ecosystem-<phase> HEAD`,
   then work in it. (A concurrent agent may be touching the PWA — the worktree keeps you out
   of its way.)
2. **Build the phase's checklist**, reusing existing seams (named per phase). Add/extend
   tests with **synthetic fixtures**. Keep `tsc --noEmit` clean for both the bridge
   (`bridge/tsconfig.json`) and the app. Run the relevant unit suites and an end-to-end smoke
   (a live `serve.mjs` / `mcp.mjs` run, or a real PWA drive for a PWA phase — use the
   `/verify` skill for anything with a runtime surface).
3. **Docs alongside code.** Update `bridge/README.md` (or the PWA docs) *in the same phase* as
   the feature — do not let docs drift. The dedicated documentation truth-up is EI-7, but each
   phase still documents its own surface.
4. **Review gate (mandatory).** Before merging, run the **`/code-review high`** skill on the
   phase diff — **every phase, always `high`** (never `ultra`). EI-1, EI-4, and EI-5 are the
   largest / highest-blast-radius phases (event delivery, the service-worker/install surface,
   and MQTT networking), so review those especially carefully — but still at `high`. Resolve
   every **confirmed** finding; re-review until the diff is clean. Record in the Outcome that
   the gate ran and what it caught.
5. **Merge + clean up.** Exit the worktree, `git merge --no-ff` the branch into `main`, then
   `git worktree remove …` and `git branch -d …`. Verify with `git worktree list`.
6. **Close the loop in this doc.** Tick the phase's boxes, append its **Outcome** paragraph,
   and update the memory index line if the phase changed the integration surface materially.
7. **Hand off.** Emit the next phase's embedded continuation prompt as a raw fenced block in
   chat (see the foot of each phase). After **EI-7**, the plan is complete — emit a short
   "all phases done" note instead.

**No time estimates anywhere** (plans, commits, UI copy) — scope by leverage and correctness,
never by time (project convention).

---

## Shared foundation: the event model (built in EI-1, reused by EI-2 & EI-6)

Three phases need "what changed, as typed events": webhooks (EI-1), the SSE stream (EI-1),
the syndication feeds (EI-6). EI-1 builds this **once** as a pure, transport-agnostic module
so nothing forks it:

- **Source of truth:** the already-synced, immutable **`item_history` ledger** — the same
  table the Phase 80 activity feed projects (`src/features/activity/`). New ledger rows since
  the last hydrated generation *are* the event list, already typed by `HistoryAction` and
  already grouped into semantic kinds by the pure `activityKindForAction` seam. Prefer this to
  a raw row-diff of the two hydrated DBs (cleaner, typed, and reuses the
  `describeHistoryEntry` / `historyActionLabel` shapers).
- **Watcher hook:** `bridge/src/watcher.ts` already re-hydrates old → new atomically on every
  snapshot change. EI-1 adds a post-swap callback that computes the new-since-last events and
  fans them out to the registered sinks (webhook queue, SSE clients, …).
- **Event DTO:** `{ id, type, occurredAt, data }` where `type` is a stable dotted name
  (`item.low_stock`, `item.checked_out`, `stock.adjusted`, …) and `data` reuses the existing
  `bridge/src/api/dto.ts` shapes. Deterministic `id` (ledger rowid-derived) so every sink can
  dedupe.

---

## Phase EI-1 — Bridge event model + outbound webhooks + SSE stream

**Goal:** turn the bridge from a queryable store into an **event source**. One pure event
model, one opt-in signed-webhook delivery path, and one read-only SSE stream — the keystone
every other "notify me / react to change" feature builds on.

- [x] **Event model** (`bridge/src/events/*`, pure + tested): compute the typed event list
      for a hydration generation from the `item_history` delta (reuse
      `activityKindForAction` / `describeHistoryEntry`; do **not** fork them). Map each to the
      `{ id, type, occurredAt, data }` DTO over existing `api/dto.ts` shapes. Handle the
      first-run/cold-start case (no baseline → emit nothing, don't replay history).
- [x] **Watcher integration:** a post-swap hook in `watcher.ts` that hands the new events to a
      registered set of sinks. Coalesce per generation and **cap fan-out** so a bulk import
      can't flood downstream (bounded batch + a "N more" summary event if exceeded).
- [x] **Outbound webhooks** (`GUBBINS_BRIDGE_WEBHOOKS=on`, off by default): POST each event to
      each configured `{ url, secret, events[] }` target. `X-Gubbins-Signature` = HMAC-SHA256
      of the raw body (GitHub/Stripe pattern, `node:crypto`), a `X-Gubbins-Delivery` id,
      at-least-once with bounded exponential backoff + retry cap, and a per-target failure
      circuit so one dead URL can't stall the others. Target list from env/JSON (secrets in
      `.env` only).
- [x] **SSE stream:** `GET /api/v1/events` (bearer-token + rate-limit reuse) holds the
      connection open and writes each event as `data: <json>\n\n`, with `id:` for
      `Last-Event-ID` resumption and a heartbeat comment. Bounded client count.
- [x] **Config + docs:** `config.ts` parses the new flag(s) and the target list;
      `serve.ts` wires the sinks and logs an explicit "Webhooks ENABLED → N target(s)" /
      "Event stream available at /api/v1/events" line. `bridge/README.md` gains an "Events,
      webhooks & SSE" section (payload schema, signature verification recipe, the event-type
      table, an n8n/Node-RED/Discord example). Add the `/api/v1/events` path + event schemas to
      `bridge/src/openapi.ts` (and the generated `openapi.yaml`, with the drift-guard test).
- [x] **Tests:** pure event-model tests over the synthetic fixture (each `HistoryAction` →
      expected event; cold-start = no replay; fan-out cap). Webhook delivery tests with an
      in-process receiver asserting the signature verifies, retries/backoff fire, and a dead
      target is isolated. An SSE test asserting a change is streamed and `Last-Event-ID`
      resumes. `openapi` drift-guard updated.

**Decisions to confirm at entry (recommended defaults):**
- *Event source:* **`item_history` delta** (recommended) vs. a raw two-generation row-diff.
  Ledger delta is typed, cheaper, and reuses Phase 80 seams.
- *Webhook target config:* a **JSON list in an env var / a git-ignored `bridge/webhooks.json`**
  (recommended) vs. numbered env vars. Whichever, secrets never leave `.env`/git-ignored files.
- *Stream transport:* **SSE** (recommended — one-way, stdlib, auto-reconnect) vs. WebSocket
  (bidirectional, heavier, needs a dep or a hand-rolled handshake). SSE wins for a read-only
  event feed.

**Acceptance:** with `GUBBINS_BRIDGE_WEBHOOKS=on` and a local receiver, editing the fixture
snapshot (e.g. dropping an item below its low-stock bound) delivers a signed `item.low_stock`
webhook whose signature verifies; `curl -N .../api/v1/events` streams the same event live; with
the flag **off**, no webhook fires and `/api/v1/events` is `404`. Read-only w.r.t. inventory.

**Review gate:** `/code-review high` (largest, highest-risk phase — delivery/retry/security).

**Outcome (2026-07-03).** Shipped in `bridge/src/events/*` and merged to `main` (merge
`d5f26a2`, feature commit `b256957`). A pure, transport-agnostic event model
(`model.ts`) turns the `item_history` ledger delta between hydration generations into typed
`{ id, type, occurredAt, data }` events, reusing the app's own `activityKindForAction` and
`describeHistoryEntry` (imported, never forked) and the `api/dto.ts` `ItemSummary` shape; a
stock movement that leaves an item low/empty additionally raises `item.low_stock` /
`item.out_of_stock`. Cold start emits nothing (no replay). `generation.ts` + `pipeline.ts`
read the just-swapped driver through the app repositories only (no bespoke SQL) and fan events
to sinks; `watcher.ts` now **awaits** its post-swap hook so the pipeline always reads a live
driver (no closed-driver race). Two opt-in sinks, both off by default: signed webhooks
(`webhook.ts` — HMAC-SHA256 `X-Gubbins-Signature` over the raw body + `X-Gubbins-Delivery`,
per-target FIFO queue, bounded backoff, failure circuit; targets/secrets in a git-ignored
`webhooks.json`/`.env` only) and a read-only SSE stream `GET /api/v1/events` (`sse.ts` —
bearer+rate-limit reuse, `Last-Event-ID` replay buffer, heartbeat, bounded clients).
`GUBBINS_BRIDGE_EVENTS` / `_WEBHOOKS` flags (the latter implies the stream); `/api/v1/events`
+ the `BridgeEvent` schema added to `openapi.ts` and the regenerated `openapi.yaml` (drift
guard extended). **Zero new dependencies.** 44 new bridge tests (321 total, all green); `tsc
--noEmit` clean for bridge and app. A live `serve.mjs` smoke passed the acceptance verbatim:
with `GUBBINS_BRIDGE_WEBHOOKS=on`, a low-stock edit delivered a signature-verified
`item.low_stock` webhook and streamed the same event over SSE; with the flag off no webhook
fired and `/api/v1/events` was `404`. **Review gate:** `/code-review high` ran; its one
high-severity confirmed finding — the original `created_at` high-water-mark cursor silently
dropped an **out-of-order** ledger row synced from another device — was fixed by switching the
cursor to a bounded **seen-id set** (with a regression test), and the default `webhooks.json`
path was anchored to the bridge package (+ a root-level `.gitignore` entry) so a secret file
can never land somewhere committable. Known bound (documented): a single generation surfaces
only its newest `scanLimit` (100) ledger rows — a larger burst is summarized via
`events.truncated` and better consumed via the REST API; the stream/webhooks are at-least-once
with deterministic ids for downstream dedupe. **Note for later phases:** running `serve.mjs`
on Node 25 requires `--experimental-transform-types` (the shared app modules use TS parameter
properties, which Node's default strip-only mode rejects) — vitest is unaffected.

**Continuation prompt — emit on completion (starts EI-2):**

```text
Read docs/todo/ecosystem-integrations-plan_2026-07-03.md and run Phase EI-2 (iCalendar
subscription feed). EI-1 (event model + webhooks + SSE) is complete and merged. Work in a
NEW git worktree off local HEAD (git worktree add .claude/worktrees/ecosystem-ical -b
feat/ecosystem-ical HEAD), follow the "How every phase runs" loop and the invariants at the
top of the plan doc, gate with /code-review high before merging, then merge --no-ff into main
and clean up the worktree/branch. Update the plan doc's EI-2 Outcome, then emit EI-3's
continuation prompt as a raw fenced block. Build the read-only GET /api/v1/calendar.ics feed
(loan due-backs, asset bookings, maintenance/service, warranty expiry) with a hand-rolled
iCalendar emitter — no dependency — and stable per-source UIDs. Synthetic fixtures only.
```

---

## Phase EI-2 — iCalendar (`.ics`) subscription feed

**Goal:** expose Gubbins' time-bearing facts as a read-only calendar any app (Google/Apple/
Outlook/Thunderbird/Home Assistant) can **subscribe** to by URL.

- [x] **`GET /api/v1/calendar.ics`** returning a `text/calendar` VCALENDAR. Auth: bearer token
      accepted **in the query string** as well as the header (the standard for calendar
      subscriptions, which can't send auth headers) — document the trade-off and keep the
      loopback/opt-in posture; consider a dedicated read-only calendar token later.
- [x] **Sources** (each a pure projection through existing repositories, VEVENT per row with a
      **stable `UID`** so subscribers update in place, not duplicate): loan due-backs
      (checked-out items with a due date), **asset bookings** (the shipped asset-booking
      feature), maintenance / service-due dates, and warranty-expiry dates where present on
      items. Skip a source gracefully if its data isn't present.
- [x] **Hand-rolled iCalendar emitter** (`bridge/src/ical/*`, pure + tested) — RFC 5545 line
      folding, text escaping, `DTSTAMP`/`DTSTART`/`SUMMARY`/`DESCRIPTION`/`UID`, all-day vs.
      timed. **No dependency** (same posture as the YAML emitter).
- [x] **Optional per-type feeds** (`?type=loans|bookings|maintenance|warranty`) so a consumer
      can subscribe to just one calendar.
- [x] **Docs:** `bridge/README.md` "Calendar subscription" section (the subscribe URL shape,
      the token-in-URL note, an HA `calendar:` example); add the path to the OpenAPI spec.
- [x] **Tests:** emitter unit tests (folding/escaping/edge dates), and a feed test over the
      synthetic fixture asserting the expected VEVENTs and stable UIDs; a no-dated-data case
      yields a valid empty VCALENDAR.

**Decisions to confirm at entry:** *token placement* (query-string default, documented) and
*per-type feeds* (recommended — cheap once the emitter exists).

**Acceptance:** subscribing a calendar client to
`http://127.0.0.1:8787/api/v1/calendar.ics?token=<t>` shows Gubbins loan/booking/maintenance/
warranty events; the feed validates as iCalendar; UIDs are stable across refetches.

**Review gate:** `/code-review high`.

**Outcome (2026-07-03).** Shipped in `bridge/src/ical/*` and merged to `main`. A read-only
`GET /api/v1/calendar.ics` serves a `text/calendar` (RFC 5545) VCALENDAR of Gubbins' time-bearing
facts. A small **hand-rolled iCalendar emitter** (`emitter.ts`, **zero dependencies**, same
stdlib-first posture as the JSON-RPC / mDNS / YAML encoders) does TEXT escaping (`\ ; , \n` — and
it collapses any `CR`/`LF` in a value to the literal `\n` escape, so a hostile item name can't
inject VEVENT structure), 75-octet line folding on code-point boundaries (never mid-character),
and both all-day `VALUE=DATE` and timed UTC `DATE-TIME` values with an **exclusive** all-day
`DTEND`. The feed projection (`feed.ts`) draws four sources, each a **read-only projection through
an existing repository** — no bespoke SQL: loan due-backs (`CheckoutRepository.listOpen`, open
checkouts filtered to those with a due date), asset bookings (`AssetBookingRepository.listUpcoming`,
active + not-yet-passed), maintenance (`MaintenanceRepository.listUpcoming` + the pure
`maintenanceStatus` seam — **TIME** schedules get their computed due date; **USAGE** schedules have
no calendar date and are skipped), and warranty expiries (`ItemRepository.listWarrantyExpiring`
over a generous decade horizon; the stored `YYYY-MM-DD` is used verbatim, no timezone maths). Each
event carries a **stable per-source `UID`** (`loan-…` / `booking-…` / `maintenance-…` /
`warranty-…`, suffixed `@gubbins.invalid` — the RFC 2606 reserved TLD, so no real host is
committed), so a subscriber updates in place rather than duplicating on refetch; each source is
bounded (5 000 events). **Auth:** the bearer token is accepted as a `?token=` query parameter
**on the calendar path only** (calendar clients can't send an `Authorization` header) — scoped in
`server.ts`'s `isAuthorised`, so every other endpoint still refuses a URL token (verified: `GET
/api/v1/items?token=…` → 401, and a `calendar.ics/../items` traversal normalises to `/api/v1/items`
so the scoped token can't leak). The token-in-URL trade-off is documented in the README with an HA
**Remote Calendar** subscribe example. Optional `?type=loans|bookings|maintenance|warranty` (comma-
separated) narrows the feed; an unknown type is a `400`. Added the `calendar` tag +
`/api/v1/calendar.ics` path to `openapi.ts` and regenerated `openapi.yaml` (drift guard green).
**Decisions at entry:** token-in-query default (documented) and per-type feeds — both taken as
recommended; and **no new `GUBBINS_BRIDGE_*` flag** — the calendar is a read-only *pull* surface
like `items.csv`, not an outbound/write capability, so it is always available (invariant #2 gates
outbound/write surfaces, not reads). **Zero new dependencies.** 33 new bridge tests (354 total, all
green — emitter units for folding/escaping/edge-date arithmetic, a feed test over a dedicated
synthetic fixture asserting each source's VEVENTs + stable/unique UIDs + the type filter + an empty
VCALENDAR, and a server test for content-type, header-vs-query-token auth, the `?type=` 400, and
UID stability across refetches); `tsc --noEmit` clean. A live `serve.mjs` smoke passed the
acceptance verbatim: subscribing to `…/calendar.ics?token=<t>` returned a `text/calendar` VCALENDAR
with loan/booking/maintenance/warranty VEVENTs; `?type=warranty` returned only those; a bad `type`
was a `400`; a missing/wrong token was a `401`. **Review gate:** `/code-review high` ran across all
eight angles (correctness, removed-behaviour, cross-file callers, reuse, simplification, efficiency,
altitude, CLAUDE.md conventions) — **no confirmed or plausible findings**; the two highest-risk
spots (calendar-line injection and the scoped-token path-traversal bypass) were verified safe.

**Continuation prompt — emit on completion (starts EI-3):**

```text
Read docs/todo/ecosystem-integrations-plan_2026-07-03.md and run Phase EI-3 (migration
importers). EI-1 and EI-2 are complete and merged. Work in a NEW git worktree off local HEAD
(git worktree add .claude/worktrees/ecosystem-importers -b feat/ecosystem-importers HEAD),
follow the "How every phase runs" loop and the top-of-doc invariants, gate with /code-review
high before merging, then merge --no-ff into main and clean up. Update the EI-3 Outcome, then
emit EI-4's continuation prompt as a raw fenced block. Add named migration mappers (Homebox,
Grocy, Sortly, Snipe-IT, InvenTree) as pure field-mappings in FRONT of the existing
src/features/inventory/{text-import.ts, catalog-import.ts} pipeline (buildImportPlanFromRows →
applyCatalogImportPlan) surfaced in ImportDataDialog.tsx — do NOT fork the pipeline. Use
Foundry primitives + design tokens for any UI. Synthetic fixtures only (made-up parts,
example.com).
```

---

## Phase EI-3 — Migration importers (Homebox / Grocy / Sortly / Snipe-IT / InvenTree)

**Goal:** the on-ramp — let people bring an existing inventory *in*. The biggest single
adoption lever. Each migration is a **pure field-mapping** in front of the existing import
pipeline; no new architecture.

- [x] **Source-format mappers** (`src/features/inventory/importers/*`, pure + tested): one per
      tool, turning that tool's export (their column/field names) into the row shape
      `buildImportPlanFromRows` already consumes. Reuse the auto-detecting `text-import.ts`
      and `catalog-import.ts` (`applyCatalogImportPlan`) unchanged.
- [x] **Format detection / selection:** auto-detect where a format is unambiguous (a
      recognisable header row); otherwise a **source picker** in `ImportDataDialog.tsx` (a
      Foundry `Select` — see the app-wide Select convention). Map unknown/extra columns to
      notes or drop them explicitly, never silently mis-map.
- [x] **Field coverage:** name, quantity, location, category, price/currency (via the Money/
      currency conventions), identifiers (mpn/gtin), and notes — mapped to Gubbins fields;
      unmapped source fields folded into `items.notes` with a clear provenance line.
- [x] **Docs:** a "Migrating from another tool" section (PWA import docs / top-level README as
      appropriate) listing supported sources and how to export from each.
- [x] **Tests:** one synthetic fixture export per source (made-up parts) asserting the produced
      import plan matches expectations, including the "extra columns → notes" and
      "ambiguous format → picker" paths.

**Decisions to confirm at entry:** *which sources first* (recommend Homebox + Grocy first —
same self-hosted audience as the bridge), and *auto-detect vs. always-pick* (recommend
auto-detect with a manual override).

**Acceptance:** importing a synthetic Homebox (and one other) export via `ImportDataDialog`
creates the expected items/locations/categories; malformed input fails safely with a clear
message; all UI uses Foundry primitives + tokens.

**Review gate:** `/code-review high`.

**Outcome (2026-07-03).** Shipped in `src/features/inventory/importers/migrations.ts` (pure,
zero-dependency) and merged to `main` (merge `824b604`, feature commit `467b568`). Five **named
migration mappers** — Homebox, Grocy, Sortly, Snipe-IT, InvenTree — sit **in front of** the
existing generalised-import pipeline as pure field-mappings: each is a declarative
`{ signature, rules, exportHint }` spec, recognised by a set of header columns unique to that
tool (`detectMigrationSource`, unambiguous — at most one matches), then `mapMigration` reshapes
the *already-parsed* header + data-row matrix into the canonical Gubbins fields and hands it to
the **unchanged** `buildImportPlanFromRows` → `applyCatalogImportPlan` (no forked pipeline, no
new SQL, no new write path). Every column a source exports that has no clean Gubbins field —
labels, tags, serial numbers, warranty dates, and each tool's **category/group name** — is
folded into that item's `notes` with an "Imported from &lt;tool&gt;:" provenance line, so nothing
is silently mis-mapped or lost; a native notes/description column is preserved and the fold
appended. Identifier columns (model/part/barcode/IPN) target the `mpn` slot; asset-oriented
Snipe-IT rows (no quantity column) gain a synthesised quantity of 1. **Category is deliberately
folded, not mapped** — Gubbins categories are referenced by id (with per-category custom fields)
and the sources export only a name, so fabricating a `categoryId` would create a dangling
reference; the name is kept in the provenance note for manual assignment. A one-line
`applyMigration` bridge in `text-import.ts` adapts an `ImportExtraction` (no-op for free-form
line lists / empty input, preserves any parse `note`). Surfaced in `ImportDataDialog.tsx` via a
Foundry `Select` **"Import source"** picker (Auto-detect / Generic / the five tools) that reshapes
columns *before* the shared plan builder and live preview see them — Auto-detect names the
recognised tool, Generic bypasses the mapper for hand-mapping. **Decisions at entry:** Homebox +
Grocy first (same self-hosted audience) — all five shipped together as the mapping cost is small;
and auto-detect-with-manual-override (taken as recommended). **Zero new dependencies.** UI uses
only existing design tokens + the Foundry `Select` (no raw palette/colour literals). Added a
"Migrating from another tool" README section (per-source export instructions + folding/category
posture). **Tests:** a dedicated `migrations.test.ts` with a synthetic export fixture per source
(made-up parts, `example.com`) asserting each produced `CreateItemInput`, the extras→notes fold,
first-wins target claiming, the "two columns → same field" fold, quantity synthesis, unknown-source
pass-through, and the `applyMigration` bridge end-to-end (124 import tests green; 488 inventory
tests green; `tsc --noEmit` clean; production `vite build` succeeded). **Review gate:**
`/code-review high` ran across all eight angles (line-by-line, removed-behaviour, cross-file
callers, reuse, simplification, efficiency, altitude, CLAUDE.md conventions) — **no confirmed or
plausible findings**; the one candidate examined (a migrated `Location` name that doesn't yet
exist erroring its row) is pre-existing, by-design shared-pipeline behaviour identical to a generic
CSV with a Location column (the dialog's default-location control and the "Generic" escape hatch
cover it), not a regression.

**Continuation prompt — emit on completion (starts EI-4):**

```text
Read docs/todo/ecosystem-integrations-plan_2026-07-03.md and run Phase EI-4 (Web Share Target
+ file/protocol handlers). EI-1 through EI-3 are complete and merged. Work in a NEW git
worktree off local HEAD (git worktree add .claude/worktrees/ecosystem-share -b
feat/ecosystem-share HEAD), follow the "How every phase runs" loop and the top-of-doc
invariants, gate with /code-review high before merging (this touches the service-worker /
install surface — high blast radius, so review carefully), then merge --no-ff into main and
clean up. Update the
EI-4 Outcome, then emit EI-5's continuation prompt as a raw fenced block. This
is a PWA-side phase: register a web app manifest share_target (handled in src/sw.ts, since the
PWA has no server) so "Share to Gubbins" from the OS share sheet opens a PRE-FILLED add-item
DRAFT the user confirms (never auto-commit); reuse the add-item enrichment / supplier-scraper /
import seams to hydrate the draft. Add file_handlers and a web+gubbins: protocol handler.
Manifest lives in the VitePWA config in vite.config.ts. Use Foundry primitives + design tokens
for all UI. Synthetic examples only.
```

---

## Phase EI-4 — Web Share Target + file / protocol handlers (inbound, PWA-side)

**Goal:** open Gubbins *inbound* from the mobile OS — "Share to Gubbins" and deep links — so
capturing an item is one gesture. PWA-side; the service worker is the mechanism (no server).

- [x] **`share_target`** in the web app manifest (VitePWA config in `vite.config.ts`): accept
      shared **URL / text / title** and (POST + `multipart/form-data`) an **image**. Because
      the PWA has no server, the **service worker** (`src/sw.ts`) intercepts the share POST,
      stashes the payload, and redirects to a share-landing route.
- [x] **Share-landing route:** opens a **pre-filled add-item draft** (never auto-commits) —
      hydrate it via the existing add-item enrichment: a shared URL → the supplier-scraper /
      Amazon-ASIN paths; shared text → the import parser; a shared image → the item image flow.
      The user reviews and confirms.
- [x] **`file_handlers`:** register `.json` / `.csv` (and any Gubbins export type) to open the
      import dialog directly.
- [x] **`protocol_handlers`:** a `web+gubbins:` handler (e.g. `web+gubbins://item/<id>`) for
      deep links from notes/other apps.
- [x] **Docs:** a short "Add to Gubbins from other apps" section (install the PWA, then Share /
      open-with / deep-link).
- [x] **Tests:** unit-test the SW share-intercept payload handling and the draft-hydration
      mapping (URL vs. text vs. image); a smoke that a shared URL lands on a pre-filled draft.
      Manifest JSON validates.

**Decisions to confirm at entry:** *auto-commit vs. draft* — **always a reviewable draft**
(recommended, non-negotiable for a share that could be accidental). *Which enrichment path a
share maps to* — confirm the URL→scraper / text→import / image→image-flow mapping.

**Acceptance:** with the PWA installed, sharing a product URL from the OS share sheet opens
Gubbins on a pre-filled add-item draft; opening a `.csv` via the OS routes to the import
dialog; all new UI uses Foundry primitives + design tokens.

**Review gate:** `/code-review high` (touches the SW / install surface — high blast radius; review carefully).

**Outcome (2026-07-03).** Shipped in `src/features/share/*` + three new routes and merged to
`main` (merge `7bd49c9`, feature commit `3645977`). Gubbins now opens **inbound** from the
mobile OS — every path landing on a **reviewable draft the user confirms** (never auto-committed,
the non-negotiable decision-at-entry). The web app manifest (VitePWA config in `vite.config.ts`)
declares three surfaces, all relative to the `/Gubbins/` scope: a **`share_target`** (`POST` +
`multipart/form-data`, so a shared image file can arrive), **`file_handlers`** for
`.csv/.tsv/.json/.md/.txt`, and a **`web+gubbins:` `protocol_handler`**. Because the PWA has no
server, the **service worker** (`src/sw.ts`) is the mechanism: a "Share to Gubbins" `POST` to the
share path is intercepted, parsed (`parseShareForm`), stashed in a dedicated **Cache Storage inbox**
(`share-inbox.ts`, origin-anchored keys so the worker-writer and page-reader derive an identical
key without sharing the base-path build constant), and answered with a `303` redirect to
`share-target?share=<id>`; the landing route reads the stash back, opens the draft, and clears it
(a one-shot inbox). The `activate` cache prune now **preserves** the inbox (an in-flight share must
survive a mid-share SW update) and a TTL sweep (`pruneStaleShares`, 1 h) reclaims any share whose
landing tab was dismissed before the draft opened, so an abandoned image blob can't linger forever.
Hydration reuses existing seams, never a fork: the pure **`share-draft.ts`** maps a payload →
add-item draft — a shared URL runs through the **Amazon-ASIN parser** (`parseAsin`/`findAsin`, EI-3
era) so a listing link fills the SKU/MPN **and** pre-seeds the supplier-scraper panel's URL box
(new `initialUrl` prop) for one-tap enrichment; the title/text become the name + a provenance note
(nothing shared is silently dropped). The three landing routes render **existing dialogs**
pre-filled through new optional props: `CreateItemDialog` gained `initialValues` + `initialImage`
(the shared image is attached after create, best-effort, via `useAddItemImage`); `ImportDataDialog`
gained `initialText`/`initialFilename` (a `file_handlers` launch consumes `window.launchQueue`);
`web+gubbins://item/<id>` opens `ItemDetailDialog`, `add?…` opens a draft, anything else falls back
to inventory. All UI is Foundry primitives + design tokens (a shared `LandingScaffold` wires the
`PageHeader` + `<main id="main-content">` + skip-link + spinner shell once). **Decisions at entry:**
always a reviewable draft (taken, non-negotiable) and the URL→scraper/ASIN, text→name+note,
image→attach-after-create mapping (taken as recommended). **Zero new dependencies.** New unit tests
(`share-draft`, `deep-link`, `share-inbox` incl. the TTL sweep, + `CreateItemDialog` pre-fill and
image-attach) and a **real service-worker end-to-end** PWA smoke step: with the built app under a
SW-controlled context, a `multipart` share `POST` is intercepted, redirected, and the landing route
opens a draft pre-filled with the shared title **and** the ASIN-derived MPN; the manifest's
share/file/protocol members are asserted present. Full suite green (2227 app tests + the 5-step PWA
smoke); `tsc --noEmit` clean; production `vite build` emits the manifest members and a SW carrying
the intercept. **Review gate:** `/code-review high` ran (2 finder angles across correctness +
conventions/cleanup, then verification) — **no correctness bugs**; the one low-severity finding (an
unconsumed share leaking in the inbox, since the `activate` prune now spares that cache) was fixed
with the TTL sweep, and the cleanup findings (triplicated landing scaffold → shared `LandingScaffold`;
a mirrored default-location expression → new `markedDefaultLocationId` helper reused in
`InventoryScreen`; three speculative `CreateItemInitialValues` fields → trimmed to what a share can
populate) were all applied. **Known bound (documented):** the share/file/protocol entry points only
appear **after the PWA is installed** (they are OS-registered manifest members), and the SW is
disabled in dev — so they are exercisable only against the built/installed app (the PWA smoke covers
this).

**Continuation prompt — emit on completion (starts EI-5):**

```text
Read docs/todo/ecosystem-integrations-plan_2026-07-03.md and run Phase EI-5 (MQTT publish +
Home Assistant MQTT discovery). EI-1 through EI-4 are complete and merged. Work in a NEW git
worktree off local HEAD (git worktree add .claude/worktrees/ecosystem-mqtt -b
feat/ecosystem-mqtt HEAD), follow the "How every phase runs" loop and the top-of-doc
invariants, gate with /code-review high before merging, then merge --no-ff into main and
clean up. Update the EI-5 Outcome, then emit EI-6's continuation prompt as a raw fenced block.
Add an opt-in (GUBBINS_BRIDGE_MQTT=on, off by default) mode where the bridge connects OUT to a
user's MQTT broker and publishes inventory state + the EI-1 events to topics, optionally
emitting Home Assistant MQTT-discovery config so HA auto-creates entities with NO custom
component. DECISION AT ENTRY: hand-rolled MQTT 3.1.1 publish-only client (preserve zero-dep)
vs. the first vetted MIT dependency (e.g. `mqtt`) — vet licence/maintenance and decide
explicitly; this is the sanctioned place to reconsider the zero-dependency rule. Secrets in
.env only; synthetic fixtures only.
```

---

## Phase EI-5 — MQTT publish + Home Assistant MQTT discovery

**Goal:** reach the self-hosted / home-automation ecosystem (Node-RED, Zigbee2MQTT-style
pipelines, and especially Home Assistant) by **publishing out** to the user's MQTT broker —
optionally auto-creating HA entities with **no custom component at all**.

- [x] **Opt-in outbound MQTT client** (`GUBBINS_BRIDGE_MQTT=on`, off by default):
      `GUBBINS_BRIDGE_MQTT_URL` + optional `_MQTT_USERNAME` / `_MQTT_PASSWORD` (all in `.env`).
      The bridge is an MQTT **client** connecting *out* — no inbound port, so it doesn't
      violate "no inbound server".
- [x] **Publish topics:** item/location state under `gubbins/…/state` (retained, JSON) and the
      **EI-1 events** under `gubbins/event/…`. Reuse the EI-1 event model — do not fork it.
- [x] **Home Assistant MQTT discovery (optional, own sub-flag):** emit
      `homeassistant/<component>/gubbins_<id>/config` topics so HA auto-creates low-stock
      binary sensors, per-location count sensors, etc. — **no** `custom_components/gubbins`
      needed for this path. Document how it relates to the existing custom component (they are
      alternatives; a user picks one).
- [x] **Resilience:** reconnect with backoff, an availability/LWT topic (`online`/`offline`),
      and best-effort (a broker outage logs a warning; the HTTP API is unaffected).
- [x] **Docs:** `bridge/README.md` "MQTT publishing" section; `homeassistant/README.md` gains
      the MQTT-discovery route as an alternative to the custom component.
- [x] **Tests:** pure tests for topic/payload/discovery-config construction over the synthetic
      fixture; the connection/reconnect shell behind a seam so it's unit-testable without a
      live broker (an injected fake client).

**Decision to confirm at entry (the important one): dependency.** Hand-roll a minimal MQTT
3.1.1 **publish-only** client over `node:net`/`node:tls` (CONNECT/PUBLISH/PINGREQ/DISCONNECT —
a small, RFC-specified subset), preserving the zero-dependency invariant, **or** take the
bridge's first runtime dependency (a vetted MIT client such as `mqtt`). Present both, vet the
dependency (licence, maintenance, popularity, transitive surface) per CLAUDE.md, and record
the choice + rationale in the Outcome. Default lean: **hand-rolled publish-only** if the subset
stays small; otherwise the vetted dep.

**Acceptance:** with `GUBBINS_BRIDGE_MQTT=on` pointed at a local broker (e.g. Mosquitto),
Gubbins state + events appear on the expected topics; with HA discovery on, HA shows Gubbins
entities without the custom component; with the flag off, nothing connects.

**Review gate:** `/code-review high` (networking + the dependency decision; review carefully).

**Outcome (2026-07-03).** Shipped in `bridge/src/mqtt/*` and merged to `main`. An opt-in
(`GUBBINS_BRIDGE_MQTT=on`, off by default) mode connects the bridge **out** to the operator's MQTT
broker (an MQTT *client* dialling out — **no inbound port**, so the "no inbound server" posture
holds) and publishes inventory state + the EI-1 change events. **Dependency decision (the
sanctioned reconsideration of the zero-dependency rule): hand-rolled.** The `mqtt` npm client is
MIT/well-maintained and would pass IP-hygiene vetting, but it exists to be a *full* client
(subscribe, QoS-1/2 ack machines, WS transport) and pulls a broad transitive tree for a job the
bridge doesn't need; the required subset is strict and RFC-specified — CONNECT (clean session,
keep-alive, LWT, optional username/password), CONNACK, **QoS-0** PUBLISH (no packet id / ack),
PINGREQ/PINGRESP, DISCONNECT — the same size as the already-hand-rolled mDNS wire format and
iCal/YAML emitters. So the bridge **stays zero-runtime-dependency and build-free** (`bridge/src/mqtt/packet.ts`
is the pure codec, `client.ts` the `node:net`/`node:tls` connection shell). The pure pieces —
`topics.ts` (status/summary/location/event topic + payload builders), `state.ts` (a **read-only
projection through the app repositories**, no bespoke SQL, reusing the EI-1 `isLow` / `isStockEmpty`
seams so the low/out-of-stock counts can never drift from the `item.low_stock` / `item.out_of_stock`
events; system buckets `Unassigned`/`In Transit` are excluded as HA-sensor clutter), and
`discovery.ts` (Home Assistant MQTT-discovery config builder) — are all unit-tested directly, and
`publisher.ts` orchestrates them: it is an EI-1 **`EventSink`** (each event → `gubbins/event/<type>`,
not retained) **and** publishes **retained** state per generation (`gubbins/summary/state`,
`gubbins/location/<id>/state`), reusing the event model (never forked). Availability is a retained
`gubbins/status` topic — `online` on each (re)connect and `offline` as the connection's **Last-Will**
(ungraceful death flips it automatically) and on graceful stop. **Resilience:** reconnect with
bounded backoff, keep-alive pings with **half-open detection** (two unanswered pings → force
reconnect rather than black-holing publishes to a dead socket), and offline **retained-only**
buffering (transient events are dropped rather than replayed stale after an outage; retained state is
re-announced on reconnect, along with the discovery layout so a broker that restarted without
persistence re-learns everything). **Home Assistant discovery** is a second sub-flag
(`GUBBINS_BRIDGE_MQTT_DISCOVERY=on`): it emits retained `homeassistant/.../config` topics so HA
auto-creates the four count sensors + a low-stock `binary_sensor` + one sensor per user location
under a single "Gubbins" device with **no custom component at all** (documented as an *alternative*
to the custom component — "Option C" in `homeassistant/README.md`; a removed location clears its
retained state + discovery entity so no ghost sensors linger). Config: `GUBBINS_BRIDGE_MQTT[_URL|
_USERNAME|_PASSWORD|_PREFIX|_CLIENT_ID|_DISCOVERY|_DISCOVERY_PREFIX]` (secrets in `.env` only, never
logged; the broker URL is parsed once at startup and only its host/port label is logged). Enabling
MQTT turns the internal event pipeline on **without** exposing the SSE HTTP endpoint (that stays
gated by `GUBBINS_BRIDGE_EVENTS` / `_WEBHOOKS`) — per-capability opt-in. **Zero new dependencies.**
61 new bridge tests (415 total, all green; `tsc --noEmit` clean for bridge and app). A live
`serve.mjs` smoke against a **throwaway in-process MQTT broker** passed the acceptance verbatim (15
checks): with the flag on, the bridge connected out, published retained `online` + summary + per-
location state + all six HA discovery configs, and — after a snapshot change dropped an item below
its low-stock bound — published live `gubbins/event/stock.adjusted` + `item.low_stock` (non-
retained); with the flag off, the broker saw **no connection**. **Review gate:** `/code-review high`
ran (correctness + cleanup/conventions finder angles, then verification). It caught, and this phase
fixed: (1) a **stale-retained-topic** leak — a removed location's retained state + HA entity now
cleared via a zero-length retained publish; (2) **no half-open detection** — added the unanswered-
ping force-reconnect; (3) **stale event replay** — the offline buffer now holds retained messages
only. Cleanup findings (a duplicated paged-scan loop → shared `forEachPage`; a double-parsed broker
URL + duplicated endpoint label → parsed once + shared `endpointLabel()`; a conflated scan cap →
separate `MAX_LOCATIONS_SCANNED`) were all applied. The review also surfaced a stray **NUL byte**
that had crept into publisher.ts's discovery-signature line (git had flagged the file binary,
hiding it from the diff) — fixed by switching the signature to `JSON.stringify` of the location
`[id,name]` pairs. Separately, two **pre-existing** bridge `tsc` breakages (app-side additions that
outpaced the EI-1 event model — the `TRACKING_CHANGED` history action and the `isUnlimited`
`ItemSummaryDto` field) were repaired so the gate is genuinely green.

**Continuation prompt — emit on completion (starts EI-6):**

```text
Read docs/todo/ecosystem-integrations-plan_2026-07-03.md and run Phase EI-6 (RSS/Atom/JSON
Feed + Prometheus /metrics). EI-1 through EI-5 are complete and merged. Work in a NEW git
worktree off local HEAD (git worktree add .claude/worktrees/ecosystem-feeds -b
feat/ecosystem-feeds HEAD), follow the "How every phase runs" loop and the top-of-doc
invariants, gate with /code-review high before merging, then merge --no-ff into main and clean
up. Update the EI-6 Outcome, then emit EI-7's continuation prompt as a raw fenced block. Add
cheap standards read-surfaces on the bridge: GET /api/v1/activity.rss (+ .atom, .json) rendering
the Phase 80 activity feed (item_history projection, reuse the EI-1 event model / activity-kind
seams) via a hand-rolled emitter (no dependency), and GET /metrics in OpenMetrics/Prometheus
text format (gubbins_items_total, gubbins_low_stock_items, gubbins_locations_total,
gubbins_out_of_stock_items, storage/fullness gauges). Add both to the OpenAPI spec. Synthetic
fixtures only.
```

---

## Phase EI-6 — RSS / Atom / JSON Feed + Prometheus `/metrics`

**Goal:** cheap, standards-based read surfaces — a human "what changed" feed for any reader,
and machine metrics for Grafana/Prometheus home-labs (the same audience running the bridge).

- [ ] **Syndication feeds:** `GET /api/v1/activity.rss` (+ `.atom`, `.json` [JSON Feed 1.1])
      rendering the Phase 80 activity feed — the `item_history` projection, reusing the EI-1
      event model and the `activity-kind` / `describeHistoryEntry` seams. Hand-rolled XML/JSON
      emitter (same posture as the YAML/iCal emitters — **no dependency**). Bounded item count.
- [ ] **`GET /metrics`** in OpenMetrics/Prometheus text format:
      `gubbins_items_total`, `gubbins_low_stock_items`, `gubbins_out_of_stock_items`,
      `gubbins_locations_total`, and storage/fullness gauges — counts sourced through the
      existing repositories / `countByAst`, never bespoke SQL. Decide auth posture (recommend:
      same bearer token; document if left open for a scrape job on loopback).
- [ ] **Docs + spec:** `bridge/README.md` "Feeds & metrics" section (a Grafana/Prometheus
      scrape-config example, feed URLs); add the paths to `bridge/src/openapi.ts` +
      `openapi.yaml` (drift-guard).
- [ ] **Tests:** feed-emitter unit tests (valid RSS/Atom/JSON Feed, escaping); a `/metrics`
      test asserting the metric names/values over the synthetic fixture; OpenAPI drift-guard.

**Decisions to confirm at entry:** *feed auth* (token vs. open-on-loopback) and *metrics auth*
(recommend token; note the common "scrape on loopback" exception).

**Acceptance:** a feed reader subscribed to `/api/v1/activity.rss` shows recent Gubbins
activity; `curl .../metrics` returns valid OpenMetrics a Prometheus scrape accepts.

**Review gate:** `/code-review high`.

**Outcome (____-__-__).** _(fill in on completion)_

**Continuation prompt — emit on completion (starts EI-7):**

```text
Read docs/todo/ecosystem-integrations-plan_2026-07-03.md and run Phase EI-7 (documentation
truth-up + ecosystem finalisation). EI-1 through EI-6 are complete and merged. Work in a NEW
git worktree off local HEAD (git worktree add .claude/worktrees/ecosystem-docs -b
feat/ecosystem-docs HEAD), follow the "How every phase runs" loop and the top-of-doc
invariants, gate with /code-review high before merging, then merge --no-ff into main and clean
up. This is the FINAL phase: update ALL integration docs to detail EXACTLY what is now
supported — bridge/README.md, the MCP server section + tool table, homeassistant/README.md and
custom_components/gubbins docs, the top-level README's integration section, and make the
OpenAPI spec complete for every /api/v1 surface. Add a single "permission & security matrix"
listing every GUBBINS_BRIDGE_* opt-in flag and what it exposes. Verify every example is
synthetic. After merging, mark the whole plan complete in the plan doc and update the memory
index. There is NO next phase — emit an "all phases complete" summary instead of a continuation
prompt.
```

---

## Phase EI-7 — Documentation truth-up + ecosystem finalisation

**Goal (explicitly requested by the user):** make the **MCP and Home Assistant documentation
— and every other integration doc — actually detail what is supported**, now that the surface
is much larger. Close the loop so a stranger can discover and use every capability.

- [ ] **`bridge/README.md`:** ensure every surface is documented and accurate — REST `/api/v1`,
      OpenAPI, CSV, events/webhooks/SSE (EI-1), calendar (EI-2), MQTT (EI-5), feeds & metrics
      (EI-6), limited writes, push, mDNS. Fix any drift accumulated across phases.
- [ ] **MCP docs:** the "MCP server" section must list **exactly** the tools that exist and
      their real I/O shapes (the tool table), the `mcpServers` config example, transport
      (stdio) and its trust boundary, and what is *not* supported (HTTP transport, write tools)
      so expectations are correct.
- [ ] **Home Assistant docs:** `homeassistant/README.md` + `custom_components/gubbins` — detail
      the custom-component path **and** the new MQTT-discovery path (EI-5) as alternatives, the
      conversation intent, the sensor, zeroconf discovery, and the exact bridge contract each
      relies on.
- [ ] **Top-level `README.md`:** refresh the integration section to enumerate the full
      ecosystem (pull: REST/OpenAPI/CSV/MCP; push: webhooks/SSE/MQTT/feeds; calendar; inbound:
      share target/importers; metrics) with the opt-in posture stated once, clearly.
- [ ] **OpenAPI completeness:** every `/api/v1` path added across EI-1…EI-6 is in
      `bridge/src/openapi.ts` + `openapi.yaml`, drift-guard green.
- [ ] **Permission & security matrix:** one table listing every `GUBBINS_BRIDGE_*` flag, its
      default (off), what it exposes, whether it can write, and where its secret lives — the
      single place a user reasons about what they've turned on.
- [ ] **Final audit:** re-confirm no secret/real-data anywhere across all new files, fixtures,
      logs, and docs; all examples synthetic; licence/`package.json` consistent if any dep was
      added in EI-5.

**Acceptance:** a newcomer reading the docs can enumerate and use every integration; the docs
match the code (no aspirational or stale claims); the security matrix is complete and correct.

**Review gate:** `/code-review high` (docs-focused, but catches contract drift).

**Outcome (____-__-__).** _(fill in on completion)_

**Continuation prompt:** none — this is the final phase. On completion, mark the plan
**complete** here, update the memory index line, and emit an "all ecosystem phases complete"
summary in chat instead of a continuation prompt.

---

## Cross-cutting acceptance (the whole build)

- Every opt-in flag defaults **off** and is logged as a deliberate choice; with all flags off,
  the bridge behaves exactly as it does today (pure additive).
- No secret or real/personal data in any file, fixture, log, commit message, or doc.
- The PWA bundle / GitHub-Pages build is **unchanged** by the bridge phases (EI-1/2/5/6/7);
  the PWA phases (EI-3/EI-4) use Foundry primitives + design tokens throughout.
- `parseASTtoSQL` remains the only SQL path; the §7.3 sync merge remains the only write path.
- Each phase merged only after its `/code-review` gate is clean.

## Continuation prompt (current)

The current next step is **Phase EI-6** (EI-1 through EI-5 are complete and merged). Its
kick-off prompt (self-contained, for a cold session) is below; each completed phase replaces this
with the next phase's embedded prompt.

```text
Read docs/todo/ecosystem-integrations-plan_2026-07-03.md and run Phase EI-6 (RSS/Atom/JSON
Feed + Prometheus /metrics). EI-1 through EI-5 are complete and merged. Work in a NEW git
worktree off local HEAD (git worktree add .claude/worktrees/ecosystem-feeds -b
feat/ecosystem-feeds HEAD), follow the "How every phase runs" loop and the top-of-doc
invariants, gate with /code-review high before merging, then merge --no-ff into main and clean
up. Update the EI-6 Outcome, then emit EI-7's continuation prompt as a raw fenced block. Add
cheap standards read-surfaces on the bridge: GET /api/v1/activity.rss (+ .atom, .json) rendering
the Phase 80 activity feed (item_history projection, reuse the EI-1 event model / activity-kind
seams) via a hand-rolled emitter (no dependency), and GET /metrics in OpenMetrics/Prometheus
text format (gubbins_items_total, gubbins_low_stock_items, gubbins_locations_total,
gubbins_out_of_stock_items, storage/fullness gauges). Add both to the OpenAPI spec. Synthetic
fixtures only.
```
