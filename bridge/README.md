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

> **Status:** Complete (Phase HA-5 — packaging, docs, hardening) plus the generic
> [versioned REST API](#versioned-rest-api-apiv1) and a read-only
> [MCP server](#mcp-server-for-llmagent-tools) for LLM/agent tools. The bridge serves
> bearer-token-protected, read-only endpoints — the original `GET /health`, `/search`,
> `/where` plus an additive, OpenAPI-described `/api/v1` surface (items, locations,
> categories, capabilities) — and the same read-only core over an MCP stdio server; it
> re-hydrates automatically when the snapshot changes, and is rate-limited per client. An
> **opt-in** set of [limited write endpoints](#limited-writes-opt-in) (off by default) can
> additionally check stock in/out by round-tripping through the app's own sync merge, and an
> **opt-in** [snapshot-ingest endpoint](#snapshot-push-opt-in) (also off by default) lets the
> PWA push its whole dataset straight to the bridge for users without folder sync. The
> Home Assistant custom integration that consumes it lives in
> [`../homeassistant/`](../homeassistant/README.md). Full plan:
> [`docs/todo/home-assistant_2026-06-29.md`](../docs/todo/home-assistant_2026-06-29.md).

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
- All ids are the app's stable record ids; timestamps are UNIX-ms integers (as stored).

### Endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1` | A small discovery index (version + endpoint list). |
| `GET /api/v1/openapi.json` | This API's OpenAPI 3 document. |
| `GET /api/v1/health` | `{ ok, itemCount, snapshotGeneratedAt }` (alias of `/health`). |
| `GET /api/v1/search?q=&limit=` | Relevance search, top-N (limit `[1, 25]`, default 5) — not paginated. Alias of `/search`. |
| `GET /api/v1/where?q=` | "Where is X?" with per-location breakdown + spoken sentence. Alias of `/where`. |
| `GET /api/v1/items?limit=&offset=&location=&category=&includeInactive=` | Paginated item summaries (`ItemSummary`). |
| `GET /api/v1/items/{id}` | One item with `placements` and `capabilities` (`ItemDetail`); `404` if unknown. |
| `GET /api/v1/locations?limit=&offset=` | Paginated locations with live item counts (`Location`). |
| `GET /api/v1/locations/{id}` | One location; `404` if unknown. |
| `GET /api/v1/categories?limit=&offset=` | Paginated categories with field counts (`CategorySummary`). |
| `GET /api/v1/categories/{id}` | One category with its custom-field schema (`CategoryDetail`); `404` if unknown. |
| `GET /api/v1/capabilities?limit=&offset=` | The distinct, queryable capability vocabulary (`CapabilityKey`) — the keys you can filter on with `cap:<key>`. |

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
and supply the snapshot path (the client stores it; nothing is committed):

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

> Needs **Node ≥ 24** (or **22.16+ LTS**) on `PATH` — for built-in TypeScript type-stripping
> plus `node:sqlite` **with FTS5** (the v23.x line never got FTS5; see the
> [Requirements](#requirements) caveat below). An older Node can fall back to
> `--experimental-strip-types`, but you still need FTS5 support for a working database.

### Tools

All tools are **read-only** and return both human-readable `text` content and a machine-usable
`structuredContent`:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `gubbins_search` | `q` (required), `limit?` | Relevance-ranked compact matches (top-N, max 25). Accepts a casual phrase or the power-user grammar (`cap:key>n`, `AND`/`OR`, …). |
| `gubbins_where_is` | `q` (required), `limit?` | The top matches with their per-location breakdown plus one spoken British-English sentence. |
| `gubbins_get_item` | `id` (required) | One item with `placements` and `capabilities`; `{ found: false }` if unknown. |
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
  `node:fs` / `node:crypto` (and `node:dgram` / `node:os` for the optional mDNS advertiser)
  only — so there is no third-party supply-chain surface to vet.

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
      respond.ts        # shared JSON / error-envelope helpers (legacy flat + v1 structured)
      params.ts         # shared q / pagination parsing (clamped)
      limits.ts         # shared request/pagination bounds
      v1.test.ts        # in-process /api/v1 endpoint + pagination + auth + 404 tests
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
