# Gubbins Bridge

An **optional, local-first companion service** that lets external applications — first of
all a Home Assistant voice assistant — ask **read-only** questions about your Gubbins
inventory ("Where are my M3 screws?").

Gubbins itself is a serverless, in-browser PWA; it cannot host a LAN endpoint. The bridge
closes that gap **without** breaking the local-first promise: it watches the
`gubbins-sync.json` snapshot the PWA already writes to a shared folder (the FS-Access
sync), hydrates it into a headless SQLite database **on your own hardware**, and runs the
app's *own* search code over it. Nothing is sent to any cloud.

This package is **not** part of the PWA or the GitHub-Pages build — it has no React, no
Vite, and ships nothing to the browser bundle. It has **no runtime dependencies** and runs
TypeScript directly (no build step) on Node ≥ 23.6 — but see the
[FTS5 caveat](#requirements) below: the **v23.x line never got FTS5** support, so in practice
you need Node **≥ 24** (or the **22.16+ LTS** line).

> **Status:** Complete and stable. The bridge serves bearer-token-protected, **read-only-by-
> default** surfaces and re-hydrates automatically when the snapshot changes, rate-limited per
> client. What it exposes, at a glance:
>
> - **Read (always on):** the original `GET /health`, `/search`, `/where`; an additive,
>   OpenAPI-described [`/api/v1`](#versioned-rest-api-apiv1) surface (items, locations,
>   categories, capabilities, with field-selection + an OData-style query subset); a
>   [CSV export](#csv-export); an [iCalendar subscription feed](#calendar-subscription); and
>   [syndication feeds + a Prometheus `/metrics`](#feeds--metrics) endpoint. The same read-only
>   core is also offered over a read-only [MCP stdio server](#mcp-server-for-llmagent-tools) for
>   LLM/agent tools.
> - **Opt-in, off by default (each its own `GUBBINS_BRIDGE_*` flag):**
>   [limited stock writes](#limited-writes-opt-in), [snapshot push](#snapshot-push-opt-in),
>   [outbound webhooks + an SSE event stream](#events-webhooks--sse-opt-in),
>   [outbound MQTT publishing + Home Assistant MQTT discovery](#mqtt-publishing-opt-in), and
>   [mDNS/zeroconf advertising](#mdns--zeroconf-discovery). Every one is a deliberate,
>   startup-logged choice — see the [Permission & security matrix](#permission--security-matrix)
>   for the single, authoritative list of what each flag turns on.
>
> The Home Assistant custom integration that consumes the read surface lives in
> [`../homeassistant/`](../homeassistant/README.md). The original HA build plan is
> [`docs/todo/done/home-assistant_2026-06-29.md`](../docs/todo/done/home-assistant_2026-06-29.md); the
> ecosystem build-out (events, calendar, importers, share target, MQTT, feeds/metrics) is
> [`docs/todo/done/ecosystem-integrations-plan_2026-07-03.md`](../docs/todo/done/ecosystem-integrations-plan_2026-07-03.md).

---

## Quick start

You need **Node ≥ 24** (or **22.16+ LTS** — see the [FTS5 caveat](#requirements)) and a
checkout of this repository. From the **repository root**:

```bash
npm install                       # once — the bridge borrows the root toolchain, no deps of its own

cp bridge/.env.example bridge/.env   # then edit bridge/.env (it is git-ignored)
#  - set GUBBINS_BRIDGE_TOKEN to a long random string
#  - point GUBBINS_SNAPSHOT_PATH at your synced gubbins-sync.json

node bridge/serve.mjs             # starts the read-only HTTP server (loopback by default)
```

Generate a token with anything that produces a long random string, e.g.:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Then query it (replace `<token>` with your `GUBBINS_BRIDGE_TOKEN`):

```bash
curl -H "Authorization: Bearer <token>" "http://127.0.0.1:8787/health"
curl -H "Authorization: Bearer <token>" "http://127.0.0.1:8787/where?q=M3%20screws"
curl -H "Authorization: Bearer <token>" "http://127.0.0.1:8787/search?q=ESP32&limit=3"
```

The server **binds `127.0.0.1` (loopback only) by default** — it is not reachable from the
LAN. To wire it into Home Assistant, follow [`../homeassistant/README.md`](../homeassistant/README.md).
To run it as a long-lived service, see [Docker](#run-with-docker) or
[systemd](#run-with-systemd) below.

---

## Data sources: JSON snapshot or raw `.sqlite`

The bridge can hydrate its headless database from **either** of the two paths the PWA already
exports the data through — point `GUBBINS_SNAPSHOT_PATH` at whichever you have, and the bridge
auto-detects which it is (by file extension, with a SQLite magic-byte sniff for an ambiguous
name):

| Source | What it is | When to use it |
| --- | --- | --- |
| **JSON snapshot** (`gubbins-sync.json`) | The versioned-JSON the Phase 7 FS-Access **sync** writes to a shared folder — cross-device by design. | The default and recommended source: it is the sync channel the PWA reads back, so it also supports the opt-in [limited writes](#limited-writes-opt-in) and [snapshot push](#snapshot-push-opt-in). |
| **Raw `.sqlite` export** (`*.sqlite` / `*.db`) | The whole database file, written by the app's raw DB export (Safe-Mode rescue / "export database"). | For a user who exports the raw DB rather than enabling FS-Access sync. **Read-only** — see below. |

> **Browser note.** The "Local folder" sync that writes `gubbins-sync.json` relies on the
> File System Access API, which is **Chromium-only** (Chrome / Edge / Opera). On **Firefox** or
> **Safari** folder sync is unavailable — use the [snapshot push](#snapshot-push-opt-in) flow,
> or point the bridge at a raw `.sqlite` export instead.

Everything downstream — the [query core](#http-api-read-only), the [`/api/v1`](#versioned-rest-api-apiv1)
surface, the [MCP server](#mcp-server-for-llmagent-tools), and the auto-re-hydrating watcher —
is **identical** regardless of source; only this front-end differs. The app's *own* repositories
and the single `parseASTtoSQL` run over the hydrated DB either way, so answers match the app.

How the raw `.sqlite` path works (and why it is safe):

- **A private copy is opened, never your file.** The bridge copies the export to a temp
  directory and opens *that*, so it never locks or mutates your export, and any SQLite
  `-journal`/`-wal` sidecars stay in temp. The copy is deleted when the source is re-hydrated or
  the bridge stops.
- **Migrations run, idempotently.** A raw export may be at any past schema version, so the bridge
  runs the app's migration engine on the copy to bring it up to the current schema (materialising
  FTS5 / triggers / derived tables if the export predates them) — exactly as the PWA does when it
  opens the database. An export from a **newer** build than the bridge understands is refused with
  a clear message (mirroring the JSON path's version guard).
- **The watcher re-hydrates a `.sqlite` source by re-copying** when the file changes, with the
  same atomic swap (build the new driver to completion, swap, then discard the old copy).
- **Writes are refused for a raw `.sqlite` source.** The opt-in [limited writes](#limited-writes-opt-in)
  round-trip a change back through the PWA's sync channel by rewriting `gubbins-sync.json`. A raw
  `.sqlite` export has no such channel (the PWA never reads the exported `.sqlite` back), so a
  write there would silently drift or be lost. With a `.sqlite` source the write endpoints stay
  `404` **even if `GUBBINS_BRIDGE_ALLOW_WRITES=on`** (logged at startup); use a JSON sync snapshot
  to enable writes.
- **Images are irrelevant to the read path.** Full-resolution image bytes are OPFS *files* pointed
  to by `item_images.full_res_opfs_path`; they are in neither the JSON snapshot nor the raw
  `.sqlite` (the DB holds only a tiny thumbnail blob and the path). Nothing in the read path
  dereferences an image, so textual answers are unaffected.

---

## HTTP API (read-only)

All endpoints are **GET-only** and require the bearer token. The contract is stable —
the Home Assistant integration depends on it.

These three unversioned paths are **permanent, stable aliases** of their `/api/v1`
equivalents (see [the versioned API](#versioned-rest-api-apiv1) below) — they return
byte-for-byte identical success bodies, so existing consumers keep working unchanged:

| Endpoint (alias of) | Returns |
| --- | --- |
| `GET /health` (`/api/v1/health`) | `{ ok, itemCount, snapshotGeneratedAt }` — liveness + a cheap snapshot summary. |
| `GET /search?q=<query>&limit=<n>` (`/api/v1/search`) | `{ query, matches: ItemMatch[] }` — compact item DTOs (`id`, `name`, `quantity`, `locationName`, `mpn`, `manufacturer`). `limit` is clamped to `[1, 25]`. |
| `GET /where?q=<query>` (`/api/v1/where`) | `{ query, matches: WhereIsMatch[], spoken }` — per-location breakdown plus one spoken British-English sentence for a voice assistant. |

Status codes: `401` (missing/wrong token), `400` (missing or over-long `q`, max 200 chars),
`404` (unknown path), `405` (non-GET), `429` (rate-limited — see [below](#rate-limiting)),
`503` (no snapshot loaded yet), `500` (generic — never leaks internals). `q` accepts the
app's full search grammar (`field:value`, `cap:key>n`, `AND`/`OR`/parentheses) as well as a
casual phrase like `M3 screws`. The unversioned paths keep a flat `{ "error": "<message>" }`
body; the versioned API uses the structured envelope described next.

---

## Versioned REST API (`/api/v1`)

For **any** application (not just Home Assistant), the bridge exposes a versioned, documented,
read-only REST API under `/api/v1`. It is **purely additive** — it does not change or replace
the three paths above — and is described by a committed [OpenAPI 3 spec](#openapi-spec).
Same auth (bearer token) and same per-IP [rate limit](#rate-limiting) as everything else;
every endpoint is **GET-only** and strictly read-only.

### Conventions

- **List** endpoints return `{ "data": [ … ], "pagination": { limit, offset, count, hasMore } }`.
- **Single-resource** endpoints return the resource object directly.
- **Pagination** is offset/limit: `?limit=` is clamped to `[1, 100]` (default `50`); `?offset=`
  is `≥ 0` (default `0`). `hasMore` is true whenever a *full* page came back (so it may be a
  benign `true` on an exact-boundary last page — fetch the next page to confirm).
- **Errors** use a structured, machine-readable envelope:
  `{ "error": { "code": "not_found", "message": "…" } }`. Codes: `bad_request`,
  `unauthorized`, `not_found`, `method_not_allowed`, `too_many_requests`,
  `snapshot_unavailable`, `internal_error`.
- **Field selection** — the item endpoints accept `fields` (return only the named fields) and
  `include` (add extended fields on top of the default payload). See
  [Field selection & extended fields](#field-selection--extended-fields) below.
- **OData-style options** — the item endpoints also accept a convenience subset of the OData
  query options (`$select`, `$expand`, `$top`, `$skip`, `$orderby`, `$filter`, `$count`,
  `$search`), plus a CSDL `$metadata` document and an `/items/$count` path. See
  [OData-style query options](#odata-style-query-options) below.
- All ids are the app's stable record ids; timestamps are UNIX-ms integers (as stored).

### Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1` | A small discovery index (version + endpoint list). |
| `GET /api/v1/openapi.json` | This API's OpenAPI 3 document. |
| `GET /api/v1/$metadata` | OData v4 CSDL describing the read model (descriptive; see [OData-style options](#odata-style-query-options)). |
| `GET /api/v1/items/$count` | The count of matching items as a bare `text/plain` integer (honours `$filter`/`$search`). |
| `GET /api/v1/items.csv` | A spreadsheet-friendly CSV of the matching items (refreshable pull for Excel/Power BI). See [CSV export](#csv-export). |
| `GET /api/v1/calendar.ics` | A read-only iCalendar feed of Gubbins' time-bearing facts (loan due-backs, bookings, maintenance, warranty) that any calendar app can **subscribe** to. See [Calendar subscription](#calendar-subscription). |
| `GET /api/v1/activity.rss` (`.atom`, `.json`) | A read-only syndication feed of the recent activity log (RSS 2.0 / Atom 1.0 / JSON Feed 1.1) any feed reader can **subscribe** to. See [Feeds & metrics](#feeds--metrics). |
| `GET /metrics` | A Prometheus/OpenMetrics text exposition of the aggregate inventory counts (root path, not under `/api/v1`). See [Feeds & metrics](#feeds--metrics). |
| `GET /api/v1/health` | `{ ok, itemCount, snapshotGeneratedAt }` (alias of `/health`). |
| `GET /api/v1/search?q=&limit=&fields=&include=` | Relevance search, top-N (limit `[1, 25]`, default 5) — not paginated. Alias of `/search`. Supports [field selection](#field-selection--extended-fields). |
| `GET /api/v1/where?q=` | "Where is X?" with per-location breakdown + spoken sentence. Alias of `/where`. |
| `GET /api/v1/items?limit=&offset=&location=&category=&includeInactive=&fields=&include=&$orderby=&$filter=` | Paginated item summaries (`ItemSummary`). Supports [field selection](#field-selection--extended-fields) and [OData-style options](#odata-style-query-options) (`$orderby`, `$filter`, …). |
| `GET /api/v1/items/{id}?fields=&include=` | One item with `placements` and `capabilities` (`ItemDetail`); `404` if unknown. Supports [field selection](#field-selection--extended-fields). |
| `GET /api/v1/locations?limit=&offset=` | Paginated locations with live item counts (`Location`). |
| `GET /api/v1/locations/{id}` | One location; `404` if unknown. |
| `GET /api/v1/categories?limit=&offset=` | Paginated categories with field counts (`CategorySummary`). |
| `GET /api/v1/categories/{id}` | One category with its custom-field schema (`CategoryDetail`); `404` if unknown. |
| `GET /api/v1/capabilities?limit=&offset=` | The distinct, queryable capability vocabulary (`CapabilityKey`) — the keys you can filter on with `cap:<key>`. |
| `GET /api/v1/events` | **Opt-in** read-only SSE stream of change events (`GUBBINS_BRIDGE_EVENTS=on`); `404` when off. See [Events, webhooks & SSE](#events-webhooks--sse-opt-in). |

Search is the **relevance** endpoint (top-N, capped at 25 for voice safety); to **browse all
items** with pagination use `GET /api/v1/items`. Every read flows through the app's own
repositories and the single parameterised `parseASTtoSQL` — no bespoke SQL, no write path.

### Examples

```bash
TOKEN=<your GUBBINS_BRIDGE_TOKEN>
BASE=http://127.0.0.1:8787/api/v1

curl -H "Authorization: Bearer $TOKEN" "$BASE"                       # discovery index
curl -H "Authorization: Bearer $TOKEN" "$BASE/items?limit=2"         # first page of items
curl -H "Authorization: Bearer $TOKEN" "$BASE/items/item-esp32"      # one item + detail
curl -H "Authorization: Bearer $TOKEN" "$BASE/locations"             # browse locations
curl -H "Authorization: Bearer $TOKEN" "$BASE/categories/cat-electronics"
curl -H "Authorization: Bearer $TOKEN" "$BASE/capabilities"          # the cap: vocabulary
curl -H "Authorization: Bearer $TOKEN" "$BASE/openapi.json"          # the spec
```

(Ids such as `item-esp32` / `cat-electronics` above are from the synthetic test fixture.)

### Field selection & extended fields

The item endpoints (`/search`, `/items`, `/items/{id}`) let a caller **shape the response** with
two optional, composable query parameters — so an integration fetches *exactly* the data it needs
and nothing more. Both are also available on the MCP `gubbins_search` and `gubbins_get_item`
[tools](#tools).

| Parameter | Meaning | Example |
| --- | --- | --- |
| `fields` | **Sparse fieldset (projection).** A comma-separated list; the response contains **only** these fields. Naming an extended field opts it in — so you can ask for just the price. One level of nesting is supported for the array fields via a dotted path. | `?fields=name,unitCost` → `{ name, unitCost }` |
| `include` | **Field expansion.** A comma-separated list of extended fields (or named groups) **added on top** of the default payload. | `?include=capabilities,notes` |

- **"Just the price of M3 screws"** — `GET /api/v1/search?q=M3%20screw&fields=name,unitCost`
  returns each match as `{ "name": …, "unitCost": … }` and nothing else.
- **"More information, if available"** — `GET /api/v1/items/item-esp32?include=all` returns the
  full detail payload plus every extended field the app stores (owner's notes, lifecycle, reorder
  policy, operational metadata, the gauge, …).
- **Nested projection** — `GET /api/v1/items/item-esp32?fields=name,placements.quantity` returns
  `{ "name": …, "placements": [ { "quantity": … }, … ] }`.

**Default field set** (returned when neither parameter is given — unchanged from before):

| Endpoint | Default fields |
| --- | --- |
| `/search` | `id, name, quantity, locationName, mpn, manufacturer` |
| `/items` | the above + `isUnlimited, locationId, categoryId, trackingMode, isActive` (`ItemSummary`) |
| `/items/{id}` | the `ItemSummary` fields + `description, categoryName, unitCost, condition, serialNumber, serialNo, parentId, expiryDate, batchNumber, lotNumber, createdAt, updatedAt, placements, capabilities` (`ItemDetail`) |

> **Unlimited supply.** An item marked _unlimited_ (an effectively infinite source — tap water,
> mains air) reports `isUnlimited: true` and its `quantity` as **`null`** (JSON has no `Infinity`);
> in the CSV export its quantity cell is left blank.

**Full field vocabulary** (nameable in `fields`, or in `include` when extended): `id`, `name`,
`quantity`, `isUnlimited`, `locationId`, `locationName`, `categoryId`, `categoryName`, `mpn`, `manufacturer`,
`trackingMode`, `isActive`, `description`, `notes`, `condition`, `serialNumber`, `serialNo`, `parentId`,
`unitCost`, `purchasePrice`, `expiryDate`, `batchNumber`, `lotNumber`, `acquiredAt`,
`warrantyExpiresAt`, `depreciationMonths`, `reorderPoint`, `reorderGaugePercent`, `reorderQty`,
`operationalMetadata`, `gauge`, `createdAt`, `updatedAt`, `placements` (nestable:
`locationId, locationName, quantity`), `capabilities` (nestable: `key, valueNum, valueText, weight`).

**Include groups** (aliases usable in `include`): `relations` (placements + capabilities +
categoryName), `pricing` (unitCost + purchasePrice), `lifecycle` (acquiredAt + warrantyExpiresAt +
purchasePrice + depreciationMonths), `reorder` (the three reorder fields), `timestamps`
(createdAt + updatedAt), and `all` (every extended field).

An unknown field or include name is a `400 bad_request` whose message lists the valid vocabulary;
an over-long selection is likewise rejected. Relational fields are resolved **lazily** — a
projection that doesn't select `placements`/`capabilities`/`categoryName` never incurs their extra
read. The unversioned `/search` and `/where` aliases are deliberately **frozen** (no field
selection) so their long-standing contract never changes; use the `/api/v1` twins for shaping.

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/search?q=M3%20screw&fields=name,unitCost"
curl -H "Authorization: Bearer $TOKEN" "$BASE/items/item-esp32?include=all"
curl -H "Authorization: Bearer $TOKEN" "$BASE/items?fields=id,name,quantity"
```

### OData-style query options

For callers already fluent in **OData**, the item endpoints accept a small, familiar subset of
the OData v4 query options. This is a **convenience alias layer, not a compliant OData service** —
there is deliberately **no** `$metadata`/CSDL document, `$batch`, `$apply`, or navigation-property
semantics (see [the earlier discussion](#versioned-rest-api-apiv1) of why full OData isn't a fit
for a zero-dependency bridge). It adds **no dependency** and ships **nothing** to the PWA.

| Option | Maps to | Notes |
| --- | --- | --- |
| `$select` | `fields` | Sparse fieldset (projection). |
| `$expand` | `include` | Field expansion. |
| `$top` | `limit` | Page size / result cap. |
| `$skip` | `offset` | Row offset (list endpoints). |
| `$orderby` | *(new)* | Sort — see below. |
| `$filter` | *(new)* | Constrained boolean filter — see below. |
| `$count` | *(new)* | `$count=true` adds the grand total as `pagination.total`. |
| `$search` | *(new)* | Free-text (FTS) match across name/description/notes/mpn/manufacturer/serial number. |

Each `$`-prefixed option is an **alias** of its plain REST name and **wins** when both are given
(`?$top=5&limit=9` ⇒ 5). `$select`/`$expand`/`$top` work on `/search`, `/items` and `/items/{id}`;
`$skip`, `$orderby`, `$filter`, `$count` and `$search` apply to the `/items` list.

There are also two dedicated paths:

- **`GET /api/v1/$metadata`** — an OData v4 **CSDL** document describing the read model (the
  `items`/`locations`/`categories` entity sets and their complex types), for OData-aware tooling.
  It is **descriptive**: the service implements only this query subset, not the whole OData
  protocol (no service document, no `$batch`/`$apply`, no navigation-property expansion beyond the
  bundled `placements`/`capabilities`).
- **`GET /api/v1/items/$count`** — the OData inline-count path: the total number of matching items
  as a bare `text/plain` integer (honouring `$filter`/`$search`/`location`/`category`).

**`$orderby`** — a comma-separated list of `<field> [asc|desc]` terms (direction defaults to
`asc`). Sortable fields: `name`, `quantity`, `unitCost`, `mpn`, `manufacturer`, `createdAt`,
`updatedAt`, `serialNo`. NULLs sort last regardless of direction, and ties break on `id` so
pagination is stable. An unknown field is a `400`.

**`$filter`** — a **constrained** boolean filter that is compiled to the app's own search AST and
run through the single parameterised `parseASTtoSQL` (so it can never drift from the app's search
semantics and has no injection surface — it is **never** bespoke SQL). Supported subset:

- comparisons: `eq`, `gt`, `lt` (e.g. `quantity gt 10`, `name eq 'M3 Bolt'`)
- the `contains(field, 'text')` function (free-text, FTS-backed)
- boolean composition with `and`, `or`, and parentheses
- literals: single-quoted strings (`''` escapes a quote), numbers, `true`/`false`
- filterable fields: `name`, `description`, `notes`, `mpn`, `manufacturer`, `serialNumber`, `quantity`,
  `category`(`Id`), `location`(`Id`)

Anything outside the subset (`ne`/`ge`/`le`, `not`, `startswith`/`endswith`, arithmetic, lambdas,
an unknown field) is a `400` naming what *is* supported. When `$filter` is present it is the sole
row filter, so the `location`/`category`/`$search` query params are ignored.

**`$count`** — `$count=true` computes the grand total of matching rows across *all* pages and
returns it as `pagination.total` alongside the page (it costs one extra `COUNT` query, so it is
opt-in). For just the number, hit the dedicated `/items/$count` path instead.

**`$search`** — a free-text match over the FTS5-indexed item columns (name, description, notes,
mpn, manufacturer, serial number), the same backend the app's own search uses. It combines with `location` /
`category`; it is ignored when `$filter` is set (which is then the sole filter).

```bash
# Sort by quantity, biggest first, top 5:
curl -H "Authorization: Bearer $TOKEN" "$BASE/items?\$orderby=quantity desc&\$top=5"

# Everything with more than ten in stock whose name contains "bolt", names only, with the total:
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/items?\$filter=quantity gt 10 and contains(name,'bolt')&\$select=name&\$count=true"

# Just the number of ESP32-ish items, and the metadata document:
curl -H "Authorization: Bearer $TOKEN" "$BASE/items/\$count?\$search=esp32"
curl -H "Authorization: Bearer $TOKEN" "$BASE/\$metadata"
```

(Escape the literal `$` for your shell, as above, or single-quote the whole URL.)

### CSV export

`GET /api/v1/items.csv` returns a spreadsheet-friendly **CSV** of the matching items — the same
column shape and RFC-4180 quoting as the app's own catalogue export (`id, name, description,
notes, trackingMode, quantity, isUnlimited, mpn, manufacturer, unitCost`; an unlimited-supply
row's quantity cell is blank), reused verbatim so the two never
drift. Unlike the JSON list it returns **all** matching rows (up to a hard cap of 100,000), not a
single page, and it honours the same `$filter`/`$search`/`$orderby`/`location`/`category`/
`includeInactive` scope.

> The Gubbins **app** already exports far richer CSVs (a round-trippable catalogue with custom-field
> columns, plus ten analytics reports) from its **Export Wizard** — use that for a one-off download.
> This endpoint exists for the one thing the app can't do: a **refreshable** pull over HTTP.

Point Excel/Power BI **From Web** (not the OData connector — see the note above) at the URL for a
refreshable table; `Web.Contents` lets you attach the bearer token as a header:

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/items.csv?\$filter=quantity gt 0&\$orderby=name" -o items.csv
```

### Calendar subscription

`GET /api/v1/calendar.ics` is a read-only **iCalendar** (RFC 5545) feed of Gubbins' time-bearing
facts. Point any calendar app — Google Calendar, Apple Calendar, Outlook, Thunderbird, Home
Assistant — at the URL as a **subscribed** calendar and its events appear alongside your own,
refreshing whenever the client refetches.

Four sources become calendar events (each a read-only projection through the app's own
repositories — no bespoke SQL):

| Source | Event | Where it comes from |
| --- | --- | --- |
| **Loan due-backs** | `Loan due: <item>` on the due date | open checkouts that carry a due date |
| **Asset bookings** | `Booking: <item>` spanning the booked days | upcoming (not-yet-passed) asset bookings |
| **Maintenance** | `Maintenance due: <schedule> — <item>` on the due date | time-based service schedules (usage-based ones have no calendar date, so they are omitted) |
| **Warranty** | `Warranty expires: <item>` on the expiry date | items with a warranty-expiry date |

Most events are **all-day**. Each carries a **stable, per-source `UID`** (`loan-…`, `booking-…`,
`maintenance-…`, `warranty-…`), so a subscriber updates an event in place on refetch rather than
duplicating it. A source with no data simply contributes nothing — an empty inventory yields a
valid, event-free calendar.

**Subscribing (the token-in-URL trade-off).** A calendar client subscribing by URL **cannot send
an `Authorization` header**, so — for this path *only* — the bearer token may be supplied as a
`token` query parameter:

```
http://127.0.0.1:8787/api/v1/calendar.ics?token=<YOUR_GUBBINS_BRIDGE_TOKEN>
```

A token in a URL is a weaker posture than a header (URLs get logged by proxies and saved in
history), so this is deliberately scoped to the calendar path — every other endpoint still
requires the header. Keep the bridge's default **loopback** bind (or a trusted LAN) in mind, and
treat the subscribe URL as a secret. The `Authorization: Bearer` header still works too (e.g.
`curl`), and a dedicated read-only calendar token is a possible future refinement.

**Per-type feeds.** Add `?type=` to subscribe to just one (or a comma-separated subset) of the
sources — handy for a separate "maintenance" calendar:

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/calendar.ics"                    # everything
curl -H "Authorization: Bearer $TOKEN" "$BASE/calendar.ics?type=warranty"      # warranties only
curl -H "Authorization: Bearer $TOKEN" "$BASE/calendar.ics?type=loans,bookings"
```

An unknown `type` is a `400`. Each source is bounded (up to 5,000 events) so a very large vault
can't produce an unbounded feed. Dates from a stored calendar date (a warranty) are used verbatim;
dates derived from a timestamp (bookings, due-backs) use UTC calendar components, so a far-eastern
local day may appear shifted by one day — a documented limitation of a timezone-less feed.

**Home Assistant.** Add the **Remote Calendar** integration (Settings → Devices & Services → Add
Integration → *Remote Calendar*) and paste the subscribe URL above (including `?token=…`) as the
calendar URL. HA then exposes a `calendar.gubbins` entity you can use in automations and on
dashboards.

### Feeds & metrics

Two cheap, standards-based **read** surfaces for the same self-hosted audience: a human "what
changed" feed for any reader, and machine metrics for a Prometheus/Grafana home-lab. Both are
**read-only pulls** (like `calendar.ics` / `items.csv`), so — like those — they carry **no
`GUBBINS_BRIDGE_*` flag**; they are always available and gated only by the bearer token.

**Syndication feeds.** `GET /api/v1/activity.rss` (plus `.atom` and `.json`) render the recent
cross-item **activity log** — the same `item_history` projection the app's Activity screen shows —
newest first, in RSS 2.0, Atom 1.0, or [JSON Feed 1.1](https://jsonfeed.org). Each entry carries a
stable, host-free URN id (`urn:gubbins:activity:<ledger-id>`) so a reader updates it in place rather
than duplicating on refetch, and the same stable dotted `type` the [event stream](#events-webhooks--sse-opt-in)
uses for that row. Like the calendar, a feed reader can't send an `Authorization` header, so these
paths **also** accept the token as a `?token=` query parameter (the same deliberately weaker
token-in-URL posture, scoped to the feed/calendar paths only).

```bash
BASE=http://127.0.0.1:8787/api/v1

curl -H "Authorization: Bearer $TOKEN" "$BASE/activity.rss"           # RSS 2.0
curl -H "Authorization: Bearer $TOKEN" "$BASE/activity.atom"          # Atom 1.0
curl -H "Authorization: Bearer $TOKEN" "$BASE/activity.json"          # JSON Feed 1.1
curl "$BASE/activity.rss?token=$TOKEN&limit=20"                       # subscribe-by-URL form
```

The feed is a **recent-activity window** (newest `?limit=` entries, clamped to `[1, 50]`, default
50) — for a full history use the REST API. Point any feed reader (or Home Assistant's *Feedreader*
integration) at the subscribe-by-URL form.

**Prometheus `/metrics`.** `GET /metrics` (at the **root**, the scrape convention — not under
`/api/v1`) returns a `text/plain; version=0.0.4` exposition a Prometheus scrape accepts directly:

| Metric | Type | Meaning |
| --- | --- | --- |
| `gubbins_items_total` | gauge | Total active items. |
| `gubbins_low_stock_items` | gauge | Active items at/below their low-stock threshold. |
| `gubbins_out_of_stock_items` | gauge | Active items fully depleted (a subset of low-stock). |
| `gubbins_locations_total` | gauge | User-defined locations (system buckets excluded). |
| `gubbins_location_items{location_id,location}` | gauge | Item count per location. |
| `gubbins_location_capacity{location_id,location}` | gauge | Configured capacity (only when set). |
| `gubbins_location_fullness_ratio{location_id,location}` | gauge | `items / capacity` (only when a capacity is set). |

The low/out-of-stock counts reuse the **same seams** as the event stream and MQTT publishing, so a
scraped count can never drift from an `item.low_stock` event or the `gubbins/summary` MQTT topic.
Every read flows through the app's own repositories — no bespoke SQL. Unlike the feeds, `/metrics`
is **header-only** (no `?token=`): a Prometheus scrape config sends the token via an `Authorization`
header or a `bearer_token_file`. On a trusted loopback you can also run the scrape job beside the
bridge and share the token through its own config.

```yaml
# prometheus.yml — scrape the bridge on loopback
scrape_configs:
  - job_name: gubbins
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: "<your GUBBINS_BRIDGE_TOKEN>"   # or credentials_file: /etc/prometheus/gubbins.token
    static_configs:
      - targets: ["127.0.0.1:8787"]
```

### OpenAPI spec

The full v1 surface is described by **[`openapi.yaml`](openapi.yaml)** (committed,
synthetic examples only). It is generated from a single typed source of truth
(`src/openapi.ts`) — a test asserts the committed YAML never drifts from it — and the
identical document is served live at `GET /api/v1/openapi.json`. Point Swagger UI, Redoc,
or a client-generator at either.

---

## MCP server (for LLM/agent tools)

For an **LLM/agent** (e.g. Claude) to query your inventory as a *tool*, the bridge ships a
read-only **Model Context Protocol** server over **stdio** — separate from, and additive to,
the HTTP API. It wraps the *same* read-only core (the query core, the shared item-detail
loader, and the app's repositories), so an agent gets exactly the answers the HTTP API and the
PWA give. There is **no write path**: an agent can only read.

Run it directly (it speaks JSON-RPC on stdin/stdout, so a human won't interact with it — an
MCP client launches it):

```bash
GUBBINS_SNAPSHOT_PATH=/path/to/your/synced/gubbins-sync.json node bridge/mcp.mjs
```

It reuses the same atomic snapshot watcher, so it answers from fresh data as the snapshot
changes. **Transport posture:** stdio is the launched process's own pipe — its trust boundary
is the OS process, so there is **no network bearer token** (only `GUBBINS_SNAPSHOT_PATH` is
required). All diagnostic logging goes to **stderr**; stdout carries only the protocol.

### Wiring it into an MCP client

Most MCP clients take a launch command plus an `env` block. Point the command at `mcp.mjs`
and supply the snapshot path (the client stores it; nothing is committed). This is the shape
**Claude Desktop** uses in its `claude_desktop_config.json`; other clients accept an
equivalent object:

```json
{
  "mcpServers": {
    "gubbins": {
      "command": "node",
      "args": ["/path/to/gubbins/bridge/mcp.mjs"],
      "env": { "GUBBINS_SNAPSHOT_PATH": "/path/to/your/synced/gubbins-sync.json" }
    }
  }
}
```

Use absolute paths — the client launches `node` with no particular working directory. On
Windows the two paths look like `C:\\Users\\<you>\\Gubbins\\bridge\\mcp.mjs` and
`C:\\Users\\<you>\\Gubbins\\gubbins-sync.json` (JSON needs the backslashes doubled; forward
slashes also work).

> Needs **Node ≥ 24** (or **22.16+ LTS**) on `PATH` — for built-in TypeScript type-stripping
> plus `node:sqlite` **with FTS5** (the v23.x line never got FTS5; see the
> [Requirements](#requirements) caveat below). An older Node can fall back to
> `--experimental-strip-types`, but you still need FTS5 support for a working database.

### Wiring it into Claude Code

Claude Code registers MCP servers from the command line rather than a hand-edited JSON file.
Add the bridge with `claude mcp add`, passing the snapshot path as an `-e` env entry and the
launch command after `--`:

```bash
claude mcp add gubbins -s local \
  -e GUBBINS_SNAPSHOT_PATH="/path/to/your/synced/gubbins-sync.json" \
  -- node "/path/to/gubbins/bridge/mcp.mjs"
```

On Windows the same command uses Windows paths (no backslash-doubling needed here — this is a
shell argument, not JSON):

```powershell
claude mcp add gubbins -s local `
  -e GUBBINS_SNAPSHOT_PATH="C:\Users\<you>\Gubbins\gubbins-sync.json" `
  -- node "C:\Users\<you>\Gubbins\bridge\mcp.mjs"
```

What the flags do:

- **`-s local`** keeps the entry in your **per-project** user config (`~/.claude.json`), which
  is outside this repository — so the machine-specific absolute paths never get committed to a
  public repo. (`-s project` would write a shared `.mcp.json` in the tree; don't use it here —
  an absolute path from one machine must not be committed.)
- **`-e KEY="value"`** sets an environment variable for the launched server — this is how the
  bridge receives `GUBBINS_SNAPSHOT_PATH`.
- **Everything after `--`** is the launch command and its arguments, run verbatim: `node`
  followed by the absolute path to `mcp.mjs`.

MCP servers are launched when the client starts, so after adding it **restart (or reload) the
Claude Code session**; the six `gubbins_*` tools then appear. `claude mcp list` shows each
configured server with a health status — you want `gubbins` to report `Connected`.

### Verify it works

Because the server just speaks JSON-RPC on stdin/stdout, you can smoke-test it with no MCP
client at all — pipe a couple of requests in and read the responses. Send `initialize`, then
`tools/list` (and, if you like, a `tools/call` of `gubbins_search`):

```bash
export GUBBINS_SNAPSHOT_PATH=/path/to/your/synced/gubbins-sync.json
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"gubbins_search","arguments":{"q":"cable"}}}' \
  | node bridge/mcp.mjs
```

On Windows/PowerShell set the env var first, then pipe the same requests in:

```powershell
$env:GUBBINS_SNAPSHOT_PATH = "C:\Users\<you>\Gubbins\gubbins-sync.json"
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
'{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node bridge/mcp.mjs
```

You should see JSON-RPC responses on stdout: the `initialize` reply advertises a `serverInfo`
of **`gubbins-bridge-mcp`**, and `tools/list` returns the **six `gubbins_*` tools** below. On
stderr you'll see `Gubbins MCP server ready on stdio (read-only).`. A missing snapshot file is
**non-fatal** — the server still starts and the tools return an "Inventory snapshot is not
loaded yet" message until the file appears, so you can wire everything up before the first
sync has written `gubbins-sync.json`.

### Tools

All tools are **read-only** and return both human-readable `text` content and a machine-usable
`structuredContent`:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `gubbins_search` | `q` (required), `limit?`, `fields?`, `include?` | Relevance-ranked compact matches (top-N, max 25). Accepts a casual phrase or the power-user grammar (`cap:key>n`, `AND`/`OR`, …). `fields`/`include` [shape the result](#field-selection--extended-fields). |
| `gubbins_where_is` | `q` (required), `limit?` | The top matches with their per-location breakdown plus one spoken British-English sentence. |
| `gubbins_get_item` | `id` (required), `fields?`, `include?` | One item with `placements` and `capabilities`; `{ found: false }` if unknown. `fields`/`include` [shape the result](#field-selection--extended-fields). |
| `gubbins_list_locations` | `limit?`, `offset?` | Paginated locations with live item counts. |
| `gubbins_list_categories` | `limit?`, `offset?` | Paginated categories with field counts. |
| `gubbins_list_capabilities` | `limit?`, `offset?` | The distinct `cap:` vocabulary you can filter on. |

The list tools clamp `limit` to `[1, 100]` (default 50); `gubbins_search`/`gubbins_where_is`
cap results at 25 (default 5) for safety. Tool ids/keys (e.g. `item-esp32`, `voltage`) in
examples are from the synthetic test fixture.

---

## Limited writes (opt-in)

By default the bridge is **strictly read-only** — everything above only ever reads. It can
optionally expose a **small, fixed set of stock mutations** (check-in / check-out, quantity
adjust) so an automation or voice command can *change* stock, not just query it. This is **off
by default** and must be deliberately enabled.

> **Why it's safe under sync.** The bridge does **not** own the database — the PWA does, and the
> two reconcile through the synced `gubbins-sync.json` using the app's §7.3 Last-Write-Wins /
> Delta-CRDT merge. A naive `UPDATE` on the bridge's copy would be silently overwritten on the
> next sync (or cause drift). So a write here is **not** a bespoke SQL statement. Instead the
> bridge acts as **just another sync device**: it reads the latest snapshot, applies the change
> through the app's **own** mutation code (firing the same triggers and writing the same activity
> ledger), and writes the merged snapshot back **atomically**. The PWA then picks it up on its
> next sync through the **identical** merge path it uses for any peer — a bumped timestamp wins
> LWW, a gauge change replays through the Delta-CRDT — so there is **no drift and no forked merge
> logic**.

### Enabling it

Set **`GUBBINS_BRIDGE_ALLOW_WRITES=on`**. When off, the write paths return `404` (the feature is
invisible). When on, writes use the **same bearer token and rate limit** as reads, and the server
logs a clear "Writes ENABLED" line at startup. Keeping the bridge on the `127.0.0.1` default is
the safest posture; enabling writes **and** binding `0.0.0.0` is a deliberate double opt-in.

Writes require a **JSON snapshot** source — they are **refused for a raw `.sqlite` source** (which
has no sync channel to round-trip through), so the write paths stay `404` there even with this set.
See [Data sources](#data-sources-json-snapshot-or-raw-sqlite).

### Endpoints

Both are **POST**, under `/api/v1`, GET-everything-else unchanged. The body is a tiny JSON
object `{ "delta": <number>, "note"?: "<string>" }`; the response is the updated item (the same
`ItemDetail` shape as `GET /api/v1/items/{id}`).

| Endpoint | Body | Effect |
| --- | --- | --- |
| `POST /api/v1/items/{id}/adjust-quantity` | `{ delta, note? }` | Adjust a **DISCRETE** item's home-location stock by a signed whole number (negative = check out). |
| `POST /api/v1/items/{id}/adjust-gauge` | `{ delta, note? }` | Adjust a **CONSUMABLE_GAUGE** item's net value by a signed amount (clamped to `[0, capacity]`). |

Status codes: `200` (updated item), `400` (malformed body / non-numeric `delta`), `401`
(missing/wrong token), `404` (writes disabled, or no such item), `422` (`unprocessable` — the
change was rejected, e.g. quantity below zero or the wrong tracking mode), `429` (rate-limited),
`503` (snapshot briefly unavailable). The `/api/v1` index reports `"writable": true|false`.

### Example

```bash
TOKEN=<your GUBBINS_BRIDGE_TOKEN>
BASE=http://127.0.0.1:8787/api/v1

# Check out two of an item (synthetic fixture id):
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"delta":-2,"note":"Taken to the workshop"}' \
  "$BASE/items/item-m3-bolt/adjust-quantity"
```

The change lands in the synced `gubbins-sync.json`; the PWA applies it on its next sync. The MCP
server stays **read-only** — writes are HTTP-only, by design.

## Snapshot push (opt-in)

The bridge normally **reads** `gubbins-sync.json` from a shared folder (the FS-Access sync). For a
user who does **not** use folder sync — no NAS, no synced drive — the PWA can instead **push** its
whole dataset straight to the bridge over HTTP, so no shared folder is needed at all. This is
**off by default** and **independent** of the [limited writes](#limited-writes-opt-in) above
(push *replaces* the whole snapshot; a write applies a surgical per-item change — orthogonal
opt-ins).

> **Why it's safe.** The pushed body is the **same** versioned backup JSON the PWA already writes
> to a synced folder (`snapshotToBackupJson(buildLocalSnapshot(...))`). The bridge validates it
> with the **same** format-version guard the watcher uses, then writes it to
> `GUBBINS_SNAPSHOT_PATH` **atomically** (temp file + rename). The unchanged watcher re-hydrates it
> through its normal path, so what the bridge serves is byte-identical to what it would have read
> from a synced file. Ingest runs **no SQL** — it only validates JSON and renames a file.

### Enabling it

Set **`GUBBINS_BRIDGE_ALLOW_PUSH=on`**. When off, `POST /api/v1/snapshot` returns `404` (the
feature is invisible). When on, push uses the **same bearer token and rate limit** as reads, and
the server logs a clear "Snapshot push ENABLED" line at startup. Like writes, push requires a
**JSON snapshot** source — it is **refused for a raw `.sqlite` source** (which is not the PWA sync
channel), so the path stays `404` there even with this set.

The body is capped at **`GUBBINS_BRIDGE_MAX_PUSH_BYTES`** (default **64 MiB**); it is streamed to a
temp file as it arrives, so an over-large upload is rejected (`413`) before it is all on disk. Lower
the cap on a constrained host (a Pi/NAS on an SD card).

### Endpoint

| Endpoint | Body | Effect |
| --- | --- | --- |
| `POST /api/v1/snapshot` | The versioned backup JSON (the bytes `snapshotToBackupJson` produces). | Validates and **atomically replaces** the served snapshot; the watcher re-hydrates it. Returns `{ ok, formatVersion, generatedAt }`. |

Status codes: `200` (accepted), `400` (malformed/non-JSON body), `401` (missing/wrong token),
`404` (push disabled, or a `.sqlite` source), `413` (`payload_too_large` — body over the cap),
`422` (`unprocessable` — a snapshot from a newer Gubbins build), `429` (rate-limited). The
`/api/v1` index reports `"pushable": true|false`.

### From the PWA

Open **Cloud Sync & backups** in the app, fill in the bridge **URL** and **token** under "Push to
bridge", and press **Push now**. The URL/token are stored on that device only (never synced, never
committed). The MCP server stays **read-only** — push is HTTP-only, by design.

## Events, webhooks & SSE (opt-in)

The bridge already re-hydrates the snapshot on every change; this turns that into an **event
source**. One transport-agnostic event model feeds two sinks — **outbound webhooks** (push) and a
**read-only SSE stream** (pull) — so one mechanism covers Slack/Discord/n8n/Node-RED/Home Assistant
without integrating any of them by name. Both are **off by default** and strictly **read-only**
w.r.t. inventory (an event never mutates data).

> **Where events come from.** New rows in the synced, immutable `item_history` ledger — the same
> table the app's activity feed projects — *are* the events, already typed by the §4 activity
> actions. The bridge reuses the app's own `activityKindForAction` / `describeHistoryEntry` shapers
> (never a fork) and never runs bespoke SQL. The **first** generation after a (re)start establishes
> a baseline and emits **nothing** — it never replays history as a burst.

### The event shape

Every event is `{ id, type, occurredAt, data }`:

- **`id`** — deterministic (ledger-row-derived) so a consumer can dedupe.
- **`type`** — a stable dotted name: `item.created`, `item.renamed`, `stock.adjusted`,
  `item.low_stock`, `item.out_of_stock`, `item.moved`, `item.checked_out`, `item.checked_in`,
  `item.reserved`, `item.reservation_cleared`, `item.removed`, `item.restored`,
  `item.condition_changed`, `item.maintenance_logged`, `item.supplier_data_applied`,
  `item.changed` (forward-compat fallback), and `events.truncated` (a burst exceeded the fan-out
  cap). A stock movement that leaves an item at/below its low-stock floor additionally raises an
  `item.low_stock` (or `item.out_of_stock` when empty) event.
- **`occurredAt`** — the ledger row's timestamp, ISO-8601.
- **`data`** — the change plus the item's current summary (the same `ItemSummary` shape the REST
  API uses).

A bulk import is coalesced per generation and **capped** (a `events.truncated` summary is appended
if the cap is exceeded), so a downstream sink can't be flooded.

### Outbound webhooks

Set **`GUBBINS_BRIDGE_WEBHOOKS=on`** and list your targets in a **git-ignored** file (copy
[`webhooks.example.json`](webhooks.example.json) → `webhooks.json`) or inline via
`GUBBINS_BRIDGE_WEBHOOKS_TARGETS`. Each target is `{ "url", "secret", "events"? }` — omit `events`
(or use `"*"`) to receive everything. **The signing secrets live only in that git-ignored file /
`.env`, never in a committed file.**

Each event is POSTed as JSON with:

| Header | Value |
| --- | --- |
| `X-Gubbins-Signature` | `sha256=<hex>` — HMAC-SHA256 of the **raw body** under the target's `secret` (the GitHub/Stripe pattern). |
| `X-Gubbins-Delivery` | A unique delivery id (make your handler idempotent and dedupe on it). |
| `X-Gubbins-Event` | The event `type`. |

Delivery is **at-least-once** with bounded exponential backoff; each target has its **own FIFO
queue and failure circuit**, so one dead URL can neither stall the others nor retry forever.

**Verify a signature** (Node):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
// `rawBody` must be the exact bytes received (do not re-serialise the parsed JSON).
const expected = 'sha256=' + createHmac('sha256', SECRET).update(rawBody).digest('hex');
const got = req.headers['x-gubbins-signature'];
const ok = got && got.length === expected.length &&
  timingSafeEqual(Buffer.from(got), Buffer.from(expected));
```

A minimal **n8n / Node-RED / Discord** recipe: point a "Webhook" / "HTTP In" node (or a Discord
channel's incoming-webhook relay) at the URL, verify the signature above, then branch on
`type` — e.g. post to a channel when `type === 'item.low_stock'`.

### SSE event stream

`GET /api/v1/events` holds the connection open and writes each event as a `data: <json>\n\n` frame
(with an `id:` line for resumption and periodic `: heartbeat` comments), using the **same bearer
token + rate limit** as every endpoint. Enable it with **`GUBBINS_BRIDGE_EVENTS=on`** — and it is
also implied by `GUBBINS_BRIDGE_WEBHOOKS=on` (the two share one pipeline). When neither is on the
path is a `404`.

```bash
curl -N -H "Authorization: Bearer $GUBBINS_BRIDGE_TOKEN" http://127.0.0.1:8787/api/v1/events
```

Resume after a disconnect with the standard `Last-Event-ID` header, or a `?lastEventId=<id>` query
param for clients that can't set it; events still buffered after that id are replayed on connect.
A browser `EventSource` receives every event via `onmessage` (the type is in the JSON payload). The
concurrent-stream count is capped (a `429` past the cap).

## MQTT publishing (opt-in)

The bridge can **publish out** to your MQTT broker (Mosquitto, EMQX, the Home Assistant add-on, …),
so a home-automation stack (Node-RED, Zigbee2MQTT-style pipelines, and especially **Home
Assistant**) can react to Gubbins state and change events. The bridge is an MQTT **client** dialling
*out* — it opens **no inbound port**, so this doesn't widen the bridge's attack surface. It is
**off by default** and best-effort: a broker that is down, unreachable or rejects the credentials
only logs a secret-free warning and retries with backoff — the HTTP API is unaffected.

Enable it with **`GUBBINS_BRIDGE_MQTT=on`** and point `GUBBINS_BRIDGE_MQTT_URL` at your broker:

```bash
# in the git-ignored bridge/.env
GUBBINS_BRIDGE_MQTT=on
GUBBINS_BRIDGE_MQTT_URL=mqtt://127.0.0.1:1883        # or mqtts:// for TLS
GUBBINS_BRIDGE_MQTT_USERNAME=<YOUR_MQTT_USERNAME>    # optional
GUBBINS_BRIDGE_MQTT_PASSWORD=<YOUR_MQTT_PASSWORD>    # optional; .env only, never logged
```

### Topics

Everything hangs under the prefix (default `gubbins`, override with `GUBBINS_BRIDGE_MQTT_PREFIX`):

| Topic | Retained? | Payload |
| --- | --- | --- |
| `gubbins/status` | yes | `online` / `offline` — the availability topic (also the MQTT Last-Will, so an ungraceful death flips it to `offline` automatically). |
| `gubbins/summary/state` | yes | `{ itemsTotal, lowStockItems, outOfStockItems, locationsTotal, generatedAt }` — refreshed on every snapshot change. |
| `gubbins/location/<id>/state` | yes | `{ id, name, itemCount }` — one per **user** location (the built-in `Unassigned` / `In Transit` buckets are omitted). |
| `gubbins/event/<type>` | no | The EI-1 change event (the [same shape](#the-event-shape) the webhooks/SSE emit), e.g. `gubbins/event/item.low_stock`. Transient — a late subscriber doesn't replay history. |

State is **retained** so a subscriber (or Home Assistant) that connects after the bridge sees the
last-known values immediately. The low-stock / out-of-stock counts use the exact same rule as the
`item.low_stock` / `item.out_of_stock` events, so they never drift. Every published payload is
synthetic-safe: it carries only inventory facts, never the token or the broker credentials.

### Home Assistant MQTT discovery (no custom component)

Set **`GUBBINS_BRIDGE_MQTT_DISCOVERY=on`** to *also* publish Home Assistant
[MQTT-discovery](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery) configs
(retained, under the `homeassistant/` prefix — override with `GUBBINS_BRIDGE_MQTT_DISCOVERY_PREFIX`).
Home Assistant then **auto-creates** the entities with **no `custom_components/gubbins` at all** —
this is an *alternative* to the [custom component](../homeassistant/README.md); pick one. It creates,
under a single "Gubbins" device: `sensor.gubbins_items_total`, `sensor.gubbins_low_stock_items`,
`sensor.gubbins_out_of_stock_items`, `sensor.gubbins_locations_total`, a
`binary_sensor.gubbins_low_stock` (problem class, `on` when anything is low), and one
`sensor.gubbins_location_<id>` per user location. The discovery layout is re-published whenever a
location is added/removed/renamed and on every reconnect (so a broker that restarted without
persistence re-learns it).

```bash
# verify the bridge is publishing (subscribe to everything under the prefix)
mosquitto_sub -h 127.0.0.1 -t 'gubbins/#' -v
```

## Home Assistant reads (opt-in)

Everything else here flows *outward* — Gubbins publishes inventory state to Home Assistant. This
is the one capability that flows the other way: it lets the app's **"Count by weight"** screen read
a live weight off a Home Assistant **scale entity**, instead of you reading the scale and typing
the figure in.

**Off by default.** With `GUBBINS_BRIDGE_HA` unset, `/api/v1/scale/*` is a `404` and the app shows
no scale controls at all — manual entry is, and remains, the default path.

### Why the bridge, and not the app directly

The app is served over **HTTPS**, and a browser on an HTTPS page cannot fetch a plain-`http` Home
Assistant on your LAN — mixed content is hard-blocked. The bridge runs on the same network as Home
Assistant and has no such restriction. Routing it this way also keeps your Home Assistant
long-lived token in this git-ignored `.env`, alongside every other bridge secret, rather than in
browser storage — the app never sees it, only the resulting weight.

### Enabling it

```bash
GUBBINS_BRIDGE_HA=on
GUBBINS_BRIDGE_HA_URL=http://homeassistant.local:8123
GUBBINS_BRIDGE_HA_TOKEN=<YOUR_HOME_ASSISTANT_TOKEN>
```

Create the token in Home Assistant under **Profile → Security → Long-lived access tokens**.

> **Read-only, outbound-only.** The bridge is an HTTP *client* here — it opens no extra port. It
> calls exactly two Home Assistant endpoints (list states, read one state) and **cannot call a
> service**, so this path can never switch, unlock or actuate anything in your home.

### Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/scale/entities` | `{ entities: [{ entityId, name, unit }] }` — every entity reporting a convertible mass unit, for the app's scale picker. |
| `GET /api/v1/scale/state?entity_id=…` | `{ entityId, grams, value, unit, lastUpdated }` — the current reading, reconciled to canonical **grams**. |

Both use the same bearer token and rate limit as every other endpoint, and both answer before a
snapshot has loaded (they read Home Assistant, not your inventory).

### Units, and why an unknown one is refused

Gubbins stores mass canonically in grams; a scale entity reports whatever unit its integration
chose. The bridge converts `mg`, `g`, `kg`, `oz`, `lb` and `st` — and **rejects anything else with
a `409` rather than assuming**. That strictness is deliberate: a mis-read unit would not produce a
slightly-wrong number, it would multiply the resulting stock count by a factor of a thousand.

A reading that can't be used is likewise a `409`, never a `200` with a zero weight:

| Code | Meaning |
| --- | --- |
| `scale_unavailable` | The scale is off, asleep, or its integration has lost the connection. |
| `scale_unsupported_unit` | The sensor reports a unit that cannot be converted to grams. |
| `scale_not_a_number` | That entity doesn't report a numeric weight (it probably isn't a scale). |
| `home_assistant_unreachable` / `home_assistant_unauthorised` | The bridge couldn't reach Home Assistant, or the token was rejected. |

### Using it in the app

In Gubbins, open an item → **Count by weight**. When a bridge with this capability is configured
(Settings → the same bridge URL and token used for "push to bridge"), the dialog gains a **scale
picker** and a **Read the scale** button; the reading lands in the "Weight on scale" field, in
your chosen weight unit, and everything after that — the tare, the count, the confidence band —
works exactly as it does for a typed figure.

## Permission & security matrix

This is the **single authoritative list** of what the bridge can do and how you turn each
capability on. The design rule is **read-only by default, per-capability opt-in**: with **no
`GUBBINS_BRIDGE_*` capability flag set**, the bridge only ever *reads* your snapshot and
*serves* token-gated read endpoints — it never writes your inventory and never connects out.
Each capability below is a **separate, deliberate opt-in** that defaults **off** and is **logged
as an explicit choice at startup**, so what you've enabled is always visible in the logs.

**Always on (no flag) — token-gated reads only.** These are pure read *pulls*; they cannot
mutate inventory and open no outbound connection, so they carry no opt-in flag and are gated
solely by the bearer token (the calendar and feeds additionally accept the token as a `?token=`
query parameter — see their sections):

| Surface | Path | Notes |
| --- | --- | --- |
| REST API + discovery/OpenAPI | `GET /health`, `/search`, `/where`, `/api/v1/*` | Read-only; field-selection + OData-style options. |
| CSV export | `GET /api/v1/items.csv` | Refreshable spreadsheet pull. |
| Calendar subscription | `GET /api/v1/calendar.ics` | `?token=` accepted (calendar clients can't send headers). |
| Syndication feeds | `GET /api/v1/activity.{rss,atom,json}` | `?token=` accepted. |
| Prometheus metrics | `GET /metrics` | Header-only token (no `?token=`). |
| MCP server | stdio (`mcp.mjs`) | No network token — trust boundary is the OS process. |

**Opt-in capabilities — each its own flag, all default `off`.** "Writes inventory?" means the
capability can change your stock (always via the app's own §7.3 sync merge — never bespoke SQL);
"Direction" is whether the capability serves *in*, sends *out*, or advertises on the LAN:

| Flag (`GUBBINS_BRIDGE_…`) | Turns on | Direction | Writes inventory? | Secret — where it lives |
| --- | --- | --- | --- | --- |
| `ALLOW_WRITES` | [Limited stock writes](#limited-writes-opt-in) — `POST /api/v1/items/{id}/adjust-quantity` \| `/adjust-gauge` (JSON source only). | inbound (HTTP) | **Yes** — check-in/out & gauge adjust, round-tripped through the sync merge. | None new — reuses `GUBBINS_BRIDGE_TOKEN`. |
| `ALLOW_PUSH` | [Snapshot push](#snapshot-push-opt-in) — `POST /api/v1/snapshot` (the PWA "push to bridge"; JSON source only). | inbound (HTTP) | Replaces the **whole** served snapshot atomically (no SQL). | None new — reuses the token. |
| `EVENTS` | [SSE event stream](#events-webhooks--sse-opt-in) — `GET /api/v1/events`. | outbound (pull) | No — read-only change events. | None new — reuses the token. |
| `WEBHOOKS` | [Outbound signed webhooks](#events-webhooks--sse-opt-in) (also implies `EVENTS`). | outbound (push) | No — an event never mutates inventory. | Per-target HMAC signing secrets in the **git-ignored** `webhooks.json` / `GUBBINS_BRIDGE_WEBHOOKS_TARGETS` / `.env` only. |
| `MQTT` | [Outbound MQTT publishing](#mqtt-publishing-opt-in) — state + events to your broker (a *client* dialling out; no inbound port). | outbound (push) | No — publishes read-only facts only. | Broker `…_MQTT_USERNAME` / `…_MQTT_PASSWORD` in `.env` only; **never logged**. |
| `MQTT_DISCOVERY` | [Home Assistant MQTT discovery](#home-assistant-mqtt-discovery-no-custom-component) configs (sub-flag of `MQTT`). | outbound (push) | No. | None new (uses the MQTT connection above). |
| `HA` | [Home Assistant reads](#home-assistant-reads-opt-in) — `GET /api/v1/scale/{entities,state}`, so "count by weight" can read a scale entity. | outbound (pull) | No — reads a weight; the resulting stock change is the user's own action in the app. | Home Assistant `…_HA_TOKEN` in `.env` only; **never logged, never sent to the app**. |
| `MDNS` | [mDNS / zeroconf advertising](#mdns--zeroconf-discovery) so HA can auto-discover the bridge (auto-skipped on the loopback default). | LAN advertisement | No — announcement only. | **None** — the token is **never** advertised. |

Notes that apply across the table:

- **Writes/push require a JSON snapshot source.** With a raw `.sqlite` source the write and push
  paths stay `404` **even with the flag on** (there is no sync channel to round-trip through) —
  see [Data sources](#data-sources-json-snapshot-or-raw-sqlite).
- **No secret is ever advertised, logged, or committed.** Signing secrets and broker credentials
  live only in the git-ignored `.env` / `webhooks.json`; `.env.example` and `webhooks.example.json`
  hold placeholders only. The bearer token and item data are never written to the logs.
- **Enabling an outbound/write capability and binding the LAN (`GUBBINS_BRIDGE_HOST=0.0.0.0`) is a
  deliberate double opt-in.** The safest posture keeps the bridge on the `127.0.0.1` default.

The full environment-variable reference (including the non-capability tuning knobs — host, port,
rate limits, topic prefixes, byte caps) follows.

## Configuration reference

The server is configured **entirely from the environment**, so no secret or local path is
ever committed. `serve.mjs` loads a git-ignored `bridge/.env` if present, otherwise it reads
the ambient process environment (so systemd/Docker can supply the values instead).

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GUBBINS_BRIDGE_TOKEN` | **yes** | — | Shared bearer token every request must send. Generate a long random value; never commit it. |
| `GUBBINS_SNAPSHOT_PATH` | **yes** | — | Absolute path to the data source: either the synced `gubbins-sync.json` the PWA writes, **or** a raw exported `.sqlite` database. The kind is auto-detected (extension + magic bytes) — see [Data sources](#data-sources-json-snapshot-or-raw-sqlite). |
| `GUBBINS_BRIDGE_HOST` | no | `127.0.0.1` | Bind address. `127.0.0.1` = loopback only. Set `0.0.0.0` to **deliberately** expose on the LAN (logged as a warning). |
| `GUBBINS_BRIDGE_PORT` | no | `8787` | TCP port. |
| `GUBBINS_BRIDGE_RATE_CAPACITY` | no | `60` | Per-client burst (requests back-to-back). `0` disables the rate limiter entirely. |
| `GUBBINS_BRIDGE_RATE_REFILL` | no | `1` | Per-client sustained rate (requests/second) once the burst is spent. |
| `GUBBINS_BRIDGE_MDNS` | no | `off` | Advertise over mDNS so Home Assistant can auto-discover the bridge. `on` to enable. Carries **no secret**; only meaningful when LAN-exposed (auto-skipped on the loopback default). See [mDNS / zeroconf discovery](#mdns--zeroconf-discovery). |
| `GUBBINS_BRIDGE_MDNS_NAME` | no | `Gubbins Bridge` | Service instance name shown in a discovery browser. |
| `GUBBINS_BRIDGE_ALLOW_WRITES` | no | `off` | Enable the opt-in [limited write endpoints](#limited-writes-opt-in) (stock check-in/out, quantity adjust). **Off by default — the bridge is read-only unless this is `on`.** Writes use the same bearer token + rate limit. |
| `GUBBINS_BRIDGE_ALLOW_PUSH` | no | `off` | Enable the opt-in [snapshot-ingest endpoint](#snapshot-push-opt-in) (`POST /api/v1/snapshot`, the PWA "push to bridge"). **Off by default**, independent of writes; JSON source only. Same bearer token + rate limit. |
| `GUBBINS_BRIDGE_MAX_PUSH_BYTES` | no | `67108864` | Hard cap (bytes) on a pushed snapshot; default 64 MiB. An over-large push is rejected with `413`. Lower it on a constrained host. |
| `GUBBINS_BRIDGE_EVENTS` | no | `off` | Enable the opt-in read-only [SSE event stream](#events-webhooks--sse-opt-in) at `GET /api/v1/events`. **Off by default** (the path is `404` when off). Implied by `GUBBINS_BRIDGE_WEBHOOKS`. Same bearer token + rate limit. |
| `GUBBINS_BRIDGE_WEBHOOKS` | no | `off` | Enable opt-in signed [outbound webhooks](#events-webhooks--sse-opt-in). **Off by default**; also lights up the event stream (shared pipeline). A webhook never mutates inventory. |
| `GUBBINS_BRIDGE_WEBHOOKS_FILE` | no | `webhooks.json` | Path to the **git-ignored** JSON webhook-target list. The target **secrets live only here** — never in a committed file. |
| `GUBBINS_BRIDGE_WEBHOOKS_TARGETS` | no | — | The whole target list inline as JSON (wins over the file). Carries secrets, so keep it in the git-ignored `.env` only. |
| `GUBBINS_BRIDGE_MQTT` | no | `off` | Enable opt-in [outbound MQTT publishing](#mqtt-publishing-opt-in) (state + events to your broker). **Off by default**; outbound-only (no inbound port). Does **not** expose the SSE HTTP endpoint. |
| `GUBBINS_BRIDGE_MQTT_URL` | when MQTT on | — | Broker URL: `mqtt://host:port` (plaintext, default port 1883) or `mqtts://host:port` (TLS, default 8883). Any `user:pass@` in the URL is ignored — use the vars below. |
| `GUBBINS_BRIDGE_MQTT_USERNAME` | no | — | Broker username. Keep it in the git-ignored `.env`. |
| `GUBBINS_BRIDGE_MQTT_PASSWORD` | no | — | Broker password. `.env` only; **never logged**. |
| `GUBBINS_BRIDGE_MQTT_PREFIX` | no | `gubbins` | Topic prefix every published topic hangs under. |
| `GUBBINS_BRIDGE_MQTT_CLIENT_ID` | no | `gubbins-bridge` | The MQTT client identifier. |
| `GUBBINS_BRIDGE_MQTT_DISCOVERY` | no | `off` | Also publish [Home Assistant MQTT-discovery](#home-assistant-mqtt-discovery-no-custom-component) configs so HA auto-creates entities with no custom component. Only meaningful when MQTT is on. |
| `GUBBINS_BRIDGE_MQTT_DISCOVERY_PREFIX` | no | `homeassistant` | HA discovery prefix (match HA's `discovery_prefix` if you changed it). |

A missing required value, an out-of-range port, or a non-numeric rate setting makes the
bridge **fail loudly at startup** (with a secret-free message) rather than serve
misconfigured.

---

## mDNS / zeroconf discovery

So Home Assistant can **auto-discover** the bridge instead of you typing its host and port,
the bridge can advertise itself on the LAN over mDNS / DNS-SD (the same mechanism printers
and Chromecasts use). It is **opt-in and off by default**, **stdlib-only** (a tiny
hand-rolled responder over `node:dgram` — no new dependency), and **read-only**: it only
sends a small announcement describing the already-running HTTP service.

Enable it by setting **`GUBBINS_BRIDGE_MDNS=on`**. It is only meaningful when the bridge is
**LAN-exposed** (`GUBBINS_BRIDGE_HOST=0.0.0.0`) — advertising a loopback-only bind to the
LAN is pointless, so on the `127.0.0.1` default it is **auto-skipped** (logged, not an
error). The advertiser starts and stops with the HTTP server.

What is advertised (service type **`_gubbins._tcp.local`**):

| Record | Value |
| --- | --- |
| Instance name | `Gubbins Bridge` (override with `GUBBINS_BRIDGE_MDNS_NAME`). |
| Port | the bridge's HTTP port. |
| TXT | `server=gubbins-bridge`, `api=v1`, `path=/api/v1`, `version=<bridge version>`. |

> **No secret is ever advertised.** The TXT record carries only the API path/version for
> identification — **never** the bearer token. Home Assistant still prompts for the token in
> its UI; discovery only pre-fills the host and port. See
> [`../homeassistant/README.md`](../homeassistant/README.md) for the HA side.

Advertising is **best-effort**: if the mDNS UDP port can't be bound (another responder such
as Avahi already holds it without address-reuse, or multicast isn't permitted), the bridge
logs a warning and carries on serving HTTP normally — discovery just won't be available, and
you can still add the integration manually.

---

## Shared-code mechanism (the important decision)

The single most important design choice for the bridge is **how it reuses the app's pure
search/DB code without forking it** — above all `parseASTtoSQL`, the one SQL translator
that defines Gubbins' search semantics. A fork would let bridge answers silently drift
from the app's. So the bridge **imports** these modules from `../src`; it never copies
them.

**Decision: a `tsconfig` path alias `@/* → ../src/*`, honoured at runtime by a tiny
zero-dependency ESM loader, with Node's built-in TypeScript support running the code
directly.** No build step, no bundler, no runtime dependencies.

Concretely there are two halves:

| Context | How `@/…` and extensionless imports resolve |
| --- | --- |
| **Type-checking** (`tsc`) and **tests** (Vitest) | The `paths` alias in [`tsconfig.json`](tsconfig.json) and the `resolve.alias` in [`vitest.config.ts`](vitest.config.ts) — exactly mirroring the app's bundler-mode config. |
| **Runtime** (`node bridge/cli.mjs`) | [`loader.mjs`](loader.mjs), a ~40-line ESM `resolve` hook that maps `@/…` → `../src/…` and retries the app's extensionless imports with a `.ts`/`index.ts` suffix. Node 23.6+ then strips the TypeScript types on the fly. |

Why this over the alternatives the plan floated:

- **vs. an npm workspace + `@gubbins/core` export map** — the app's source uses `@/…`
  aliases *internally* everywhere, so a package boundary alone wouldn't make it
  Node-resolvable; we'd still need alias resolution. The loader is simpler and touches no
  root config (important while another agent works on the PWA concurrently).
- **vs. compiling with `tsc` to `dist/`** — `tsc` leaves both the `@/` alias and the
  extensionless specifiers unrewritten, so the emitted JS still wouldn't run under plain
  Node. We'd need a bundler or a path-rewriter anyway. The loader avoids the whole build.

The one piece that is a **copy, not a shared import**, is the database *driver*
([`src/node-driver.ts`](src/node-driver.ts)) — a Node-runnable sibling of the app's
test-only `src/test/drivers/memory-driver.ts`. Both implement the same production
`IDatabaseDriver` over `node:sqlite`. The test driver lives under `src/test/**` (excluded
from the app tsconfig and `@/`-aliased for Vitest); rather than widen the app's tsconfig to
drag a test module into a Node build, the bridge keeps a small injected copy. The driver is
plumbing, not search semantics — the thing that must never fork (`parseASTtoSQL`) is
imported.

---

## Requirements

- **Node ≥ 24**, or **Node ≥ 22.16** (LTS) — **not** any Node v23.x build. The bridge needs
  two things from Node: built-in, unflagged TypeScript type-stripping (available from
  Node 22.6) and `node:sqlite` **with FTS5 support**, which Gubbins' schema requires
  (`CREATE VIRTUAL TABLE … USING fts5`). FTS5 shipped in `node:sqlite` via
  [nodejs/node#57621](https://github.com/nodejs/node/pull/57621), which landed in
  **Node 22.16.0** and **Node 24.0.0** — but was **never backported to the v23.x line**, so
  a v23.x Node (including 23.6+) will hydrate every snapshot with a migration failure
  (`no such module: fts5`). On Node 22.6–22.15 you can run with
  `node --experimental-strip-types`, but you still need ≥ 22.16 for FTS5 to work.
- The repo-root dev toolchain (Vitest, TypeScript) — the bridge has **no `node_modules` of
  its own** and no runtime dependencies; it borrows the root install. Run `npm install`
  once at the repository root.
- Any app source the bridge imports must stay **strip-only-compatible** — Node's type-stripping
  loader erases types but does not transform code, so no TypeScript parameter properties,
  `enum`, or `namespace` may appear anywhere in the bridge's import graph (they would fail at
  runtime even though they type-check and pass under Vitest's esbuild).

---

## Try it (HA-1 parity CLI)

A throwaway CLI hydrates a snapshot and prints the item count plus one sample item with its
location, driven through the app's real repositories — proof the headless DB matches the
app:

```bash
# Against the synthetic fixture shipped with the tests:
node bridge/cli.mjs bridge/src/fixtures/synthetic-snapshot.json

# Against a real exported snapshot (point it at your synced folder):
node bridge/cli.mjs /path/to/your/gubbins-sync.json
```

Expected output (fixture):

```
Active items: 4

Sample item:
  name     : ESP32 Dev Board
  quantity : 7
  location : Shelf 2
  ...
```

## Tests

```bash
# from the bridge/ directory (uses the repo-root Vitest):
npx vitest run --config vitest.config.ts
# or from the repo root:
npx vitest run --config bridge/vitest.config.ts
```

The tests hydrate the **synthetic** fixture ([`src/fixtures/synthetic-snapshot.json`](src/fixtures/synthetic-snapshot.json)
— made-up parts and `*-synthetic` makers only) and assert row counts and a
`parseTextQuery → searchByAst` round-trip, including the power-user `cap:` syntax.

## Type-check

```bash
npx tsc --noEmit -p bridge/tsconfig.json
```

---

## Security & hardening

The bridge is designed to be safe by construction; this is the checklist it satisfies.

- **Read-only by default; writes are opt-in and gated.** With `GUBBINS_BRIDGE_ALLOW_WRITES`
  unset (the default), hydration into a *private, in-memory* `node:sqlite` DB is the only write
  and the snapshot file on disk is only ever read — no endpoint mutates anything. The opt-in
  [limited write endpoints](#limited-writes-opt-in) never string-build SQL either: they apply the
  change through the app's **own** repository mutation and round-trip it through the §7.3 sync
  merge, so even when enabled there is no bespoke write path and no risk of sync drift. The opt-in
  [snapshot-ingest endpoint](#snapshot-push-opt-in) runs **no SQL** at all — it validates the same
  versioned JSON the watcher reads and atomically rewrites the snapshot file; the watcher then
  re-hydrates it through the unchanged read path.
- **Parameterised queries only.** Every query — casual phrase or power-user
  `field:`/`cap:` syntax — is parsed to an AST and translated by the app's single
  `parseASTtoSQL`. SQL is **never string-built** from user input, so there is no injection
  surface; the bridge imports that translator rather than forking it, so its semantics can't
  drift from the app's.
- **Token required on every request.** A shared bearer token is checked in **constant time**
  (`timingSafeEqual`); a missing or wrong token is a `401`. The token lives only in a
  git-ignored `.env` (or the systemd/Docker environment), never in the repo.
- **Local-bind by default.** The server binds `127.0.0.1` unless you set
  `GUBBINS_BRIDGE_HOST=0.0.0.0`, which it logs as a deliberate LAN-exposure choice.
- **No PII in logs or errors.** Logs are limited to lifecycle lines (bound address, snapshot
  loaded/failed). Item names, query text, tokens, and client IPs are **never logged**, and
  every unexpected failure is collapsed to a generic `500 { "error": "Internal error" }` —
  no SQL, paths, or stack traces leak to the caller.
- **Rate-limited.** See [below](#rate-limiting).
- **No secrets or real data in the repo.** Only [`.env.example`](.env.example) (placeholders)
  is committed; [`.gitignore`](.gitignore) and the repo-root [`.dockerignore`](../.dockerignore)
  block any real `.env`, snapshot, `.sqlite`/`.db`, or `gubbins-sync.json`. Keep local test
  data under `bridge/local/`. The only fixture committed is the fully synthetic
  `src/fixtures/synthetic-snapshot.json` (made-up parts, `example.com`/`localhost` only).
- **Minimal dependency surface.** Zero runtime dependencies — stdlib `node:http` /
  `node:fs` / `node:crypto` (and `node:dgram` / `node:os` for the optional mDNS advertiser,
  `node:net` / `node:tls` for the optional MQTT client) only — so there is no third-party
  supply-chain surface to vet. The MQTT publisher speaks a **hand-rolled**, publish-only subset
  of MQTT 3.1.1 rather than taking a client dependency (see [MQTT publishing](#mqtt-publishing-opt-in)).

### Rate limiting

Each request is charged against a small **per-client (per-IP) token bucket** before any
work, including the token check, so a runaway query loop — a misbehaving automation, a stuck
voice device — can't peg the host. A client may **burst** up to `GUBBINS_BRIDGE_RATE_CAPACITY`
requests (default 60), then is held to `GUBBINS_BRIDGE_RATE_REFILL` requests/second (default
1) as the bucket refills. An exhausted client gets `429 Too Many Requests` with a
`Retry-After` header. The key is the socket's source IP — client-supplied
`X-Forwarded-For` is deliberately **not** trusted, so the limit can't be forged away. Set
`GUBBINS_BRIDGE_RATE_CAPACITY=0` to disable it and rely solely on the LAN/firewall. This is
a backstop, not the security boundary — the token and the loopback default are.

## Layout

```
bridge/
  package.json          # no runtime deps; borrows the repo-root toolchain
  tsconfig.json         # @/* → ../src/* alias (type-check only; bundler resolution)
  vitest.config.ts      # node env + the same @/ alias, pinned to bridge/ as root
  loader.mjs            # zero-dep ESM resolve hook (the runtime half of the alias)
  cli.mjs               # bare-node bootstrap: register loader, import src/cli.ts
  serve.mjs             # bare-node bootstrap: register loader, load .env, import src/serve.ts
  mcp.mjs               # bare-node bootstrap: register loader, load .env, import src/mcp/serve.ts
  Dockerfile            # thin, build-free node:slim image (context = repo root)
  gubbins-bridge.service # example systemd unit (hardened, runs as an unprivileged user)
  openapi.yaml          # committed OpenAPI 3 spec for /api/v1 (generated from src/openapi.ts)
  scripts/
    emit-openapi-yaml.mjs # regenerate openapi.yaml from the typed spec (run after editing src/openapi.ts)
  .env.example          # placeholder config only
  src/
    node-driver.ts      # node:sqlite IDatabaseDriver (:memory: or a file copy; sibling of the test memory-driver)
    hydrate.ts          # source → migrated, loaded driver (dispatches JSON vs raw .sqlite)
    sqlite-source.ts    # raw .sqlite front-end: detect source + copy/open/migrate; write-gating
    query.ts            # read-only query core: searchItems / whereIs (transport-agnostic)
    spoken.ts           # pure spoken-answer shaper (the voice UX)
    config.ts           # env-driven host/port/token/snapshot-path/rate-limit (pure, injectable)
    rate-limit.ts       # pure per-IP token-bucket abuse guard (injectable clock)
    server.ts           # node:http server (legacy paths + auth/rate-limit; delegates /api/v1; POST writes)
    write.ts            # opt-in limited writes: apply via app repos → write merged snapshot back (peer-device)
    push.ts             # opt-in snapshot ingest (PWA "push to bridge"): stream body → validate → atomic replace
    openapi.ts          # the OpenAPI 3 document as a typed object (single source of truth)
    openapi-yaml.ts     # tiny zero-dep YAML emitter (object → openapi.yaml)
    watcher.ts          # debounced, atomic snapshot re-hydrate on file change
    serve.ts            # composition root: config → watcher → server → listen
    cli.ts              # throwaway HA-1 parity CLI
    item-detail.ts      # shared item-detail loader (HTTP /items/{id} + MCP get-item, one source)
    mdns/
      records.ts        # pure DNS-SD record/TXT building + question parsing + opt-in/loopback gating
      advertise.ts      # node:dgram multicast lifecycle (announce/respond/goodbye; best-effort)
      records.test.ts   # pure wire-format / TXT / gating / address-pick tests
    mqtt/               # opt-in outbound MQTT publishing (EI-5) — zero-dep, publish-only
      packet.ts         # pure hand-rolled MQTT 3.1.1 codec (CONNECT/CONNACK/PUBLISH/PING/DISCONNECT)
      client.ts         # node:net/node:tls connection shell: connect/CONNACK/keep-alive/reconnect/LWT
      topics.ts         # pure topic + payload builders (status/summary/location/event)
      state.ts          # read-only inventory-state projection through the app repositories
      discovery.ts      # pure Home Assistant MQTT-discovery config builder (no custom component)
      publisher.ts      # orchestrator: EventSink + per-generation retained state + availability
      packet.test.ts / topics.test.ts / discovery.test.ts / state.test.ts / client.test.ts / publisher.test.ts
    mcp/
      tools.ts          # the six read-only gubbins_* MCP tools (wrap the query core/repositories)
      dispatcher.ts     # stdlib JSON-RPC dispatcher (initialize/tools.list/tools.call/ping)
      stdio.ts          # newline-delimited JSON-RPC over stdin/stdout
      serve.ts          # MCP composition root: watcher → stdio server (logs to stderr)
      tools.test.ts     # per-tool shape/not-found/bounds tests over the fixture
      dispatcher.test.ts # JSON-RPC handshake/call/guard tests over the fixture
    api/
      v1.ts             # versioned /api/v1 router (items/locations/categories/capabilities + aliases)
      dto.ts            # stable public DTOs + pure row→DTO mappers
      field-select.ts   # generic fields/include projection engine (parse + validate + lazy project)
      item-view.ts      # item field vocabulary + lazy relational context (SSOT for projectable fields)
      odata.ts          # OData-style option layer: $-alias reader + $orderby parser
      odata-filter.ts   # constrained OData $filter → SearchAST compiler (never bespoke SQL)
      odata-metadata.ts # OData v4 CSDL $metadata builder (descriptive read model)
      respond.ts        # shared JSON / text / xml / error-envelope helpers (legacy flat + v1 structured)
      params.ts         # shared q / pagination parsing (clamped; $top/$skip aliases)
      limits.ts         # shared request/pagination bounds
      v1.test.ts        # in-process /api/v1 endpoint + pagination + auth + 404 + field-selection + OData tests
      field-select.test.ts # unit tests for the generic projection engine
      item-view.test.ts # item registry drift-guard + lazy-resolution tests
      odata.test.ts     # $orderby validation + alias-reader tests
      odata-filter.test.ts # $filter parser grammar + rejection tests
      odata-metadata.test.ts # $metadata CSDL shape + registry drift-guard tests
    hydrate.test.ts     # hydration tests over the synthetic fixture
    sqlite-source.test.ts # raw .sqlite source tests (generated synthetic .sqlite, detection, write-gating)
    query.test.ts       # query-core tests over the synthetic fixture
    spoken.test.ts      # pure shaper unit tests
    config.test.ts      # pure env-resolution tests
    rate-limit.test.ts  # pure token-bucket tests (deterministic clock)
    server.test.ts      # in-process HTTP-endpoint + auth + rate-limit tests over the fixture
    server-writes.test.ts # in-process POST write-endpoint routing/gating/validation tests
    server-push.test.ts # in-process POST /api/v1/snapshot routing/gating/error-mapping tests
    write.test.ts       # write core + the gold no-drift LWW/Delta-CRDT round-trip via the real reconcile
    push.test.ts        # push validation + streaming ingest + the watcher-serves-a-pushed-snapshot round-trip
    openapi.test.ts     # spec drift-guard + internal-reference sanity
    watcher.test.ts     # reload/atomic-swap + fs.watch pickup tests
    fixtures/synthetic-snapshot.json
```

## Running it as a service

The bridge is meant to run continuously next to your synced folder. Two supported recipes:

### Run with Docker

A thin, **build-free** image ([`Dockerfile`](Dockerfile)) — single `node:slim` stage, no
`npm install`, no compile. The build **context is the repo root** (the bridge imports the
app's pure modules from `../src`):

```bash
# from the repo root
docker build -f bridge/Dockerfile -t gubbins-bridge .

docker run --rm \
  -p 127.0.0.1:8787:8787 \
  -e GUBBINS_BRIDGE_TOKEN=your-long-random-token \
  -e GUBBINS_SNAPSHOT_PATH=/data/gubbins-sync.json \
  -v /path/to/synced/folder/gubbins-sync.json:/data/gubbins-sync.json:ro \
  gubbins-bridge
```

Notes:

- The **token and snapshot are passed at run time**, never baked into the image. A
  repo-root [`.dockerignore`](../.dockerignore) keeps any real `.env`, snapshot, or
  `.sqlite` out of the build context as a safety net.
- Mount the snapshot **read-only** (`:ro`) — the bridge only ever reads it.
- Inside the container the process binds `0.0.0.0` (so Docker's port mapping works at all);
  keep it host-local by publishing to `127.0.0.1:8787:8787` as above. To let Home Assistant
  on another machine reach it, publish to the host's LAN IP instead (a deliberate choice).

### Run with systemd

An example unit ships as [`gubbins-bridge.service`](gubbins-bridge.service). In short: put a
checkout at `/opt/gubbins`, create `/etc/gubbins-bridge.env` (from `.env.example`, `chmod
640`, holds the token), copy the unit to `/etc/systemd/system/`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gubbins-bridge
journalctl -u gubbins-bridge -f      # logs carry no token and no item data
```

The unit runs as a dedicated unprivileged user with a tight sandbox
(`ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges`, restricted address
families) — the bridge only needs to **read** the snapshot and listen on a socket. See the
file's header comments for the full walkthrough.

### Where to run it

Anywhere that can see the synced folder and that Home Assistant can reach over the LAN:

- **On the Home Assistant host.** Simplest if HA is on a general-purpose box (an Intel NUC,
  a mini-PC) where you can also run Node ≥ 24 (or 22.16+ LTS) or Docker. Keep the bridge on `127.0.0.1`
  and point the integration at `127.0.0.1:8787` — nothing touches the LAN. (Home Assistant
  OS is a locked-down appliance; prefer one of the other two options there.)
- **On a Raspberry Pi.** A Pi that already mounts the synced folder makes a tidy always-on
  host. Use a 64-bit OS and a Node ≥ 24 (or 22.16+ LTS) build (or the Docker image, which is `arm64`-ready
  via `node:slim`). Expose it with `GUBBINS_BRIDGE_HOST=0.0.0.0` only if HA runs elsewhere.
- **On a NAS** (Synology, QNAP, etc.). If the NAS is where `gubbins-sync.json` already
  lands, run the bridge there in Docker so it reads the snapshot locally with no extra copy.
  Publish the port to the NAS's LAN IP so HA can reach it, and keep the firewall tight.

In every case the bridge re-hydrates **automatically and atomically** whenever the watched
snapshot changes, so it always answers from fresh data without a restart.
