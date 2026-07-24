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

> **Status:** Complete and stable. The bridge serves **read-only-by-default** surfaces, gated by
> a **per-user API token minted in the app**, and re-hydrates automatically when the snapshot
> changes, rate-limited per client. Every request is resolved to the user who owns the presented
> token and answered only within that user's permissions — see
> [Identities & permissions](#identities--permissions). What it exposes, at a glance:
>
> - **Read (always on):** the original `GET /health`, `/search`, `/where`; an additive,
>   OpenAPI-described [`/api/v1`](#versioned-rest-api-apiv1) surface (items, locations,
>   categories, capabilities, with field-selection + an OData-style query subset); a
>   [CSV export](#csv-export); an [iCalendar subscription feed](#calendar-subscription); and
>   [syndication feeds + a Prometheus `/metrics`](#feeds--metrics) endpoint. The same read-only
>   core is also offered over an [MCP stdio server](#mcp-server-for-llmagent-tools) for LLM/agent
>   tools (read-only unless writes are opted in).
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
#  - point GUBBINS_SNAPSHOT_PATH at your synced gubbins-sync.json
#  (there is NO token setting — tokens are minted in the app, see below)

node bridge/serve.mjs             # starts the read-only HTTP server (loopback by default)
```

**Mint a token in the app.** There is no shared token in the environment any more. In Gubbins,
go to **Users → the account the integration should act as → API tokens → New token**. The
plaintext token is shown **once**; copy it then, because only a hash is stored and it cannot be
shown again. It reaches the bridge through the snapshot the bridge already watches, so no restart
and no `.env` edit is needed — and revoking it in the app withdraws access the same way.

> **⚠️ A brand-new bridge answers `401` to everything until a token exists and the snapshot
> carrying it has loaded.** That is the safe default, not a fault. See
> [Identities & permissions](#identities--permissions).

Then query it (replace `<YOUR_TOKEN>` with the token you minted):

```bash
curl -H "Authorization: Bearer <YOUR_TOKEN>" "http://127.0.0.1:8787/health"
curl -H "Authorization: Bearer <YOUR_TOKEN>" "http://127.0.0.1:8787/where?q=M3%20screws"
curl -H "Authorization: Bearer <YOUR_TOKEN>" "http://127.0.0.1:8787/search?q=ESP32&limit=3"
```

The server **binds `127.0.0.1` (loopback only) by default** — it is not reachable from the
LAN. To wire it into Home Assistant, follow [`../homeassistant/README.md`](../homeassistant/README.md).
To run it as a long-lived service, see [Docker](#run-with-docker) or
[systemd](#run-with-systemd) below.

---

## Identities & permissions

The bridge does not have a password of its own. **A caller is a user**: the token it presents was
minted in the app against one account, and the bridge resolves it to that account, resolves that
account's role through the app's **own** permission engine, and answers only what that role
permits. A write is then attributed to that user in the Activity Ledger — the log says *who*,
not just *the bridge*.

Three consequences worth internalising before you configure anything:

- **A token carries its owner's permissions, and nothing more.** Give a narrow integration its
  own account with a narrow role and it can only ever do that much, however the token leaks. The
  operator grants remote access at all with `bridge:read` / `bridge:write`, so a role can be
  allowed to work in the app while being withheld from the bridge entirely.
- **Authentication requires a loaded snapshot.** The bridge owns no database — the tokens reach
  it in the same synced snapshot as everything else. Until the first snapshot loads there is
  nothing to resolve a token *against*, so **every** route (including the `/api/v1/scale/*`
  reads, which previously answered before a snapshot existed) returns `503` with a `Retry-After`.
  Failing closed is the only safe direction when the question is *who is this*.
- **The env capability flags remain the outer bound.** Permissions only ever *narrow* what the
  operator enabled. A route disabled by `GUBBINS_BRIDGE_ALLOW_WRITES` (or `_ALLOW_PUSH`,
  `_EVENTS`, `_WEBHOOKS`, `_HA`, …) is still a `404` for everyone, however permissive their role.
  There is no role that can switch a capability on.

### Status codes

| Code | Meaning |
| --- | --- |
| `401` `unauthorized` | No token, or a token that matches nothing live — unknown, mistyped, or **revoked**. Revocation is a hard delete, so a revoked token is simply a token that no longer exists. |
| `403` `forbidden` | The token is valid and its owner is known, but their role does not permit **this** route. Nothing is wrong with the credential; the answer will not change until the role does. |
| `503` `snapshot_unavailable` | No snapshot loaded yet, so no identity can be resolved. Retry per `Retry-After`. |
| `404` | The route is disabled by an env flag (or genuinely does not exist). Deliberately indistinguishable — a disabled capability is invisible rather than advertised. |

Both `401` and `403` are described in the [OpenAPI spec](#openapi-spec).

### What each route requires

Every route requires `bridge:read` or `bridge:write` — the capability of using the bridge at all
— **plus** the permission for the subject it actually exposes. All of them, not any of them:

| Route | Requires |
| --- | --- |
| `GET /health`, `/api/v1`, `/api/v1/openapi.json`, `/api/v1/$metadata`, `/api/v1/health`, `/api/v1/events`, `/api/v1/scale/*` | `bridge:read` |
| `GET /search`, `/where`, `/metrics`, `/api/v1/{search,where,items,items.csv,capabilities}` | `bridge:read` + `items:read` |
| `GET /api/v1/locations…` | `bridge:read` + `locations:read` |
| `GET /api/v1/categories…` | `bridge:read` + `categories:read` |
| `GET /api/v1/calendar.ics` | `bridge:read` + `bookings:read` |
| `GET /api/v1/activity.{rss,atom,json}` | `bridge:read` + `audit:view` |
| `GET /api/v1/webhooks/deliveries` | `bridge:read` + `settings:read` |
| `POST /api/v1/webhooks/test` | `bridge:write` + `settings:write` |
| `POST /api/v1/items/{id}/adjust-quantity` \| `/adjust-gauge` | `bridge:write` + `stock:write` |
| `POST /api/v1/snapshot` | `bridge:write` + `sync:write` |

A few of these are deliberate rather than obvious. The **calendar** feed publishes asset
bookings, so it is gated on `bookings:read`, not `items:read`. The **syndication feeds** publish
the Activity Ledger — the audit trail — so they need `audit:view`, which is what makes "only
some people may read the history" expressible at all. The **stock adjust** endpoints need
`stock:write` rather than `items:write`, because changing how much there is of something is not
editing the item record.

> **ℹ️ The MCP stdio server carries no credential at all.** Its trust boundary is the OS process
> (see [MCP server](#mcp-server-for-llmagent-tools)), so there is no token to resolve and no
> identity to enforce; its writes are attributed to the **System** user. Anything able to launch
> it with the write flag set can adjust stock — configure it accordingly.

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

All endpoints are **GET-only** and require an [API token](#identities--permissions). The contract is stable —
the Home Assistant integration depends on it.

These three unversioned paths are **permanent, stable aliases** of their `/api/v1`
equivalents (see [the versioned API](#versioned-rest-api-apiv1) below) — they return
byte-for-byte identical success bodies, so existing consumers keep working unchanged:

| Endpoint (alias of) | Returns |
| --- | --- |
| `GET /health` (`/api/v1/health`) | `{ ok, itemCount, snapshotGeneratedAt, … }` — liveness + a cheap snapshot summary + [snapshot freshness](#snapshot-freshness-and-health). |
| `GET /search?q=<query>&limit=<n>` (`/api/v1/search`) | `{ query, matches: ItemMatch[] }` — compact item DTOs (`id`, `name`, `quantity`, `locationName`, `mpn`, `manufacturer`). `limit` is clamped to `[1, 25]`. |
| `GET /where?q=<query>` (`/api/v1/where`) | `{ query, matches: WhereIsMatch[], spoken }` — per-location breakdown plus one spoken British-English sentence for a voice assistant. |

Status codes: `401` (missing/unknown/revoked token), `403` (valid token, but the owner's role
does not permit that route — see [Identities & permissions](#identities--permissions)), `400`
(missing or over-long `q`, max 200 chars),
`404` (unknown path), `405` (non-GET), `429` (rate-limited — see [below](#rate-limiting)),
`503` (no snapshot loaded yet — so no identity can be resolved either — with a `Retry-After`),
`500` (generic — never leaks
internals). A `POST` that declares a `Content-Type` other than `application/json` is
refused with `415` rather than having its body read as JSON. `q` accepts the
app's full search grammar (`field:value`, `cap:key>n`, `AND`/`OR`/parentheses) as well as a
casual phrase like `M3 screws`. The unversioned paths keep a flat `{ "error": "<message>" }`
body; the versioned API uses the structured envelope described next.

### Snapshot freshness and health

The bridge re-reads the snapshot whenever the app writes a new one. If that re-read fails —
the file is briefly absent, half-written, corrupt, or unreadable — the **last good snapshot
stays live** so reads keep working. That is the right trade-off for availability, but it means
the bridge can be answering from data that is out of date, so `/health` says so:

| Field | Meaning |
| --- | --- |
| `ok` | `false` once the snapshot is stale. **This is a data verdict, not liveness** — treat `false` as "don't trust these numbers". |
| `snapshotStale` | Reloads have failed enough times in a row to call the served data stale. |
| `reloadFailures` | Consecutive failed reloads since the last successful one. |
| `lastReloadError` | Why the most recent reload failed (paths removed), or `null`. |
| `lastReloadErrorAt` | When it failed, or `null`. |
| `lastReloadAt` | When the served snapshot was last loaded successfully, or `null`. |

The status stays `200` — the bridge is up and this is a successful health *report*. (A bridge
that has never loaded a snapshot at all still answers `503`.) A single failure is normal — a
snapshot is not written atomically, so catching one mid-write happens and self-heals — which is
why the verdict needs a few in a row. The threshold is `GUBBINS_BRIDGE_STALE_AFTER_FAILURES`
(default `3`); set it to `0` to keep the counters but never flip `ok`.

Consumers that poll `/health` — a Home Assistant availability template, a dashboard, a monitor
— should key off `ok` so they degrade to *unavailable* rather than displaying confidently stale
stock levels.

The same verdict rides every **authenticated** response as an `X-Gubbins-Snapshot-Stale: true|false`
header, so a consumer of `/search`, `/where`, `/metrics` or any `/api/v1` read learns the data is
stale at the point it reads it — no separate `/health` poll needed. The header carries the boolean
only; the counters above stay on `/health`. It is stamped only *after* the auth/permission gates (so
it is never disclosed to an unauthenticated caller) and is named in `Access-Control-Expose-Headers`,
so a cross-origin browser (the PWA is almost always a different origin) is allowed to read it back.

The same staleness is also surfaced over [MQTT](#mqtt-publishing) (a dedicated
`snapshot/state` topic and a Home Assistant *Snapshot stale* binary sensor) and to the
[MCP tools](#mcp-model-context-protocol), so an assistant caveats a stale count rather than
presenting it as current.

---

## Versioned REST API (`/api/v1`)

For **any** application (not just Home Assistant), the bridge exposes a versioned, documented,
read-only REST API under `/api/v1`. It is **purely additive** — it does not change or replace
the three paths above — and is described by a committed [OpenAPI 3 spec](#openapi-spec).
Same auth ([per-user API token](#identities--permissions)) and same per-IP
[rate limit](#rate-limiting) as everything else;
every endpoint is **GET-only** and strictly read-only.

### Conventions

- **List** endpoints return `{ "data": [ … ], "pagination": { limit, offset, count, hasMore } }`.
- **Single-resource** endpoints return the resource object directly.
- **Pagination** is offset/limit: `?limit=` is clamped to `[1, 100]` (default `50`); `?offset=`
  is `≥ 0` (default `0`). `hasMore` is true whenever a *full* page came back (so it may be a
  benign `true` on an exact-boundary last page — fetch the next page to confirm).
- **Errors** use a structured, machine-readable envelope:
  `{ "error": { "code": "not_found", "message": "…" } }`. Codes: `bad_request`,
  `unauthorized`, `forbidden`, `not_found`, `method_not_allowed`, `unsupported_media_type`,
  `too_many_requests`, `snapshot_unavailable`, `internal_error`.
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
| `GET /api/v1` | A small discovery index (API version, the `bridge` build block, and the endpoint list). See [Updating the bridge](#updating-the-bridge). |
| `GET /api/v1/openapi.json` | This API's OpenAPI 3 document. |
| `GET /api/v1/$metadata` | OData v4 CSDL describing the read model (descriptive; see [OData-style options](#odata-style-query-options)). |
| `GET /api/v1/items/$count` | The count of matching items as a bare `text/plain` integer (honours `$filter`/`$search`). |
| `GET /api/v1/items.csv` | A spreadsheet-friendly CSV of the matching items (refreshable pull for Excel/Power BI). See [CSV export](#csv-export). |
| `GET /api/v1/calendar.ics` | A read-only iCalendar feed of Gubbins' time-bearing facts (loan due-backs, bookings, maintenance, warranty) that any calendar app can **subscribe** to. See [Calendar subscription](#calendar-subscription). |
| `GET /api/v1/activity.rss` (`.atom`, `.json`) | A read-only syndication feed of the recent activity log (RSS 2.0 / Atom 1.0 / JSON Feed 1.1) any feed reader can **subscribe** to. See [Feeds & metrics](#feeds--metrics). |
| `GET /metrics` | A Prometheus/OpenMetrics text exposition of the aggregate inventory counts (root path, not under `/api/v1`). See [Feeds & metrics](#feeds--metrics). |
| `GET /api/v1/health` | `{ ok, itemCount, snapshotGeneratedAt, … }` (alias of `/health`; see [snapshot freshness](#snapshot-freshness-and-health)). |
| `GET /api/v1/search?q=&limit=&fields=&include=` | Relevance search, top-N (limit `[1, 25]`, default 5) — not paginated. Alias of `/search`. Supports [field selection](#field-selection--extended-fields). |
| `GET /api/v1/where?q=` | "Where is X?" with per-location breakdown + spoken sentence. Alias of `/where`. |
| `GET /api/v1/items?limit=&offset=&location=&category=&includeInactive=&fields=&include=&$orderby=&$filter=` | Paginated item summaries (`ItemSummary`). Supports [field selection](#field-selection--extended-fields) and [OData-style options](#odata-style-query-options) (`$orderby`, `$filter`, …). |
| `GET /api/v1/items/{id}?fields=&include=` | One item with `placements` and `capabilities` (`ItemDetail`); `404` if unknown. Supports [field selection](#field-selection--extended-fields), including `include=fields` for [custom-field values](#custom-field-values-includefields). |
| `GET /api/v1/locations?limit=&offset=&fields=&include=` | Paginated locations with live item counts (`Location`). `include=fields` adds each location's [custom-field values](#custom-field-values-includefields). |
| `GET /api/v1/locations/{id}?fields=&include=` | One location; `404` if unknown. `include=fields` adds its [custom-field values](#custom-field-values-includefields). |
| `GET /api/v1/categories?limit=&offset=` | Paginated categories with field counts (`CategorySummary`). |
| `GET /api/v1/categories/{id}` | One category with its custom-field schema (`CategoryDetail`); `404` if unknown. |
| `GET /api/v1/capabilities?limit=&offset=` | The distinct, queryable capability vocabulary (`CapabilityKey`) — the keys you can filter on with `cap:<key>`. |
| `GET /api/v1/events` | **Opt-in** read-only SSE stream of change events (`GUBBINS_BRIDGE_EVENTS=on`); `404` when off. See [Events, webhooks & SSE](#events-webhooks--sse-opt-in). |
| `GET /api/v1/webhooks/deliveries?since=&limit=` | **Opt-in** read-only log of recent webhook delivery outcomes (`GUBBINS_BRIDGE_WEBHOOKS=on`); `404` when off. See [the delivery log](#get-apiv1webhooksdeliveries--the-delivery-log). |

Search is the **relevance** endpoint (top-N, capped at 25 for voice safety); to **browse all
items** with pagination use `GET /api/v1/items`. Every read flows through the app's own
repositories and the single parameterised `parseASTtoSQL` — no bespoke SQL, no write path.

### Examples

```bash
TOKEN=<YOUR_TOKEN>          # minted in the app: Users -> an account -> API tokens
BASE=http://127.0.0.1:8787/api/v1

curl -H "Authorization: Bearer $TOKEN" "$BASE"                       # discovery index
curl -H "Authorization: Bearer $TOKEN" "$BASE/items?limit=2"         # first page of items
curl -H "Authorization: Bearer $TOKEN" "$BASE/items/item-esp32"      # one item + detail
curl -H "Authorization: Bearer $TOKEN" "$BASE/locations"             # browse locations
curl -H "Authorization: Bearer $TOKEN" "$BASE/categories/cat-electronics"
curl -H "Authorization: Bearer $TOKEN" "$BASE/capabilities"          # the cap: vocabulary
curl -H "Authorization: Bearer $TOKEN" "$BASE/openapi.json"          # the spec
```

(Ids such as `item-esp32` / `cat-electronics` above are from the synthetic test fixture.) Each of
these needs `items:read` / `locations:read` / `categories:read` as appropriate — a token whose
owner lacks one gets a `403` for that route and keeps working for the rest.

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
`locationId, locationName, quantity`), `capabilities` (nestable: `key, valueNum, valueText, weight`),
`fieldValues` (nestable: `name, fieldType, value, source, inheritedFrom` — see
[Custom-field values](#custom-field-values-includefields)).

**Include groups** (aliases usable in `include`): `relations` (placements + capabilities +
categoryName), `pricing` (unitCost + purchasePrice), `lifecycle` (acquiredAt + warrantyExpiresAt +
purchasePrice + depreciationMonths), `reorder` (the three reorder fields), `timestamps`
(createdAt + updatedAt), `fields` (fieldValues), and `all` (every extended field).

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

### Custom-field values (`include=fields`)

Gubbins lets you define your own **custom fields** in the app and record values for them against
items *and* locations — a supplier reference, a datasheet URL, a shelf's label code, the entity id
of the light above a bin. `include=fields` exposes those values over the API, **read-only**, so an
integration can act on metadata you maintain in the app rather than in a parallel table of its own.

It works on the item endpoints (`/search`, `/items`, `/items/{id}`) and the location endpoints
(`/locations`, `/locations/{id}`), and adds a `fieldValues` array:

```bash
curl -H "Authorization: Bearer $TOKEN" "$BASE/items/item-esp32?include=fields"
curl -H "Authorization: Bearer $TOKEN" "$BASE/locations?include=fields"
curl -H "Authorization: Bearer $TOKEN" "$BASE/locations/loc-shelf-2?fields=id,name,fieldValues"
```

On an **item**, each entry is `{ name, fieldType, value, source, inheritedFrom }`:

```json
{
  "name": "Indicator Entity",
  "fieldType": "TEXT",
  "value": "light.shelf_two",
  "source": "inherited",
  "inheritedFrom": { "locationId": "loc-shelf-2", "locationName": "Shelf 2" }
}
```

`source` is `stored` (set on the item itself), `inherited` (taken from the nearest ancestor
location offering the field) or `default` (the field's default value), and `inheritedFrom` names
the location an inherited value came from. Inheritance is resolved by the app's own rules, so an
item reads exactly what you see on its detail screen.

On a **location**, each entry is `{ name, fieldType, value, isInheritable }` — the values the
location holds, with `isInheritable` showing whether it offers that value to the items stored
beneath it.

> **ℹ️ Note** Fields with no value are omitted, values are always returned as text (as the app
> stores them), and `fieldValues` never appears unless you ask for it — the default payloads are
> unchanged.

### OData-style query options

For callers already fluent in **OData**, the item endpoints accept a small, familiar subset of
the OData v4 query options. This is a **convenience alias layer, not a compliant OData service** —
there is deliberately no `$batch`, no `$apply`, and no navigation-property semantics, and the
`$metadata` document below is descriptive rather than a conformance claim (see
[the earlier discussion](#versioned-rest-api-apiv1) of why full OData isn't a fit for a
zero-dependency bridge). It adds **no dependency** and ships **nothing** to the PWA.

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

  Each entity type describes the **whole projectable shape**, which is wider than a default
  request returns — `GET /items` emits the summary field set, and the rest (`placements`,
  `capabilities`, `fieldValues`, the gauge, dimensions, pricing, …) is opt-in via
  `fields`/`include` or `$select`/`$expand`. So that a CSDL reader isn't misled into
  materialising columns that are always empty, every property outside its entity set's default
  payload carries an `Org.OData.Core.V1.Description` annotation saying it is opt-in, and each
  entity set is annotated with the exact field list an unprojected request returns. Note also
  that on the collection-valued properties `Nullable="false"` describes the *elements* (CSDL
  v4.01 §7.1.1) — the collection itself can never be null — and says nothing about whether the
  property is present.
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
refreshable table; `Web.Contents` lets you attach the token as a bearer header:

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
an `Authorization` header**, so — for this path *only* — the token may be supplied as a
`token` query parameter:

```
http://127.0.0.1:8787/api/v1/calendar.ics?token=<YOUR_TOKEN>
```

A token in a URL is a weaker posture than a header (URLs get logged by proxies and saved in
history), so this is deliberately scoped to the calendar path — every other endpoint still
requires the header. Keep the bridge's default **loopback** bind (or a trusted LAN) in mind, and
treat the subscribe URL as a secret. The `Authorization: Bearer` header still works too (e.g.
`curl`).

> **💡 Mint the subscribe URL's token against a narrow account.** Because the token in the URL
> is a *user's* token, it can do everything that user can — so a calendar subscription is a good
> reason to give the integration its own account whose role holds little beyond `bridge:read` and
> `bookings:read`. Revoke it in the app and the URL stops working immediately.

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
`GUBBINS_BRIDGE_*` flag**; they are always available, gated by the caller's
[token and permissions](#identities--permissions) — `items:read` for `/metrics`, `audit:view`
for the activity feeds.

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
      credentials: "<YOUR_TOKEN>"   # or credentials_file: /etc/prometheus/gubbins.token
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
**Model Context Protocol** server over **stdio** — separate from, and additive to, the HTTP
API. It wraps the *same* read-only core (the query core, the shared item-detail loader, and
the app's repositories), so an agent gets exactly the answers the HTTP API and the PWA give.

It is **read-only by default**: an agent can only read unless you opt in. Setting
**`GUBBINS_BRIDGE_ALLOW_WRITES=on`** — the *same* flag the HTTP endpoints use — additionally
exposes the two [stock-adjustment tools](#write-tools-opt-in), which round-trip through the
identical sync merge. With the flag off those tools are not built at all, so they are absent
from `tools/list` **and** uncallable.

Run it directly (it speaks JSON-RPC on stdin/stdout, so a human won't interact with it — an
MCP client launches it):

```bash
GUBBINS_SNAPSHOT_PATH=/path/to/your/synced/gubbins-sync.json node bridge/mcp.mjs
```

It reuses the same atomic snapshot watcher, so it answers from fresh data as the snapshot
changes. **Transport posture:** stdio is the launched process's own pipe — its trust boundary
is the OS process, so it carries **no credential at all** (only `GUBBINS_SNAPSHOT_PATH` is
required): there is no API token to present, no user to resolve, and therefore no permission
check. Anything it writes is attributed to the **System** user. All diagnostic logging goes to
**stderr**; stdout carries only the protocol.

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
stderr you'll see `Gubbins MCP server ready on stdio (read-only).` — or `(reads + limited
writes)` when the write opt-in is on. A missing snapshot file is
**non-fatal** — the server still starts and the tools return an "Inventory snapshot is not
loaded yet" message until the file appears, so you can wire everything up before the first
sync has written `gubbins-sync.json`.

### Tools

These six tools are **read-only** and always present. Each returns both human-readable `text`
content and a machine-usable `structuredContent`:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `gubbins_search` | `q` (required), `limit?`, `fields?`, `include?` | Relevance-ranked compact matches (top-N, max 25). Accepts a casual phrase or the power-user grammar (`cap:key>n`, `AND`/`OR`, …). `fields`/`include` [shape the result](#field-selection--extended-fields). |
| `gubbins_where_is` | `q` (required), `limit?` | The top matches with their per-location breakdown plus one spoken British-English sentence. |
| `gubbins_get_item` | `id` (required), `fields?`, `include?` | One item with `placements` and `capabilities`; `{ found: false }` if unknown. `fields`/`include` [shape the result](#field-selection--extended-fields); `include=fields` adds its [custom-field values](#custom-field-values-includefields). |
| `gubbins_list_locations` | `limit?`, `offset?`, `fields?`, `include?` | Paginated locations with live item counts. `include=fields` adds each location's [custom-field values](#custom-field-values-includefields). |
| `gubbins_list_categories` | `limit?`, `offset?` | Paginated categories with field counts. |
| `gubbins_list_capabilities` | `limit?`, `offset?` | The distinct `cap:` vocabulary you can filter on. |

The list tools clamp `limit` to `[1, 100]` (default 50); `gubbins_search`/`gubbins_where_is`
cap results at 25 (default 5) for safety. Tool ids/keys (e.g. `item-esp32`, `voltage`) in
examples are from the synthetic test fixture.

#### Stale-snapshot caveat

Like the HTTP surface, the MCP server keeps serving its **last good** snapshot when a reload
fails (the file is briefly absent, half-written or unreadable) rather than going dark. So that an
assistant doesn't present out-of-date figures as authoritative, a tool result run against a
[knowingly stale](#snapshot-freshness-and-health) snapshot is **prefixed with a short caveat**
(its own `text` content block, ahead of the data) noting the data may be out of date, how many
reloads have failed and when it was last read successfully. The `structuredContent` is left
untouched — the staleness is metadata about the answer, not part of it — and a healthy call is
never annotated. The threshold is the shared `GUBBINS_BRIDGE_STALE_AFTER_FAILURES` (default `3`;
`0` disables the caveat), so MCP trips at the same point `/health` flips `ok`.

### Write tools (opt-in)

Set **`GUBBINS_BRIDGE_ALLOW_WRITES=on`** and two more tools join the six above, letting an
agent adjust stock as well as read it ("I've used two of those" → the count drops):

| Tool | Arguments | Effect |
| --- | --- | --- |
| `gubbins_adjust_quantity` | `id`, `delta` (required), `note?` | Adjust a **DISCRETE** item's home-location stock by a signed whole number (negative = check out). |
| `gubbins_adjust_gauge` | `id`, `delta` (required), `note?` | Adjust a **CONSUMABLE_GAUGE** item's net value by a signed amount (clamped to `[0, capacity]`). |

Each maps 1:1 to the HTTP [write endpoints](#limited-writes-opt-in) and shares their machinery
exactly — the same single-flight executor, the same round-trip through the app's own mutation
code and the §7.3 sync merge, the same `note` bound (500 chars). There is no separate write
path here. A rejection (unknown id, wrong tracking mode, quantity below zero) comes back as a
tool result flagged `isError` carrying the reason, so the model can correct itself rather than
just failing. A `delta` of `0` is refused — a no-op still writes a history entry, so it is far
more likely a mistake than an intent.

The same source restriction applies: writes need a **JSON snapshot** source and are refused for
a raw `.sqlite` one (no sync channel to round-trip through), in which case the server logs why
and stays read-only.

> **⚠️ Understand the trust boundary before enabling this.** Unlike the HTTP API — where a
> request is a *user* whose role is enforced and whose writes are attributed to them — stdio has
> **no credential at all**: the boundary is the OS process, so *anything able to launch this
> server with the flag set can adjust your stock*, with no second credential and no permission
> check, and the adjustment is recorded against the System user. That is fine for an MCP
> client you configured yourself and reasonable for a local agent you trust; it is not a
> permission system. Leave the flag off in the client config unless you actively want an agent
> writing, and note that an agent can be steered by the content it reads. Writes are never
> destructive in the "lose data" sense — every adjustment is a delta recorded in the item's
> history, visible and reversible in the app — but they are still real changes to your
> inventory. On enabling, the server logs a loud `Writes ENABLED` line to stderr.

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
invisible). When on, writes use the **same tokens and rate limit** as reads, and the server
logs a clear "Writes ENABLED" line at startup. Keeping the bridge on the `127.0.0.1` default is
the safest posture; enabling writes **and** binding `0.0.0.0` is a deliberate double opt-in.

The flag is the **outer** bound, not the whole gate: with it on, a caller still needs
`bridge:write` + `stock:write` to adjust stock, and the adjustment is attributed to that token's
owner in the Activity Ledger. A read-only role holding a token gets a `403` here and carries on
reading. See [Identities & permissions](#identities--permissions).

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
(missing/unknown/revoked token), `403` (the owner's role lacks `bridge:write` or `stock:write`),
`404` (writes disabled, or no such item), `422` (`unprocessable` — the
change was rejected, e.g. quantity below zero or the wrong tracking mode), `429` (rate-limited),
`503` (snapshot briefly unavailable). The `/api/v1` index reports `"writable": true|false`.

### Example

```bash
TOKEN=<YOUR_TOKEN>          # its owner needs bridge:write + stock:write
BASE=http://127.0.0.1:8787/api/v1

# Check out two of an item (synthetic fixture id):
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"delta":-2,"note":"Taken to the workshop"}' \
  "$BASE/items/item-m3-bolt/adjust-quantity"
```

The change lands in the synced `gubbins-sync.json`; the PWA applies it on its next sync. The same
flag also exposes the equivalent [MCP write tools](#write-tools-opt-in), which share this exact
machinery — so enabling writes enables them on **both** surfaces.

## Snapshot push (opt-in)

The bridge normally **reads** `gubbins-sync.json` from a shared folder (the FS-Access sync). For a
user who does **not** use folder sync — no NAS, no synced drive — the PWA can instead **push** its
whole dataset straight to the bridge over HTTP, so no shared folder is needed at all. This is
**off by default** and a **separate** opt-in from the [limited writes](#limited-writes-opt-in)
above — but **not a lesser one**.

> **⚠️ Push is a wider privilege than writes — not a milder one.** A write applies a single
> **bounded, reversible** stock delta to one item. A push merges caller-supplied content into the
> **whole** served dataset through the app's §7.3 reconcile, so a token holder who can push can
> reshape **any** row — items, locations, and even users and their permissions — and can delete via
> tombstones. Anything a write can do, a push can do too, and much more. The two are orthogonal
> *switches*, not orthogonal *risk levels*: enabling push trusts the caller **at least as much** as
> enabling writes. Gate it on the caller's account (`bridge:write` + `sync:write`) accordingly, and
> keep the bridge on the loopback default unless you mean to expose it.

> **Why it's still safe under sync.** The pushed body is the **same** versioned backup JSON the PWA
> already writes to a synced folder (`snapshotToBackupJson(buildLocalSnapshot(...))`), and the
> bridge validates it with the **same** format-version guard the watcher uses. It does **not** run
> any *caller-supplied* SQL — like the [limited writes](#limited-writes-opt-in), a push is treated
> as just another sync peer and **merged** into the served snapshot through the app's **own** §7.3
> reconcile (LWW / Delta-CRDT), so a change the bridge itself made in the meantime is not silently
> clobbered ([#154](https://github.com/BootBlock/Gubbins/issues/154)). The merged result is written
> back **atomically** (temp file + rename) and the unchanged watcher re-hydrates it. Only when there
> is nothing to merge into — a first push, or an unreadable served snapshot — is the pushed body
> placed verbatim.

### Enabling it

Set **`GUBBINS_BRIDGE_ALLOW_PUSH=on`**. When off, `POST /api/v1/snapshot` returns `404` (the
feature is invisible). When on, push uses the **same tokens and rate limit** as reads — and needs
`bridge:write` + `sync:write`, replacing the whole snapshot being a sync operation rather than a
stock edit — and the server logs a clear "Snapshot push ENABLED" line at startup. Like writes, push requires a
**JSON snapshot** source — it is **refused for a raw `.sqlite` source** (which is not the PWA sync
channel), so the path stays `404` there even with this set.

The body is capped at **`GUBBINS_BRIDGE_MAX_PUSH_BYTES`** (default **64 MiB**); it is streamed to a
temp file as it arrives, so an over-large upload is rejected (`413`) before it is all on disk. Lower
the cap on a constrained host (a Pi/NAS on an SD card).

### Endpoint

| Endpoint | Body | Effect |
| --- | --- | --- |
| `POST /api/v1/snapshot` | The versioned backup JSON (the bytes `snapshotToBackupJson` produces). | Validates and **merges** the push into the served snapshot (placed verbatim only when there is nothing to merge into), then writes the result **atomically**; the watcher re-hydrates it. Returns `{ ok, formatVersion, generatedAt }`. |

Status codes: `200` (accepted), `400` (malformed/non-JSON body), `401` (missing/unknown/revoked
token), `403` (the owner's role lacks `bridge:write` or `sync:write`),
`404` (push disabled, or a `.sqlite` source), `413` (`payload_too_large` — body over the cap),
`422` (`unprocessable` — a snapshot from a newer Gubbins build), `429` (rate-limited). The
`/api/v1` index reports `"pushable": true|false`.

### From the PWA

Open **Cloud Sync & backups** in the app, fill in the bridge **URL** and **token** under "Push to
bridge", and press **Push now** — the token being one you minted under **Users → an account →
API tokens**, whose owner holds `bridge:write` + `sync:write`. The URL/token are stored on that
device only (never synced, never committed). The MCP server stays **read-only** — push is HTTP-only, by design.

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
> a baseline and emits **nothing** — it never replays history as a burst. The **one exception**
> is the opt-in [`lookup.resolved` event](#lookup-events--read-triggered-opt-in-separate-flag),
> which is triggered by a *read* (somebody asking "where is X?") rather than by a change — see
> its section for why it has its own flag.

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

Set **`GUBBINS_BRIDGE_WEBHOOKS=on`**. Targets then come from **two sources, merged** — they are not
alternatives, and a bridge configured with both honours both:

1. **Subscriptions configured in the app.** The Webhooks screen in the PWA writes them to a synced
   table, and the bridge reads them out of the database it already hydrates — no new config
   endpoint, no new token, no new auth surface. These carry the richer model: an HTTP method, an
   event-type list, a filter, a payload template and extra headers.
2. **The operator's file / env list**, which predates the app-configured source and **stays
   supported**. Copy [`webhooks.example.json`](webhooks.example.json) → a **git-ignored**
   `webhooks.json`, or set the whole list inline via `GUBBINS_BRIDGE_WEBHOOKS_TARGETS` (which wins
   over the file). Each target is `{ "url", "secret", "events"? }` — omit `events` (or use `"*"`)
   to receive everything. These are always `POST`, always enabled, and always send the default
   envelope, so an existing receiver keeps seeing byte-identical bodies.

> **ℹ️ App-configured subscriptions arrive on the next sync, not instantly.** The bridge re-reads
> them from the snapshot on every hydration, so a subscription you just created starts delivering
> once the next sync or "push to bridge" reaches the bridge — not the moment you save it.

**The signing secrets live only in the git-ignored `webhooks.json` / `.env`, never in a committed
file.**

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

> **⚠️ A `GET` subscription carries no signature.** An app-configured subscription may choose
> `GET`, in which case the payload is flattened into query parameters and there is no body to sign.
> Authenticate those another way (a secret path segment, a receiver-side allowlist) or use `POST`.

#### `secret_ref` — keep the signing secret off the sync artefact

An app-configured subscription signs with **either** a secret stored in its own row **or** a
`secret_ref`, which stores only a **name**. `secret_ref` is the recommended option, and the one the
app steers to: the value lives here on the bridge — in the `"secrets"` block of your git-ignored
`webhooks.json`, or inline via `GUBBINS_BRIDGE_WEBHOOKS_SECRETS` (merged over the file) — and
**never enters the database, the sync artefact or a backup**. An in-row secret, by contrast,
travels with synced data, which typically means a NAS or a cloud drive.

```jsonc
// webhooks.json (git-ignored) — resolves a subscription whose secret_ref is "home-assistant"
{
  "secrets": { "home-assistant": "<YOUR_SIGNING_SECRET>" },
  "targets": []
}
```

> **⚠️ A `secret_ref` the bridge cannot resolve drops the subscription — it is never delivered
> unsigned.** The user asked for a signed webhook and their receiver is verifying signatures;
> silently downgrading would either fail confusingly at the receiver or succeed against one that
> treats a missing signature as acceptable. The bridge logs the **missing name** (never a value) —
> once, not on every hydration — and records it as a `blocked` row in the delivery log below, so a
> subscription
> that appears to do nothing has a visible reason rather than being a mystery.

#### The SSRF guard, and reaching a receiver on your LAN

A webhook URL is user-supplied and arrives over sync, and the bridge is the one component sitting on
the LAN — able to reach a router's admin page, a printer or a cloud instance's metadata service that
a browser never could. So by default the bridge **refuses to deliver** to loopback, link-local,
private and cloud-metadata destinations. A hostname is **resolved** before the check (every address
it maps to must be public) so pointing a public name at a private address does not slip through, and
a resolution failure is a refusal rather than a pass.

**Most self-hosted receivers are on the LAN, so this flag is the expected setup rather than an
override to be nervous about.** A Home Assistant instance at `homeassistant.local:8123`, or a
Node-RED flow on `localhost`, needs:

```bash
GUBBINS_BRIDGE_WEBHOOKS_ALLOW_PRIVATE=on
```

Be clear about what that opens: with it on, **any** subscription that reaches this bridge may
deliver to **any** address it can route to, including hosts on your network that are not the one you
had in mind. It is off by default for the same reason every other reaching capability is — the
capability exists, but never without someone saying so. Leave it off if every receiver is a public
HTTPS endpoint.

#### Extra headers a subscription may set

A subscription can attach static extra headers. Two families are **refused** and dropped
(the operator is told which, in a secret-free warning):

- **Credentials** — `authorization`, `proxy-authorization`, `cookie`, `set-cookie`. A subscription
  that could set these would be a way to aim *your* bridge at a third-party host carrying a header
  someone else chose: request forgery dressed as configuration.
- **Headers the deliverer computes** — the whole `X-Gubbins-*` family (letting a subscription set
  `X-Gubbins-Signature` would let it forge its own signature), plus `host`, `content-type`,
  `content-length`, `transfer-encoding` and `connection`.

The rule lives in [`../src/features/webhooks/headers.ts`](../src/features/webhooks/headers.ts) and
the bridge **imports it**, so the app's editor checks a header name as it is typed against the very
list enforced at delivery — there is one list, and it cannot drift.

#### `GET /api/v1/webhooks/deliveries` — the delivery log

The app's only window onto what its subscriptions actually did. It uses the **same tokens and
rate limit** as every other endpoint (needing `bridge:read` + `settings:read`, since it reports on
configuration rather than inventory), and takes two optional query parameters:

| Parameter | Meaning |
| --- | --- |
| `since` | Return only records with a `seq` greater than this — pass the highest `seq` you have already seen so a poll returns just what is new. Must be a non-negative integer. |
| `limit` | Cap the page size (a positive integer, clamped to **200**, which is also the default). |

```bash
curl -H "Authorization: Bearer <YOUR_TOKEN>" \
  "http://127.0.0.1:8787/api/v1/webhooks/deliveries?since=0&limit=50"
```

The response carries the page plus `latestSeq`, so a poller can advance its cursor even when the
page comes back empty. Records are **newest first** and deliberately carry **no secret, signature,
request header or query string**; the URL is reduced to its origin and path.

> **The log lives in bridge memory, and that is deliberate.** The bridge is read-only over a
> snapshot that is **swapped wholesale on every hydration**, so a delivery outcome written back into
> the database would simply be discarded by the next hydrate. Keeping the log here and letting the
> app read it is the only shape that works. It follows that the log is **bounded** (the most recent
> 200 deliveries) and does **not** survive a bridge restart. It is a debugging aid, not an audit
> trail — send deliveries somewhere durable if you need one.

> **⚠️ A `404` here means webhooks are off on this bridge** — deliberately distinct from a `200`
> with an empty list, which means webhooks are on and nothing has been delivered yet. The app says
> something different for each; conflating them would send someone hunting a delivery problem that
> is really a missing flag.

#### `POST /api/v1/webhooks/test` — fire a test event

Backs the app's "Send test event". It needs `bridge:write` + `settings:write` — firing no
inventory change, but making the bridge issue an outbound request on the operator's behalf. Post
the id of one app-configured subscription:

```bash
curl -X POST -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"subscriptionId":"<SUBSCRIPTION_ID>"}' \
  http://127.0.0.1:8787/api/v1/webhooks/test
```

**Everything but the event itself is real** — the subscription is read from the hydrated snapshot,
the real matcher decides whether it would be delivered, and the real deliverer (and therefore the
real SSRF guard and `secret_ref` resolution) issues it, writing a real delivery-log row. A shortcut
around any of that would report success for a subscription that never delivers.

The `200` body reports `outcome`, `status`, `attempts`, `detail` and the log row's `seq` (`null`
when no row was written — the `unmatched` outcome, meaning the subscription's own event types or
filter excluded the synthetic event). Three failure codes mean genuinely different things:

| Status | Meaning |
| --- | --- |
| `404` | Webhooks are not enabled on this bridge at all. |
| `422` | The subscription exists in the app but has not reached the bridge yet — it arrives on the next sync. |
| `400` | The request body was malformed or carried no `subscriptionId`. |

### SSE event stream

`GET /api/v1/events` holds the connection open and writes each event as a `data: <json>\n\n` frame
(with an `id:` line for resumption and periodic `: heartbeat` comments), using the **same tokens
+ rate limit** as every endpoint (`bridge:read`). Enable it with **`GUBBINS_BRIDGE_EVENTS=on`** — and it is
also implied by `GUBBINS_BRIDGE_WEBHOOKS=on` (the two share one pipeline). When neither is on the
path is a `404`.

> **One caveat on revocation.** The caller is identified when the request arrives, which is the
> right granularity everywhere except here: this response stays open indefinitely, so a stream
> authorised *before* a token was revoked keeps delivering until the connection drops. Every new
> request — including the reconnect an `EventSource` makes on its own — is refused immediately.
> Tearing streams down on each re-hydration would close the gap and would also disconnect every
> consumer on each ordinary sync, which is a worse trade for a read-only feed of change events.

```bash
curl -N -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/v1/events
```

Resume after a disconnect with the standard `Last-Event-ID` header, or a `?lastEventId=<id>` query
param for clients that can't set it; events still buffered after that id are replayed on connect.
A browser `EventSource` receives every event via `onmessage` (the type is in the JSON payload). The
concurrent-stream count is capped (a `429` past the cap).

### Lookup events — read-triggered (opt-in, separate flag)

> **⚠️ This event class is triggered by a *read*, not by a change.** Every other bridge event
> comes from a new row in the `item_history` ledger: something in your inventory changed.
> `lookup.resolved` is the exception — it fires when somebody **asks where something is**, and
> nothing was written. That is the point: an automation can react to the *question* (light the
> shelf the answer names, wake a display, log the request). It also means the event **publishes
> the search text**, which is why it has its own flag and is never implied by
> `GUBBINS_BRIDGE_EVENTS`.

Set **`GUBBINS_BRIDGE_LOOKUP_EVENTS=on`** (default `off`). It rides the sinks you already have —
SSE, webhooks, MQTT — so a lookup event reaches them exactly like any other; with no sink enabled
there is nowhere to publish and nothing is sent. Enabling the SSE stream, webhooks or MQTT does
**not** turn it on, and turning it on does **not** enable the SSE stream.

Every `GET /where` / `GET /api/v1/where` that **matched at least one item** emits one event:

```json
{
  "id": "lookup:4f2a91c0d7be1a35:1751004800000",
  "type": "lookup.resolved",
  "occurredAt": "2026-06-27T06:13:20.000Z",
  "data": {
    "query": "M3 screws",
    "itemIds": ["item-m3-bolt", "item-m3-washer"],
    "locationIds": ["loc-drawer-a", "loc-bin-4"],
    "matches": [
      {
        "itemId": "item-m3-bolt",
        "itemName": "M3 Bolt",
        "placements": [{ "locationId": "loc-drawer-a", "locationName": "Drawer A", "quantity": 42 }]
      }
    ]
  }
}
```

`itemIds` and `locationIds` are the **flattened, de-duplicated unions** across every match — trigger
an automation on those rather than walking `matches`. Placements carry a **location id** as well as
a name, so a consumer can act on the answer instead of string-matching a label.

**A lookup that matched nothing emits no event.** There would be no location for an automation to
act on, so the event could only ever no-op — and it keeps queries that found nothing, the most
revealing thing a lookup could publish, off the wire entirely. The Home Assistant integration
suppresses the same case, so the two paths always agree. A consumer can therefore assume
`matches`, `itemIds` and `locationIds` are **non-empty** on every event it receives.

**The `id` derivation.** The published contract is "the id is deterministic, so a sink can dedupe";
a ledger event satisfies it with the ledger row's id, and there is no ledger row here. So a lookup
id is derived from the **resolved answer plus the debounce window**:

```
lookup:<first 16 hex of sha256(normalisedQuery + "|" + itemIds + "|" + locationIds)>:<windowStartEpochMs>
```

where `normalisedQuery` is the query trimmed, whitespace-collapsed and lower-cased, and the id lists
are comma-joined in payload order. The same question resolving the same way inside one window always
produces the same id — so deduping on `id` behaves exactly as it does for change events.

**Debouncing.** Voice assistants retry and people rephrase, so repeated **equivalent** lookups — the
same normalised query resolving to the same items in the same locations — emit **once** per window
(default **3 s**, set by `GUBBINS_BRIDGE_LOOKUP_EVENTS_DEBOUNCE_MS`; `0` disables it). The window is
anchored at the emission that opened it, so a stream of retries cannot keep pushing it back. A
different question, or the same wording now resolving somewhere else, emits immediately.

> **ℹ️ Privacy note.** This is the only bridge event that publishes what someone *searched for*
> rather than what the inventory *is*. Whatever you point it at — a broker, a webhook endpoint, a
> log — will see those queries. That is exactly why it is a separate, explicit opt-in.

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
| `gubbins/status` | yes | `online` / `offline` — the availability topic (also the MQTT Last-Will, so an ungraceful death flips it to `offline` automatically). Tracks **connection liveness** only: it stays `online` while the bridge keeps serving its last good data. |
| `gubbins/summary/state` | yes | `{ itemsTotal, lowStockItems, outOfStockItems, locationsTotal, generatedAt }` — refreshed on every snapshot change. |
| `gubbins/snapshot/state` | yes | `{ stale, reloadFailures, lastReloadAt, lastReloadError, lastReloadErrorAt }` — the [snapshot-freshness](#snapshot-freshness-and-health) verdict, the MQTT sibling of `/health`. Unlike the topics above it is **also published from the reload *failure* path**, so it still updates when the summary/location topics have frozen at their last good values. |
| `gubbins/location/<id>/state` | yes | `{ id, name, itemCount, attributes }` — one per **user** location (the built-in `Unassigned` / `In Transit` buckets are omitted). See [location attributes](#location-attributes-your-custom-fields) below. |
| `gubbins/event/<type>` | no | The EI-1 change event (the [same shape](#the-event-shape) the webhooks/SSE emit), e.g. `gubbins/event/item.low_stock`. Transient — a late subscriber doesn't replay history. |
| `gubbins/locate` | **no** | The resolved answer to a "where is X?" lookup. Needs `GUBBINS_BRIDGE_LOOKUP_EVENTS=on` — see [the locate topic](#the-locate-topic-where-is-x-for-automations) below. Transient, deliberately. |

State is **retained** so a subscriber (or Home Assistant) that connects after the bridge sees the
last-known values immediately. The low-stock / out-of-stock counts use the exact same rule as the
`item.low_stock` / `item.out_of_stock` events, so they never drift. Every published payload is
synthetic-safe: it carries only inventory facts — your inventory's own data, including the custom
fields described next — and never the token or the broker credentials.

Staleness is deliberately kept **off the availability topic**. Availability tracks whether the
bridge process is *there*; a bridge that can no longer reload the snapshot is still there and still
serving its last good data, so overloading `status` with `offline` would make every entity vanish
from a dashboard (and leave history gaps) the moment a sync folder blips. Instead the freshness
verdict rides its own `snapshot/state` topic and, with discovery on, a *Snapshot stale* binary
sensor — so the data going stale is a signal you can alert or automate on, while the entities stay
present. If you *want* entities to disappear on staleness, template an HA `availability` off that
binary sensor yourself.

### Location attributes (your custom fields)

Each location's state payload carries an `attributes` object holding the **custom-field values that
location holds** — the app's field dictionary. That is what lets an automation read "which lamp is
above this shelf" straight off the location, instead of you keeping a parallel mapping table in your
automation config:

```json
{
  "id": "loc-bin-42",
  "name": "Bin 42",
  "itemCount": 7,
  "attributes": { "ha_entity": "light.bin_42", "aisle": "B" }
}
```

Field names are lower-cased with anything non-alphanumeric collapsed to `_`, so a field called
`HA Entity` reads as `ha_entity`. A location with no custom fields publishes `"attributes": {}` — the
key is always there, so a template never has to guard for it. Empty values are omitted, and if two
field names normalise to the same key the first (by field name) wins.

> **⚠️ Upgrading an existing MQTT setup?** Location attributes ride on the state topic whenever
> MQTT publishing is on — there is **no separate flag** for them. So if you were already running
> with `GUBBINS_BRIDGE_MQTT=on` before this existed, your locations' custom-field values begin
> reaching your broker as soon as you upgrade, without you changing any configuration.
>
> That is the point of the feature, and a broker you run yourself is exactly where this data is
> meant to go. But it is worth a moment's thought if a location holds a field you would rather not
> publish — a door code, an insurance valuation, a supplier's pricing. **Every** custom-field value
> a location holds is published, not a chosen subset, and there is currently no way to exclude one
> field while keeping the others. Until there is, the options are: don't record that kind of detail
> on a *location* (an item field is not published this way), restrict the topic with a broker ACL,
> or leave MQTT publishing off.
>
> Nothing else changed: item custom fields are **not** pushed to MQTT, and no field of any kind is
> readable over HTTP unless a caller explicitly asks for it.

With [discovery](#home-assistant-mqtt-discovery-no-custom-component) on, these arrive as **entity
attributes** on `sensor.gubbins_location_<id>`, so an automation reads them directly:

```yaml
# turn on whichever light the location's "HA Entity" field names
service: light.turn_on
target:
  entity_id: "{{ state_attr('sensor.gubbins_location_bin_42', 'ha_entity') }}"
```

### The locate topic: "where is X?" for automations

With **`GUBBINS_BRIDGE_LOOKUP_EVENTS=on`** (the same flag as
[lookup events](#lookup-events--read-triggered-opt-in-separate-flag) — there is no separate one), a
resolved "where is X?" lookup is also published to a single fixed topic, `gubbins/locate`, with the
answer flattened to the top level:

```json
{
  "id": "lookup:0123456789abcdef:1751000000000",
  "occurredAt": "2025-06-27T07:33:20.000Z",
  "query": "solder",
  "itemIds": ["item-solder"],
  "locationIds": ["loc-bin-42"],
  "matches": [
    {
      "itemId": "item-solder",
      "itemName": "Solder 0.7mm",
      "placements": [{ "locationId": "loc-bin-42", "locationName": "Bin 42", "quantity": 3 }]
    }
  ]
}
```

Combined with the location attributes above, that is a complete "ask where it is, light that bin"
path in **Node-RED or a plain MQTT trigger, with no `custom_components/gubbins` installed**: trigger
on `gubbins/locate`, read `locationIds[0]`, and look up that location's `ha_entity` attribute.
(The event also still appears on `gubbins/event/lookup.resolved` in its untouched event shape, for
anything consuming the event stream generically.)

> **⚠️ Transient, not retained — deliberately.** Unlike the state topics, `gubbins/locate` is
> published **without** the retain flag, and never will be. A retained locate message would be
> re-delivered to every client that connects later, so restarting Home Assistant at midnight would
> light a bin over a question somebody asked at lunchtime. It answers a question asked *now*, so it
> exists only for whoever is listening now.

With the flag off — its default — nothing is ever published to `gubbins/locate`.

### Home Assistant MQTT discovery (no custom component)

Set **`GUBBINS_BRIDGE_MQTT_DISCOVERY=on`** to *also* publish Home Assistant
[MQTT-discovery](https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery) configs
(retained, under the `homeassistant/` prefix — override with `GUBBINS_BRIDGE_MQTT_DISCOVERY_PREFIX`).
Home Assistant then **auto-creates** the entities with **no `custom_components/gubbins` at all** —
this is an *alternative* to the [custom component](../homeassistant/README.md); pick one. It creates,
under a single "Gubbins" device: `sensor.gubbins_items_total`, `sensor.gubbins_low_stock_items`,
`sensor.gubbins_out_of_stock_items`, `sensor.gubbins_locations_total`, a
`binary_sensor.gubbins_low_stock` (problem class, `on` when anything is low), a
`binary_sensor.gubbins_snapshot_stale` (problem class, `on` when the bridge is knowingly serving
[out-of-date data](#snapshot-freshness-and-health), with the reload counters as entity attributes),
and one `sensor.gubbins_location_<id>` per user location — each carrying that location's
[custom fields as entity attributes](#location-attributes-your-custom-fields). The discovery layout is re-published whenever a
location is added/removed/renamed and on every reconnect (so a broker that restarted without
persistence re-learns it). Entity names are **device-relative** — Home Assistant prefixes the
"Gubbins" device name itself, so they display as *Gubbins*, *Gubbins Low stock items*, *Gubbins
Location Store Room* and so on, never doubled up.

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

### Finding Home Assistant instead of typing its URL (opt-in)

The bridge already advertises *itself* over mDNS (see [mDNS / zeroconf discovery](#mdns--zeroconf-discovery))
so Home Assistant can find it. This is the reverse: rather than typing `GUBBINS_BRIDGE_HA_URL` and
finding out at startup that you mistyped it, let the bridge ask the LAN where Home Assistant is.

```bash
GUBBINS_BRIDGE_HA=on
GUBBINS_BRIDGE_HA_DISCOVERY=on
GUBBINS_BRIDGE_HA_TOKEN=<YOUR_HOME_ASSISTANT_TOKEN>
# GUBBINS_BRIDGE_HA_URL left unset — the bridge fills it in
```

```text
Home Assistant discovery: looking for an instance on the LAN over mDNS…
Home Assistant discovered on the LAN: "Home" at http://homeassistant.local:8123.
```

**Off by default**, like everything else that touches the network. Three things to know:

- **An explicit URL always wins.** Set `GUBBINS_BRIDGE_HA_URL` and discovery is skipped entirely —
  it only ever supplies a *default* for a value you left unset.
- **It finds an address, not a credential.** A discovered instance is a suggestion, not a trust
  decision: your long-lived access token is still required, and the bridge still cannot call a Home
  Assistant service. Nothing about what the integration can do changes.
- **Nothing answering is not fatal.** The bridge waits about 2.5 seconds, logs that it found
  nothing, and starts anyway with the scale endpoints unavailable — exactly as it would with no URL
  configured. Set the URL directly and restart.

Home Assistant is asked over the same standard `_home-assistant._tcp` service it advertises to
every other device on your network, and the bridge prefers the *internal* URL Home Assistant
publishes for itself (falling back to the advertised host and port).

### Startup check

When this capability is enabled, the bridge checks Home Assistant once at startup — it lists states
and throws the result away — so a wrong URL or a revoked token is reported in the log immediately
rather than the first time someone opens **Count by weight**:

```text
Home Assistant reachable at http://homeassistant.local:8123 and the access token was accepted.
Home Assistant at http://homeassistant.local:8123 REJECTED the access token — check GUBBINS_BRIDGE_HA_TOKEN …
Home Assistant at http://homeassistant.local:8123 could not be reached — check GUBBINS_BRIDGE_HA_URL …
```

The check **never blocks or fails startup**: it runs after the bridge is already listening, so a
Home Assistant that is still booting (or down entirely) costs the bridge's other capabilities
nothing. A failure is a warning; fix the setting and restart, or just try a reading. Only the base
URL you configured is logged — the token never is.

### Timeouts and retries

One read is given a **5-second total budget**, split across **two attempts** (about 2.4s each) with
a 200 ms pause between them. A single busy moment in Home Assistant — an integration reloading, a
recorder flush — therefore recovers silently, while an instance that is genuinely down still reports
in about five seconds rather than ten.

A retry only happens where it could plausibly help: a timeout, a transport failure, or a `5xx` from
Home Assistant. A rejected token (`401`/`403`) or an unknown entity (`404`) is deterministic and
answered on the first attempt.

### Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/scale/entities` | `{ entities: [{ entityId, name, unit }] }` — every entity reporting a convertible mass unit, for the app's scale picker. |
| `GET /api/v1/scale/state?entity_id=…` | `{ entityId, grams, value, unit, lastUpdated }` — the current reading, reconciled to canonical **grams**. |

Both use the same tokens and rate limit as every other endpoint, and both require `bridge:read`
(they read Home Assistant, not your inventory, so no subject permission applies).

> **⚠️ These two no longer answer before a snapshot has loaded.** They used to — reading Home
> Assistant rather than your inventory, they needed no data of their own. But identifying the
> caller does: the tokens live in the snapshot, so until it loads there is nobody to
> authenticate and these paths answer `503` like everything else. See
> [Identities & permissions](#identities--permissions).

### Only scales can be read, and unknown units are refused

`state` will only read an entity that qualifies as a scale — one reporting a unit the bridge can
convert. **Any other entity, or one that doesn't exist, answers `404` exactly like a missing
entity.** That is deliberate: the token is scoped to your inventory and this one Home Assistant
capability, so the endpoint must not double as a way to probe the rest of your home. A light, a
thermostat or a presence sensor is indistinguishable from an entity that was never there — the
bridge never reports its state, its unit, or when it last changed.

Gubbins stores mass canonically in grams; a scale reports whatever unit its integration chose. The
bridge converts `mg`, `g`, `kg`, `oz`, `lb` and `st` — and treats anything else as **not a scale**
(so, a `404`) rather than guessing. That strictness is deliberate: a mis-read unit would not
produce a slightly-wrong number, it would multiply the resulting stock count by a factor of a
thousand.

A **genuine** scale that can't be read right now is a `409`, never a `200` with a zero weight:

| Code | Meaning |
| --- | --- |
| `scale_unavailable` | The scale is off, asleep, or its integration has lost the connection. |
| `scale_not_a_number` | The sensor isn't reporting a numeric weight right now. |
| `home_assistant_unreachable` / `home_assistant_unauthorised` | The bridge couldn't reach Home Assistant, or the token was rejected. |

### Using it in the app

In Gubbins, open an item → **Count by weight**. When a bridge with this capability is configured
(Settings → the same bridge URL and token used for "push to bridge"), the dialog gains a **scale
picker** and a **Read the scale** button; the reading lands in the "Weight on scale" field, in
your chosen weight unit, and everything after that — the tare, the count, the confidence band —
works exactly as it does for a typed figure.

## Permission & security matrix

This is the **single authoritative list** of what the bridge can do and how you turn each
capability on. There are **two independent gates**, and both must let a request through:

1. **What the operator enabled** — the `GUBBINS_BRIDGE_*` capability flags, set in the
   environment where the bridge runs. The design rule is **read-only by default,
   per-capability opt-in**: with **no capability flag set**, the bridge only ever *reads* your
   snapshot and *serves* read endpoints — it never writes your inventory and never connects out.
   Each capability below is a **separate, deliberate opt-in** that defaults **off** and is
   **logged as an explicit choice at startup**, so what you've enabled is always visible.
2. **Who is asking** — the [identity behind the presented API token](#identities--permissions)
   and the permissions their role holds. This gate can only ever **narrow** the first: a route
   the operator disabled is a `404` for everyone, however permissive the role.

So the flags describe the bridge's *maximum* reach, and the caller's role describes their share
of it. The two are set in different places by design: the operator's choices live where the
bridge runs and need a restart; the caller's live in the app and take effect as soon as the
change reaches the snapshot.

**Always on (no flag) — reads only.** These are pure read *pulls*; they cannot mutate inventory
and open no outbound connection, so they carry no opt-in flag. Each is still gated on its
caller's permissions (the calendar and feeds additionally accept the token as a `?token=` query
parameter — see their sections):

| Surface | Path | Requires | Notes |
| --- | --- | --- | --- |
| REST API + discovery/OpenAPI | `GET /health`, `/search`, `/where`, `/api/v1/*` | `bridge:read` + the route's subject | Read-only; field-selection + OData-style options. See [what each route requires](#what-each-route-requires). |
| Custom-field values | `GET /api/v1/{items,locations}…?include=fields` | as the underlying route | Read-only; **opt-in per request** — your custom fields are returned only when a caller asks with `include=fields`, never in a default payload. |
| CSV export | `GET /api/v1/items.csv` | `bridge:read` + `items:read` | Refreshable spreadsheet pull. |
| Calendar subscription | `GET /api/v1/calendar.ics` | `bridge:read` + `bookings:read` | `?token=` accepted (calendar clients can't send headers). |
| Syndication feeds | `GET /api/v1/activity.{rss,atom,json}` | `bridge:read` + `audit:view` | `?token=` accepted. The feeds publish the audit trail, hence `audit:view`. |
| Prometheus metrics | `GET /metrics` | `bridge:read` + `items:read` | Header-only token (no `?token=`). |
| MCP server | stdio (`mcp.mjs`) | — | **No credential and no permission check** — the trust boundary is the OS process; writes are attributed to the System user. |

**Opt-in capabilities — each its own flag, all default `off`.** "Writes inventory?" means the
capability can change your stock (always via the app's own §7.3 sync merge — never bespoke SQL);
"Direction" is whether the capability serves *in*, sends *out*, or advertises on the LAN:

| Flag (`GUBBINS_BRIDGE_…`) | Turns on | Direction | Writes inventory? | Caller must also hold / secrets |
| --- | --- | --- | --- | --- |
| `ALLOW_WRITES` | [Limited stock writes](#limited-writes-opt-in) — `POST /api/v1/items/{id}/adjust-quantity` \| `/adjust-gauge`, plus the matching [MCP write tools](#write-tools-opt-in) (JSON source only). | inbound (HTTP + MCP stdio) | **Yes** — check-in/out & gauge adjust, round-tripped through the sync merge, attributed over HTTP to the token's owner. | `bridge:write` + `stock:write` over HTTP — the flag opens the route, the role decides who may use it. The MCP tools have **no credential and no permission check** (stdio's boundary is the OS process), so enabling this trusts whoever can launch the server. No new operator secret. |
| `ALLOW_PUSH` | [Snapshot push](#snapshot-push-opt-in) — `POST /api/v1/snapshot` (the PWA "push to bridge"; JSON source only). | inbound (HTTP) | **Yes — wider than `ALLOW_WRITES`.** Merges a caller-supplied snapshot into the **whole** served dataset through the app's §7.3 reconcile (no *bespoke* SQL), so it can reshape **any** row — not just a bounded stock delta. | `bridge:write` + `sync:write`. No new operator secret. |
| `EVENTS` | [SSE event stream](#events-webhooks--sse-opt-in) — `GET /api/v1/events`. | outbound (pull) | No — read-only change events. | `bridge:read`. No new operator secret. |
| `LOOKUP_EVENTS` | [Read-triggered lookup events](#lookup-events--read-triggered-opt-in-separate-flag) — one `lookup.resolved` per resolved "where is X?" lookup, published to whichever sinks you enabled; with MQTT on, also to the transient [`gubbins/locate`](#the-locate-topic-where-is-x-for-automations) topic. | outbound (push) | No — it is a read; nothing is written. | Nothing beyond the lookup itself — but it publishes the **search text**, so it is deliberately **not** implied by `EVENTS`. |
| `WEBHOOKS` | [Outbound signed webhooks](#events-webhooks--sse-opt-in) (also implies `EVENTS`). Targets are the webhooks configured **in the app** (read from the snapshot the bridge already hydrates) merged with the operator's file/env list. Adds the read-only `GET /api/v1/webhooks/deliveries` log and `POST /api/v1/webhooks/test` (fires a synthetic event at one subscription through the real delivery path). | outbound (push) | No — an event never mutates inventory. | `bridge:read` + `settings:read` for the delivery log; `bridge:write` + `settings:write` to fire a test. Signing secrets in the **git-ignored** `webhooks.json` / `GUBBINS_BRIDGE_WEBHOOKS_TARGETS` / `GUBBINS_BRIDGE_WEBHOOKS_SECRETS` / `.env` only. An app-configured webhook may name a secret held here (`secret_ref`) so its value never enters the database; an **unresolvable** ref drops that subscription rather than delivering it unsigned. Delivery to loopback/private/metadata addresses is **refused** unless `GUBBINS_BRIDGE_WEBHOOKS_ALLOW_PRIVATE=on`. |
| `MQTT` | [Outbound MQTT publishing](#mqtt-publishing-opt-in) — state + events to your broker (a *client* dialling out; no inbound port). Location state includes that location's [custom-field values as attributes](#location-attributes-your-custom-fields) — **all of them, automatically, with no separate flag**, so enabling `MQTT` is what consents to publishing them. | outbound (push) | No — publishes read-only facts only. | Broker `…_MQTT_USERNAME` / `…_MQTT_PASSWORD` in `.env` only; **never logged**. |
| `MQTT_DISCOVERY` | [Home Assistant MQTT discovery](#home-assistant-mqtt-discovery-no-custom-component) configs (sub-flag of `MQTT`), including the location attributes above. | outbound (push) | No. | None new (uses the MQTT connection above). |
| `HA` | [Home Assistant reads](#home-assistant-reads-opt-in) — `GET /api/v1/scale/{entities,state}`, so "count by weight" can read a scale entity. | outbound (pull) | No — reads a weight; the resulting stock change is the user's own action in the app. | `bridge:read`. Home Assistant `…_HA_TOKEN` in `.env` only; **never logged, never sent to the app**. |
| `MDNS` | [mDNS / zeroconf advertising](#mdns--zeroconf-discovery) so HA can auto-discover the bridge (auto-skipped on the loopback default). | LAN advertisement | No — announcement only. | **None** — no credential is **ever** advertised. |

Notes that apply across the table:

- **Writes/push require a JSON snapshot source.** With a raw `.sqlite` source the write and push
  paths stay `404` **even with the flag on** (there is no sync channel to round-trip through) —
  see [Data sources](#data-sources-json-snapshot-or-raw-sqlite).
- **No secret is ever advertised, logged, or committed.** Signing secrets and broker credentials
  live only in the git-ignored `.env` / `webhooks.json`; `.env.example` and `webhooks.example.json`
  hold placeholders only. API tokens and item data are never written to the logs, and the bridge
  stores only a **hash** of each token, never the token itself.
- **Enabling an outbound/write capability and binding the LAN (`GUBBINS_BRIDGE_HOST=0.0.0.0`) is a
  deliberate double opt-in.** The safest posture keeps the bridge on the `127.0.0.1` default.
- **Access is granted and withdrawn in the app, not here.** No flag in this table mints, widens or
  revokes a caller's access — that is a token and a role, both managed in Gubbins, both taking
  effect as soon as the change reaches this bridge's snapshot.

The full environment-variable reference (including the non-capability tuning knobs — host, port,
rate limits, topic prefixes, byte caps) follows.

## Configuration reference

The server is configured **entirely from the environment**, so no secret or local path is
ever committed. `serve.mjs` loads a git-ignored `bridge/.env` if present, otherwise it reads
the ambient process environment (so systemd/Docker can supply the values instead).

> **ℹ️ There is no inbound token setting.** Callers authenticate with a
> [per-user API token minted in the app](#identities--permissions), which reaches the bridge in
> the snapshot it already watches — so granting or revoking access needs neither an `.env` edit
> nor a restart. The only credentials configured here are the *outbound* ones the bridge presents
> to your broker and to Home Assistant.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GUBBINS_SNAPSHOT_PATH` | **yes** | — | Absolute path to the data source: either the synced `gubbins-sync.json` the PWA writes, **or** a raw exported `.sqlite` database. The kind is auto-detected (extension + magic bytes) — see [Data sources](#data-sources-json-snapshot-or-raw-sqlite). |
| `GUBBINS_BRIDGE_HOST` | no | `127.0.0.1` | Bind address. `127.0.0.1` = loopback only. Set `0.0.0.0` to **deliberately** expose on the LAN (logged as a warning). |
| `GUBBINS_BRIDGE_PORT` | no | `8787` | TCP port. |
| `GUBBINS_BRIDGE_RATE_CAPACITY` | no | `60` | Per-client burst (requests back-to-back). `0` disables the rate limiter entirely. |
| `GUBBINS_BRIDGE_RATE_REFILL` | no | `1` | Per-client sustained rate (requests/second) once the burst is spent. |
| `GUBBINS_BRIDGE_ALLOWED_ORIGINS` | no | *(hosted app)* | Comma-separated list of **browser origins** allowed to read a bridge response cross-origin (CORS). Defaults to the hosted app origin `https://bootblock.github.io`; **loopback origins (a dev server) are always allowed on top**. Add your own PWA origin here if you self-host the app on another domain and use "push to bridge" from the browser. Set to `*` to restore the old permissive wildcard. Only browsers are affected — a non-browser client (Home Assistant, `curl`, a scrape) sends no `Origin` and is unaffected. See [Cross-origin (CORS) policy](#cross-origin-cors-policy). |
| `GUBBINS_BRIDGE_MDNS` | no | `off` | Advertise over mDNS so Home Assistant can auto-discover the bridge. `on` to enable. Carries **no secret**; only meaningful when LAN-exposed (auto-skipped on the loopback default). See [mDNS / zeroconf discovery](#mdns--zeroconf-discovery). |
| `GUBBINS_BRIDGE_MDNS_NAME` | no | `Gubbins Bridge` | Service instance name shown in a discovery browser. |
| `GUBBINS_BRIDGE_ALLOW_WRITES` | no | `off` | Enable the opt-in [limited write endpoints](#limited-writes-opt-in) (stock check-in/out, quantity adjust) **and the matching [MCP write tools](#write-tools-opt-in)**. **Off by default — the bridge is read-only unless this (or `GUBBINS_BRIDGE_ALLOW_PUSH`) is `on`.** HTTP writes additionally need the caller to hold `bridge:write` + `stock:write`; the MCP tools are gated by process launch alone (stdio carries no credential). |
| `GUBBINS_BRIDGE_ALLOW_PUSH` | no | `off` | Enable the opt-in [snapshot-ingest endpoint](#snapshot-push-opt-in) (`POST /api/v1/snapshot`, the PWA "push to bridge"). **Off by default**; a **separate** opt-in from writes but a **strictly wider privilege** — a push merges caller-supplied content into the **whole** dataset, not a bounded stock delta, so treat it as at least as sensitive as writes. JSON source only. Same rate limit; the caller needs `bridge:write` + `sync:write`. |
| `GUBBINS_BRIDGE_MAX_PUSH_BYTES` | no | `67108864` | Hard cap (bytes) on a pushed snapshot; default 64 MiB. An over-large push is rejected with `413`. Lower it on a constrained host. |
| `GUBBINS_BRIDGE_STALE_AFTER_FAILURES` | no | `3` | Consecutive failed snapshot reloads before [`/health`](#snapshot-freshness-and-health) reports the served data as stale (`ok: false`). `0` keeps the counters but never flips `ok`. |
| `GUBBINS_BRIDGE_EVENTS` | no | `off` | Enable the opt-in read-only [SSE event stream](#events-webhooks--sse-opt-in) at `GET /api/v1/events`. **Off by default** (the path is `404` when off). Implied by `GUBBINS_BRIDGE_WEBHOOKS`. Same rate limit; the caller needs `bridge:read`. |
| `GUBBINS_BRIDGE_LOOKUP_EVENTS` | no | `off` | Also emit the **read-triggered** [`lookup.resolved` event](#lookup-events--read-triggered-opt-in-separate-flag) when a "where is X?" lookup resolves. **Off by default and deliberately NOT implied by `GUBBINS_BRIDGE_EVENTS`** — it publishes the search text, so it is its own explicit choice. Needs a sink (SSE / webhooks / MQTT) to reach. |
| `GUBBINS_BRIDGE_LOOKUP_EVENTS_DEBOUNCE_MS` | no | `3000` | Window (ms) in which repeated **equivalent** lookups emit once. Clamped to `[0, 600000]`; `0` disables debouncing. |
| `GUBBINS_BRIDGE_WEBHOOKS` | no | `off` | Enable opt-in signed [outbound webhooks](#events-webhooks--sse-opt-in). **Off by default**; also lights up the event stream (shared pipeline). A webhook never mutates inventory. |
| `GUBBINS_BRIDGE_WEBHOOKS_FILE` | no | `webhooks.json` | Path to the **git-ignored** JSON webhook-target list. The target **secrets live only here** — never in a committed file. |
| `GUBBINS_BRIDGE_WEBHOOKS_TARGETS` | no | — | The whole target list inline as JSON (wins over the file). Carries secrets, so keep it in the git-ignored `.env` only. |
| `GUBBINS_BRIDGE_WEBHOOKS_SECRETS` | no | — | Inline JSON `{ "name": "secret" }` map resolving the secret **name** an app-configured webhook may sign with, so the value never enters the database (and therefore never the sync artefact or a backup). Merged over any `"secrets"` block in the targets file. A webhook naming a secret that is not configured is **not delivered** — never delivered unsigned. Keep it in the git-ignored `.env` only. |
| `GUBBINS_BRIDGE_WEBHOOKS_ALLOW_PRIVATE` | no | `off` | Allow webhook delivery to loopback, link-local, private and cloud-metadata addresses. **Off by default** — a webhook URL is user-supplied and arrives over sync, and the bridge sits on the LAN, so this is the feature's primary SSRF control. Turn it on to reach your own Home Assistant / Node-RED on the LAN. |
| `GUBBINS_BRIDGE_MQTT` | no | `off` | Enable opt-in [outbound MQTT publishing](#mqtt-publishing-opt-in) (state + events to your broker). **Off by default**; outbound-only (no inbound port). Does **not** expose the SSE HTTP endpoint. |
| `GUBBINS_BRIDGE_MQTT_URL` | when MQTT on | — | Broker URL: `mqtt://host:port` (plaintext, default port 1883) or `mqtts://host:port` (TLS, default 8883). Any `user:pass@` in the URL is ignored — use the vars below. |
| `GUBBINS_BRIDGE_MQTT_USERNAME` | no | — | Broker username. Keep it in the git-ignored `.env`. |
| `GUBBINS_BRIDGE_MQTT_PASSWORD` | no | — | Broker password. `.env` only; **never logged**. |
| `GUBBINS_BRIDGE_MQTT_PREFIX` | no | `gubbins` | Topic prefix every published topic hangs under. |
| `GUBBINS_BRIDGE_MQTT_CLIENT_ID` | no | `gubbins-bridge` | The MQTT client identifier. |
| `GUBBINS_BRIDGE_MQTT_DISCOVERY` | no | `off` | Also publish [Home Assistant MQTT-discovery](#home-assistant-mqtt-discovery-no-custom-component) configs so HA auto-creates entities with no custom component. Only meaningful when MQTT is on. |
| `GUBBINS_BRIDGE_MQTT_DISCOVERY_PREFIX` | no | `homeassistant` | HA discovery prefix (match HA's `discovery_prefix` if you changed it). |
| `GUBBINS_BRIDGE_HA` | no | `off` | Enable opt-in [Home Assistant reads](#home-assistant-reads-opt-in) so "Count by weight" can read a scale entity. **Off by default** (`/api/v1/scale/*` is `404` when off). Outbound-only and read-only — the bridge cannot call a service. |
| `GUBBINS_BRIDGE_HA_URL` | when HA on¹ | — | Base URL of your Home Assistant instance, e.g. `http://homeassistant.local:8123`. |
| `GUBBINS_BRIDGE_HA_TOKEN` | when HA on | — | Home Assistant long-lived access token. `.env` only; **never logged** and never sent to the app. |
| `GUBBINS_BRIDGE_HA_DISCOVERY` | no | `off` | Find Home Assistant on the LAN over mDNS and use its advertised address when `GUBBINS_BRIDGE_HA_URL` is unset. **Off by default**; an explicit URL always wins. Supplies an **address only** — the token above is still required. See [Finding Home Assistant](#finding-home-assistant-instead-of-typing-its-url-opt-in). |

¹ Unless `GUBBINS_BRIDGE_HA_DISCOVERY=on`, in which case the bridge fills it in from the LAN.

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
| TXT | `server=gubbins-bridge`, `api=v1`, `path=/api/v1`, `version=<Gubbins version>`. |

The `version=` value is the **Gubbins release the checkout is on** (e.g. `1.2.0`) — the bridge
has no version of its own to advertise. See [Updating the bridge](#updating-the-bridge).

> **No secret is ever advertised.** The TXT record carries only the API path/version for
> identification — **never** a credential. Home Assistant still prompts for the API token in
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

- **Read-only by default; every mutation is opt-in and gated.** With **both**
  `GUBBINS_BRIDGE_ALLOW_WRITES` **and** `GUBBINS_BRIDGE_ALLOW_PUSH` unset (the default), hydration
  into a *private, in-memory* `node:sqlite` DB is the only write and the snapshot file on disk is
  only ever read — no endpoint mutates anything. The opt-in
  [limited write endpoints](#limited-writes-opt-in) never string-build SQL: they apply a bounded,
  reversible per-item change through the app's **own** repository mutation and round-trip it through
  the §7.3 sync merge, so even when enabled there is no bespoke write path and no risk of sync
  drift. The opt-in [snapshot-ingest endpoint](#snapshot-push-opt-in) runs **no *caller-supplied*
  SQL** either, but it is the **wider** privilege of the two — it merges a caller-supplied snapshot
  into the **whole** served dataset through that same §7.3 reconcile, so it can reshape any row, not
  just a stock level. Both mutate only through the app's own merge; neither is "read-only", so the
  bridge is read-only precisely when **neither** flag is set.
- **Parameterised queries only.** Every query — casual phrase or power-user
  `field:`/`cap:` syntax — is parsed to an AST and translated by the app's single
  `parseASTtoSQL`. SQL is **never string-built** from user input, so there is no injection
  surface; the bridge imports that translator rather than forking it, so its semantics can't
  drift from the app's.
- **An identified caller on every request.** Every request must present an
  [API token minted in the app](#identities--permissions); the bridge resolves it to the user who
  owns it and enforces that user's permissions on the route. A missing, unknown or revoked token
  is a `401`; a valid token whose owner's role doesn't cover the route is a `403`. Only a
  **SHA-256 hash** of each token is ever stored, so a snapshot or backup cannot yield a usable
  credential, and revocation is a hard delete that propagates like any other deletion. The bridge
  holds no inbound credential in its environment at all.
- **Authentication fails closed.** Until the first snapshot has loaded there is nothing to resolve
  a token against, so every route — including the Home Assistant scale reads — answers `503`
  rather than being let through.
- **Capability flags bound what permissions can reach.** A route the operator disabled is a `404`
  for every caller, whatever their role; permissions only ever narrow the operator's choices.
- **Local-bind by default.** The server binds `127.0.0.1` unless you set
  `GUBBINS_BRIDGE_HOST=0.0.0.0`, which it logs as a deliberate LAN-exposure choice.
- **Plaintext HTTP transport — no TLS, so keep it loopback or trusted-LAN.** The bridge speaks
  `http` only: it has no certificate handling and takes no TLS option. On the loopback default that
  is moot — nothing leaves the host. But once you set `GUBBINS_BRIDGE_HOST=0.0.0.0` to expose it on
  the LAN, **every request crosses the network in cleartext**, including the `Authorization: Bearer`
  token — and, on the [calendar](#calendar-subscription) and [feed](#feeds--metrics) paths, the
  `?token=` in the URL. A passive observer or an ARP-spoofing peer on the same segment can capture
  that token and replay it for whatever the owning account may do (read, and — if enabled — write
  and push). The **outbound** Home Assistant call has the same exposure the other way: since
  `GUBBINS_BRIDGE_HA_URL` accepts an `http://` address it will put the long-lived HA token on the
  wire in cleartext, and the [Home Assistant custom component](../custom_components/gubbins/api.py)
  likewise reaches the bridge over plain HTTP. So keep the default loopback bind, or confine any
  wider bind to a network you actually trust; to reach the bridge across an untrusted network, front
  it with a **TLS-terminating reverse proxy** (nginx, Caddy, a tunnel) — the bridge stays plain HTTP
  bound to loopback *behind* the proxy — and give it an `https://` Home Assistant URL. This is the
  same weaker posture the token-in-URL trade-off under
  [Calendar subscription](#calendar-subscription) already flags, stated here for transport as a whole.
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
a backstop, not the security boundary — the identity check and the loopback default are.

### Cross-origin (CORS) policy

The bridge authenticates with a bearer token in the `Authorization` header (never a cookie), so
the token — not the browser's same-origin policy — is the security boundary. But the bridge sits
on the LAN, and a blanket `Access-Control-Allow-Origin: *` would let **any web page the user
happened to be viewing** script requests at it from inside the network — a free scanning /
token-guessing position a remote attacker could not otherwise reach. So the bridge instead grants
CORS only to an **allow-list** of browser origins:

- **By default**, the hosted app origin (`https://bootblock.github.io`), plus **any loopback
  origin** (`localhost` / `127.0.0.1` / `::1`, any port — a page served from your own machine can
  only be you). An allow-listed origin is reflected on **every** response, including errors, so the
  app can read a meaningful error body.
- Any **other** browser origin gets **no CORS header at all** — the browser then blocks the page
  from reading the response, so a hostile page can't tell a valid token from an invalid one (both
  read as an opaque failure). A refused origin is logged **once** with a hint, so a legitimately
  self-hosted app that simply isn't listed is easy to diagnose.
- **Non-browser clients are unaffected.** Home Assistant, a Prometheus scrape, `curl` and the MCP
  server send no `Origin` header, so CORS never applies to them.

If you serve the Gubbins PWA from your own domain **and** use "push to bridge" from the browser,
add that origin to `GUBBINS_BRIDGE_ALLOWED_ORIGINS` (comma-separated, e.g.
`https://gubbins.example.com`). To deliberately restore the old permissive behaviour, set it to
`*`. The active policy is printed at startup.

## Layout

```
bridge/
  package.json          # no runtime deps; borrows the repo-root toolchain (and deliberately no version field)
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
    version.ts          # the bridge's reported build — read from the repo-root package.json, never hand-maintained
    config.ts           # env-driven host/port/snapshot-path/rate-limit (pure, injectable)
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
      tools.ts          # the six read-only gubbins_* MCP tools + the two opt-in write tools
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
      location-view.ts  # location field vocabulary (defaults + the opt-in custom-field values)
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
app's pure modules from `../src`, and reads the root `package.json` for the version it
reports — see [Updating the bridge](#updating-the-bridge)):

```bash
# from the repo root
docker build -f bridge/Dockerfile -t gubbins-bridge .

docker run --rm \
  -p 127.0.0.1:8787:8787 \
  -e GUBBINS_SNAPSHOT_PATH=/data/gubbins-sync.json \
  -v /path/to/synced/folder/gubbins-sync.json:/data/gubbins-sync.json:ro \
  gubbins-bridge
```

Notes:

- **No inbound credential goes into the container at all** — callers present an
  [API token minted in the app](#identities--permissions), which arrives in the mounted
  snapshot. The snapshot path (and any outbound broker / Home Assistant credentials) are passed
  at run time, never baked into the image. A repo-root [`.dockerignore`](../.dockerignore) keeps
  any real `.env`, snapshot, or `.sqlite` out of the build context as a safety net.
- Mount the snapshot **read-only** (`:ro`) — the bridge only ever reads it.
- Inside the container the process binds `0.0.0.0` (so Docker's port mapping works at all);
  keep it host-local by publishing to `127.0.0.1:8787:8787` as above. To let Home Assistant
  on another machine reach it, publish to the host's LAN IP instead (a deliberate choice).

### Run with systemd

An example unit ships as [`gubbins-bridge.service`](gubbins-bridge.service). In short: put a
checkout at `/opt/gubbins`, create `/etc/gubbins-bridge.env` (from `.env.example`, `chmod
640`, holds the snapshot path and any outbound credentials), copy the unit to
`/etc/systemd/system/`, then:

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

---

## Updating the bridge

The bridge **re-reads your data** by itself, but it never **updates itself**. It has no build
step, no published package and no release artefact — by design: it ships as source *inside this
repository* and Node runs the TypeScript directly (see
[Shared-code mechanism](#shared-code-mechanism-the-important-decision)). So it only moves when
you move the checkout it runs from.

### How to update it

| You run it as | Update it by |
| --- | --- |
| A checkout (`node bridge/serve.mjs`, systemd) | `git pull` in the repository, then restart the process. |
| The Docker image | `git pull`, then `docker build -f bridge/Dockerfile -t gubbins-bridge .` from the repo root again, then recreate the container. |

`npm install` is only needed again if the **root** toolchain changed — the bridge itself has no
dependencies of its own to install.

### Which build am I running?

The bridge **has no version of its own**. It reports the version of the Gubbins repository the
checkout is on — the same number the PWA shows on its About screen — because that is the only
thing that actually identifies which code is answering. (`bridge/package.json` deliberately
carries no `version` field: a second, hand-edited number could only ever drift, and did.)

Ask the running bridge directly:

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/v1
```

```jsonc
{
  "name": "Gubbins Bridge API",
  "version": "1.0.0",          // the API *contract* version — see the note below
  "bridge": {
    "version": "1.2.0",        // which Gubbins release this bridge's checkout is on
    "schemaVersion": 5         // the data-schema generation it expects
  },
  "openapi": "/api/v1/openapi.json"
  // …
}
```

> **ℹ️ Two different versions live in that index.** The top-level `version` is the **API
> contract** version — what the `/api/v1` endpoints promise, which stays put across many
> releases of the software implementing it. The `bridge` block is **which build is answering**.
> They are unrelated numbers; don't compare one against the other.

The same value is what mDNS advertises in its `version=` TXT record and what MQTT discovery
reports as `sw_version`, so a Home Assistant device page shows the bridge's build too.

### `schemaVersion` is the one that matters

Of the two numbers in the `bridge` block, **`schemaVersion` is the one that governs whether the
bridge reads your data correctly.** It is the compatibility generation of the stored schema. A
bridge a release or two behind on `version` is untidy but still reading the snapshot correctly;
a bridge behind on `schemaVersion` may be reading columns that have since moved — the failure
that shows up as plausible-looking but wrong answers rather than an error.

### The app tells you when yours is stale

You don't have to poll this yourself. The Gubbins app compares the `bridge` block against its
own build and, on the **Sync** screen's bridge section, says so when they differ:

| What the app sees | What it tells you |
| --- | --- |
| Same version, same schema | Nothing — it stays quiet. |
| Older `schemaVersion` | A **warning**: the bridge may misread your data. Update it. |
| Same schema, older `version` | An informational note that an update is available. |
| Newer than the app | A note — usually just a browser tab that hasn't reloaded since the checkout moved. |
| No `bridge` block at all | The bridge predates this reporting, so it is definitely old. |

### What this does *not* give you

Being honest about the limits:

- **No signed or checksummed release artefact.** There is no tarball, tag-based download or
  published image to verify — you get whatever your `git pull` fetched. Verify the *repository*
  (clone over HTTPS/SSH from the canonical remote) if you need provenance.
- **No version pin.** The bridge always reports and runs whatever the checkout is on; there is
  no way to hold it at a version independent of the repository. Pin by checking out a tag or
  commit yourself.
- **No auto-update and no update channel.** Nothing checks for, downloads or applies updates.
  The app's notice tells you drift exists; acting on it is manual.
