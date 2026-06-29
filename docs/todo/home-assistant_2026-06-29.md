# Home Assistant query bridge — phased plan (2026-06-29)

> **Living document.** Each phase is implemented in its own chat session. Tick the
> `[ ]` boxes as work lands, append a one-paragraph "Outcome" note under each phase
> when it completes (mirroring `docs/dev/deferred-features.md`), and re-schedule —
> never silently drop — any deferred item.
>
> **Continuation-prompt rule (mandatory).** When a phase is completed, you **must** do
> **both** of the following before ending the session — not one or the other:
>
> 1. **Emit the next phase's kick-off prompt directly in your chat reply** as a **raw,
>    fenced Markdown code block** (a ```` ```text ```` block the user can copy verbatim
>    into a new chat). This is the **last thing** in your reply. Do **not** merely say
>    "I've added it to the doc" — the user must be able to copy it straight from the chat
>    without opening the file.
> 2. **Record that same prompt** under "[Continuation prompt](#continuation-prompt)" at
>    the foot of this doc (replacing the previous one) so the thread is never lost.
>
> The two must be **identical**. The prompt must name the doc, the phase to run, and any
> context the fresh session needs (it starts cold). After the **final** phase, the
> continuation prompt instead kicks off the first **Deferred work** item (the generic
> REST API).
>
> **Status:** _Phases HA-1 → HA-5 complete — the phased plan is done._ On top of the HA-1
> hydration, HA-2 query core, HA-3 HTTP server and HA-4 Home Assistant custom integration,
> Phase HA-5 packaged and hardened the bridge: a build-free `node:slim` Docker image, a
> hardened systemd unit, a rewritten `bridge/README.md` (quick-start, config reference,
> Docker/systemd, where-to-run), a per-IP rate limit, a full read-only/no-PII security
> audit, repo-hygiene tightening, a top-level README pointer, and CI that runs the bridge
> tests alongside the app suite. **Update:** all six **Deferred-work** items have since shipped
> too — the generic REST API, the MCP server wrapper, mDNS / zeroconf discovery, Read + limited
> writes, the Direct `.sqlite` data source, and the PWA "push to bridge". **All planned and
> deferred work is now complete** — see each item's Outcome below and
> [Continuation prompt](#continuation-prompt).

## The idea

Let a user ask their Home Assistant voice assistant *"Where are my M3 screws?"* and be
told the location(s) according to the Gubbins inventory. More generally: expose a
**read-only query API** over the Gubbins data that Home Assistant — and, later, any
application — can call.

## The hard constraint that shapes everything

Gubbins is a **strictly local-first PWA with no server**. The database is an in-browser
SQLite (WASM) on the **OPFS VFS**, living inside the user's browser profile. A web page
**cannot host a LAN HTTP endpoint** that Home Assistant could reach, and the project's
whole premise is that *nothing is sent to a server* (`README.md`). So Home Assistant
cannot talk to the PWA directly, and we will not add a cloud relay.

What the data *can* do is **leave the browser through paths that already exist**:

| Existing export path | What it writes | Code |
| --- | --- | --- |
| **FS-Access sync** (Phase 7) | A versioned-JSON snapshot `gubbins-sync.json` to a **user-chosen folder** (a NAS mount, a synced drive, a USB key) — designed for cross-device sharing. | `src/features/sync/providers/file-system-provider.ts`, `src/features/sync/backup.ts` |
| Raw `.sqlite` export | The whole DB file | `src/features/export/*` |
| Markdown vault / JSON / CSV export | Human/Obsidian formats | `src/features/export/export-data.ts` |

The cleanest seam is the **sync snapshot**: it is plain JSON, already cross-device by
design, and round-trips through the *same* code the app uses to restore a database.

## Architecture: an optional companion "bridge"

```
┌─────────────────┐   writes gubbins-sync.json    ┌──────────────────────────┐
│  Gubbins PWA    │ ─────────────────────────────▶│  Shared folder           │
│ (browser, OPFS) │   (existing FS-Access sync)    │  (NAS / synced drive)    │
└─────────────────┘                                └────────────┬─────────────┘
                                                                 │ watch + read (read-only)
                                                                 ▼
                                                  ┌──────────────────────────────┐
                                                  │  Gubbins Bridge  (Node/TS)    │
                                                  │  • hydrate snapshot → headless│
                                                  │    node:sqlite DB (FTS5)      │
                                                  │  • reuse app's pure search    │
                                                  │    (parse-text-query → AST →  │
                                                  │     searchByAst)              │
                                                  │  • read-only local HTTP API   │
                                                  └──────────────┬────────────────┘
                                                                 │ HTTP (token, LAN-local)
                                                                 ▼
                                                  ┌──────────────────────────────┐
                                                  │  Home Assistant               │
                                                  │  custom integration `gubbins` │
                                                  │  + conversation intent        │
                                                  │  "Where are my {item}?"       │
                                                  └──────────────────────────────┘
```

**The key reuse win:** the bridge does **not** reimplement search. It hydrates the
snapshot into a real, headless SQLite database and runs the *actual* Gubbins query code,
so results match the app exactly:

- `src/test/drivers/memory-driver.ts` — `createMemoryDriver()` is already a real
  `node:sqlite` engine **with FTS5** implementing the production `IDatabaseDriver`.
  (Today it's test-only; HA-1 promotes a Node-runnable copy/shared module.)
- `src/db/migrations/engine.ts` + `src/db/migrations/index.ts` — build the schema.
- `src/features/sync/backup.ts` `parseBackupJson` + `src/features/sync/snapshot.ts`
  `restoreSnapshot` — load the snapshot rows into that DB.
- `src/features/search/parse-text-query.ts` → `src/db/search/ast.ts` →
  `src/db/search/parseASTtoSQL.ts` → `ItemRepository.searchByAst` — run the query.
  `Item` results already carry `locationId` + `locationName`
  (`ItemRepository.ts:76-77`), and `listStockAtLocation` gives the per-location
  breakdown for a multi-location answer.

So "Where are my M3 screws?" = `parse-text-query("M3 screws")` → AST → `searchByAst` →
read each result's location(s).

## Locked decisions (from the 2026-06-29 scoping)

| Decision | Choice | Implication |
| --- | --- | --- |
| **Data source** | **Sync-folder watcher** reading `gubbins-sync.json`. | No PWA changes needed to ship a first version; bridge re-reads on file change. |
| **HA integration** | **Custom HA integration + conversation intent** (best voice UX). A **generic REST API for any app is a deferred future task** (see "Deferred work"). | Phase HA-4 ships the Python custom component; the bridge's HTTP layer is designed neutral so the generic API is later a documentation/superset task, not a rewrite. |
| **API scope** | **Read-only** queries (search, "where is X", quantities, locations). | No writes → no LWW/CRDT round-trip, no sync conflicts, safe by construction. Read+write is explicitly deferred. |

## Repository shape

A **new top-level package**, isolated from the PWA so it never bloats the browser
bundle or the GitHub-Pages build, and so the concurrently-working agent's PWA changes
rarely collide with it:

```
bridge/                     # the Node/TS companion service (new)
  package.json              # its own deps (no React, no Vite)
  tsconfig.json             # path alias to ../src for the shared pure modules
  src/
    hydrate.ts              # snapshot file → headless node:sqlite DB
    query.ts                # text query → AST → searchByAst → shaped result
    server.ts               # read-only node:http server
    watcher.ts              # debounced re-hydrate on snapshot change
    config.ts               # env-driven config (host, port, token, snapshot path)
    cli.ts                  # entry point
  README.md                 # run / Docker / systemd / HA wiring
homeassistant/              # the HA custom component (new, Phase HA-4)
  custom_components/gubbins/ # config_flow, sensor/intent, manifest.json
  README.md                 # HACS install + voice-assistant setup
```

> **Sharing pure code without copy-paste.** The reused modules under `src/` use the `@/`
> path alias and a couple are browser-/test-scoped. HA-1 decides the mechanism (npm
> workspace + a `@gubbins/core` export map, or a `tsconfig` path mapping `@/* →
> ../src/*` compiled for Node). Whichever is chosen, the goal is **one source of truth
> for search semantics** — the bridge must never fork `parseASTtoSQL`.

---

## Phase HA-1 — Bridge foundation & headless DB hydration

**Goal:** prove the snapshot can be turned into a queryable Gubbins database in Node,
with zero HTTP and zero HA yet.

- [x] Create the `bridge/` package (`package.json`, `tsconfig.json`, lint/test wired to
      the repo's existing tooling where possible).
- [x] Establish the **shared-module mechanism** to import the app's pure DB/search code
      into Node (workspace export or `tsconfig` path alias). Document the decision at the
      top of `bridge/README.md`.
- [x] `hydrate.ts`: given a path to `gubbins-sync.json`, build an in-memory
      `node:sqlite` DB via the migration engine, then `parseBackupJson` +
      `restoreSnapshot` to load every synced table. Returns a ready `IDatabaseDriver`.
- [x] Make the `node:sqlite` driver reusable from production-style code (today
      `memory-driver.ts` is test-only and `@/`-aliased) — either export a Node driver
      module or share it; do **not** silently widen the app tsconfig.
- [x] A throwaway `cli.ts` that hydrates a real exported snapshot and prints item count
      + a sample item with its location, to verify parity.
- [x] Unit tests: hydrate a fixture snapshot (synthetic data only — `example.com`,
      made-up part names) and assert row counts + a `searchByAst` round-trip.

**Acceptance:** `node bridge/dist/cli.js <snapshot.json>` prints the item count and one
item's `locationName`, and the bridge's tests pass. **No secrets, no real data** in any
fixture.

**Risks/notes:** snapshot `formatVersion` skew (a snapshot from a newer PWA build) —
reuse `parseBackupJson`'s existing version guard and surface a clear error. Confirm no
reused module pulls in a DOM/`window` dependency at import time; if one does, extract the
pure part rather than shimming the DOM.

**Outcome (2026-06-29).** The `bridge/` package is in place and isolated from the PWA
(its own `package.json`/`tsconfig.json`, no React/Vite, no runtime dependencies, nothing
added to the browser bundle). **Shared-code mechanism:** a `tsconfig` path alias
`@/* → ../src/*` honoured at runtime by a ~40-line zero-dependency ESM `resolve` hook
(`bridge/loader.mjs`) that maps the alias and retries the app's extensionless
bundler-mode imports — Node 23.6+ (dev env is Node 25) then strips the TypeScript types,
so the app's real modules run directly with **no build step and no bundler**. The chosen
seam keeps `parseASTtoSQL` single-sourced — it is imported, never forked — and was picked
over an npm-workspace export (the app's source is `@/`-aliased *internally*, so a package
boundary alone wouldn't resolve) and over a `tsc → dist` compile (`tsc` rewrites neither
the alias nor the extensionless specifiers, so the output wouldn't run under plain Node
anyway). `hydrate.ts` runs the app end-to-end — `parseBackupJson` (version guard) →
migration engine → `restoreSnapshot` — returning a ready `IDatabaseDriver`. The only
*copy* (not a fork) is `bridge/src/node-driver.ts`, a Node-runnable sibling of the
test-only `memory-driver.ts` over `node:sqlite`; the app tsconfig was left untouched. An
audit of the hydrate import graph confirmed **no module touches `window`/`navigator`/
`Worker` at import time** (all such access is lazy, inside functions), so no DOM shim or
pure-part extraction was needed. Tests (10, all green) run under a dedicated
`bridge/vitest.config.ts` (Node env, `@/` alias, `threads` pool) over a fully synthetic
fixture and assert row counts plus `parseTextQuery → searchByAst` round-trips (casual
name, distinctive FTS token, and the power-user `cap:voltage>3` path). The parity CLI is
run as `node bridge/cli.mjs <snapshot>` (a bare-Node bootstrap that registers the loader
before importing the TS CLI) rather than the doc's illustrative `dist/cli.js`, since the
mechanism is build-free; against the fixture it prints `Active items: 4` and a sample item
with `location: Shelf 2`. No secrets, no real or personal data in any file or fixture;
`.env` is git-ignored with only `.env.example` placeholders committed. *Deferred to
HA-3 (not dropped):* `.env`-driven config consumption, the bearer token, and LAN-bind
choice are documented in `.env.example` but not yet read by code (there is no server
yet).

---

## Phase HA-2 — Read-only query core ("where is X")

**Goal:** a pure, tested query layer on top of the hydrated DB that answers the questions
HA will ask, independent of any transport.

- [x] `query.ts` `searchItems(driver, q)`: run `parseTextQuery(q)`; on `{ok:false}`
      fall back to a bare name-CONTAINS search (so a casual phrase like "M3 screws" still
      works); execute via `searchByAst`. Return a compact, **read-only** DTO
      (`id`, `name`, `quantity`, `locationName`, `mpn`, `manufacturer`).
- [x] `whereIs(driver, q)`: for the top matches, attach the **per-location breakdown**
      (`item_stock` via `listStock`) so a multi-location item answers "5 on Shelf 2, 2 in
      Bin 4", not just its primary location.
- [x] A **spoken-answer shaper** (pure) that turns results into one short British-English
      sentence suitable for a voice assistant ("Your M3 screws are in Drawer A — 42 in
      stock." / "I found 3 items matching 'screws'…" / "I couldn't find any M3 screws.").
      Keep this pure and unit-tested — it is the voice UX.
- [x] Bound result size (top-N, default ~5) so a vague query can't return the whole
      inventory to a voice device.
- [x] Unit tests for: exact hit, no hit, multiple hits, multi-location item, and a
      power-user `field:`/`cap:` query passing through unchanged.

**Acceptance:** given a hydrated fixture, `whereIs("M3 screws")` returns the correct
location(s) and a sensible spoken sentence; the power-user syntax (`cap:voltage>3.3`)
still parses through the same path.

**Outcome (2026-06-29).** The query core landed as two small, dependency-free modules.
`bridge/src/query.ts` is transport-agnostic (no `node:http` — that is HA-3) and strictly
read-only: `searchItems(driver, q, { limit })` runs `parseTextQuery` and, only when that
genuinely can't parse, falls back to a bare name-CONTAINS `SearchAST`, then executes via
`ItemRepository.searchByAst` — so all SQL still flows through the single `parseASTtoSQL`
translator, never string-built. It returns the compact DTO (`id`, `name`, `quantity`,
`locationName`, `mpn`, `manufacturer`); the primary `locationName` is resolved via
`LocationRepository.getById` (the app's `Item` carries `locationId`, not `locationName` —
the plan's old `ItemRepository.ts:76-77` cite was stale). `whereIs(driver, q)` enriches the
top matches with their per-location breakdown via `ItemRepository.listStock` (busiest
location first) and a single spoken sentence. Results are bounded by `DEFAULT_RESULT_LIMIT`
(5), hard-capped at `MAX_RESULT_LIMIT` (25), so a vague query can't dump the inventory. The
spoken-answer shaper is a separate **pure** module (`bridge/src/spoken.ts`,
`speakWhereIs`) — no DB, no I/O — covering found-one (single- and multi-location),
found-several (names the first 3, then "and N more"), and not-found, with a small "on
Shelf / in Drawer" preposition heuristic for natural British phrasing. Tests: `query.test.ts`
drives the real hydrated synthetic fixture (exact hit, no hit, blank query, multiple hits,
the bounded limit, the multi-location breakdown, and the power-user `cap:voltage>3` passing
through unchanged — i.e. *not* falling back to a name search), and `spoken.test.ts`
unit-tests the shaper over hand-built matches. Whole bridge suite is **27 green** and
`tsc --noEmit -p bridge/tsconfig.json` is clean. No secrets, no real or personal data in any
file or fixture. *Nothing deferred from HA-2.*

---

## Phase HA-3 — Local, read-only HTTP server + snapshot watcher

**Goal:** expose the query core over HTTP on the LAN, refreshing automatically when the
synced snapshot changes.

- [x] `server.ts`: a minimal `node:http` server (no heavyweight framework). Endpoints,
      all **GET / read-only**:
  - `GET /health` → `{ ok, itemCount, snapshotGeneratedAt }`
  - `GET /search?q=<query>&limit=<n>` → `searchItems` DTOs
  - `GET /where?q=<query>` → `whereIs` result + spoken sentence
- [x] **Auth:** a shared bearer token read from the environment (`.env`, git-ignored —
      see "Security"). Reject unauthenticated requests. Provide `.env.example` with a
      **placeholder** token only.
- [x] **Bind locally by default** (`127.0.0.1`); LAN exposure (`0.0.0.0`) is opt-in via
      config and documented as a deliberate choice.
- [x] `watcher.ts`: watch the snapshot file (`fs.watch`/chokidar), **debounced**, and
      re-hydrate atomically (build the new DB, then swap) so a query is never served from
      a half-loaded DB. Handle "file briefly absent during write".
- [x] Basic abuse guards: small per-request work cap, sane timeouts, `limit` clamp.
- [x] Tests: server returns correct JSON for each endpoint against a fixture; a 401 when
      the token is missing/wrong; a snapshot change is picked up.

**Acceptance:** `curl -H "Authorization: Bearer <token>" "http://localhost:PORT/where?q=M3%20screws"`
returns the location JSON + spoken sentence; editing the fixture snapshot updates results
without a restart; an unauthenticated request is rejected.

**Decision to confirm at entry:** dependency budget for the bridge (pure stdlib `node:http`
+ `fs.watch` vs. a tiny framework + `chokidar`). Default: **stdlib-first**, matching the
app's "minimal dependency surface" rule (`CLAUDE.md`). Vet any new dep (licence,
maintenance) before adding.

**Decision taken (2026-06-29).** **Stdlib-first, zero new dependencies** — `node:http`,
`node:fs` (`fs.watch`), `node:crypto` (`timingSafeEqual`) only. No framework and no
`chokidar` were added: the routing is three GET paths, auth is one bearer-token check, and
directory-level `fs.watch` covers the atomic-rename publish pattern, so a dependency would
add supply-chain/licence surface (`CLAUDE.md` IP-hygiene) for no real gain.

**Outcome (2026-06-29).** The bridge now exposes the HA-2 query core over a minimal,
**read-only** `node:http` server with **no new dependencies** (stdlib `node:http` /
`node:fs` / `node:crypto` only — the vetted "stdlib-first" decision above). `server.ts`
serves three **GET-only** endpoints — `/health` → `{ ok, itemCount, snapshotGeneratedAt }`
(item count via `emptyAst → countByAst`, never bespoke SQL), `/search?q=&limit=` →
`{ query, matches }`, and `/where?q=` → the `whereIs` result with its spoken sentence — each
guarded by a **constant-time bearer-token check** (`timingSafeEqual`; missing/wrong →
`401 WWW-Authenticate: Bearer`). Non-GET → `405`, unknown path → `404`, missing/over-long
`q` (>200 chars) → `400`, and the whole handler is wrapped so any unexpected failure is a
generic `500` that never leaks SQL/paths/stacks. Abuse guards: the 200-char `q` cap, the
query core's existing `[1,25]` limit clamp, `requestTimeout`/`headersTimeout`, and request
bodies drained. `config.ts` is a pure, injectable env resolver (`GUBBINS_BRIDGE_TOKEN` +
`GUBBINS_SNAPSHOT_PATH` required; host defaults to **`127.0.0.1` loopback**, port `8787`),
throwing secret-free errors on misconfig; `0.0.0.0` LAN exposure is opt-in and logged as a
deliberate choice. `watcher.ts` watches the snapshot's **containing directory** (filtering on
basename, so an atomic rename-replace is still seen — a direct file watch can go deaf after
the inode is swapped), **debounced** (200 ms default), and re-hydrates **atomically**: it
builds the complete new driver, swaps it into the state the server reads, then closes the old
one, so a query is never served from a half-loaded DB; a hydrate that fails (file briefly
absent / partial write / bad JSON) keeps the last good state and waits for the next event.
The runnable entry is `node bridge/serve.mjs` (a bare-Node bootstrap that registers the `@/`
loader, loads the git-ignored `.env` via `process.loadEnvFile`, then imports `src/serve.ts`,
the thin config→watcher→server composition root with SIGINT/SIGTERM shutdown). Tests: the
whole bridge suite is **47 green** (`config.test.ts` pure env resolution; `server.test.ts`
drives the server **in-process** — a hydrated synthetic-fixture driver injected via
`getState`, bound to an ephemeral loopback port — asserting each endpoint's JSON plus the
401/405/404/400/503 guards; `watcher.test.ts` covers deterministic `reload()` atomic swap,
last-good-state retention when the file is absent, and a real `fs.watch` pickup), and
`tsc --noEmit -p bridge/tsconfig.json` is clean. An end-to-end smoke (`serve.mjs` against the
fixture) confirmed `/health` → `itemCount 4`, a spoken `/where`, and `401` without a token.
Read-only throughout — the only SQL is the parameterised `parseASTtoSQL` the repositories
already use; no secrets or real/personal data in any file, fixture, log, or error (`.env`
git-ignored, only `.env.example` placeholders committed). *Nothing deferred from HA-3.*

---

## Phase HA-4 — Home Assistant custom integration + conversation intent

**Goal:** the actual voice experience — "Where are my M3 screws?" answered out loud.

- [x] `homeassistant/custom_components/gubbins/`: a HACS-compatible custom component
      (`manifest.json`, `config_flow.py`, `__init__.py`) with a UI config flow for
      **host, port, and token** (token stored by HA, never in YAML/the repo).
- [x] A **conversation intent** (`GubbinsWhereIs`) with sample sentences ("where are my
      {item}", "where is my {item}", "find my {item}", "how many {item} do I have") that
      calls `GET /where?q={item}` and **speaks the bridge's sentence back**.
- [x] Optionally a `gubbins.search` service + a template/REST sensor example for
      dashboards, so non-voice automations can use it too.
- [x] Graceful failure: bridge unreachable / unauthorised → a friendly spoken fallback,
      not a stack trace.
- [x] `homeassistant/README.md`: HACS install, config flow walkthrough, and how to wire
      the intent into Assist. Synthetic examples only.

**Acceptance:** with the bridge running and the integration configured, asking Assist
"Where are my M3 screws?" speaks the correct location. (Document a manual test recipe —
HA isn't unit-testable here; keep any Python logic thin and obvious.)

**Decision to confirm at entry:** custom component vs. a documented built-in
`rest_command` + `intent_script` recipe. The locked decision is the **custom component**;
re-confirm scope (and whether to also publish the `intent_script` recipe as a no-code
fallback).

**Decision taken (2026-06-29).** Built the **custom component** (the locked decision) **and**
shipped the no-code `rest_command` + `intent_script` recipe as a documented fallback (user
confirmed "Both" at entry) — the YAML path is cheap and lets users without HACS/custom
components still get the voice intent. **No third-party Python dependency** was added: the
integration uses only Home Assistant built-ins (`aiohttp` via HA's shared session,
`voluptuous`, the `conversation`/`intent`/`update_coordinator` helpers), so there is no
licence/maintenance/supply-chain surface to vet (`CLAUDE.md` IP-hygiene rule).

**Outcome (2026-06-29).** `homeassistant/custom_components/gubbins/` is a HACS-compatible,
**strictly read-only** integration that consumes the unchanged HA-3 bridge contract
(`GET /health`, `/search`, `/where`) — it only ever issues `GET`s, never a write. `api.py` is
a thin async client over HA's shared `aiohttp` session that maps failures to typed errors
(`GubbinsAuthError`/`GubbinsConnectionError`) and exposes `where_spoken()`, which **never
raises** — on a 401 or an unreachable bridge it returns a friendly British-English fallback
so Assist reads a sentence, not a stack trace. `config_flow.py` is a UI flow capturing
**host/port/token**, masking the token via a password `TextSelector` and verifying it against
`GET /health` before saving (typed `invalid_auth`/`cannot_connect` errors); the token is held
in HA's config-entry store, **never in YAML or this repo**. `intent.py` registers one
`GubbinsWhereIs` handler (a wildcard `{item}` slot) that speaks the bridge's ready-made
`spoken` sentence back **verbatim** — voice wording stays single-sourced in the bridge;
sentences ship in `custom_sentences/en/gubbins.yaml` for the user to drop into their HA config
(the standard mechanism — an integration can't inject sentences into the default Assist
agent). `__init__.py` also registers a response-returning `gubbins.search` service, and
`sensor.py` adds an optional `/health` item-count sensor (via a slow `DataUpdateCoordinator`)
for dashboards / "bridge offline" automations. `homeassistant/README.md` documents both
install paths — the recommended custom integration (manual copy, with HACS-custom-repo noted
honestly since the component sits in a sub-folder of this PWA monorepo, not at the root) and
the no-code `rest_command` + `intent_script` fallback — plus a config-flow walkthrough, the
Assist wiring, a REST-sensor dashboard example, a **manual test recipe** against the synthetic
fixture, and a security/privacy section. Verification: `python -m py_compile` is clean on all
modules; all JSON/YAML parse; and an end-to-end smoke (the live bridge against
`synthetic-snapshot.json`) confirmed the exact JSON/`spoken` shapes the client is built
against (`/where?q=M3 bolt` → "Your M3 x 10 Hex Bolt is in Drawer A — 42 in stock.";
multi-location ESP32 → "…spread across 2 locations: 5 on Shelf 2 and 2 in Bin 4 — 7 in
total."; missing token → 401) — and the README examples were corrected to match real fixture
output (the fixture has no "screws", so the verifiable recipe uses "M3 bolt"). No secrets and
no real/personal data in any file: the only token shown is the clearly-labelled throwaway
`test-token-123` in the local test recipe; everything else is `example.com`/`localhost`/
`127.0.0.1`/synthetic parts; the real token is entered in HA's UI or a local, never-committed
`secrets.yaml`. *Nothing deferred from HA-4.*

---

## Phase HA-5 — Packaging, docs, hardening

**Goal:** make it runnable and safe for a real user, and document it.

- [x] `bridge/README.md`: quick start, config reference, **Docker** image, **systemd**
      unit example, and a note on running it on the Home Assistant host / a Pi / a NAS.
- [x] **Security hardening pass:** confirm read-only (no SQL write path reachable),
      token required, local-bind default, input is parameterised (it already is — queries
      go through `parseASTtoSQL`, never string-built SQL), and **no PII leaks** in logs or
      errors. Add a rate limit if not already present.
- [x] Repo hygiene: extend `.gitignore` for bridge build artefacts and any local config;
      confirm no snapshot/`.sqlite`/`.env` can be committed (`CLAUDE.md` secret rules).
- [x] Top-level `README.md`: a short "Home Assistant / external query bridge" section
      pointing at `bridge/README.md` (this is an **optional companion**, not part of the
      GitHub-Pages app).
- [x] CI: run the bridge's unit tests alongside the existing suite.

**Acceptance:** a fresh user can follow `bridge/README.md` to run the bridge against
their synced folder and query it; the security checklist is fully ticked; nothing
sensitive is committable.

**Decision taken (2026-06-29).** Confirmed the two entry questions at the defaults: a
**thin, build-free `node:slim` Docker image** (the bridge has no build step — `tsc`/a
bundler would buy nothing, so a single stage with no `npm install` is correct) and a
**small in-process per-IP token-bucket rate limit** (stdlib only, zero new deps — preferred
over leaving it to the LAN/firewall so a deliberately-exposed bridge has an in-app backstop
against runaway query loops). No dependency was added.

**Outcome (2026-06-29).** Phase HA-5 packages, documents and hardens the bridge for real
use with **no new dependencies**. **Hardening:** a new pure, injectable-clock per-IP
token-bucket limiter (`bridge/src/rate-limit.ts`) is charged before any work (including the
token check), so a flood is capped even unauthenticated; an exhausted client gets `429` +
`Retry-After`, and the key is the socket IP (client `X-Forwarded-For` is deliberately *not*
trusted, so it can't be forged away). It is configurable via `GUBBINS_BRIDGE_RATE_CAPACITY`
(default 60; `0` disables) / `GUBBINS_BRIDGE_RATE_REFILL` (default 1/s) and on by default.
A security audit confirmed the rest of the checklist holds: **read-only** (hydration is the
only write, into a private in-memory DB before any request; no write path is reachable),
**parameterised** (all SQL flows through the single imported `parseASTtoSQL`, never
string-built), **token required** (constant-time `timingSafeEqual`, `401` otherwise),
**loopback-bind by default**, and **no PII in logs/errors** — an end-to-end smoke confirmed
the log contains only lifecycle lines (snapshot timestamp, bind address, rate-limit
settings) with no token, item names, query text, or IPs, and every unexpected failure
collapses to a generic `500`. **Packaging:** a thin build-free `bridge/Dockerfile`
(`node:24-slim`, single stage, runs as the unprivileged `node` user, context = repo root so
it can import `../src`; token + snapshot passed at run time and mounted `:ro`, never baked
in), a repo-root `.dockerignore` that keeps any real `.env`/snapshot/`.sqlite` out of the
build context, and a hardened example `bridge/gubbins-bridge.service` systemd unit
(dedicated unprivileged user, `ProtectSystem=strict`/`ProtectHome=read-only`/
`NoNewPrivileges`, env file at `/etc/gubbins-bridge.env`). **Docs:** `bridge/README.md` was
rewritten with a quick-start, an HTTP-API table, a full config reference, the Docker and
systemd recipes, a "where to run it" note (HA host / Raspberry Pi / NAS), and an expanded
security-&-hardening checklist; the top-level `README.md` gained a short, opt-in "Home
Assistant / external query bridge" section pointing at `bridge/README.md` and making clear
it is **not** part of the PWA / GitHub-Pages build. **Repo hygiene:** the bridge
`.gitignore` now also blocks `*.env` (keeping `.env.example`); `git check-ignore` confirms a
real `.env`, `gubbins-sync.json`, `*.sqlite`/`*.db`, and `bridge/local/` are all
un-committable while the placeholder examples stay committable. **CI:** a new
`.github/workflows/tests.yml` runs the app suite (Node 20) and the bridge suite + type-check
(Node 24, for built-in type-stripping) on push/PR — the bridge tests now run alongside the
existing suite. Verification: bridge suite **57 green** (10 new — 6 rate-limiter, 3 config,
1 server `429`), `tsc --noEmit` clean, and a live `serve.mjs` smoke against the synthetic
fixture confirmed `/health` (`itemCount 4`), a spoken `/where`, `401` on missing/wrong
token, and `429` + `Retry-After: 1` once a small bucket is spent. No secrets and no
real/personal data in any file, fixture, log, or doc. *Nothing deferred from HA-5 — the
phased plan is complete; the continuation now kicks off the first Deferred-work item, the
generic REST API.*

---

## Deferred work (tracked, never dropped)

Per `docs/dev/deferred-features.md` conventions — each item keeps a concrete target.

- [x] **Generic REST API for any application** → **after HA-4** (own follow-up phase).
      Promote the bridge's neutral HTTP layer into a documented, versioned public API:
      an OpenAPI spec, stable DTOs, pagination, and capability/location/category
      endpoints — so anything (not just HA) can query Gubbins. The HA integration becomes
      one consumer of this API. *(This was explicitly requested as a future task at
      scoping time.)* **Done — see [the Outcome below](#deferred-work--generic-rest-api).**
- [x] **MCP server wrapper** → conditional/YAGNI (trigger: wanting an LLM/agent — e.g.
      Claude — to query inventory as a tool). The same `query.ts` core behind an MCP
      stdio/HTTP server. **Done — see [the Outcome below](#deferred-work--mcp-server-wrapper).**
- [x] **mDNS / zeroconf discovery** → conditional (trigger: setup friction reports). Let
      HA auto-discover the bridge instead of typing host/port. **Done — see
      [the Outcome below](#deferred-work--mdns--zeroconf-discovery).**
- [x] **Read + limited writes** (check-in/out, quantity adjust via the API) →
      conditional/YAGNI (trigger: a concrete request). Must round-trip through the §7.3
      LWW/Delta-CRDT rules to avoid drift — this is the reason the first cut is read-only.
      **Done — see [the Outcome below](#deferred-work--read--limited-writes).**
- [x] **Direct `.sqlite` data source** → conditional (trigger: a user who exports the raw
      DB rather than syncing JSON). An alternate `hydrate` that opens the `.sqlite`
      directly; the rest of the bridge is unchanged. **Done — see
      [the Outcome below](#deferred-work--direct-sqlite-data-source).**
- [x] **PWA "push to bridge"** → conditional (trigger: users who don't use FS-Access
      sync). A PWA-side feature that POSTs the dataset to the bridge on demand. If any
      PWA UI is added here, it **must use design tokens / Foundry primitives**
      (`CLAUDE.md`), never raw colour/spacing literals. **Done — see
      [the Outcome below](#deferred-work--pwa-push-to-bridge).**

## Deferred work — generic REST API

**Decisions taken at entry (all at the offered defaults).** (1) The OpenAPI 3 spec is
**hand-authored as a typed object** (`bridge/src/openapi.ts`, the single source of truth)
and served live at `GET /api/v1/openapi.json`; the committed human-readable
`bridge/openapi.yaml` is **generated** from it by a tiny zero-dependency YAML *emitter*
(`bridge/src/openapi-yaml.ts`), with a test asserting the two never drift (emitting a known
object is safe and dep-free, whereas parsing arbitrary YAML would need a dependency —
CLAUDE.md IP-hygiene). (2) Pagination is **offset/limit** with a hard ceiling, mirroring the
repositories' own `Page` envelope. (3) The current unversioned paths stay as **permanent,
stable aliases** of their `/api/v1` twins.

**Outcome (2026-06-29).** The bridge's HTTP layer is now a generic, versioned, **read-only**
REST API under `/api/v1`, **purely additive** — `/health`, `/search`, `/where` keep their
exact bodies and are documented aliases of `/api/v1/health|search|where`, so the Home
Assistant integration keeps working unchanged. New resource endpoints, all flowing through
the app's **existing repositories** and the single parameterised `parseASTtoSQL` (never
bespoke SQL): `GET /api/v1/items` (paginated browse, filterable by `location`/`category`/
`includeInactive`), `GET /api/v1/items/{id}` (full detail with per-location `placements` and
`capabilities`), `GET /api/v1/locations[/{id}]` (with live item counts), `GET
/api/v1/categories[/{id}]` (with the custom-field schema), and `GET /api/v1/capabilities`
(the distinct, queryable `cap:` vocabulary). The one change in `src/` is a single small,
read-only `ItemRepository.listCapabilityKeys` (static parameterised SQL + a
`CapabilityKeySummary` type) so the capability vocabulary is single-sourced like everything
else — no write path was added anywhere. Conventions: list endpoints return
`{ data, pagination: { limit, offset, count, hasMore } }` (limit clamped to `[1, 100]`,
default 50; relevance `search` stays top-N capped at 25 and is *not* paginated); single
resources return the object directly; **errors** use a structured `{ error: { code, message } }`
envelope on `/api/v1` (codes: `bad_request`/`unauthorized`/`not_found`/`method_not_allowed`/
`too_many_requests`/`snapshot_unavailable`/`internal_error`), while the legacy paths keep
their flat `{ error }`. Auth (constant-time bearer token) and the per-IP token-bucket rate
limit are applied **once, before routing**, so both surfaces share them; the error-envelope
shape is path-aware. Stdlib-only — **no new runtime dependency** (the YAML emitter and a
small `api/` module set: `v1.ts` router, `dto.ts` stable DTOs + pure mappers, `respond.ts`
envelope helpers, `params.ts` clamped parsing, `limits.ts` bounds). A committed
`bridge/openapi.yaml` (OpenAPI 3, **synthetic examples only**) describes the whole v1 surface
and is served at `GET /api/v1/openapi.json`; `bridge/README.md` gained a "Versioned REST API
(`/api/v1`)" section for third-party consumers (conventions, endpoint table, examples,
spec pointer). Verification: bridge suite **85 green** (28 new — full `/api/v1` endpoint
shapes, pagination bounds/clamps, the v1 error envelope, 404s, auth, the alias equivalence,
and an OpenAPI drift-guard + internal-`$ref` sanity check), plus 2 new app-side
`ItemRepository` tests for the vocabulary method (app suite path); `tsc --noEmit` clean for
both the bridge and the app; CI already runs the bridge suite, so the new tests are wired in.
A live `serve.mjs` smoke over the synthetic fixture confirmed the index, paginated `items`,
item detail (placements + capabilities), the capability vocabulary, the v1 `404`/`401`
envelopes, the byte-identical legacy `/search` alias, and `openapi.json` — with the server
log carrying only lifecycle lines (no token, item names, query text, or IPs). Read-only
throughout; no secrets and no real/personal data in any file, fixture, log, or doc
(synthetic / `example.com` / `localhost` / `127.0.0.1` only). The continuation now kicks off
the next Deferred-work item — the **MCP server wrapper**.

## Deferred work — MCP server wrapper

**Decisions taken at entry (all at the offered defaults).** (1) **Transport: stdio only** — a
local stdio MCP server (newline-delimited JSON-RPC on stdin/stdout), the standard for local
agent/desktop use; an HTTP/SSE MCP transport stays deferred. (2) **No SDK — hand-rolled stdlib
JSON-RPC.** The official `@modelcontextprotocol/sdk` vets cleanly on licence (MIT) and
maintenance (Anthropic), but it would be the bridge's **first runtime dependency** (plus
transitive deps and an `npm install` the bridge has so far avoided), breaking its defining
zero-dep, no-build-step invariant. The read-only MCP surface needed (`initialize`,
`tools/list`, `tools/call`, `ping`) is small and stable, so a tiny stdlib JSON-RPC loop
preserves the invariant — the same "stdlib-first" call made for `chokidar` (HA-3) and the rate
limiter (HA-5). (3) **Six `gubbins_*` tools** — one per query-core/repository capability,
snake_case + `gubbins_`-prefixed to avoid agent tool-name collisions.

**Outcome (2026-06-29).** The bridge now exposes its **same read-only core** to an LLM/agent
(e.g. Claude) over a Model Context Protocol **stdio** server, **purely additive** and with
**no new dependency** (stdlib `node:readline` framing + a hand-rolled JSON-RPC 2.0 dispatcher).
Six read-only tools wrap the existing core — never bespoke SQL: `gubbins_search` /
`gubbins_where_is` (the transport-agnostic `query.ts` `searchItems`/`whereIs`, including the
spoken sentence and per-location breakdown), `gubbins_get_item` (a new shared
`loadItemDetail` extracted from the `/api/v1/items/{id}` handler so the HTTP API and the MCP
tool return the *same* `ItemDetailDto` from one source), and `gubbins_list_locations` /
`gubbins_list_categories` / `gubbins_list_capabilities` (the `LocationRepository` /
`CategoryRepository` / `ItemRepository.listCapabilityKeys` reads, mapped through the same
`api/dto.ts` DTOs and returned in the same `{ data, pagination }` envelope, clamped to the same
`[1, 100]` bounds). Each tool result carries both human `text` content and a machine-usable
`structuredContent`; bad arguments raise a `ToolInputError` the dispatcher turns into a
model-visible `isError` result, an unknown tool is a JSON-RPC `-32602`, an unknown method
`-32601`, and any unexpected failure collapses to a generic, leak-free message. It **reuses the
same `hydrate.ts` + the atomic re-hydrating `watcher.ts`**, so the MCP tools answer from fresh
data exactly like the HTTP API. **Transport posture:** stdio is the launched process's own
pipe (trust boundary = the OS process), so there is **no network bearer token** — only
`GUBBINS_SNAPSHOT_PATH` is required (a new shared `config.loadSnapshotPath`); **all logging
goes to stderr** so it never corrupts the stdout protocol channel. New files:
`bridge/src/mcp/{tools,dispatcher,stdio,serve}.ts`, the `bridge/mcp.mjs` bootstrap (mirroring
`serve.mjs`), and `bridge/src/item-detail.ts`; the entry is `node bridge/mcp.mjs` (also `npm
run mcp`). Docs: a new `bridge/README.md` "MCP server (for LLM/agent tools)" section (run
instructions, an MCP-client `mcpServers` config example, and the tool table), the status note,
the layout, and a `.env.example` note that the MCP server needs only the snapshot path.
Verification: bridge suite **113 green** (28 new — 16 tool tests over the synthetic fixture for
shape/not-found/bounds/clamps/invalid-args, 12 dispatcher tests for the handshake, `tools/list`,
the tool-call success/error envelopes, and the JSON-RPC guards), `tsc --noEmit` clean, and an
end-to-end stdio smoke against the synthetic fixture confirmed the `initialize` handshake,
`tools/list`, a `gubbins_where_is`/`gubbins_get_item` call (with both `content` and
`structuredContent`), `ping`, a silent notification, and **stderr carrying only lifecycle
lines** (no token, item names, or query text). CI already runs the bridge tsc + vitest, so the
new tests and type-check are wired in. One runtime gotcha fixed: Node's strip-only TypeScript
mode rejects constructor *parameter properties* (which `tsc` accepts), so the small `RpcError`
uses an explicit field. Read-only throughout — the only SQL is the parameterised
`parseASTtoSQL` the repositories already use; no write path is reachable. No secrets and no
real/personal data in any file, fixture, log, or doc (synthetic / `example.com` / `localhost`
/ `127.0.0.1` only). The continuation now kicks off the next Deferred-work item — **mDNS /
zeroconf discovery**.

## Deferred work — mDNS / zeroconf discovery

**Decisions taken at entry (all at the offered defaults).** (1) **Dependency: hand-rolled,
stdlib-only.** The mDNS / DNS-SD responder is a tiny `node:dgram` multicast shell over a pure
wire-format module — **no new runtime dependency**, consistent with the bridge's defining
zero-dep invariant and every prior "stdlib-first" call (hand-rolled JSON-RPC, the YAML emitter,
the rate limiter; no `chokidar`). The read-only surface needed (encode PTR/SRV/TXT/A, parse a
query's question names, announce/respond/goodbye) is small and RFC-specified, so a dep would
add supply-chain surface (`CLAUDE.md` IP-hygiene) for no gain. (2) **Service type + TXT:** a
dedicated **`_gubbins._tcp.local`** type (so HA matches precisely, not the noisy `_http._tcp`),
instance name `Gubbins Bridge`, and a TXT record of `server=gubbins-bridge`, `api=v1`,
`path=/api/v1`, `version=<bridge version>` — enough for HA to identify and connect, with **no
secret** (the bearer token is never advertised). (3) **Gating:** opt-in `GUBBINS_BRIDGE_MDNS`
(**off by default**) **and** auto-skipped on a loopback bind (advertising a `127.0.0.1`-only
bridge to the LAN is pointless) — both gates must pass.

**Outcome (2026-06-29).** The bridge can now **advertise itself over mDNS / DNS-SD** so Home
Assistant auto-discovers it instead of the user typing host/port — **purely additive**, with
**no change to the query core or the API contract** and **no new dependency**. The advertising
logic is split pure/impure: `bridge/src/mdns/records.ts` is a pure, fully-tested wire-format
module (DNS name/record encoding, PTR + SRV + TXT + A answer building, goodbye/TTL-0 encoding,
question-section parsing with compression-pointer support, the secret-free `buildTxtEntries`,
the opt-in/loopback `resolveMdnsPlan` gate, `pickAdvertisedAddress`, and `sanitizeHostLabel`),
while `bridge/src/mdns/advertise.ts` is the thin `node:dgram` shell that owns the multicast
socket and the announce/respond-to-query/goodbye lifecycle. It is **best-effort and read-only**:
a bind failure (another responder holds UDP 5353, no multicast permission) logs a warning and
the HTTP server carries on — discovery just won't be available. `config.ts` gained
`GUBBINS_BRIDGE_MDNS` (a strict on/off `parseBool`, **off by default**) + an optional
`GUBBINS_BRIDGE_MDNS_NAME`; `serve.ts` starts/stops the advertiser with the server, but only
when opted in **and** LAN-exposed (`resolveMdnsPlan` auto-skips loopback with a clear log line),
resolving the advertised IPv4 from the host's interfaces and stamping the real bridge version
into the TXT record. **The advertisement carries no secret** — only the service type, port, and
the `path`/`api`/`version` TXT — so the token is still entered in HA's UI. **HA side:** the
`manifest.json` gained `"zeroconf": ["_gubbins._tcp.local."]` and `config_flow.py` gained
`async_step_zeroconf` + `async_step_zeroconf_confirm` (via the canonical
`homeassistant.helpers.service_info.zeroconf.ZeroconfServiceInfo`) that pre-fills the
discovered host/port, prompts **only** for the never-advertised token, verifies it against
`GET /health`, and dedupes on `host:port`; the manual `async_step_user` flow is unchanged as a
fallback, and `strings.json`/`translations/en.json` gained the `zeroconf_confirm` step text +
a discovered-card `flow_title`. Docs: a new `bridge/README.md` "mDNS / zeroconf discovery"
section (service type, TXT table, the opt-in/loopback gating, the best-effort note), a config
reference row + `.env.example` entry, the layout, and a `homeassistant/README.md`
auto-discovery callout + a manual discovery test recipe (`avahi-browse`/`dns-sd` over the
synthetic fixture). Verification: bridge suite **134 green** (21 new — the pure
records/gating/address tests), `tsc --noEmit` clean, Python `py_compile`-clean on all
`custom_components/gubbins/` modules, and all JSON parses; two live `serve.mjs` smokes confirmed
both gates — `0.0.0.0 + on` logs `mDNS advertising "Gubbins Bridge" on 224.0.0.251:5353`, while
`127.0.0.1 + on` logs the loopback auto-skip — with the server log carrying only lifecycle
lines (no token, item names, query text, or IPs). CI already runs the bridge tsc + vitest, so
the new tests/type-check are wired in. Read-only throughout — the advertiser only ever reads
interfaces and sends UDP describing the running HTTP service; no write path is reachable. No
secrets and no real/personal data in any file, fixture, log, or doc (synthetic / `example.com`
/ `localhost` / `127.0.0.1` only). The continuation now kicks off the next Deferred-work item —
**Read + limited writes**.

## Deferred work — Read + limited writes

**Decisions taken at entry (all at the offered defaults, user-confirmed).** (1) **Write
transport: "bridge as a peer device" write-back.** A write does **not** issue a bespoke SQL
`UPDATE` on the served snapshot (which the next sync would silently overwrite, or worse, drift).
Instead the bridge reads the latest `gubbins-sync.json` fresh, hydrates it into its private
`node:sqlite` DB (full production schema, triggers and repositories), applies the change through
the app's **own** `ItemRepository` mutation (firing the same recompute/`updated_at` triggers and
appending the same `item_history` ledger row a local PWA edit would), then serialises the whole
merged state back and writes it **atomically** (temp file + rename). The PWA then merges it on its
next sync through the **identical** §7.3 `reconcile`/`applyPlan` path it uses for any peer — so a
bumped `updated_at` wins LWW and a gauge change replays through the Delta-CRDT, with **no drift and
no forked merge logic, and no PWA-side change required.** (2) **Operation set: `adjustQuantity` +
`adjustGauge` only** — a signed delta on a DISCRETE item's home-location stock (check-in/out) and a
signed delta on a CONSUMABLE_GAUGE net value; both map 1:1 to existing app repository methods.
Transfers/moves stay out (YAGNI). (3) **Auth posture: off by default behind
`GUBBINS_BRIDGE_ALLOW_WRITES`** (a strict on/off flag); when on, writes use the **same** bearer
token + per-IP rate limit as reads. (4) **MCP stays read-only** — writes are HTTP-only, the
smaller blast radius.

**Outcome (2026-06-29).** The bridge gained an **opt-in, off-by-default** set of limited write
endpoints that break the read-only invariant *only* when `GUBBINS_BRIDGE_ALLOW_WRITES=on`, and
do so **without drift** by round-tripping through the app's real sync merge — **no bespoke SQL,
no forked merge, no PWA change**. New `bridge/src/write.ts` holds the split core: `applyOperation`
(pure-ish — dispatches to `ItemRepository.adjustQuantity`/`adjustGauge`, mapping a missing item to
a `404` and a domain rejection to a `422` with the app's own safe message) and `executeWrite` (the
file-IO orchestrator: read fresh → `hydrateFromJson` → apply → `buildLocalSnapshot` →
`snapshotToBackupJson` → **atomic** temp-file-then-`rename` write-back). A `createWriteExecutor`
**serialises** writes (a promise chain) so two concurrent writes can't both read the pre-write
state and clobber each other. The HTTP surface is **purely additive**: two **POST** endpoints under
`/api/v1` — `items/{id}/adjust-quantity` and `items/{id}/adjust-gauge`, body `{ delta, note? }`,
returning the updated `ItemDetail` — gated so that when writes are off they `404` (invisible), a
POST to a read resource is `405`, and an unknown action is `404`; auth + rate limit are shared with
reads. `server.ts` now accepts POST (with a bounded 8 KB JSON body reader), `config.ts` parses the
new flag (off by default), `serve.ts` wires the executor and logs an explicit "Writes ENABLED"
line, and the OpenAPI spec/`openapi.yaml` describe the two POSTs (new `unprocessable`/`422`) — the
existing read-only HTTP/`/api/v1`/MCP contract is **unchanged**. **Tests:** the **gold round-trip**
(`write.test.ts`) proves no-drift by driving the app's **real** `reconcile`/`applyPlan`: a bridge
check-out (`-2`) converges on a simulated PWA via LWW and is idempotent; a *newer* local edit
correctly wins (the bridge's older change is not bulldozed); and a gauge change converges via the
§7.3 Delta-CRDT replay (gauge built with the app's own `create`+`adjustGauge` so the ledger
invariant holds) — plus pure `applyOperation` cases (not-found `404`, below-zero/non-integer/wrong-
mode `422`), the `executeWrite` atomic write-back + the `503` read-failure mapping + write
serialisation, in-process server routing/gating/validation/error-mapping (`server-writes.test.ts`),
and the config flag. The synthetic fixture gained the previously-missing `stock_batches` rows
(Phase 28 SSOT) so it is realistic and the batch-aware write path works; item counts are unchanged.
Bridge suite **162 green** (was 134), `tsc --noEmit` clean, and a live `serve.mjs` smoke confirmed
a POST `-3` taking `M3 x 10 Hex Bolt` 42→39 (the bridge's own watcher re-hydrating its atomic
write-back so the next read reflects it), the on-disk file gaining a `QUANTITY_CHANGE` ledger row,
`401` on a missing token, and `404` + `writable:false` when writes are off — with the log carrying
only lifecycle lines (no token, item names, query text, or IPs). **HA side (thin):** a new opt-in
`gubbins.adjust_quantity` service (a `POST` client method that maps a `404` to a clear "writes
disabled / unknown item" error), with `services.yaml`/`strings.json`/`translations` entries and a
manual write test recipe; `py_compile`-clean and all JSON/YAML parse. Read-only stays the default
everywhere; no secrets and no real/personal data in any file, fixture, log, or doc (synthetic /
`example.com` / `localhost` / `127.0.0.1` only). The continuation now kicks off the next
Deferred-work item — **Direct `.sqlite` data source**.

## Deferred work — Direct `.sqlite` data source

**Decisions taken at entry (all at the offered defaults).** (1) **Source selection: one
`GUBBINS_SNAPSHOT_PATH`, auto-detected** — `.json` → JSON snapshot, `.sqlite`/`.sqlite3`/`.db`
→ raw SQLite, with a 16-byte `"SQLite format 3\0"` magic-byte sniff resolving an ambiguous
extension. Preferred over a second `GUBBINS_SQLITE_PATH` env: minimal config surface, no
"both set" ambiguity, and transparent to the (unchanged) watcher / server / MCP. (2) **Open a
private copy, read-write.** The raw file is *copied* to an OS temp directory and the copy is
opened — never the user's export — because a freshly-exported file may be locked or mid-write,
because migrations must *write* (an older export needs new tables) and must not mutate the
user's file, and because opening a SQLite file spawns `-journal`/`-wal`/`-shm` sidecars that
would otherwise pollute their folder. The migration engine then runs idempotently to bring any
past `user_version` up to the current schema (FTS5 / triggers / derived tables), exactly as the
PWA does on open; an export *newer* than the bridge understands is refused with a clear message,
mirroring the JSON path's `formatVersion` guard. (3) **Watcher re-hydrates a `.sqlite` source by
re-copy + re-open + migrate**, through the unchanged atomic-swap (the old copy's temp dir is
removed when its driver is closed). (4) **Writes stay JSON-only.** A raw `.sqlite` source has no
sync channel to round-trip through (the PWA never reads the exported `.sqlite` back), so writes
would drift — they are refused for a `.sqlite` source even when `GUBBINS_BRIDGE_ALLOW_WRITES=on`.

**Outcome (2026-06-29).** The bridge can now hydrate from a **raw exported `.sqlite` database**
as an alternate to the `gubbins-sync.json` snapshot — **purely additive**, with the query core,
HTTP API, `/api/v1`, MCP server, watcher and the opt-in writes all **unchanged**; only the
"source → driver" front-end gained a second path. The new `bridge/src/sqlite-source.ts` holds it:
`detectSource` (extension-first, magic-byte fallback), `sourceKindFromExtension` (the synchronous
classifier the write-gate uses), `writesEnabledForSource` (the pure JSON-only write gate), and
`hydrateFromSqliteFile` (copy the export to a private `mkdtemp` dir → open the copy via
`createNodeDriver(filePath)` → guard `user_version` ≤ `TARGET_SCHEMA_VERSION` → `runMigrations`
→ return the same `HydrateResult` shape, with the driver's `close()` also removing the temp copy
+ sidecars). `hydrate.ts`'s `hydrateFromFile` now dispatches on `detectSource`, so the
**unchanged** watcher/CLI consume either source identically (a raw `.sqlite` gets a synthesised
snapshot envelope whose `generatedAt` is the export's mtime). `node-driver.ts` gained one optional
`location` parameter (default `:memory:`), so the same production driver runs over a file copy;
no other `src/` or bridge file's behaviour changed. `serve.ts` detects the source once at startup
and wires the write executor **only for a JSON source** — a `.sqlite` source logs "Data source:
raw .sqlite export" and, if writes were requested, a clear "REFUSED" line, and the HTTP write
paths `404` (with `/api/v1` reporting `writable:false`). **Confirmed facts:** the raw export is a
self-contained SQLite file (its 16-byte magic header verified), already in the app's schema, so
the existing repositories + the single `parseASTtoSQL` answer over it unforked; full-res image
bytes are OPFS *files* (in neither source) and the read path never dereferences them, so parity
holds. **Tests:** 12 new in `bridge/src/sqlite-source.test.ts` over a synthetic `.sqlite`
**generated at test time** from the same synthetic JSON fixture (no binary DB committed —
`.gitignore` already blocks `*.sqlite`/`*.db`): source detection (extension + magic-byte sniff +
unreadable→JSON default), the write-gate truth table, row-count/FTS/`cap:`/recompute-trigger
parity with the JSON path, idempotent migrate to `TARGET_SCHEMA_VERSION`, the user's file left
unmutated (works on a copy), the newer-than-known refusal, and `hydrateFromFile` returning
identical items from a `.sqlite` and the JSON. Bridge suite **174 green** (was 162),
`tsc --noEmit -p bridge/tsconfig.json` clean; CI already runs the bridge suite + type-check, so
the new tests are wired in. A live smoke confirmed it end-to-end: `node bridge/cli.mjs
synthetic.sqlite` prints `schema migrated: v19 → v19` and `Active items: 4`, and `serve.mjs`
against the `.sqlite` with `GUBBINS_BRIDGE_ALLOW_WRITES=on` served `/health` (`itemCount 4`), a
spoken `/where`, a POST adjust → `404` (writes refused), and `/api/v1` `writable:false` — the log
carrying only lifecycle lines (no token, item names, query text, or IPs). No HA-side change was
needed (a data-source change is invisible to the integration, which still consumes the same HTTP
contract). Read-only by default everywhere; no secrets and no real/personal data in any file,
fixture, log, or doc (synthetic / `example.com` / `localhost` / `127.0.0.1` only). The
continuation now kicks off the next Deferred-work item — **PWA "push to bridge"**.

## Deferred work — PWA push to bridge

**Decisions taken at entry (all user-confirmed).** (1) **Flag: `GUBBINS_BRIDGE_ALLOW_PUSH`,
independent of writes.** Push *replaces* the whole served snapshot; the §7.3 limited writes apply a
surgical per-item change — orthogonal concerns, so two independent off-by-default opt-ins (you can
enable either, both, or neither). (2) **Endpoint `POST /api/v1/snapshot`; body streamed to a temp
file; cap user-configurable** via `GUBBINS_BRIDGE_MAX_PUSH_BYTES` (default 64 MiB). The user asked
about constrained hosts (a Pi/NAS on an SD card), so the cap is tunable and the body is streamed to
a sibling temp file as it arrives (rejected at the cap *before* it is all on disk) rather than
buffered whole. (3) **PWA setting lives on the SyncScreen; URL + token in `usePreferencesStore`**
(localStorage, device-local, never synced/committed; token in a masked input). (4) **Not exposed
over MCP** — push stays HTTP-only, mirroring the limited-writes decision (MCP stays read-only).

**Outcome (2026-06-29).** The final Deferred-work item shipped — a PWA-side "push to bridge" plus
the bridge endpoint that receives it — **purely additive**, with the read-only HTTP/`/api/v1`/MCP
contract and the opt-in writes **unchanged**. **Bridge side:** a new `bridge/src/push.ts` holds the
split core — `validateSnapshotText` (pure: runs the app's **existing** `parseBackupJson` version
guard, mapping a malformed/missing-version body to a `400` and a *newer*-format snapshot to a `422`)
and `ingestSnapshot` (streams the request body to a sibling temp file bounded by `maxBytes`, rejects
an over-large body with `413` *before* it is all on disk, validates, then `rename`s the temp file
over `GUBBINS_SNAPSHOT_PATH` — an atomic publish, so the **unchanged** watcher re-hydrates the
pushed bytes through its normal path; the temp file is always cleaned up on failure). It runs **no
SQL** — it only validates JSON and renames a file — so the single `parseASTtoSQL` is untouched.
`server.ts` gained a `PushCapability` (present only when enabled) and routes `POST /api/v1/snapshot`
to a streaming handler *before* the small bounded JSON-body reader the writes use, mapping a
`PushError` to its status/code and `404`-ing when push is off (invisible); `config.ts` parses the
new **independent** `GUBBINS_BRIDGE_ALLOW_PUSH` flag (off by default) + `GUBBINS_BRIDGE_MAX_PUSH_BYTES`
(default `DEFAULT_MAX_PUSH_BYTES` = 64 MiB); `sqlite-source.ts` gained `pushEnabledForSource`
(mirrors `writesEnabledForSource` — refused for a raw `.sqlite` source); `serve.ts` wires the
capability only for a JSON source and logs an explicit "Snapshot push ENABLED" / "REFUSED" line;
the `/api/v1` index now reports `pushable`; and the OpenAPI spec/`openapi.yaml` describe the POST
(new `payload_too_large`/`413`, a `push` tag). **PWA side:** a pure, transport-only
`src/features/sync/push-to-bridge.ts` builds the payload with the **same**
`snapshotToBackupJson(buildLocalSnapshot(...))` the folder sync and "Download backup" use (never a
hand-rolled shape, so the bytes are byte-identical to a synced file) and shapes/maps the request
(`resolveBridgeIngestUrl`/`buildPushRequest`/`pushSnapshotToBridge`/`mapPushResponse`), returning a
friendly, token-free result for every status; it imports **nothing** from `bridge/` (no bundle
bloat). `usePreferencesStore` gained device-local `bridgeUrl`/`bridgeToken` (the token treated as a
secret — masked input, never synced/committed), and the **SyncScreen** gained a "Push to bridge"
section built entirely from Foundry primitives + design tokens (`Surface`, `FormField`, `Input`,
`Button`, `Banner`, `text-muted-foreground`, `CloudUploadIcon`) — no raw colour/spacing literals.
**Tests:** bridge suite **194 green** (was 174 — 20 new: `push.test.ts` validation + streaming
ingest + the watcher-serves-a-pushed-snapshot round-trip, `server-push.test.ts` routing/gating/
error-mapping, plus the new config-flag and `pushEnabledForSource` cases); PWA-side `push-to-bridge.test.ts`
(12 — URL/token shaping, status→message mapping, the no-throw unreachable path with no token/error
leak, and a `buildPushSnapshotJson` round-trip through `parseBackupJson` over a real memory driver).
`tsc --noEmit` clean for **both** the bridge and the app; the sync feature suite is green; CI already
runs both suites + type-check, so the new tests are wired in. A live `serve.mjs` smoke over the
synthetic fixture confirmed the `/api/v1` index (`pushable:true`, `writable:false` — independent
opt-ins), a `POST /api/v1/snapshot` → `200 { ok, formatVersion, generatedAt }` with the watcher
re-hydrating the atomic write-back (a pushed rename of `M3 x 10 Hex Bolt` → `M3 LIVE-PUSHED Bolt`
visible on the next read), and `401` without a token — the log carrying only lifecycle lines (no
token, item names, query text, or IPs). No HA-side change was needed (this is a PWA↔bridge feature;
the integration still consumes the unchanged read contract). No secrets and no real/personal data
in any file, fixture, log, or doc (synthetic / `example.com` / `localhost` / `127.0.0.1` only). This
was the **last** Deferred-work item — all planned (HA-1→HA-5) and deferred work is now complete.

## Security & privacy checklist (applies to every phase)

- **Read-only by design** — no endpoint mutates data; the SQL path is `parseASTtoSQL`
  (parameterised), never string-built.
- **No secrets in the repo** — the bridge token and any config live in `.env` (git-
  ignored); only `.env.example` with placeholders is committed (`CLAUDE.md`).
- **No real/personal data in fixtures or docs** — synthetic items, `example.com`,
  `localhost`, made-up part numbers only.
- **Local-first preserved** — the bridge runs on the user's own hardware; **no cloud
  relay**, nothing leaves the LAN. The PWA's "nothing sent to a server" promise is intact
  (the user explicitly chooses to run the bridge and point HA at it).
- **Minimal dependency surface** — stdlib-first; vet licence/maintenance before adding
  any dep (`CLAUDE.md` IP-hygiene rules).
- **Public-repo hygiene** — professional, neutral comments/commits; no internal hostnames
  or infra details.

## Continuation prompt

> **All planned and deferred work is complete — there is no further kick-off prompt.**
>
> The phased plan (HA-1 → HA-5) and **every** Deferred-work item are done and shipped: the
> generic versioned REST API, the MCP server wrapper, mDNS / zeroconf discovery, Read + limited
> writes, the Direct `.sqlite` data source, and (finally) the PWA "push to bridge". See the
> per-item **Outcome** sections above for what each delivered. There is nothing left to schedule;
> the Continuation-prompt rule has been satisfied by retiring the prompt rather than replacing it.
>
> If a *new* enhancement is wanted later, add it as a fresh item under "Deferred work (tracked,
> never dropped)" with a concrete target, and seed a new continuation prompt for it then — do not
> revive the (now historical) prompt below.

<details>
<summary>Historical: the kick-off prompt for the final item (PWA "push to bridge"), now complete.</summary>

```text
We're extending the Gubbins query bridge. The full plan and history are in
docs/todo/home-assistant_2026-06-29.md — read it first (especially "The hard constraint",
"Architecture: an optional companion bridge", the locked decisions, the "Deferred work"
list, the "Security & privacy checklist", ALL the Phase HA-1 through HA-5 Outcome notes, and
the "## Deferred work — generic REST API", "## Deferred work — MCP server wrapper",
"## Deferred work — mDNS / zeroconf discovery", "## Deferred work — Read + limited writes" AND
"## Deferred work — Direct .sqlite data source" Outcomes). Phases HA-1 to HA-5 are DONE and
shipped, AND FIVE Deferred-work items are DONE: (a) the generic, versioned, read-only REST API,
(b) the MCP server wrapper, (c) mDNS / zeroconf discovery, (d) Read + limited writes, and (e) the
Direct .sqlite data source. This is the LAST Deferred-work item. Today the bridge/ package
hydrates EITHER a gubbins-sync.json snapshot OR a raw exported .sqlite (auto-detected by
GUBBINS_SNAPSHOT_PATH; see bridge/src/sqlite-source.ts) into a headless node:sqlite DB, has a pure
read-only query core (bridge/src/query.ts), and exposes it over the SAME core and the SAME atomic
re-hydrating watcher: a local, bearer-token-protected, rate-limited node:http API (the original
GET /health,/search,/where paths AND an additive, OpenAPI-described /api/v1 surface —
items/locations/categories/capabilities + those three as aliases), a read-only MCP stdio server
(six gubbins_* tools via a hand-rolled stdlib JSON-RPC dispatcher, run via bridge/mcp.mjs), and an
OPT-IN, stdlib-only mDNS/DNS-SD advertiser (bridge/src/mdns/, gated on GUBBINS_BRIDGE_MDNS=on +
LAN-exposed). It also has an OPT-IN, off-by-default set of LIMITED WRITES (bridge/src/write.ts,
gated on GUBBINS_BRIDGE_ALLOW_WRITES=on, and only for a JSON source): two POST
/api/v1/items/{id}/adjust-quantity|adjust-gauge endpoints that apply a stock change through the
app's OWN ItemRepository mutation and write the merged snapshot back atomically, so the PWA merges
it via the §7.3 LWW/Delta-CRDT path with no drift. It is packaged (build-free node:slim Docker
image + hardened systemd unit) and documented, with CI running its tests alongside the app suite.
A HACS-compatible Home Assistant custom integration (homeassistant/custom_components/gubbins/)
consumes the HTTP API (zeroconf discovery + an opt-in gubbins.adjust_quantity write service). Note
another agent may be working on the codebase concurrently.

Read bridge/README.md (the "Data sources", "HTTP API", "Versioned REST API (/api/v1)", "MCP
server", "mDNS / zeroconf discovery", "Limited writes (opt-in)" sections, AND the "Shared-code
mechanism" section) and homeassistant/README.md first. ALSO read the PWA sync code:
src/features/sync/providers/file-system-provider.ts and src/features/sync/backup.ts
(snapshotToBackupJson / buildLocalSnapshot), and the existing sync UI (src/features/sync/*,
src/features/settings/SettingsScreen.tsx). Key facts you must reuse, NOT re-derive (and NOT
regress):
- The bridge is stdlib-only (zero runtime deps) and runs TypeScript directly with no build
  step via bridge/loader.mjs (Node >= 23.6). Run the HTTP server: `node bridge/serve.mjs`
  after copying bridge/.env.example → .env (git-ignored) and setting GUBBINS_BRIDGE_TOKEN +
  GUBBINS_SNAPSHOT_PATH. The server binds 127.0.0.1 (loopback) by DEFAULT; LAN exposure
  (GUBBINS_BRIDGE_HOST=0.0.0.0) and writes (GUBBINS_BRIDGE_ALLOW_WRITES=on) are explicit,
  logged opt-ins. The shipped HTTP API + /api/v1 (bridge/openapi.yaml) and MCP contract are a
  contract — DO NOT break them; keep changes ADDITIVE. ALL SQL flows through the single imported
  parseASTtoSQL — never string-build SQL; never fork it.
- The PWA already serialises its whole dataset to the SAME versioned JSON the bridge hydrates:
  src/features/sync/backup.ts `snapshotToBackupJson(buildLocalSnapshot(driver, now))` produces
  exactly the gubbins-sync.json bytes. The FS-Access sync (src/features/sync/providers/
  file-system-provider.ts) writes that to a user-chosen folder. "Push to bridge" must REUSE that
  same snapshot builder — never hand-roll a payload — so what the bridge ingests is byte-identical
  to what the watcher reads from a file.
- The synthetic fixture (bridge/src/fixtures/synthetic-snapshot.json) has made-up parts only
  (incl. item_stock + stock_batches). Use ONLY synthetic data / example.com / localhost /
  127.0.0.1 in any example, test, or doc; tokens live in .env / HA's UI, never committed.

Please implement the FINAL **Deferred work** item: **PWA "push to bridge"** — a PWA-side feature
that POSTs the dataset to the bridge on demand, for users who don't use FS-Access sync (so they
don't need a shared folder at all — the PWA hands the snapshot straight to the bridge). In short:

- Bridge side (additive, gated): add an OPT-IN ingest endpoint — POST /api/v1/snapshot (or
  similar) — that accepts the SAME versioned backup JSON the watcher reads, validates it via the
  EXISTING parseBackupJson version guard, and writes it to GUBBINS_SNAPSHOT_PATH **atomically**
  (reuse write.ts's temp-file-then-rename writeSnapshotAtomic), so the existing watcher re-hydrates
  it through the unchanged path. It must be OFF by default behind a new explicit flag
  (e.g. GUBBINS_BRIDGE_ALLOW_PUSH=on — decide the name and confirm at entry), use the SAME bearer
  token + rate limit as everything else, 404 when disabled, and bound the body (a snapshot is
  larger than a {delta} — pick and justify a sane cap, streamed to disk if needed). It must be
  REFUSED for a raw .sqlite source (no JSON sync channel — mirror the write-gating in
  sqlite-source.ts). It is distinct from the §7.3 limited writes: push REPLACES the snapshot the
  bridge serves; decide and CONFIRM how it interacts with GUBBINS_BRIDGE_ALLOW_WRITES (likely
  independent opt-ins).
- PWA side (additive, design-tokens-mandatory): a small "Push to bridge" action (likely in the
  sync/settings area) that builds the snapshot via the EXISTING snapshotToBackupJson/
  buildLocalSnapshot and POSTs it to a user-configured bridge URL + token (stored in the existing
  preferences/settings store, NOT committed; treat the token like any secret). Graceful, tokenised
  UI for success/failure. ANY PWA UI here MUST use design tokens / Foundry primitives (CLAUDE.md —
  variant="primary"/"destructive", bg-card, text-muted-foreground, ease-emphasized, etc.), NEVER
  raw hex/rgb/oklch or ad-hoc Tailwind palette classes. Keep PWA logic pure + unit-tested where it
  can be (the snapshot-build + POST-shaping), and don't bloat the browser bundle with bridge code.
- Decide and CONFIRM AT ENTRY: (1) the ingest flag name + whether push and writes are independent;
  (2) the endpoint path + the body cap + whether to stream the body to a temp file; (3) where the
  PWA setting lives + how the bridge URL/token are stored (reuse the existing settings store);
  (4) whether to also expose this over MCP (likely NO — keep push HTTP-only, like writes).

Tests: bridge-side over the synthetic fixture (ingest accepts a valid snapshot and the watcher
serves it; 404 when disabled; refused for a .sqlite source; bad/oversized body rejected; version
guard enforced); PWA-side pure tests for the snapshot-build + request shaping. Type-check clean
(bridge AND app); both suites green and wired into CI. Keep the existing read-only HTTP API + MCP
+ /api/v1 contract and the opt-in writes UNCHANGED and additive. Any HA-side change stays thin +
py_compile-clean with a manual test recipe (likely none — this is a PWA↔bridge feature).

Hard rules: the existing read-only + opt-in-write surfaces must not regress; keep the bridge
stdlib-only (no new runtime dep) unless you justify and vet one; ALL SQL still flows through the
imported parseASTtoSQL; PWA UI uses design tokens / Foundry primitives only; NO secrets and NO
real/personal data in any file, fixture, log, or doc (synthetic / example.com / localhost /
127.0.0.1 only) — never commit a real snapshot/.sqlite/.db or a token. When this item is done (or
consciously deferred with a design note), tick/annotate its box in the "Deferred work" list, add
a one-paragraph Outcome note (a new "## Deferred work — PWA push to bridge" section mirroring the
others). This is the LAST Deferred-work item, so per the doc's Continuation-prompt rule, finish by
replacing this "Continuation prompt" section to note that ALL planned + deferred work is complete
(no further kick-off prompt is needed) — and say so in your chat reply.
```

</details>

## Open questions to resolve at the relevant phase entry

1. **Shared-code mechanism** (HA-1): npm workspace + `@gubbins/core` export, or a Node
   `tsconfig` path alias over `../src`? Whichever keeps `parseASTtoSQL` single-sourced.
2. **Dependency budget** (HA-3): stdlib `node:http`/`fs.watch` vs. a tiny framework +
   `chokidar`. Default stdlib-first.
3. **Multi-vault / multi-folder** (HA-3+): one snapshot file, or support several (e.g. a
   household with multiple devices syncing different folders)? Default: one to start.
4. **Spoken-answer phrasing & locale** (HA-2): how chatty; reuse the app's locale/currency
   preferences if they appear in the snapshot? Default: concise British English.

