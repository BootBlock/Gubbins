# Opening the Gubbins ecosystem — integration feasibility (2026-07-03)

> **Status:** 📘 REFERENCE — research/feasibility survey, not a build plan; kept for its verdicts.

> **Research / feasibility doc**, not a build plan. It answers the user ask:
> *"There's a Home Assistant bridge and an MCP server — what other services or features
> can we add that open the Gubbins ecosystem to other applications, tools, and services?
> We want everything available to anyone that wants to consume it (with the user's
> permission)."*
>
> It surveys the realistic options, assesses each against the local-first constraint and
> the existing seams, gives a **verdict** (recommend / defer / decline) with a rough
> ordering, and records what to explicitly *not* build. No code is written here. Where an
> item graduates to a real feature it gets its own phased plan doc, mirroring
> [`home-assistant_2026-06-29.md`](done/home-assistant_2026-06-29.md).

## TL;DR — the recommendation

We are in good shape on **pull** (any app can already *query* Gubbins via the versioned
REST API, OpenAPI, CSV, and the MCP server). The two big gaps are **push** (Gubbins can't
yet *tell* another system that something happened) and **inbound** (getting data *into*
Gubbins from other tools). The highest-leverage additions, in order:

1. **Outbound webhooks from the bridge** — the missing primitive. One generic "on change,
   POST a signed JSON event" mechanism unlocks Slack/Discord/n8n/Node-RED/IFTTT/Make and
   home automation without us integrating any of them by name. *(→ own phase.)*
2. **An iCalendar (`.ics`) subscription feed** — expose loan due-backs, maintenance/service
   dates, warranty expiry and asset bookings as a read-only calendar URL any calendar app
   (Google/Apple/Outlook/HA) can subscribe to. Read-only, standards-based, high value.
3. **MQTT publish (with Home Assistant discovery)** — idiomatic for the self-hosted / home
   automation crowd; can auto-create HA entities with *no* custom component, and feeds
   Node-RED/Zigbee2MQTT-style pipelines. Complements (1).
4. **Web Share Target + inbound "quick capture"** — let the phone OS share sheet ("Share to
   Gubbins") and forwarded receipts create draft items, opening the ecosystem *inbound* from
   mobile. PWA-side; must use Foundry/tokens.
5. **A `/metrics` (OpenMetrics/Prometheus) endpoint** and **feed formats (RSS/Atom/JSON
   Feed)** on the bridge — cheap, standards-based read surfaces for Grafana and any reader.
6. **Migration importers** (Homebox / Grocy / Sortly / Snipe-IT / InvenTree) — the on-ramp
   that lets people *bring their existing inventory in*, the biggest single adoption lever.

Everything below stays true to the two invariants that already shape the bridge: **the PWA
never gets a server**, and **nothing leaves the user's control without an explicit,
per-capability opt-in**.

## The constraint that shapes everything (recap)

Gubbins is a **strictly local-first PWA with no server** — an in-browser SQLite (WASM) on
OPFS. A web page cannot host a LAN endpoint, and the project premise is that nothing is sent
to a cloud. Every integration therefore has to route through one of two existing seams:

- **The browser** can *read* the OS (Web Share Target, file handlers, protocol handlers,
  clipboard, camera) and *write out* through user-chosen paths (the FS-Access **sync**
  snapshot `gubbins-sync.json`, raw `.sqlite` export, Markdown/JSON/CSV export). It cannot
  accept an inbound network connection.
- **The bridge** (`bridge/`) is the *only* component that can hold a LAN socket. It already
  watches the sync snapshot, hydrates it into a headless `node:sqlite` DB, and runs the
  app's own query code. It runs **on the user's own hardware**, ships nothing to the browser
  bundle, and is off unless the user runs it. **Any new "serve to the network" integration
  belongs in the bridge, not the PWA.**

**Permission model (non-negotiable, mirrors the bridge's existing posture).** Every new
outbound or write-capable capability is **opt-in and off by default**, gated by its own
`GUBBINS_BRIDGE_*` flag (like `GUBBINS_BRIDGE_ALLOW_WRITES` / `_ALLOW_PUSH` / `_MDNS`),
carries **no secret in any advertisement**, and is documented as a deliberate choice. PWA-side
inbound capabilities (share target, file handler) are user-granted by the OS install prompt
and never auto-act — they create *drafts* the user confirms.

## What already exists (so we don't re-propose it)

The bridge is far more complete than "HA + MCP" implies. Current integration surface:

| Surface | What it gives consumers | Where |
| --- | --- | --- |
| **Versioned REST API `/api/v1`** | items, item detail (placements + capabilities), locations, categories, capabilities; offset/limit pagination; structured error envelope | `bridge/src/api/*` |
| **OpenAPI 3 spec** | machine-readable contract at `GET /api/v1/openapi.json` + committed `openapi.yaml` | `bridge/src/openapi.ts` |
| **CSV export endpoint** | `GET /api/v1/items.csv` honouring the same filter/sort/search | `bridge/src/api/*` |
| **Legacy read aliases** | `/health`, `/search`, `/where` (+ spoken sentence) | `bridge/src/server.ts` |
| **MCP stdio server** | 6 read-only `gubbins_*` tools for LLM/agents | `bridge/src/mcp/*` |
| **Limited writes (opt-in)** | `POST …/adjust-quantity`, `…/adjust-gauge` round-tripped through the sync merge | `bridge/src/write.ts` |
| **mDNS / DNS-SD discovery (opt-in)** | `_gubbins._tcp.local` advertisement for zero-config HA setup | `bridge/src/mdns/*` |
| **Snapshot push (opt-in)** | PWA POSTs its whole dataset to the bridge (no shared folder needed) | `src/features/sync/push-to-bridge.ts`, `bridge/src/push.ts` |
| **HA custom integration** | HACS component + conversation intent + sensor | `homeassistant/`, `custom_components/gubbins/` |
| **App-side exports** | Markdown vault / JSON / CSV / raw `.sqlite` | `src/features/export/*` |

So **read/pull is essentially solved** for anyone who can speak HTTP or MCP. The blank spots
are **push-out**, **inbound**, and a few cheap **standards** surfaces. The rest of this doc
is organised by those directions.

---

## Direction A — Push out (events leave Gubbins)

Today a consumer must *poll* `/api/v1` to notice a change. The bridge already knows exactly
when data changes — its `watcher.ts` re-hydrates on every snapshot write. That is the natural
hook for turning Gubbins from a queryable store into an **event source**.

### A1. Outbound webhooks *(recommend — first)*

**What.** An opt-in bridge capability that POSTs a small JSON event to one or more
user-configured URLs whenever the watched snapshot changes in a way worth announcing —
e.g. `item.low_stock`, `item.out_of_stock`, `item.checked_out`, `item.checked_in`,
`item.created`, `stock.adjusted`, `location.archived`, `maintenance.due`.

**How it fits.** The bridge already re-hydrates old → new on each change. A webhook is a
**diff** between the previous hydrated DB and the new one, mapped to a stable event DTO
(reuse the `api/dto.ts` shapes). The `item_history` ledger (already synced, the basis of the
Phase 80 activity feed) is an even cleaner source: new ledger rows since the last generation
*are* the event list, already typed by `HistoryAction`. Emit each as one webhook.

- **Delivery:** stdlib `fetch`/`node:http` POST, small retry/backoff, at-least-once, an
  `X-Gubbins-Signature` HMAC (shared secret) so the receiver can verify authenticity — the
  de-facto webhook pattern (GitHub/Stripe style). No new dependency.
- **Config:** `GUBBINS_BRIDGE_WEBHOOKS=on` + a small JSON/env list of `{url, secret, events[]}`.
  Off by default; the URL list is the user's explicit consent.
- **Payload:** `{ id, type, occurredAt, data }` where `data` is an existing DTO. Include a
  `deliveryId` and make handlers idempotent (the receiver dedupes).

**Why it's the keystone.** One generic mechanism means we never have to build "a Slack
integration", "a Discord integration", "an IFTTT integration" by name — n8n, Node-RED,
Make, IFTTT, Zapier (Catch Hook), Discord/Slack incoming webhooks, and Home Assistant's
`webhook` trigger all consume a plain signed POST. This is the single highest-leverage
addition and the prerequisite for most "notify me when…" asks (low-stock alerts, loan
overdue, restock reminders).

**Effort/risk.** Moderate. The diff/ledger-delta logic and delivery queue are the real work;
everything is read-only w.r.t. the user's data (a webhook never mutates inventory). Needs
care that a burst of changes doesn't fan out into a flood (coalesce per generation, cap).

**Verdict: recommend — own phase, do first.** It converts the whole existing read API from
pull to pull+push.

### A2. MQTT publish + Home Assistant MQTT discovery *(recommend)*

**What.** An opt-in mode where the bridge connects *out* to a user's MQTT broker and
publishes inventory state and events to topics (`gubbins/item/<id>/state`,
`gubbins/event/…`), optionally emitting **HA MQTT-discovery** config topics so Home
Assistant auto-creates sensors (low-stock binary_sensors, per-location counts) **with no
custom component at all**.

**How it fits.** Same change-detection source as A1, different sink. MQTT is the lingua
franca of self-hosted/home-automation (Node-RED, Zigbee2MQTT, esphome, HA). Publishing is
outbound-only (the bridge is an MQTT *client*), so it doesn't violate "no inbound server"
and needs no port opened.

**Effort/risk.** The wire protocol is small but not trivial; a hand-rolled MQTT client is
more surface than the JSON-RPC/mDNS encoders we hand-rolled. This is the **one place the
"zero runtime dependency" rule deserves a real re-think** — a tiny, well-vetted MIT MQTT
client (e.g. `mqtt`) may be worth the first dependency. Flag as a decision-at-entry.

**Verdict: recommend — after webhooks.** Highest value for the home-automation audience;
overlaps webhooks but reaches a different, large ecosystem and can be *no-config* on the HA
side.

### A3. Server-Sent Events / live stream `GET /api/v1/events` *(recommend — cheap)*

**What.** A read-only SSE endpoint the bridge holds open; each snapshot generation pushes
the same event objects as A1 down the stream.

**How it fits.** Trivial on top of A1's event model — `node:http` keeps the response open and
writes `data: …\n\n`. Bearer-token + rate-limit reuse the existing middleware. It's the
*pull-side* twin of webhooks: great for a local dashboard, a browser tab, a Grafana/loki
tail, or an agent that wants to watch rather than poll. SSE over raw WebSocket because it's
one-way, stdlib-only, and auto-reconnecting.

**Verdict: recommend — bundle with A1.** Near-free once the event model exists.

### A4. RSS / Atom / JSON Feed of the activity log *(recommend — cheap)*

**What.** `GET /api/v1/activity.rss` (+ `.atom`, `.json`) rendering the Phase 80 activity
feed (the `item_history` projection) as a standard syndication feed.

**How it fits.** Pure read projection of an existing, already-shipped feature; a tiny XML/JSON
emitter (like the existing hand-rolled YAML emitter). Any feed reader, IFTTT ("New feed
item"), Slack RSS app, or Discord webhook-via-RSS bot can then subscribe — a zero-auth-tooling
way to get a human "what changed" stream.

**Verdict: recommend — cheap win.** Lowest effort in this whole doc.

---

## Direction B — Inbound (data comes into Gubbins)

Query-out is solved; *getting things in from other tools* is thin (manual add, the
generalised import dialog, the researched Amazon path). This is where adoption actually lives
— people won't switch to Gubbins if they can't bring their stuff with them.

### B1. Web Share Target — "Share to Gubbins" *(recommend)*

**What.** Register the installed PWA as a Web Share **Target** so the mobile OS share sheet
lists Gubbins. Sharing a product URL, a photo of a box/label, or text/barcode into Gubbins
opens a **pre-filled "add item" draft** the user confirms.

**How it fits.** A `share_target` entry in the web app manifest + a route that receives the
shared payload (already have the add-item enrichment flow, the supplier scraper, and the
generalised import parser to hydrate the draft). Purely additive, user-granted by the OS,
never auto-commits. **Must** use Foundry primitives + tokens for any UI (CLAUDE.md).

**Why.** It's the single most natural *inbound* mobile gesture and it composes with existing
enrichment. Opens Gubbins to "every app that can share" without integrating any of them.

**Verdict: recommend.** PWA-side; pairs well with the Amazon-import research already done.

### B2. File handler + protocol handler *(defer — small)*

**What.** `file_handlers` (open a `.gubbins`/`.csv`/`.json` export by double-clicking →
import dialog) and a `web+gubbins:` protocol handler for deep links (`web+gubbins://item/<id>`)
so other apps and notes can link into Gubbins.

**Verdict: defer.** Genuinely nice, low effort, but lower leverage than the share target and
overlapping with the existing import dialog. Bundle behind B1.

### B3. Migration importers (Homebox / Grocy / Sortly / Snipe-IT / InvenTree) *(recommend)*

**What.** Named import mappers that turn an export from a competing/adjacent tool into a
Gubbins catalog-import plan.

**How it fits.** The generalised `text-import.ts` → `buildImportPlanFromRows` →
`applyCatalogImportPlan` pipeline already exists and auto-detects csv/tsv/json/markdown. Each
migration is a **pure field-mapping** in front of that pipeline (their column names → ours),
plus a small fixture. No new architecture.

**Why.** This is the biggest *adoption* lever in the doc — "bring your existing inventory"
turns a curious visitor into a user. It also makes Gubbins a good ecosystem citizen (easy in,
easy out — we already export Markdown/JSON/CSV/sqlite).

**Verdict: recommend — high adoption value, low architectural risk.** Sequence by ecosystem
size (Homebox/Grocy first — same self-hosted audience as the bridge).

### B4. Email / receipt forwarding intake *(decline for now)*

**What.** Forward a receipt email → items appear.

**Why not.** Requires a mailbox/inbound server or a third-party parsing service — a
**cloud/server dependency that breaks local-first** and adds real privacy surface. The
share-target + Amazon-invoice paste paths cover the same need locally. Revisit only if a
purely-local IMAP-poll variant is requested; even then it belongs in the bridge, not the PWA.

---

## Direction C — Standards & discovery (cheap breadth)

### C1. Prometheus / OpenMetrics `GET /metrics` *(recommend — cheap)*

Expose counts as metrics: `gubbins_items_total`, `gubbins_low_stock_items`,
`gubbins_locations_total`, `gubbins_out_of_stock_items`, storage/fullness gauges. Text
format, stdlib, no dep. Instantly makes Gubbins a first-class citizen in Grafana/Prometheus
home-lab dashboards — the same audience running the bridge. **Verdict: recommend.**

### C2. schema.org / JSON-LD `Product` on item detail *(defer — small)*

Emit `application/ld+json` (`schema.org/Product`, `Offer`, `gtin`) alongside item detail so
generic semantic tools and future scrapers can read a Gubbins item structurally.
**Verdict: defer** — cheap, low demand today.

### C3. GS1 Digital Link / GTIN resolution *(defer)*

Resolve/emit GS1 Digital Link URIs from a GTIN so a scanned barcode maps to an item across
tools. Interesting for the barcode/label workstream (`label-customisation`), not urgent.
**Verdict: defer to the label/barcode track.**

---

## Direction D — Agent / LLM surface (extend the MCP lead)

### D1. MCP over HTTP/SSE (remote transport) *(defer — already tracked)*

The MCP server is **stdio-only** by design (local trust boundary). An HTTP/SSE MCP transport
would let a *remote* agent (not co-located with the process) use the tools. Already noted as
deferred in the HA plan; unblock only on a concrete request, and it must reuse the bearer
token + rate limit and stay read-only (writes stayed HTTP-only for blast-radius). **Verdict:
defer — conditional.**

### D2. MCP write tools *(decline for now)*

Keep writes HTTP-only (smaller blast radius, the existing decision). Revisit only with a
concrete agent-write use case. **Verdict: decline for now.**

### D3. Publish generated client SDKs (TS / Python) *(defer — docs task)*

The OpenAPI spec already lets anyone generate a client. Optionally *publish* a thin typed
client so integrators don't have to. Pure docs/packaging; do it once a third party actually
asks. **Verdict: defer.**

---

## Explicitly declined (with reasons)

These are the plausible-sounding options we should *not* pursue, so the "no" is on record:

- **A hosted/cloud API or relay.** Directly breaks the local-first premise. The bridge on the
  user's own hardware is the answer; we never add a cloud middleman.
- **Cloud voice assistants (Alexa / Google Assistant) directly.** Both require a cloud skill
  endpoint and send queries off-device. HA's local Assist (already integrated) is the
  privacy-preserving path; users who want Alexa can bridge through HA themselves.
- **GraphQL endpoint.** REST + OpenAPI already covers programmatic access; GraphQL adds a
  server-side query engine and (realistically) a dependency for marginal benefit over the
  typed REST surface. YAGNI.
- **ActivityPub / Fediverse publishing.** No credible audience for "federated inventory";
  pure novelty.
- **Two-way CalDAV / calendar *write-back*.** The read-only `.ics` feed (below) covers the
  need; accepting calendar writes reopens the whole sync-merge/drift problem the bridge
  deliberately constrains.
- **Inbound email server / SMS.** Server + privacy surface; see B4.

---

## The iCalendar feed (detailed — recommendation #2)

Called out separately because it's high-value and slightly different from the A-direction
event stream.

**What.** `GET /api/v1/calendar.ics` (bearer-token in the URL, the standard for calendar
subscriptions) returning a read-only VCALENDAR of Gubbins' time-bearing facts:

- **Loan due-backs** — items checked out with a due date (the loan/agenda subsystem).
- **Asset bookings** — the asset-booking feature's reservations (already shipped, has its own
  sync path `asset-booking-sync.ts`).
- **Maintenance / service due** and **warranty expiry** — where those dates exist on items.

**How it fits.** A pure projection: query the relevant dated rows through the existing
repositories and emit VEVENTs with a tiny hand-rolled iCalendar emitter (same pattern as the
YAML/RSS emitters — no dependency). Stable `UID`s per source row so subscribers update in
place rather than duplicate.

**Why.** Any calendar app on earth — Google Calendar, Apple Calendar, Outlook, Thunderbird,
and Home Assistant's `calendar` platform — can **subscribe** to a URL and show Gubbins dates
alongside everything else. It's the read-only, standards-based, zero-lock-in way to get
Gubbins' schedule into the tools people already live in. Complements, not duplicates, the
webhook/event stream (a *calendar* of upcoming dates vs. a *log* of past changes).

**Effort/risk.** Low–moderate. iCalendar has fiddly line-folding/escaping but is well
specified and read-only. Token-in-URL is the accepted trade-off for calendar subscriptions
(document it; keep the loopback/opt-in posture).

**Verdict: recommend — second after webhooks.**

---

## Suggested phasing

Each graduates to its own phased plan doc when picked up (like the HA plan). Rough order by
leverage-per-effort:

1. **Event model + outbound webhooks (A1)** + **SSE stream (A3)** — the keystone; everything
   else in Direction A reuses the event model.
2. **iCalendar subscription feed** — high value, self-contained, read-only.
3. **Migration importers (B3)** — biggest adoption lever; reuses the import pipeline.
4. **Web Share Target (B1)** (+ file/protocol handlers B2) — inbound mobile capture.
5. **MQTT publish + HA discovery (A2)** — home-automation reach; decide the dependency
   question at entry.
6. **RSS/Atom/JSON Feed (A4)** + **`/metrics` (C1)** — cheap standards wins, do alongside
   whatever bridge work is already open.
7. Defer: MCP-over-HTTP (D1), JSON-LD (C2), GS1 (C3), published SDKs (D3), file/protocol
   handlers (B2 if not bundled).

## Cross-cutting rules for every item here

- **Off by default, per-capability opt-in.** New outbound/write surfaces get their own
  `GUBBINS_BRIDGE_*` flag and are logged as a deliberate choice at startup — exactly like
  `_ALLOW_WRITES` / `_ALLOW_PUSH` / `_MDNS`.
- **No secret ever advertised or committed.** Webhook/MQTT secrets live in the bridge `.env`
  (git-ignored); mDNS-style advertisements never carry the token; `.env.example` holds
  placeholders only (CLAUDE.md).
- **Read-only unless the write path is the explicit point**, and any write still round-trips
  through the app's own sync merge (§7.3) — never bespoke SQL, never a forked merge.
- **Stdlib-first**, but MQTT (A2) is a legitimate place to re-evaluate the zero-dependency
  invariant; vet licence/maintenance and decide at entry.
- **Any PWA-side UI** (share target, importers) uses Foundry primitives + design tokens, never
  raw colour/spacing/motion literals (CLAUDE.md).
- **Everything synthetic in tests/fixtures/docs** — `example.com` / `localhost` / made-up
  parts, no real data (CLAUDE.md).

## Continuation

No continuation prompt — this is a survey, not a phased build. When an item is picked up,
spin it into its own `docs/todo/<name>_<date>.md` plan (mirroring
[`home-assistant_2026-06-29.md`](done/home-assistant_2026-06-29.md)) and start at Phase 1.
