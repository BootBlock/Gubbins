# Full codebase audit — phased plan and findings register

> **Status:** 🟢 ACTIVE — Phases 0–1 complete; Phase 2 (the item repository family) is next.

This is the single source of truth for a whole-repository audit of Gubbins. Its purpose is to find
every **genuine** mechanical, functional, performance and prompt defect in the codebase and log each
one as a GitHub issue — nothing more. **The audit fixes nothing.** Fixing is the job of the ordinary
issue workflow in `CLAUDE.md`, one issue at a time, after this audit has produced the backlog.

It is a **living document**. Each phase updates the phase map (§8), the findings register (§10), the
carry-over list (§11) and the change log (§13) in the same change that lands its work, so the next
session can pick up from the document alone. A phase is started by pasting its prompt (§9) into a
fresh session.

Sibling audits already on record, kept so their conclusions are not re-derived:
[`done/feature-gap-audit_2026-07-09.md`](done/feature-gap-audit_2026-07-09.md) (feature gaps
against comparable tools), [`done/ui-bodge-audit.md`](done/ui-bodge-audit.md) (design-system
bodges) and the 2026-06-29 security audit (no exploitable defect; CSP tightened to zero inline
scripts). This audit is broader than all three and does not repeat their scope questions; it looks
for defects in what exists.

---

## 1. Scope

**Everything tracked in the repository is in scope**, partitioned into the phases in §8 so that each
session has a bounded reading list. The partition is by directory, so nothing falls between two
phases; the phase map names every top-level path once. Where a finding's root cause lies outside the
phase that noticed it, the finding is still verified and filed — the register records which phase it
belongs to.

Out of scope, deliberately:

- **Fixing.** Not even a one-line fix. A phase that fixes something has stopped auditing.
- **Feature gaps.** "Gubbins does not do X" is a feature request, not a defect, unless the app, the
  wiki or a tool description *claims* it does X. Feature gaps were the subject of the earlier audit
  above and are filed as `enhancement` issues only when a claim is contradicted.
- **Style preferences.** A finding must name a consequence a user, an integrator, an agent or a
  future maintainer will actually suffer. "I would have written this differently" is not one.
- **The sibling programmes that are already tracked as issues** — see §4.2. A phase may file a
  *new, specific* defect inside one of those areas, but never a restatement of the programme.

## 2. What counts as a finding

Four classes. Every finding is tagged with exactly one primary class in the register; the issue's
labels come from the class and the area (§5.3).

### 2.1 Mechanical

The code does not do what the code says it does, or does it unsafely. Examples: an unhandled
rejection; a missing `await`; a race between an effect and its cleanup; an event listener, timer or
worker that is never released; a swallowed error; a cast (`as any`, `as unknown as`, a `!` assertion)
that hides a real `null`; a `switch` over a domain union without the exhaustive guard; SQL that
interpolates an identifier; a multi-statement write outside a transaction; a persisted-store shape
read back without reconciliation; a seam bypassed where `CLAUDE.md` or a memory note says it must
not be (§7 lists them with a grep for each); a build, lint, hook or CI step that cannot fail or does
not run what it says it runs; a test that cannot fail.

### 2.2 Functional

The code does what it says, but what it says is wrong for the user. Examples: behaviour that
contradicts the wiki, a tool description, a label, a tooltip or the issue that introduced it; an
off-by-one at a page, day or currency boundary; a timezone or DST shift; a validation gap that lets a
bad value in or a good value out; an unreachable state or control; a permission the ACL layer does
not enforce; two devices that do not converge after sync; an offline path that silently loses a
write; a keyboard, focus or screen-reader path that does not work; a copy string that misleads.

### 2.3 Performance

The code produces the right result at a cost the target hardware cannot pay. Gubbins must run from
a low-end phone to a desktop (issue #112), and visual effects are not to be removed to get there.
Examples: an unbounded query; a `SELECT *` or a blob column read into a list; a correlated subquery
per row on a paginated scan; an N+1 loop of round-trips through the worker RPC; an invalidation that
refetches everything on every write; a component that re-renders a whole list on one keystroke; a
list that is not virtualised; an image decoded at full size for a thumbnail; work on the main thread
that belongs in the worker; object churn in a hot loop or an animation frame; a chunk that loads
eagerly but is used rarely; a service-worker precache that has grown past what a first install can
afford. A performance finding needs a **measurement** (§3.3), not an opinion.

### 2.4 Prompt

Text that another program or a model reads and acts on, where the text is ambiguous, wrong, stale or
self-contradictory. Two surfaces:

- **Shipped to integrators and assistants:** the MCP tool names, schemas and descriptions
  (`bridge/src/mcp/tools.ts`), the spoken-answer shaper (`bridge/src/spoken.ts`), the Home Assistant
  intent sentences and strings (`homeassistant/custom_sentences/`, `custom_components/gubbins/`),
  the OpenAPI document (`bridge/openapi.yaml`), the OData metadata, and the wiki page an assistant
  user is pointed at. A tool whose description promises a filter the dispatcher ignores, a schema
  whose enum is narrower than the database's, an error string that leaves the model no way to
  recover, a sentence the intent parser cannot match — these are prompt defects.
- **Read by agents and contributors working on the repository:** `CLAUDE.md`, `AGENTS.md`,
  `.claude/skills/*/SKILL.md`, the issue and PR templates, `docs/dev/*`, the live plans in
  `docs/todo/`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `bridge/README.md`,
  `extension/README.md`. A command that no longer exists, a rule that contradicts another rule, a
  path that moved, a count that went stale, an instruction that a session cannot follow as written
  — these are prompt defects too, and they are cheap to verify: run the command, open the path.

## 3. The verification standard (mandatory)

**A candidate becomes a finding only when it has been demonstrated, not argued.** This is the
project's standing rule — check the real state, never infer it — applied to the audit. A confident
wrong issue costs more than a missed one, because it gets actioned.

### 3.1 Every finding needs all of these

1. **A location.** `path:line` at the pinned commit (§6.2). "Somewhere in sync" is not a location.
2. **A demonstration**, one of:
   - a scratch test that fails on the current code for the stated reason (§3.2);
   - a script, query or command whose output shows the defect (paste the output);
   - the app driven in a real browser with the `verify` skill, with the observed vs expected state
     written down (and a screenshot where a screenshot is the evidence);
   - for performance, a measurement (§3.3);
   - for prompt defects, the text quoted beside the behaviour or state that contradicts it, and — for
     a stale command or path — the command run and its failure shown.
3. **A consequence.** Who is affected and how (§5.2 severity). A defect with no consequence is
   rejected, and the rejection is recorded so the next phase does not re-find it.
4. **A dedupe check** against open *and* closed issues, this register, and the deliberate-decision
   sources (§4).
5. **A re-check against the tip of `main`** immediately before filing, because `main` advances while
   a phase runs and a finding fixed in the meantime is a duplicate, not a finding.

### 3.2 Scratch tests

A scratch test is the preferred demonstration for a mechanical or functional finding because it can
be re-run by whoever actions the issue. Rules:

- Name it `<subject>.audit-scratch.test.ts(x)` beside the code it exercises, inside the phase's
  worktree. The suffix makes it visible in `git status`; **none is ever committed** — the landing
  step (§6.6) greps for the suffix and refuses to commit if one is present.
- Run it from the worktree with `npx vitest run --config vitest.worktree.config.ts <file>`
  (never junction `node_modules` for Vitest — two instances). Bridge code uses
  `--config bridge/vitest.config.ts` from the primary checkout only; a bridge scratch test therefore
  lives in the scratchpad and is copied in for the run.
- The test must **fail for the stated reason**. Read the failure. A test that fails because of a
  fixture typo proves nothing, and a test that passes has disproved the candidate — record that.
- Paste the essential assertion and the failure output into the issue body, so the fixer can
  reproduce it without the scratch file.

### 3.3 Performance measurements

- **SQL:** build the real schema from
  `src/db/migrations/__fixtures__/schema-baseline.snapshot.json`, seed in chronological order, and
  measure with **no `ANALYZE` and no `PRAGMA optimize`** — the shipped planner has no statistics. Report
  `EXPLAIN QUERY PLAN` output and ratios between shapes, not absolute milliseconds. The memory note
  `Benchmarking index changes no stats` has the full recipe.
- **Rendering and interaction:** drive the app with Playwright against a seeded vault, with CDP CPU
  throttling (4×) to stand in for a low-end phone, and read the React Profiler or a performance
  trace. Count renders or long tasks; do not eyeball.
- **Bundle and precache:** `npm run build` and `npm run check:bundle`; compare the chunk map to what
  a cold first paint actually needs.
- **Memory:** a heap snapshot before and after a repeated action; growth that does not plateau is
  the finding.
- State the hardware and the seed size in the issue. A claim that cannot be re-measured is not filed.

### 3.4 Unverifiable candidates

A candidate the verifier cannot demonstrate here — it needs a device, a network, a second machine, a
Home Assistant instance — is **not** filed. It goes to §11 with a note of exactly what would settle
it. The close-out phase reviews §11 with the maintainer.

## 4. Dedupe and deliberate decisions

### 4.1 The dedupe check

Before filing, search **all** issues, not just open ones — 565 are closed and many closed ones
document a decision:

```bash
gh issue list --repo BootBlock/Gubbins --state all --limit 1000 --search "<two or three distinctive words>" --json number,title,state,labels
```

Search twice with different words (the symptom and the location). A closed issue that describes the
same defect means either it regressed (file a new issue that links the old one and says so) or the
fix was partial (file the residue, narrowly). A `wontfix` closure is a deliberate decision — do not
re-file; record the candidate as rejected with the issue number.

Also check: this register (§10) including other phases' rejections; §11; the "deliberate non-goals"
and "considered but not flagged" sections of the plan docs in `docs/todo/` and `docs/todo/done/`;
the memory notes the session-start hook lists (a note that explains *why* something is the way it
is — the OAuth implicit flow, the unconditional `ON CONFLICT DO UPDATE`, the number field that
reports and never rewrites — is a decision, not a defect); and the code's own comments, which in
this repository frequently record the decision beside the code.

### 4.2 Tracked programmes — do not restate

These are open, known and owned. A phase files a finding in one of these areas only when it is
**new and specific** — a concrete defect the programme's issues do not already name.

| Programme | Issues |
| --- | --- |
| i18n conversion of the remaining screens and strings | #60, #213, #224–#244, #682 |
| Accessibility sweep findings | #209–#223, #491, #515, #541–#553, #671 |
| Full performance pass | #112 (this audit's Phase 18 *is* that pass; its findings link to #112) |
| Repository metadata and settings audit | #454 (Phase 0 covers the file side; the settings side stays with #454) |
| Wiki coverage gaps | #53, #263–#271, #395, #580, #581, #585, #611 |
| Backlog triage order | #403 |
| Dependency upgrades blocked upstream | #186, #401 |

## 5. Issue format

Issues are world-readable and permanent. They describe **what** is wrong and **why it matters**, never
the plumbing that found it — no worktree, sub-agent, scratch-test, phase or register names, no
tool-call narration, no agent reasoning. The scratch test's *assertion* is evidence and belongs in
the issue; the fact that a scratch test was the method does not.

### 5.1 Title

One factual sentence, in the repository's house style: **what does what, so what happens** — e.g.
*"A loan created from a booking is due at the start of the booking's last day, so it is overdue for
the whole of it"*. No severity prefix, no `[area]` tag, no "Bug:" — labels carry those. The title
must be true on its own; a reader who sees only the title in a list should know what is broken.

### 5.2 Body

Write it to a file and pass `--body-file`; never inline a multi-line body.

```markdown
## What happens
<the observed behaviour, in user or integrator terms>

## Where
[path/to/file.ts:123](https://github.com/BootBlock/Gubbins/blob/<sha>/path/to/file.ts#L123)
<one line per relevant location; permalinks to the pinned commit, not to `main`>

## How to reproduce / how it was verified
<steps, or the assertion and its failure output, or the measurement with its setup>

## Expected
<what should happen, with the source of that expectation: the wiki page, the tool description,
the label, the issue that introduced the behaviour, or the invariant in CLAUDE.md>

## Impact
Severity: <data-loss | wrong-data | unusable | degraded | cosmetic>
<who is affected, under what conditions, how often>

## Suggested direction (optional)
<a sentence or two; never a patch, and never the only place the defect is explained>

---
This issue was opened by an agent on behalf of @BootBlock.
```

The five severities follow the ordering in #403: silent loss or corruption first, wrong-but-present
data second, unusable third, then degraded, then cosmetic. Related issues are linked with `#N` in the
body (a regression links the closed original; a performance finding links #112).

### 5.3 Labels

Use only the repository's existing labels. One nature label plus at least one area label:

| Class (§2) | Nature label |
| --- | --- |
| Mechanical, Functional | `bug` (or `enhancement` when the code is correct but a claim is unmet) |
| Performance | `performance` (+ `bug` when a limit is exceeded in normal use) |
| Prompt — shipped text | `bug` + `mcp` / `bridge` / `documentation` as fits |
| Prompt — agent guidance | `documentation` (+ `github` for `.github/` and repository plumbing) |

| Area | Label(s) |
| --- | --- |
| `src/db/**`, repositories, queries | `backend`; `schema` when the data model or a migration is implicated |
| `src/features/sync`, backup, archive, storage, danger-zone | `sync` (+ `backend`) |
| Foundry, screens, dialogs | `ui`; add `usability` when the defect is a hard-to-use control, `accessibility` for AT/keyboard, `theming` for tokens and themes, `mobile` for touch or narrow-screen |
| Inventory, items, custom fields | `ui` or `backend` by layer; `schema` for the item model; `categories`, `locations`, `measurements` as fits |
| Purchasing, suppliers, pricing | `pricing` |
| Projects, BOM, kits | `projects` |
| Reports, dashboard | `reports`, `dashboard` |
| Search, command palette | `search` |
| Scanner, OCR, barcode | `scanner` |
| Import, export, migration mappers | `import/export` |
| Bridge (all of `bridge/**`) | `bridge`; `mcp` for the MCP server; `deployment` for Docker and hosting |
| `custom_components/`, `homeassistant/` | `bridge` |
| `extension/` | `scanner` is wrong — use `import/export` for scraping and `security` if the fetch gate is implicated |
| i18n catalogs and text | `i18n` |
| `.github/`, hooks, scripts, CI | `github`; `github_actions` for workflows; `dependencies` for the lockfile and packages |
| `docs/**` | `documentation` |
| Any secret, privacy or trust-boundary finding | `security` (and stop and tell the maintainer before filing if it is exploitable — see `SECURITY.md`) |

If no existing label fits, note that in the register and file with the nearest; never invent one.

### 5.4 Filing

```bash
gh issue create --repo BootBlock/Gubbins --title "<title>" --body-file <file> --label bug --label backend
```

Record the returned number in the register the same session. One issue per defect: two symptoms of
one root cause are one issue that lists both; two defects that happen to share a file are two issues.

## 6. How a phase runs

### 6.1 Start

1. Read this document in full, then `CLAUDE.md` and `AGENTS.md`. Read every memory note the
   session-start hook lists whose title touches the phase's area — they hold the deliberate decisions
   that §4.1 says not to re-file.
2. Confirm the phase is the next one in the §8 map and that no earlier phase is marked in progress.
   If one is, stop and tell the maintainer — two sessions on one register conflict.
3. Mark the phase **in progress** in §8 (the very first edit in the worktree, committed on its own so a
   concurrent session sees it).

### 6.2 Worktree and pinned commit

Every phase edits this document, so every phase runs in a worktree — the `CLAUDE.md` rule, no
exception:

```bash
git fetch origin
git worktree add .claude/worktrees/wt-audit-p<N> -b wt-audit-p<N> origin/main
git -C .claude/worktrees/wt-audit-p<N> rev-parse HEAD   # the pinned SHA for this phase's permalinks
```

The worktree must sit under `.claude/worktrees/` (a sibling path breaks test resolution). All reading
and all scratch tests happen in the worktree, so every `path:line` in the register refers to one
known commit. Prefix every shell command with `cd <worktree> &&` or `git -C <worktree>`; the shell's
working directory does not reliably persist between calls, and a check run in the wrong tree looks
exactly like a check run in the right one.

### 6.3 Find

Split the phase's scope into independent units (the phase sections in §9 suggest a split) and
dispatch one **finder** sub-agent per unit, concurrently. A finder is read-only. Give it:

- the unit's file list, the four classes (§2), the invariant checklist (§7), and the phase's focus
  list (§9);
- the instruction to report **candidates**, not findings: for each, `path:line`, the class, the claim
  in one sentence, why it believes the claim, and how it could be demonstrated;
- the instruction to report what it read and what it skipped, so coverage is auditable.

A finder that reports nothing must say what it read. A unit the finder skipped is re-dispatched.

### 6.4 Verify

For each candidate, dispatch a **verifier** sub-agent (batch candidates that share a mechanism).
The verifier's brief is adversarial: *try to disprove this*. It reads the code path end to end, runs
the scratch test or measurement, checks the deliberate-decision sources, and returns one of:

- **CONFIRMED** — with the demonstration (§3.1 item 2) and the severity;
- **REJECTED** — with the reason (the code handles it at `path:line`; the behaviour is documented as
  intended in `<source>`; the test passed);
- **UNVERIFIABLE** — with exactly what would settle it.

The lead does not accept a CONFIRMED verdict without the demonstration attached. A verifier that
returns "looks right to me" has not verified anything — send it back. The lead spot-checks at least
one CONFIRMED and one REJECTED verdict per unit by re-running the demonstration.

### 6.5 File and record

For each CONFIRMED candidate: dedupe (§4.1), re-check against `main`'s tip (§3.1 item 5), write the
body (§5.2), file (§5.4), and add the register row (§10) with the issue number. For each REJECTED and
UNVERIFIABLE candidate: add the register row with the verdict and reason. **Every candidate gets a
row** — the register's value to later phases is mostly its rejections.

### 6.6 Land

1. Update §8 (phase status, counts), §10, §11 and §13.
2. `git -C <worktree> status` must show no `*.audit-scratch.test.*` file and no file outside
   `docs/todo/`. If it does, remove the scratch files and revert anything else — the audit does not
   change code.
3. Format (`npx prettier --write docs/todo/codebase-audit_2026-08-30.md`), run
   `npx vitest run --config vitest.worktree.config.ts src/lib/docs-todo-status.test.ts` from the
   worktree, commit with a message that names the phase, merge into `main` with `--no-ff`, and push
   with the shell's cwd in the primary checkout (`cd p:/Source/TypeScript/Gubbins && git push origin
   main`), never `git -C` from the worktree.
4. Remove the worktree. If a `node_modules` junction was created for a dev server, remove the junction
   **first** and confirm the link path is gone before `git worktree remove`.
5. Hand the maintainer the next phase's prompt (§9) in a raw fenced markdown block, with the counts:
   candidates, confirmed, rejected, unverifiable, duplicates, issues filed.

### 6.7 What a phase must not do

- Fix, refactor, format or "tidy" any file outside this document.
- Re-file a §4.2 programme, a §4.1 decision, or a rejection already in §10.
- File without a demonstration, or file a performance claim without a measurement.
- Leak process into an issue (§5).
- Estimate or ration by time. There are no time constraints on Gubbins work; a phase that has not
  finished its scope is not finished.

## 7. Project-invariant checklist

Each row is a seam or rule the project has established, with a grep that surfaces a *possible* bypass.
A hit is a candidate, never a finding — several seams have sanctioned exceptions, and a guard test
already covers some rows (a hit there means the guard has a hole, which is itself a finding). Finders
run the rows relevant to their unit; Phase 17 runs every row across the whole repository.

| Invariant (source) | Bypass looks like | Grep (ripgrep) |
| --- | --- | --- |
| Calendar-day arithmetic is DST-safe (`lib/calendar-days`) | `+ n * MS_PER_DAY`, `86400000`, `24 * 60 * 60 * 1000` | `rg -n "MS_PER_DAY|86400000|24 \* 60 \* 60" src bridge/src --glob '!**/calendar-days*'` |
| Date inputs convert through `lib/date-input` | local-midnight `new Date(y, m, d)` or `T00:00` near an `<input type="date">` | `rg -n "type=\"date\"" src` then read the handler |
| Money rounds through `lib/money` | `Math.round(x * 100) / 100`, `toFixed(2)` on a price | `rg -n "\* 100\) / 100|toFixed\(2\)" src bridge/src` |
| Prices render via the `Money` control | `fmt.currency(` in JSX | `rg -n "fmt\.currency\(" src --glob '*.tsx'` |
| Natural keys compare through `lib/name-fold` | `LOWER(`, `COLLATE NOCASE`, `.toLowerCase() ===` on a name/tag/username | `rg -n "COLLATE NOCASE|LOWER\(" src/db bridge/src` (note #577 covers sorting) |
| Thrown values become copy via `useErrorMessage` | `e instanceof Error ? e.message : ` | `rg -n "instanceof Error \? " src` |
| Every `switch` over a domain union ends in `assertExhaustive` | a `default:` that returns or throws by hand, or no default | `rg -n "switch \(" src bridge/src -A 30 \| rg -n "default:" ` then inspect |
| Import file reads go through `features/import/file-source` | `.text()`, `readAsText`, `arrayBuffer()` on a `File` elsewhere | `rg -n "\.text\(\)|readAsText|\.arrayBuffer\(\)" src --glob '!**/file-source*'` |
| A destructive path saves via `lib/save-file` and proves it landed | `downloadBlob(` followed by a delete/overwrite | `rg -n "downloadBlob\(" src` then read what follows |
| `gubbins:` storage keys are registered (`lib/storage-keys`) | a literal key elsewhere, or an unprefixed key | `rg -n "localStorage\.(get\|set\|remove)Item\(" src --glob '!**/storage-keys*'` |
| Persisted Zustand stores reconcile on read (`lib/persisted-state`) | `persist(` without a custom `merge` | `rg -n "persist\(" src/state src/features -A 15 \| rg -n "merge"` |
| `driver.query<TRow>` is build-checked against literal SQL | runtime-assembled SQL passed to `query<` | `rg -n "query<" src/db -B 2 -A 2` and look for template concatenation |
| Stock operations have derived, idempotent ids (#633, #696) | `randomblob()` or `crypto.randomUUID()` for a row that a retry could recreate | `rg -n "randomblob\(\)|randomUUID\(\)" src/db bridge/src` |
| Sync-set tables are classified (`sync-table-classification.test.ts`) | a new table in the baseline with no classification | run the test; read the list for tables whose classification looks wrong |
| LWW is decided in JavaScript, restore has no gate | an immutability trigger on a synced table; a restore path that assumes a gate | read `reconcile.ts` and the trigger list together |
| "Mirrors X" comments have a drift test | `mirror`, `must stay in sync`, `keep in sync`, `identical to`, `matches the` with no named test | `rg -n -i "mirrors\|stay in sync\|keep in sync\|kept in sync\|identical to" src bridge/src extension/src` |
| The bridge runs app `.ts` under Node's strip-only loader | parameter properties, `enum`, `namespace`, `import x = ` in any file the bridge imports | `rg -n "^\s*(export )?(const )?enum \|namespace \|constructor\((private\|public\|readonly)" src/db src/features/search src/lib` |
| Design tokens, not literals | `#[0-9a-f]{3,6}`, `rgb(`, `oklch(`, `-500`, `cubic-bezier(`, `@keyframes` outside `index.css` | `rg -n "#[0-9a-fA-F]{6}\b|rgb\(|oklch\(|cubic-bezier\(|@keyframes" src --glob '!src/styles/index.css'` |
| Foundry primitives, not native controls | `<select`, `<input` outside foundry and outside the sanctioned list in `foundry-native-inputs.test.ts` | run that test; then `rg -n "<select\|<textarea" src --glob '!src/components/foundry/**'` |
| Content hides on `handset:`, not a bare breakpoint (#546 is open) | `max-md:hidden`, `md:hidden`, `hidden md:` | `rg -n "max-\w+:hidden\|\bmd:hidden\|\bsm:hidden" src` |
| Hover reveals have a `touch:` counterpart (guard test) | run `hover-reveal-touch.test.ts`; hits are a guard hole | — |
| Every user-facing string in a converted screen goes through `t()` | a literal in Dashboard, About, global chrome, Modules | `rg -n ">[A-Z][a-z]+ [a-z]" src/features/dashboard src/features/about src/components/nav --glob '*.tsx'` |
| No inline `<script>` (CSP) | `<script>` in `index.html` or injected markup | `rg -n "<script" index.html src` |
| Errors are not swallowed | `catch {}`, `catch (e) {}`, `.catch(() => {})` | `rg -n "catch \{\s*\}\|catch \(\w+\) \{\s*\}\|\.catch\(\(\) => \{\}\)" src bridge/src extension/src` |
| Types are not lied about | `as any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error` without a reason, `!` on a value that can be null | `rg -n "as any\|as unknown as\|@ts-ignore\|@ts-expect-error" src bridge/src extension/src` |
| Lint is not silenced without a reason | `eslint-disable` | `rg -n "eslint-disable" src bridge/src extension/src scripts` |
| Tests can fail | `.skip(`, `.only(`, `expect(true)`, a test body with no `expect`, a `try { … } catch { /* ok */ }` around the assertion | `rg -n "\.skip\(\|\.only\(\|expect\(true\)" src bridge/src` |
| Effects clean up | `addEventListener`, `setInterval`, `setTimeout`, `new Worker`, `observe(` inside `useEffect` with no matching removal in the return | `rg -n "useEffect" src -A 25 \| rg -n "addEventListener\|setInterval\|observe\("` then inspect |
| Async work is cancelled on unmount or on the next call | `useEffect(() => { … fetch/query … })` with no abort or "stale" flag | read every effect that awaits |
| Lists have stable keys | `key={i}`, `key={index}` | `rg -n "key=\{(i\|index\|idx)\}" src` |
| Queries are bounded | `SELECT *`, no `LIMIT` on a list, `OFFSET` pagination | `rg -n "SELECT \*" src/db bridge/src` ; `rg -n "OFFSET" src/db bridge/src` |
| Agenda writes sweep the `['agenda']` key prefix | a mutation that reshapes a lane without the sweep | `rg -n "agendaKeys\|\['agenda'\]" src` against the list of lane-shaping mutations |
| Serialised items: at most one open checkout; bookings: no overlap; one preferred supplier part | enforced post-merge in `reconcile.ts`, plus repair on every write path | read each write path for the repair |

## 8. Phase map

| Phase | Title | Scope (paths) | Status | Cand. | Filed | Rejected | Unverif. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | Baseline, build, tooling, CI and repository configuration | `package.json`, `package-lock.json`, `tsconfig*.json`, `vite*.config.ts`, `vitest.*.ts`, `eslint.config.js`, `prettier.config.js`, `components.json`, `index.html`, `public/`, `scripts/`, `.githooks/`, `.github/`, `Dockerfile`, `docker/`, `docker-compose.yml`, `Run.bat`, `Run.ps1`, `hacs.json`, `.gitignore`, `.gitattributes`, `.dockerignore`, `.editorconfig`, `.env.example`, `.git-blame-ignore-revs`, `.nvmrc`, `.prettierignore`, `vitest.timeouts.ts`, `LICENSE`, `bridge/{package.json,Dockerfile,tsconfig.json,vitest.config.ts,*.mjs}`, `extension/{build.mjs,tsconfig.json,manifest.json}` | complete | 54 | 31 | 11 | 3 |
| 1 | Database engine, driver, migrations and shared repository seams | `src/db/*.ts`, `src/db/worker/`, `src/db/rpc/`, `src/db/migrations/`, `src/db/search/`, `src/db/repositories/{base,mappers,constants,like,tombstone,text-limits,name-lookup,location-count,receipt-guard,reservations,stock,stock-batches,supplier-cost-sql,checkout-plan,gauge,location-history,index}.ts`, `src/db/repositories/types/`, `src/test/` | complete | 77 | 34 | 30 | 1 |
| 2 | The item repository family | `src/db/repositories/ItemRepository.ts`, `src/db/repositories/item/`, `ItemRepository.*.test.ts`, `serialised-placement.test.ts`, `batched-item-reads.test.ts`, `*-parity.test.ts` | not started | | | | |
| 3 | Every other repository | remaining `src/db/repositories/*Repository.ts` and their tests, `src/db/repositories/project/`, `permissions.enforcement.test.ts`, `wishlist.test.ts`, `revaluation.test.ts`, `item-relations.test.ts`, `tare-presets.test.ts`, `test-record.test.ts` | not started | | | | |
| 4 | Data integrity: sync, backup, archive, storage, danger zone | `src/features/sync/`, `backup/`, `archive/`, `storage/`, `danger-zone/`, `clock-skew/`, `events/`, `src/lib/{save-file,download,read-all-pages}.ts` | not started | | | | |
| 5 | App shell, platform and shared libraries | `src/{main,App,sw,csp,base-path}.ts(x)`, `src/app/`, `src/routes/`, `src/routeTree.gen.ts`, `src/state/`, `src/lib/` (all), `src/lib/env/`, `src/styles/index.css`, `src/features/{errors,hotkeys,modules,i18n,not-found,lab,about,achievements}/`, `src/components/{OfflineIndicator,PwaUpdatePrompt,useConfirmSaved}.tsx`, `public/recovery.js`, `public/coi-bootstrap.js` (runtime behaviour) | not started | | | | |
| 6 | Foundry primitives and shared components | `src/components/foundry/`, `src/components/background/`, `src/components/nav/`, `src/components/icons/`, `src/components/Brand*.tsx` | not started | | | | |
| 7 | Inventory domain logic | `src/features/inventory/*.ts(x)` (top level), `dedupe/`, `importers/`, `labels/`, `ocr/`, `regions/` | not started | | | | |
| 8 | Inventory components | `src/features/inventory/components/` | not started | | | | |
| 9 | Commerce, projects and reporting | `src/features/{purchasing,suppliers,sales,projects,lifecycle,reports,dashboard,export,import}/` | not started | | | | |
| 10 | Capture and discovery | `src/features/{search,command-palette,scanner,scraping,lookups,share,images}/` | not started | | | | |
| 11 | People, time and configuration screens | `src/features/{users,contacts,bookings,calendar,alerts,activity,maintenance,tags,settings,home-assistant,webhooks}/` | not started | | | | |
| 12 | Bridge core and HTTP API | `bridge/src/*.ts` (top level), `bridge/src/api/`, `bridge/src/fixtures/`, `bridge/openapi.yaml`, `bridge/loader.mjs`, `bridge/README.md` | not started | | | | |
| 13 | Bridge integrations | `bridge/src/{events,feeds,ical,mqtt,mdns,mcp,homeassistant}/`, `bridge/webhooks.example.json`, `bridge/gubbins-bridge.service`, `bridge/scripts/` | not started | | | | |
| 14 | Satellites: browser extension and Home Assistant component | `extension/src/`, `extension/README.md`, `custom_components/gubbins/`, `homeassistant/`, `README-HA.md` | not started | | | | |
| 15 | Prompt and guidance surface | MCP tool text in `bridge/src/mcp/tools.ts`, `bridge/src/spoken.ts` output, HA sentences and `strings.json`/`translations/`, OpenAPI and OData descriptions, `src/features/i18n/catalogs/*.json` (text quality), `CLAUDE.md`, `AGENTS.md`, `.claude/skills/`, `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`, `docs/dev/`, live `docs/todo/*.md`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/modular-ui-plan.md` | not started | | | | |
| 16 | Wiki parity | `docs/wiki/` (every page, every image) against the app at the pinned commit; `docs/todo/wiki_2026-07-11.md` page map | not started | | | | |
| 17 | Cross-cutting static sweeps | the whole repository: every §7 row; dead code and unused exports; duplicate implementations of an existing seam; TODO/FIXME/HACK; test-suite quality; dependency licences and `npm audit` | not started | | | | |
| 18 | Runtime performance at scale | the running app and bridge with a seeded large vault; ties to #112 | not started | | | | |
| 19 | Close-out | this document; every issue filed by the audit | not started | | | | |

Coverage check: every top-level path in the repository appears in exactly one phase's scope above
(`dist/` and `node_modules/` are build output and are not audited; `extension/dist/` likewise).
Phase 0 adds any path this table missed before it starts, and records the addition in §13.

Phase 0 ran that check. All 12 top-level directories and all 30 top-level files are covered. Four
paths below the top level were named by no phase and are now assigned: `bridge/.env.example` and
`bridge/.gitignore` (Phase 0), `src/vite-env.d.ts` (Phase 5), and `docs/todo/done/` (Phase 15, as a
reference read — archived plans are decision sources under §4.1, not audit targets). Two deliberate
overlaps are left as they are: `bridge/loader.mjs` sits in both Phase 0 (`bridge/*.mjs`) and Phase 12,
and `.github/ISSUE_TEMPLATE/` sits in both Phase 0 (mechanics) and Phase 15 (text quality).

## 9. Phases

Each phase below has a **scope** (its row in §8), a **focus** list (what a finder should look for
beyond §2 and §7 in this area), the **verification** methods that fit the area, and the **prompt**
that starts it. The prompt is complete on its own; it does not need this section pasted with it.

### Phase 0 — Baseline, build, tooling, CI and repository configuration

**Focus.** Every gate that is supposed to fail: does it? (`#599` found that no push builds the app;
`#283` found the bundle check cannot fail.) `tests.yml`, `e2e.yml`, `deploy.yml`, `docker.yml`,
`publish-wiki.yml`: what each runs, on which trigger, with which permissions, and which of the repo's
own checks it omits. The pre-commit and pre-push hooks against what CI runs (the hook says CI is the
authoritative gate — is it?). `scripts/*.mjs`: correctness of the secret scanner (`secret-detect.mjs`
has tests — do they cover the shapes in `CLAUDE.md`?), the bundle-size check, the lockfile script,
`run-unit-tests.mjs` and `flake-retry.mjs` (a retry that masks a real failure), `wiki-check.mjs`,
`wiki-screenshots.mjs`, `browser-smoke.mjs` (steps that cannot fail, selectors that match nothing).
The three tsconfigs and the ESLint config: which files each actually covers (tests are excluded from
`tsc`, a known gap — is anything else excluded by accident?). `vite.config.ts`, the PWA manifest,
precache globs and the `cspMetaPlugin`; `index.html`. The Docker image and `nginx.conf.in` headers
against `docker.yml`'s assertions. `Run.ps1`/`Run.bat`. `package.json` `engines`, scripts and the
four ways the Node version is declared (#262). `dependabot.yml` scope. `hacs.json` and the HACS
requirements. `.gitignore` tightness against the "never commit" list in `CLAUDE.md`.

**Verification.** Run every gate and record the result in §12: `npm run type-check`, `npm run lint`,
`npm run format:check`, `npm run test:run`, `npm run test:bridge`, `npm run smoke:bridge`,
`npm run build`, `npm run check:bundle`, `npm run test:e2e` (needs a dev server), `npm run wiki:check`,
`npm run lock:check` (needs Docker), `npm audit`, `npm outdated`, `npm run build:extension`. A gate
that passes when it should fail is demonstrated by making it fail on purpose in the worktree (an
unused import, an oversized asset, a fake key in a staged file) and showing it stays green — then
reverting. Read each workflow's `on:` block and step list against the scripts it claims to run.

**Prompt.**

```
Audit Gubbins — Phase 0: baseline, build, tooling, CI and repository configuration.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 0 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch worktrees, tests, hooks, the lockfile, CI or the bundle.

Scope: the Phase 0 row of the plan's §8 map — package.json and the lockfile, every tsconfig, vite and vitest config, ESLint and Prettier config, index.html, public/, scripts/, .githooks/, .github/ (workflows, templates, dependabot), Dockerfile, docker/, docker-compose.yml, Run.bat, Run.ps1, hacs.json, .gitignore, .gitattributes, .dockerignore, .editorconfig, .env.example, .git-blame-ignore-revs, .nvmrc, .prettierignore, vitest.timeouts.ts, LICENSE, and the bridge's and extension's own package, tsconfig, vitest and build files. Before starting, check that every top-level path in the repository appears in exactly one phase's scope in §8; add any that is missing to the right phase and note it in §13.

Follow §6 exactly: mark Phase 0 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p0 from origin/main and pin its SHA; run every gate listed under Phase 0 in §9 and record each result in §12 as the baseline; dispatch finder sub-agents per scope unit (workflows; hooks and scripts; TypeScript, lint and Vite configs; Docker and run scripts; package metadata and ignore rules) with the §2 classes, the §7 checklist and the Phase 0 focus list; dispatch verifier sub-agents per candidate with an adversarial brief; dedupe every confirmed candidate against open and closed issues and against §4.2 (note #454, #599, #283, #262 and #186 are already open in this area — file only what they do not name); file one issue per confirmed finding in the §5 format with existing labels only; record every candidate in §10 under Phase 0 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree.

Verify everything, never infer: a gate that "cannot fail" is demonstrated by making it fail on purpose in the worktree and showing it stays green, then reverting. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 0 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 1 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 1 — Database engine, driver, migrations and shared repository seams

**Focus.** The worker boundary: `database.worker.ts`, `local-driver.ts`, `worker-driver.ts`, the RPC
`protocol.ts` — message ordering, error propagation across the boundary, a request whose response
never arrives, a transaction left open when a message throws (`transaction.ts`), the tab lock
(`tab-lock.ts`) under two tabs and a closed tab, OPFS file handling (`db-file-store.ts`,
`db-file.ts`, `sqlite-header.ts`, `verify-binary.ts`, `restore-candidate.ts`) including a truncated
or foreign file, the rescue driver. `sqlite-bootstrap.ts`: pragmas (journal mode, foreign keys,
busy timeout) and what happens when the wasm fails to instantiate. Migrations: the squashed v1
baseline against the schema snapshot fixture, `enum-checks`, `baseline-revision`, and the engine's
behaviour on a database newer than the app. Search: `ast.ts`, `parseASTtoSQL.ts` and `fts.ts` —
injection through a field name or an operator, tokenisation of quotes and unicode, a query that
produces a full scan. The shared repository seams: `base.ts` (query row-shape guard), `mappers.ts`
(a column read into the wrong type, the tri-state thumbnail), `tombstone.ts`, `text-limits.ts`,
`name-lookup.ts`, `stock.ts` and `stock-batches.ts` (FEFO, negative stock, the derived-id
idempotency of #696, the race test), `reservations.ts`, `receipt-guard.ts`, `checkout-plan.ts`,
`gauge.ts`, `location-history.ts`, `supplier-cost-sql.ts`. The `types/` barrel against the schema
(a nullable column typed as required). `src/test/drivers` — is the `:memory:` driver faithful to the
worker driver (FTS5, foreign keys, `RETURNING`)?

**Verification.** Scratch tests against the `:memory:` driver for repository seams; `EXPLAIN QUERY
PLAN` (no stats) for any query flagged as a scan; two-tab and mid-transaction-throw scenarios driven
in the browser with the `verify` skill where the worker is implicated; a fabricated foreign or
truncated `.sqlite` for the file paths.

**Prompt.**

```
Audit Gubbins — Phase 1: database engine, driver, migrations and shared repository seams.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 1 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch the database, migrations, the query row-shape guard, stock, batches, LWW, sync classification, name-fold, tombstones, the tab lock, or benchmarking without stats.

Scope: the Phase 1 row of the plan's §8 map — src/db/*.ts, src/db/worker/, src/db/rpc/, src/db/migrations/, src/db/search/, the shared (non-entity) files in src/db/repositories/ listed in that row, src/db/repositories/types/, and src/test/. Phase 0 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 1 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p1 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (worker and RPC; file store, header, rescue and tab lock; bootstrap and migrations; search AST and FTS; shared repository seams and types; test drivers) with the §2 classes, the §7 checklist and the Phase 1 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using scratch tests against the :memory: driver, EXPLAIN QUERY PLAN with no statistics for query shapes, and the verify skill for anything only the real worker shows; dedupe every confirmed candidate against open and closed issues, §4.2 and §10; file one issue per confirmed finding in the §5 format with existing labels only; record every candidate in §10 under Phase 1 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 1 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 2 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 2 — The item repository family

**Focus.** `ItemRepository.ts` and every mixin in `item/`: `core`, `create`, `normalise` (against the
SQL `CHECK`s — the parity test exists; does it cover every column?), `sql`, `list-order` and
`keyset-pagination` (the seek predicate against `ORDER BY` for every sortable column, ties, nulls,
a name that changes mid-scroll), `status-filter` and `attention-sql` (the correlated `EXISTS`
ceiling — measure, do not assume), `search` and `relevance`, `stock`, `cycle-count`, `kits`,
`variants`, `aliases`, `relations`, `capabilities`, `availability`, `revaluations`, `history` and
`feeds` (projection, since-cursor, clear), `dedupe`, `maintenance-default`, `section-presence`,
`test-records`. Every parallel list the item model keeps (searchable columns, tracking modes, history
actions, status filters — the memory note `Item model parallel lists`) checked for a member missing
from one registry. The `ItemRepository.*.test.ts` files themselves: a test that cannot fail, a
fixture that defaults a field to `undefined` silently, a `phaseNN` test that asserts a behaviour since
changed. Batched reads (`batched-item-reads`) and the three parity tests.

**Verification.** Scratch tests on the `:memory:` driver for every functional claim; `EXPLAIN QUERY
PLAN` for every list, filter and search shape at a seeded 50k-row table with no stats; a mutation of
each parity test's other side to prove the test goes red.

**Prompt.**

```
Audit Gubbins — Phase 2: the item repository family.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 2 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch items, the item model's parallel lists, keyset pagination, the attention/status-filter ceiling, stock, batches, cycle counts, serialised placement, kits, dedupe, the query row-shape guard, or benchmarking without stats.

Scope: the Phase 2 row of the plan's §8 map — src/db/repositories/ItemRepository.ts, src/db/repositories/item/, every ItemRepository.*.test.ts, serialised-placement.test.ts, batched-item-reads.test.ts and the *-parity.test.ts files. Phase 1 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 2 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p2 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (core, create and normalise; list order, keyset pagination, status filter and attention SQL; search and relevance; stock, cycle count and batches; kits, variants, aliases, relations and capabilities; history, feeds, revaluations and dedupe; the test files as a unit of their own) with the §2 classes, the §7 checklist and the Phase 2 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using scratch tests on the :memory: driver, EXPLAIN QUERY PLAN with no statistics on a seeded 50k-row items table, and — for each parity test — a deliberate mutation of the other side to prove the test can fail; dedupe every confirmed candidate against open and closed issues, §4.2 and §10; file one issue per confirmed finding in the §5 format with existing labels only; record every candidate in §10 under Phase 2 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 2 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 3 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 3 — Every other repository

**Focus.** `Location` (tree moves that create a cycle, path recomputation, the non-items backlog
#617, history), `Category` (inheritance, lookup sources, the preset library — #715 is open),
`Project` and `project/` (assembly draw, BOM lines, budget, costing, picking, procurement — the
"one physical thing must not be drawn by count" rule), `PurchaseOrder` (open-count parity, receipt
guard, partial receipt), `Supplier` and `SupplierPart` (the one-preferred / one-price-source
partial unique index and its repair on every write path), `Contact`, `Checkout` (the one-open-loan
serialised invariant, a return of more than was lent, borrower union), `AssetBooking` (overlap,
#496/#658/#660 are open), `Maintenance`, `Report` (every aggregate against a hand-computed value on
a small fixture; currency mixing; the "dead stock" tri-state), `User`, `Role` and
`permissions.enforcement` (every repository write checked against the ACL — find a write that is
not), `ApiToken` (hashing, comparison, expiry), `Webhook`, `Image` and `Attachment` (size caps,
orphan cleanup), `LocationPhoto`, `Diagnostics`, `Settings` (typed read of a stored JSON value),
`Storage`, `Suggestion`, `Tag` (name-fold), `TarePreset`, `Wishlist`.

**Verification.** Scratch tests on the `:memory:` driver; for the ACL, a scratch test that calls each
write as a role lacking the permission and lists the ones that succeed.

**Prompt.**

```
Audit Gubbins — Phase 3: every other repository.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 3 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch locations, categories, projects and assembly, purchase orders, supplier parts and the one-of-n flag, checkouts and the serialised loan invariant, bookings and overlap, users and ACLs, name-fold, or reports.

Scope: the Phase 3 row of the plan's §8 map — every *Repository.ts in src/db/repositories/ other than ItemRepository, with its tests; src/db/repositories/project/; permissions.enforcement.test.ts; and the remaining test files the row names. Phase 2 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 3 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p3 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (Location and LocationPhoto; Category and Tag; Project and project/; PurchaseOrder, Supplier, SupplierPart and Wishlist; Checkout, AssetBooking, Contact and Maintenance; Report and Diagnostics; User, Role, ApiToken and permissions enforcement; Webhook, Image, Attachment, Settings, Storage, Suggestion and TarePreset) with the §2 classes, the §7 checklist and the Phase 3 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using scratch tests on the :memory: driver and — for the ACL — a scratch test that attempts every write as a role without the permission; dedupe every confirmed candidate against open and closed issues, §4.2 and §10; file one issue per confirmed finding in the §5 format with existing labels only; record every candidate in §10 under Phase 3 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 3 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 4 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 4 — Data integrity: sync, backup, archive, storage, danger zone

**Focus.** This is the tier-1 area of #403: the user cannot undo any of it. Sync: the snapshot trust
boundary (`parseBackupJson` — an allow-listed identifier, a foreign column, a value of the wrong
type), FK repair in `buildLocalSnapshot`, `reconcile.ts` (LWW in JavaScript, the byte-identical
skip, the post-merge cardinality repairs for loans, bookings and preferred parts, the
`items.quantity` re-derive, the `item_history` union and prune watermark), the Google Drive and
File System Access providers (token expiry mid-sync, a 4xx that is retried forever, a partial
upload treated as success, the conflict path of #638), the offline buffer, clock skew. Backup and
restore (`restore-backup`, the raw `.sqlite` path, a restore of a newer schema, the in-flight guard
of #654), archive (`restore-archive`, the mobile weekly auto-archive), storage triage (quota
estimates, history pruning and image downgrade — what they delete and whether the "proves it landed"
seam is honoured before each delete), the danger zone (every destructive action against the
save-before-destroy seam; the history watermark parity), `events/`, `save-file.ts`,
`download.ts`, `read-all-pages.ts`.

**Verification.** Scratch tests for every merge and reconcile claim with two hand-built snapshots;
the trust boundary fed a crafted snapshot; provider failures simulated with a stubbed `fetch`; the
destructive dialogs driven in the browser with the `verify` skill, including Escape and backdrop
during the in-flight state.

**Prompt.**

```
Audit Gubbins — Phase 4: data integrity — sync, backup, archive, storage and the danger zone.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 4 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch sync, LWW, reconcile, snapshots, the trust boundary, FK repair, the offline buffer, Google Drive OAuth, backup and restore, archive, storage, the save-before-destroying seam, derived quantity, or the history watermark.

Scope: the Phase 4 row of the plan's §8 map — src/features/sync/, backup/, archive/, storage/, danger-zone/, clock-skew/, events/, and src/lib/save-file.ts, download.ts and read-all-pages.ts. Phase 3 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 4 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p4 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (snapshot build and trust boundary; reconcile and merge; providers, offline buffer and clock skew; backup and restore; archive and storage triage; danger zone, events and the save-file seam) with the §2 classes, the §7 checklist and the Phase 4 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using two-snapshot scratch tests for every merge claim, crafted snapshots for the trust boundary, a stubbed fetch for provider failures, and the verify skill for the destructive dialogs including Escape and backdrop while a restore is in flight; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 (#502, #638 and #654 are the known tier-1 items — file only what they do not name); file one issue per confirmed finding in the §5 format with existing labels only, and stop to tell the maintainer first if a finding is exploitable; record every candidate in §10 under Phase 4 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 4 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 5 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 5 — App shell, platform and shared libraries

**Focus.** Boot (`src/app/boot`, `main.tsx`, the cross-origin-isolation waiver, `coi-bootstrap.js`,
`recovery.js`, Safe Mode and the rescue actions), the router and `routeTree.gen.ts` (a route file
with no generated entry, deep links, the share target, `base-path.ts` under a non-root base), the
service worker (`sw.ts` — precache manifest dedupe, the update prompt and snooze, the schema-safety
promise keyed on `baselineRevision`, `stale-chunk-reload`), `csp.ts` against `index.html` and
`nginx.conf.in`, every Zustand store in `src/state/stores/` (persisted shape, `merge`, version
bumps in `persisted-store-versions`), the query client defaults, every module in `src/lib/`
(the seams §7 names, plus `format`, `measurement-format`, `weight`, `volume`, `dimensions`,
`colour` rounding, `fuzzy`, `highlight` (XSS through a highlighted term), `external-href`,
`host-match`, `fetch-timeout`, `version-compare`, `plural`, `text-terms`, `useFullscreen`,
`print-document`, `image-data-url`), `src/lib/env/` (device id stability, feature detection
false positives, install prompt, motion), `src/styles/index.css` (a token defined in one theme
block only, a contrast pair below WCAG — #209/#210 are open, so only new pairs), the i18n seam
(`i18n.ts`, `messages.ts`, plural selection, placeholder escaping, the drift test's reach),
hotkeys (a chord that collides, a shortcut that fires inside an input), modules (the gating map
and the deep cascade), errors, not-found, lab flags, about, achievements.

**Verification.** Scratch tests for every pure module; the boot and rescue paths driven in the
browser with a deliberately broken database file; the service worker only via two production builds
served statically (the memory note `Verifying service worker updates`); a non-root base path served
via the Docker image.

**Prompt.**

```
Audit Gubbins — Phase 5: app shell, platform and shared libraries.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 5 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch boot, safe mode, the service worker or PWA update, CSP, routes, persisted state, storage keys, the i18n seam, hotkeys, modular UI, money, colour, DST, date input, name-fold, or the error-copy seam.

Scope: the Phase 5 row of the plan's §8 map — src/main.tsx, App.tsx, sw.ts, csp.ts, base-path.ts, src/app/, src/routes/, src/routeTree.gen.ts, src/state/, all of src/lib/ including env/, src/styles/index.css, src/features/errors, hotkeys, modules, i18n, not-found, lab, about and achievements, the three shared components at src/components/*.tsx, and the runtime behaviour of public/recovery.js and public/coi-bootstrap.js. Phase 4 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 5 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p5 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (boot, rescue and isolation; router, routes and base path; service worker, PWA update and CSP; stores and query client; lib — one finder per third of the file list; lib/env; styles tokens; i18n seam; hotkeys, modules, errors and the small features) with the §2 classes, the §7 checklist and the Phase 5 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using scratch tests for pure modules, the verify skill with a deliberately corrupted database file for boot and rescue, two static production builds for anything in the service worker, and the Docker image for a non-root base path; dedupe every confirmed candidate against open and closed issues, §4.2 and §10; file one issue per confirmed finding in the §5 format with existing labels only; record every candidate in §10 under Phase 5 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 5 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 6 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 6 — Foundry primitives and shared components

**Focus.** Every primitive in `src/components/foundry/` for: keyboard and focus (the modal stack —
topmost-only Escape and Tab, focus restoration when the opener unmounted (#212 is open), the
`initialFocusRef`; menus and submenus; the combobox `Select` — type-ahead is #550, so only new
defects; roving radio groups; the glyph and emoji pickers; tooltips and their focus-open gotcha;
toasts and their timer (#543); `Autocomplete`; `Pagination`); ARIA (a role with a missing required
attribute, `aria-describedby` pointing at nothing, `LiveRegion` politeness, `Kbd`); the numeric
controls (`NumberInput`, `MoneyInput`, `numeric-bounds` — reports, never rewrites;
`evaluate-expression` — what can be evaluated); `Textarea` autogrow measuring at mount; `Markdown`
(sanitisation — what tags and URLs it lets through); `region-canvas` (pointer maths, touch,
zoom); `reorder-list` drag; `view-transition`, `reveal`, `success-burst`, `animated-number`,
`pointer-tilt`, `useCountUp` (reduced motion honoured; frames released on unmount); `unsaved-changes`
and `dialog-busy`; `use-anchored-popover` (position at viewport edges, scroll); `useMediaQuery`,
`useOnlineStatus`, `useInstallPrompt`, `usePwaUpdate`. `src/components/background/` (the precipitation
and surface engines — CPU per frame, allocation per frame, pause when hidden). `nav/` (`AppNav`,
skip link, `main-content`). Icons and brand marks (`aria-hidden`).

**Verification.** Component scratch tests with Testing Library and `user-event`; the browser with the
`verify` skill for focus, stacking and pointer behaviour; a performance trace of the background
engines under 4× CPU throttling with allocations counted per frame.

**Prompt.**

```
Audit Gubbins — Phase 6: Foundry primitives and shared components.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 6 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch Foundry, the modal stack, tooltips, textarea sizing, the number field, the glyph picker, menus, the select combobox, the dialog scroll bleed, the touch and handset variants, the ease-emphasized token, component-test gotchas, the precipitation engine, or Chromium blend modes.

Scope: the Phase 6 row of the plan's §8 map — src/components/foundry/, src/components/background/, src/components/nav/, src/components/icons/ and src/components/Brand*.tsx. Phase 5 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 6 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p6 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (modal, drawer, rail modal, modal stack, focus trap and dialog behaviour; menu, tooltip, popover, toast and banner; select, autocomplete, select-field, radio and segmented groups; input, textarea, number, money and colour inputs and their bounds and expression helpers; pickers, markdown, region canvas and reorder list; motion, reveal, count-up, tilt, view transitions and the hooks; background engines; nav, skip link, icons and brand) with the §2 classes, the §7 checklist and the Phase 6 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using Testing Library scratch tests, the verify skill for focus, stacking and pointer behaviour, and a throttled performance trace with per-frame allocation counts for the background engines; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 (the accessibility sweep issues #209–#223, #491, #515 and #541–#553 are open — file only what they do not name); file one issue per confirmed finding in the §5 format with existing labels only; record every candidate in §10 under Phase 6 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 6 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 7 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 7 — Inventory domain logic

**Focus.** The pure seams at the top of `src/features/inventory/`: `queries.ts` and
`queries.infinite` (query keys, `invalidate.ts` — which keys each mutation sweeps and which it
misses; #714 found one), `mutations.ts` and the non-optimistic writes, `catalog-import.ts` and
`importers/` (the plan builder, the `createMany` cliff, unknown category (#407), single-column
header (#408), a mistyped barcode (#489)), `custom-fields.ts`, `field-*` (number format,
prominence, suggestions, the Image/File/Colour field types), `category-presets.ts` (#715),
`category-capabilities`, `location-*` (tree, path, inheritance, fullness, map, colour, media,
export), `kits`, `kit-availability`, `batches`, `bulk-edit`, `clone`, `dedupe/`, `labels/` (barcode
fit, mm geometry, quiet zone), `ocr/` (asset staging, worker lifetime, what text is trusted),
`regions/`, `asset-lifecycle`, `low-stock-policy`, `dead-stock-options`, `price-history`, `rarity`,
`asin`, `attachment-link`, `history-*-format`, `item-dnd` and `item-drag`, `list-window`,
`density-layout`, `id-buckets`, `operational-metadata`, `item-requirements`, `item-total-value`.

**Verification.** Scratch tests for every pure seam; an import of a crafted CSV through the real
pipeline in the browser; a query-invalidation scratch test that performs each mutation and lists the
keys that stayed stale.

**Prompt.**

```
Audit Gubbins — Phase 7: inventory domain logic.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 7 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch the import pipeline, import row problems, the import file-read seam, CSV import bugs, custom fields and field types, the field dictionary, category presets, location inheritance, dead stock, low stock, kits, the assembly draw, labels and barcodes, the agenda invalidation seam, or the item model's parallel lists.

Scope: the Phase 7 row of the plan's §8 map — every file directly in src/features/inventory/ plus its dedupe/, importers/, labels/, ocr/ and regions/ subfolders. src/features/inventory/components/ is Phase 8, not this one. Phase 6 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 7 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p7 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (queries, invalidation and mutations; catalog import and importers; custom fields, field helpers and category presets and capabilities; locations — tree, path, inheritance, fullness, map, media and export; kits, batches, bulk edit, clone and dedupe; labels and OCR; regions, lifecycle, pricing seams and the remaining helpers) with the §2 classes, the §7 checklist and the Phase 7 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using scratch tests for the pure seams, a scratch test that performs each mutation and lists the query keys left stale, and the verify skill with a crafted CSV for the import pipeline; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 (#407, #408, #489, #714 and #715 are open — file only what they do not name); file one issue per confirmed finding in the §5 format with existing labels only; record every candidate in §10 under Phase 7 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 7 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 8 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 8 — Inventory components

**Focus.** All 178 files in `src/features/inventory/components/`: the item detail dialog and its
tab rail (render, focus and the smoke gotchas in the memory note), the item editor and every
sub-editor (custom fields, capabilities, reorder point, supplier parts, batches, serial numbers,
kits, variants, relations, attachments, images, regions), the create flow, the inventory list in
every density (cards, compact, table — #215 is open for headers), the location sidebar and tree
editors, the print-label dialogs, cycle count and audit day (#547 open), bulk edit and multi-select
(#130), the export wizard, the import dialog, the category and preset pickers, the dedupe sheet.
For each: unsaved-changes wiring, error copy through the seam, `FormField` and `aria-invalid`
association (#552/#553 open), i18n readiness where converted, design tokens, `handset:` and
`touch:` variants, re-render cost on a keystroke in a list of 1,000 items, virtualisation of every
long list, image decoding for thumbnails, effect cleanup.

**Verification.** Component scratch tests; the browser with the `verify` skill against a vault
seeded with the test-records seam; a React Profiler count of renders per keystroke in the list
filter and per item toggle in the multi-select.

**Prompt.**

```
Audit Gubbins — Phase 8: inventory components.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 8 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch the item detail dialog, the unsaved-changes guard, the modal stack, component-test gotchas, Playwright item-card locators, the option card, the touch and handset variants, cycle count and audit day, the tabular export seam, the info hint, or the dialog scroll bleed.

Scope: the Phase 8 row of the plan's §8 map — src/features/inventory/components/, all of it. Phase 7 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 8 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p8 from origin/main and pin its SHA; list the folder and split it into finder units of roughly twenty files grouped by dialog or screen (item detail and its tabs; item editor and sub-editors; create flow and pickers; list, cards, table and density; locations sidebar and editors; labels and print; cycle count, bulk edit and multi-select; export, import and dedupe); dispatch one finder sub-agent per unit with the §2 classes, the §7 checklist and the Phase 8 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using Testing Library scratch tests, the verify skill against a vault seeded with the test-records seam, and a React Profiler render count for any re-render claim; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 (the open accessibility and usability issues in §4.2 and #130, #215, #476, #547, #552 and #553 are known — file only what they do not name); file one issue per confirmed finding in the §5 format with existing labels only; record every candidate in §10 under Phase 8 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 8 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 9 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 9 — Commerce, projects and reporting

**Focus.** Purchasing (reorder policy, wishlist, purchase orders, receipt, the shopping list, price
breaks, currency conversion at the line and total, the money seam), suppliers (parts, price history,
preferred and price-source flags), sales and disposals (margin, COGS, the item's state after a sale),
projects (BOM, kits, assembly, picking, budget, buildability — #460 asks for it, so only claims),
lifecycle (warranty, depreciation straight-line at year boundaries, condition grading, current
value and revaluation), reports (every report against a hand-computed fixture; ABC, turnover,
aging, dead stock, valuation trend and its plan, data hygiene, item flow, the insurance schedule
print and its totals, the catalogue letterhead), dashboard (every widget's query, its invalidation,
its threshold preferences, the low-stock widget, the maintenance-due lane of #714, `DASHBOARD_WIDGETS`
against `en.json`), export (the tabular serialiser for every format — CSV quoting, the BOM of #579,
XLSX cell types, HTML escaping — and the export wizard scopes), import (the dialog, the file-source
seam, the migration mappers of #488).

**Verification.** Scratch tests with small hand-computed fixtures for every aggregate and every
money path; an export of each format opened and parsed back; a browser drive of a PO from creation
to full receipt and of a project from BOM to finalised assembly.

**Prompt.**

```
Audit Gubbins — Phase 9: commerce, projects and reporting.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 9 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch money rounding, the Money control, currency select, supplier parts and price history, the one-of-n flag, the assembly draw, purchase orders and receipt, dead stock, low-stock thresholds, the tabular export seam, the import pipeline, dashboard customisation, or reports.

Scope: the Phase 9 row of the plan's §8 map — src/features/purchasing/, suppliers/, sales/, projects/, lifecycle/, reports/, dashboard/, export/ and import/. Phase 8 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 9 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p9 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (purchasing; suppliers and sales; projects; lifecycle; reports — split in two; dashboard; export and import) with the §2 classes, the §7 checklist and the Phase 9 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using hand-computed fixtures for every aggregate and money claim, a parse-back of every export format, and the verify skill for the purchase-order and assembly flows end to end; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 (#460, #463, #467, #488, #579, #595 and #714 are open — file only what they do not name); file one issue per confirmed finding in the §5 format with existing labels only; record every candidate in §10 under Phase 9 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 9 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 10 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 10 — Capture and discovery

**Focus.** Search (the text-query parser and the visual builder round trip — a query that parses to
something other than what it shows; `nl-query`; field registries against the item model's parallel
lists; saved searches and their persisted shape; enum options), the command palette (every
registered command reachable and correctly gated by modules and ACL), the scanner (decoder worker
lifetime and the worktree gotcha; camera permission denial; continuous mode and batch actions;
manual entry; hardware-scanner keyboard-wedge input; barcode check digits and the ASCII rule;
announcements — #541 open), scraping (the extension bridge protocol and its negotiation, timeouts,
request correlation, every supplier parser against a saved fixture page, the merge of scraped data
into an item, price refresh, the supplier URL allow-list), lookups (Wikidata and Open Food Facts —
rate limits, a missing field, a non-English label, the live-lookup verification note), share
(share target and file handlers — a file of the wrong type, a payload with no file), images
(resize, WebP encoding, EXIF orientation, the size cap of #641).

**Verification.** Scratch tests for the parsers and the reducers; the scanner and share target in
the browser with the `verify` skill (a synthetic barcode image for the decoder); supplier parsers
against fixtures already in the repository, never a live site; lookups against a stubbed `fetch`.

**Prompt.**

```
Audit Gubbins — Phase 10: capture and discovery — search, command palette, scanner, scraping, lookups, share and images.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 10 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch search syntax, the decode worker, the scanner, the scraping bridge, product lookup and the live-lookup verification, images and thumbnails, the item thumbnail tri-state, or the share target.

Scope: the Phase 10 row of the plan's §8 map — src/features/search/, command-palette/, scanner/, scraping/, lookups/, share/ and images/. Phase 9 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 10 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p10 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (search parser, builder and saved searches; command palette; scanner; scraping protocol and merge; supplier parsers; lookups; share and images) with the §2 classes, the §7 checklist and the Phase 10 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using scratch tests for parsers and reducers, the verify skill with a synthetic barcode image for the scanner and a crafted payload for the share target, repository fixtures only for supplier parsers, and a stubbed fetch for lookups — never a live third-party site; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 (#18, #390, #489, #541 and #641 are open — file only what they do not name); file one issue per confirmed finding in the §5 format with existing labels only; record every candidate in §10 under Phase 10 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 10 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 11 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 11 — People, time and configuration screens

**Focus.** Users (sign-in, session store, roles, the permission gating of every screen and control
— a control that is hidden but whose mutation still succeeds; the discoverability note of #428),
contacts and loans (borrower union, renewals and their timezone, returns), bookings (#496, #658,
#660 are open — only new defects), the calendar and Upcoming agenda (`agendaKeys`, day-grained dates
and the frame of #495, DST, the invalidation seam), alerts (every lane's query, badge counts,
invalidation), activity (the feed's since-cursor and its projection), maintenance (schedules,
due-date rollover, the default seam), tags (name-fold, rename and merge), settings (every tab —
each control writes the preference it names, reads it back, and the value survives a reload;
Notifications; Keyboard shortcuts; the Focus-search-bar request of #440), the Home Assistant screen
and the webhooks screen in the app (URL validation, the SSRF rules the bridge enforces echoed or
not, test-delivery result copy).

**Verification.** Scratch tests for the pure seams and stores; the browser with the `verify` skill
for every settings control (set, reload, read back) and for the permission gating as a
low-privilege role; a scratch test that runs each lane's query at a DST boundary and a west-of-UTC
zone.

**Prompt.**

```
Audit Gubbins — Phase 11: people, time and configuration screens.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 11 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch users and ACLs, the settings dialog, the agenda invalidation seam, DST calendar days, date input, bookings and overlap, the serialised loan invariant, the tool use case, webhooks, or the Home Assistant screens.

Scope: the Phase 11 row of the plan's §8 map — src/features/users/, contacts/, bookings/, calendar/, alerts/, activity/, maintenance/, tags/, settings/, home-assistant/ and webhooks/. Phase 10 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 11 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p11 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (users and permission gating; contacts and loans; bookings and calendar; alerts, activity and maintenance; tags and settings; Home Assistant and webhooks screens) with the §2 classes, the §7 checklist and the Phase 11 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using scratch tests for seams and stores, a scratch test that runs each time-based lane at a DST boundary and in a west-of-UTC zone, and the verify skill for every settings control (set, reload, read back) and for the permission gating as a low-privilege role; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 (#428, #440, #495, #496, #658 and #660 are open — file only what they do not name); file one issue per confirmed finding in the §5 format with existing labels only; record every candidate in §10 under Phase 11 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 11 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 12 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 12 — Bridge core and HTTP API

**Focus.** `server.ts` and `serve.ts` (request lifecycle, body limits, a slow client, a request
after shutdown), `config.ts` (every option's validation, the loopback default, a misconfiguration
that starts anyway), `cors.ts`, `identity.ts` and the API tokens (constant-time compare, scope
checks on every route), `rate-limit.ts` (per what key; a burst that is not limited), `idempotency.ts`
(key scope and expiry), `resilience.ts` (retries that double-apply), `sqlite-source.ts`,
`node-driver.ts` and `hydrate.ts` (the snapshot load, a snapshot that changes under a read,
`watcher.ts` debounce and a rename), `snapshot-io.ts` and `snapshot-health.ts`, `write.ts` (the
peer-device write path — the cost of #712, LWW correctness against the app's merge, what happens
when the app is offline), `query.ts` and `inventory-scan.ts`, `low-stock-*`, `push.ts`,
`item-detail.ts`, `api/` (OData `$filter` parsing and injection, `$count`/`$top` of #362,
`field-select`, `conditional.ts` ETags, `head.ts`, `items-csv.ts` escaping, `dto.ts` against the
app's types, `limits.ts`, `respond.ts` error shapes), `openapi.ts` against `openapi.yaml` against
the routes actually mounted (#556), `version.ts`, `bridge-id.ts`, `node-version.mjs` and
`loader.mjs` (the strip-only loader — any app import that would fail under it), `cli.ts`.

**Verification.** `npm run test:bridge` scratch tests from the primary checkout; the bridge started
against a fixture snapshot with `curl` for every route (auth missing, auth wrong scope, malformed
`$filter`, oversized body, slow body); `npm run smoke:bridge`; a timed write against a 50k-item
snapshot for #712-adjacent claims.

**Prompt.**

```
Audit Gubbins — Phase 12: bridge core and HTTP API.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 12 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch the bridge, the strip-only loader, bridge writes, the ecosystem integrations, the schema version and baseline revision, API tokens, or the push-from-primary-checkout rule.

Scope: the Phase 12 row of the plan's §8 map — every file directly in bridge/src/, bridge/src/api/, bridge/src/fixtures/, bridge/openapi.yaml, bridge/loader.mjs and bridge/README.md. The events, feeds, ical, mqtt, mdns, mcp and homeassistant subfolders are Phase 13. Phase 11 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 12 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p12 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (server, serve, config, cors and cli; identity, tokens, rate limit and idempotency; sqlite source, node driver, hydrate, watcher and snapshot io/health; write, resilience, query, inventory scan, low stock and push; api — OData filter, service and metadata; api — v1 routes, dto, field select, conditional, head, csv and respond; openapi against the mounted routes; loader and node version) with the §2 classes, the §7 checklist and the Phase 12 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using bridge scratch tests run from the primary checkout with --config bridge/vitest.config.ts, the bridge started against a fixture snapshot and driven with curl for every route including missing auth, wrong scope, malformed $filter, oversized and slow bodies, npm run smoke:bridge, and a timed write against a 50k-item snapshot for any cost claim; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 (#362, #556, #712 and #718 are open — file only what they do not name); file one issue per confirmed finding in the §5 format with existing labels only, and stop to tell the maintainer first if a finding is exploitable; record every candidate in §10 under Phase 12 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 12 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 13 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 13 — Bridge integrations

**Focus.** Events (the change pipeline and generation counter, `lookup.ts`, SSE — a client that
disconnects mid-event, backpressure, heartbeat; webhooks — SSRF guard against DNS rebinding and
IPv6 literals, the blocked list, target validation, the delivery log, retries and their idempotency,
the test-delivery shape, signature headers if any), feeds (emitters, the feed model, item status,
metrics and their formatting — a Prometheus label with an unescaped value), iCal (escaping and
control characters — #368 open; folding; timezone; recurrence), MQTT (the packet codec, retained
locations, discovery payloads against what the publisher publishes — the parity test exists;
reconnect and the offline buffer of #565; the ghost retraction), mDNS (the hand-rolled responder —
a malformed query, the loopback gate, the opt-in), MCP (`stdio.ts` framing, the dispatcher's
error shapes, every tool's arguments validated before the repository is touched, pagination
cursors, the write tools' idempotency), the Home Assistant client and scale stream (reconnect,
a scale that reports garbage, backpressure).

**Verification.** Bridge scratch tests; a real MQTT broker is not assumed — the packet codec is
tested against captured bytes in the fixtures; SSE and webhooks driven with `curl` and a local
listener; the MCP server driven over stdio with `bridge/mcp.mjs` and hand-written JSON-RPC frames.

**Prompt.**

```
Audit Gubbins — Phase 13: bridge integrations — events, webhooks, feeds, iCal, MQTT, mDNS, MCP and the Home Assistant client.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 13 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch webhooks, MQTT and the ghost retraction, mDNS, the Home Assistant phases, the scale stream, the ecosystem integrations, or the bridge.

Scope: the Phase 13 row of the plan's §8 map — bridge/src/events/, feeds/, ical/, mqtt/, mdns/, mcp/ and homeassistant/, bridge/webhooks.example.json, bridge/gubbins-bridge.service and bridge/scripts/. The MCP tool descriptions as text are Phase 15; here the MCP scope is the mechanics — framing, dispatch, validation, cursors and idempotency. Phase 12 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 13 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p13 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (events pipeline and SSE; webhooks — SSRF, targets, delivery, log and test; feeds and metrics; iCal; MQTT; mDNS; MCP mechanics; Home Assistant client and scale stream) with the §2 classes, the §7 checklist and the Phase 13 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using bridge scratch tests from the primary checkout, captured packet bytes for the MQTT codec, curl and a local listener for SSE and webhook delivery, and hand-written JSON-RPC frames over stdio for the MCP server; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 (#368, #469, #559 and #586 are open — file only what they do not name); file one issue per confirmed finding in the §5 format with existing labels only, and stop to tell the maintainer first if a finding is exploitable; record every candidate in §10 under Phase 13 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 13 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 14 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 14 — Satellites: browser extension and Home Assistant component

**Focus.** Extension: `manifest.json` permissions against what the code uses (`host_permissions`
narrowed — is every parser's host present and nothing more?), `background.ts` (the fetch gate,
message validation from the content script and from the app origin — `app-origins.ts` — a page
that spoofs the app), `content-script.ts` and `active-tab-scrape.ts` (what DOM it reads, injection
into the page), `build.mjs` output against the manifest. Home Assistant component: every file in
`custom_components/gubbins/` (the config flow and zeroconf step, the coordinator's polling and
error handling — #718 is open, the entity unique ids and their stability across a bridge id change,
the sensors against the bridge's attention statuses (#559), `services.yaml` against the services
registered, `intent.py` against the sentences, `manifest.json` requirements and version,
`strings.json` and `translations/` key parity), `homeassistant/custom_sentences/en/gubbins.yaml`
(sentence syntax, slot names against the intent handler), `homeassistant/README.md` and
`README-HA.md` (#578 open), `hacs.json`.

**Verification.** The extension built with `npm run build:extension` and loaded unpacked in Edge;
its messages replayed from a page on a non-app origin; the Python component checked with
`python -m py_compile` and its config flow and coordinator exercised with a stubbed bridge (a
minimal HTTP server returning the fixture snapshot's shapes) — if Home Assistant itself is not
available, the candidate is recorded as unverifiable with what would settle it.

**Prompt.**

```
Audit Gubbins — Phase 14: the browser extension and the Home Assistant custom component.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 14 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch the Home Assistant phases (HA-4, mDNS, writes), the security audit's extension fetch gate, scraping, or app origins.

Scope: the Phase 14 row of the plan's §8 map — extension/src/, extension/README.md, extension/manifest.json (behaviour, not build), custom_components/gubbins/, homeassistant/ and README-HA.md. Phase 13 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 14 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p14 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (extension background and fetch gate; extension content script and active-tab scrape; HA config flow, coordinator and api; HA entities, sensors, services and intent; HA strings, translations, sentences and the two READMEs) with the §2 classes, the §7 checklist and the Phase 14 focus list; dispatch verifier sub-agents per candidate with an adversarial brief, using the extension built and loaded unpacked in Edge with messages replayed from a non-app origin, python -m py_compile for every Python file, and a stubbed bridge HTTP server for the config flow and coordinator — recording as unverifiable, with what would settle it, anything that needs a live Home Assistant; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 (#559, #578, #586 and #718 are open — file only what they do not name); file one issue per confirmed finding in the §5 format with existing labels only, and stop to tell the maintainer first if a finding is exploitable; record every candidate in §10 under Phase 14 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 14 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 15 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 15 — Prompt and guidance surface

**Focus.** Shipped text first. Every MCP tool in `bridge/src/mcp/tools.ts`: does the description
say what the dispatcher does, name every argument's format and default, say what the result looks
like and what an error means, and give a model enough to choose between `gubbins_search` and the
locate tool? Is any description ambiguous in a way a model would resolve wrongly (units, sign
conventions, "id as returned by" for a tool that returns none)? `spoken.ts`: every shape's output
for zero, one, several, a plural item name, a location with a leading "the", a quantity of zero, a
serialised item, an item with no location, a name with a quote. HA `custom_sentences` and
`strings.json`: sentences that the parser cannot match, slots with no handler, translations missing
a key. OpenAPI `summary`/`description` text and the OData `$metadata` annotations against
behaviour. The two catalogs (`en.json`, `de.json`): the du/Sie inconsistency is #583; look for a
placeholder that a translation dropped, an English value that differs from its code-side twin, a key
whose German changes the meaning, a plural form that is wrong. `docs/wiki/AI-Assistant-Query-MCP.md`
against the tool list.

Then agent and contributor guidance. `CLAUDE.md` and `AGENTS.md`: every command named (run it),
every path named (open it), every count stated (count it), every rule against every other rule
(two that conflict), the parity test's reach. `.claude/skills/verify/SKILL.md` and
`auto-review/SKILL.md`: the recipe against what actually works today (the memory notes record that
the verify skill carried a stale "worktree dev server can't boot" claim). The issue and PR templates
against the house style the repository actually uses. `docs/dev/PHASE_HANDOVER.md`,
`deferred-features.md`, `releases.md`, `google-drive-sync.md`: live instructions that are stale
(records of what happened are evidence and are not corrected — the `CLAUDE.md` rule). Every
`🟢 ACTIVE` plan in `docs/todo/`: is it still live, and does its "next step" still exist? (#584 is
open for the banner rule.) `README.md` (#270, #50 open), `CONTRIBUTING.md`, `SECURITY.md`,
`docs/modular-ui-plan.md` (why is it outside `docs/todo/`?).

**Verification.** For shipped text: the MCP server driven over stdio against the fixture snapshot
with each tool called as its description suggests, and the response compared to the description;
`speakWhereIs` called with the edge cases; the catalog tests plus a scratch diff of placeholders.
For guidance: every command executed, every path opened, every count recomputed. A guidance defect
is filed as `documentation` and cites the exact sentence.

**Prompt.**

```
Audit Gubbins — Phase 15: the prompt and guidance surface.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 15 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch the auto-review skill, the verify skill, the i18n catalog seam, the Home Assistant intent (HA-4), the spoken answer, MCP, the docs/todo status convention, or deferred-work tracking.

Scope: the Phase 15 row of the plan's §8 map. Shipped text: the tool names, schemas and descriptions in bridge/src/mcp/tools.ts, the output of bridge/src/spoken.ts, homeassistant/custom_sentences/, custom_components/gubbins/strings.json and translations/, the description text in bridge/openapi.yaml and the OData metadata, src/features/i18n/catalogs/en.json and de.json as text, and docs/wiki/AI-Assistant-Query-MCP.md. Guidance: CLAUDE.md, AGENTS.md, .claude/skills/*/SKILL.md, .github/ISSUE_TEMPLATE/, .github/pull_request_template.md, docs/dev/, every ACTIVE plan in docs/todo/, docs/modular-ui-plan.md, README.md, CONTRIBUTING.md and SECURITY.md. Phase 14 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 15 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p15 from origin/main and pin its SHA; dispatch finder sub-agents per scope unit (MCP tool text against the dispatcher; spoken answers; HA sentences, strings and translations; OpenAPI and OData text; the two catalogs; CLAUDE.md and AGENTS.md; skills and templates; docs/dev and the ACTIVE plans; README, CONTRIBUTING, SECURITY and the modular-ui plan) with the §2 classes, especially §2.4, and the Phase 15 focus list; dispatch verifier sub-agents per candidate with an adversarial brief — for shipped text, drive the MCP server over stdio against the fixture snapshot and call speakWhereIs with the edge cases; for guidance, run every command and open every path the sentence names and recompute every count; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 (#50, #270, #556, #583, #584 and #586 are open — file only what they do not name); file one issue per confirmed finding in the §5 format with existing labels only, quoting the exact sentence at fault; record every candidate in §10 under Phase 15 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 15 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 16 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 16 — Wiki parity

**Focus.** All 99 pages under `docs/wiki/` and every image under `docs/wiki/images/`, each read
against the app at the pinned commit. For every page: each claim of behaviour (a setting exists, a
button does X, a limit is N, a format is supported) checked in the code or in the running app; each
screenshot checked against the current UI (a stale screenshot is a finding when it shows a control
that moved or no longer exists); each `[[link]]` resolved (`npm run wiki:check` does this — run it
first and audit what it does not check); the sidebar and page map in `docs/todo/wiki_2026-07-11.md`
against the pages that exist; every feature the app ships that no page mentions (the modular UI
registry and the settings tabs are the checklist); house-style consistency where it changes meaning.
The sanctioned exception: the `/lab` flags and seasonal easter eggs are deliberately undocumented.

**Verification.** Each behavioural claim traced to code with `path:line`, or driven in the browser;
each screenshot compared to a fresh capture from `scripts/wiki-screenshots.mjs` against a dev server
(run it once; keep the captures in the scratchpad; do not commit any image). File one issue per
page that has drift, listing each claim, not one issue per claim — the fix is per page.

**Prompt.**

```
Audit Gubbins — Phase 16: wiki parity.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 16 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, the wiki plan docs/todo/wiki_2026-07-11.md, and the memory notes the session-start hook lists whose titles touch the wiki, wiki screenshots, the hidden lab flags, or modular UI.

Scope: the Phase 16 row of the plan's §8 map — every page and image under docs/wiki/, and the page map in docs/todo/wiki_2026-07-11.md, each checked against the app at the pinned commit. Phase 15 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 16 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p16 from origin/main and pin its SHA; run npm run wiki:check and note what it does not check; split the 99 pages into finder units of about ten pages grouped by the wiki sidebar's sections, and dispatch one finder sub-agent per unit to list every behavioural claim, screenshot and cross-link on its pages with the code path or UI state that should support it; dispatch verifier sub-agents per page with an adversarial brief to trace each claim to path:line or drive it in the browser with the verify skill, and to compare each screenshot with a fresh capture from scripts/wiki-screenshots.mjs kept in the scratchpad; also list every shipped feature, setting and module with no page; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 (the wiki issues in §4.2 are open — file only what they do not name); file one issue per page with drift, listing every claim on it, in the §5 format with the documentation label and the area label; record every candidate in §10 under Phase 16 with its verdict; update §8, §11 and §13; commit only the plan document — no image and no wiki page — merge --no-ff into main, push from the primary checkout, and remove the worktree.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 16 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 17 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 17 — Cross-cutting static sweeps

**Focus.** Every row of §7 run across the whole repository, each hit triaged (sanctioned exception,
already-filed, or candidate). Then: exports with no importer and files with no importer (a
`tsc`-driven or grep-driven sweep; a dead module is a finding when it still claims to be a seam);
re-implementations of an existing seam (two functions that fold names, two that format money,
two pluralisers — the memory notes list the canonical one for each); `TODO`, `FIXME`, `HACK`,
`XXX` and their age; test-suite quality across all 798 test files (a test with no assertion, an
assertion on a mock rather than behaviour, `.skip`, `.only`, a snapshot that asserts everything and
therefore nothing, a "mirrors" comment with no drift test, a drift test that cannot fail — mutate
and check); ESLint rules disabled repo-wide in `eslint.config.js` and whether each disable is
still justified; the licence of every dependency against MIT compatibility and `npm audit` against
the baseline in §12; the `dist/` and `extension/dist/` folders — are they tracked, and should they
be?

**Verification.** Every grep hit opened and read; every "cannot fail" test claim proven by mutating
the code under test in the worktree and running the test; the licence sweep with `npm ls --json`
and each package's `license` field.

**Prompt.**

```
Audit Gubbins — Phase 17: cross-cutting static sweeps.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 17 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, and every memory note the session-start hook lists whose title names a seam (name-fold, money, date input, DST, error copy, save-before-destroying, import file read, storage keys, exhaustive switch, query row shape, the Money control, the tabular export seam, plural, the touch and handset variants) — each is a canonical implementation that a duplicate would bypass.

Scope: the whole repository, as the Phase 17 row of the plan's §8 map describes — every §7 row across src/, bridge/src/, extension/src/, scripts/ and custom_components/; unused exports and files; re-implemented seams; TODO, FIXME, HACK and XXX; test-suite quality across every test file; repo-wide lint disables; dependency licences and npm audit against the §12 baseline; whether dist/ and extension/dist/ belong in the tree. Phase 16 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 17 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p17 from origin/main and pin its SHA; dispatch finder sub-agents per sweep (one per group of §7 rows, one for unused code, one for duplicated seams, one for TODO markers, one per third of the test files for test quality, one for lint config and dependencies) and require each to open and read every hit rather than report the grep; dispatch verifier sub-agents per candidate with an adversarial brief — a "cannot fail" test claim is proven by mutating the code under test in the worktree and running the test, then reverting; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 — many §7 rows have an open issue already (#546, #577, #390, #225) and earlier phases will have filed area-specific hits, so this phase files only what remains; file one issue per confirmed finding in the §5 format with existing labels only, grouping hits of one mechanism into one issue with a list; record every candidate in §10 under Phase 17 with its verdict; update §8, §11 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree with no scratch test or mutation left behind.

Verify everything, never infer. Nothing is filed without a demonstration. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 17 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 18 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 18 — Runtime performance at scale

**Focus.** This phase executes the pass #112 asks for, and every issue it files links #112. Seed a
vault at three sizes — 1k, 20k and 100k items with proportionate locations, history, stock rows,
batches, images and custom-field values — through the test-records seam or a generated backup
restored through the real path. Measure, under 4× CPU throttling and again unthrottled: cold boot to
interactive and the precache install; inventory list first paint, scroll at each density, a filter
keystroke, each status filter (the known correlated-`EXISTS` ceiling — measure it and file the
number), sort changes, keyset page fetch; search (text, builder, FTS); the item detail open and each
tab; the dashboard (every widget's query time, and the total refetch on one item write); every
report and the insurance schedule; the calendar and Upcoming; a full sync merge of two divergent
snapshots; backup, restore and archive; a CSV import of 10k rows; bulk edit of 1k selected; the
scanner's decode loop; the background engines while idle; memory after 30 minutes of the app idle
and after 200 dialog open/close cycles. On the bridge: hydrate time at 100k; every list route and
OData `$filter` at 100k; a write (#712); SSE fan-out to 20 clients; MQTT discovery of 5k locations.
Bundle: chunk map, what loads eagerly, precache size against a first install on a phone.

**Verification.** Numbers, plans and traces, per §3.3, recorded in §12 as the performance baseline
even where no issue results. Any query claim carries `EXPLAIN QUERY PLAN` with no stats. Any render
claim carries a render count or a long-task count. Report ratios and shapes; absolute milliseconds
only as context.

**Prompt.**

```
Audit Gubbins — Phase 18: runtime performance at scale.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 18 of it — no other phase, and no fixing. Then read CLAUDE.md and AGENTS.md, issue #112, and the memory notes the session-start hook lists whose titles touch benchmarking without stats, the inventory attention scaling ceiling, keyset pagination, pagination app-wide, the import pipeline's createMany cliff, batched item reads, the precipitation engine, the verify skill's port and worktree gotchas, or bridge writes.

Scope: the running app and the running bridge, seeded at 1k, 20k and 100k items with proportionate related rows, as the Phase 18 row of the plan's §8 map and its focus list describe. Phase 17 must be marked complete in §8; if it is not, stop and say so.

Follow §6 exactly: mark Phase 18 in progress in §8 and commit that alone; create the worktree .claude/worktrees/wt-audit-p18 from origin/main and pin its SHA; build the three seeded vaults through the test-records seam or a generated backup restored through the real restore path, and keep them in the scratchpad; dispatch measurement sub-agents per surface (boot and precache; inventory list, filters, sort and paging; search; item detail; dashboard and its invalidation; reports and the insurance schedule; calendar and alerts; sync merge, backup, restore and archive; import and bulk edit; scanner and background engines; memory over time; bridge hydrate, reads, writes, SSE and MQTT; bundle and chunk map), each measuring under 4× CPU throttling and unthrottled and reporting plans, render counts, long-task counts and ratios per §3.3; record every measurement in §12 as the performance baseline whether or not it yields a finding; dispatch verifier sub-agents to re-measure every candidate that exceeds what the target hardware can pay; dedupe every confirmed candidate against open and closed issues, §4.2 and §10 (#112, #145, #283, #362, #641 and #712 are open — file only what they do not name, and link #112 from every issue); file one issue per confirmed finding in the §5 format with the performance label and the area label, stating the hardware, the seed size and the measurement so it can be re-run; record every candidate in §10 under Phase 18 with its verdict; update §8, §11, §12 and §13; commit, merge --no-ff into main, push from the primary checkout, and remove the worktree, and stop every dev server and bridge process you started.

Verify everything, never infer: a performance claim without a measurement is not filed, and visual effects are not to be proposed for removal. No issue mentions the audit's process. There are no time constraints; finish the whole scope.

When Phase 18 is landed, reply with the counts (candidates, confirmed, rejected, unverifiable, duplicates, issues filed) and hand back the Phase 19 prompt from §9 of the plan inside a raw fenced markdown block.
```

### Phase 19 — Close-out

**Focus.** The audit's own integrity. Every row in §10 has a verdict and, if confirmed, an issue
number; every issue the audit filed is still open (or was closed for a stated reason), carries the
attribution trailer, carries at least one nature and one area label, contains no process leakage,
and has a title that is still true on `main`'s tip. Every §11 item has a note of what would settle
it, and is put to the maintainer as a list. The §8 counts are recomputed from §10, not copied. The
§12 baselines are complete. A summary section is written at the top of this document: findings by
class and severity, the phases that produced the most, the areas that produced nothing (and whether
that is coverage or health). Then the banner flips to `✅ COMPLETE`, the file moves to
`docs/todo/done/`, the memory note that points here is updated, and inbound links are fixed.

**Prompt.**

```
Audit Gubbins — Phase 19: close-out.

Read docs/todo/codebase-audit_2026-08-30.md in full before doing anything else. It is the single source of truth for this audit, and this session executes exactly Phase 19 of it — the close-out, with no further auditing and no fixing. Then read CLAUDE.md and AGENTS.md, and the memory notes the session-start hook lists whose titles touch the docs/todo status convention, deferred-work tracking, or memory conventions.

Scope: the plan document itself and every issue the audit filed. Phases 0 to 18 must all be marked complete in §8; if any is not, stop and say so.

Follow §6 for the worktree and landing mechanics, then: reconcile §10 so that every row has a verdict and every confirmed row an issue number; recompute the §8 counts from §10; for every filed issue, confirm with gh that it is open or closed for a stated reason, that it carries the attribution trailer, a nature label and an area label, no process leakage, and a title still true on main's tip — list any that fail and correct the label or body only (never the plan's findings); compile §11 into a list for the maintainer with what would settle each item; check §12 is complete; write a summary at the top of the document — findings by class and severity, the phases and areas that produced the most and the least, and whether a quiet area reflects health or thin coverage; flip the banner to COMPLETE, git mv the file into docs/todo/done/, grep for inbound links (docs/dev/deferred-features.md, docs/dev/PHASE_HANDOVER.md, the memory vault) and update them, run src/lib/docs-todo-status.test.ts, commit, merge --no-ff into main, push from the primary checkout, and remove the worktree. Finally, record in the memory vault at P:/Source/!Memories, following its Index.md convention, one note that points at the archived plan and states what the audit found and what remains in §11.

Verify everything, never infer. There are no time constraints. When the close-out is landed, reply with the final counts across all phases, the §11 list, and the path of the archived document. There is no next phase.
```

## 10. Findings register

One row per candidate, in every phase, whatever the verdict. IDs are `P<phase>-<n>`. **Where** is
`path:line` at the phase's pinned SHA. **Verdict** is one of `confirmed`, `rejected`, `duplicate
#N`, `unverifiable`, `fixed on main` (the re-check of §3.1 item 5 found it already gone). The
register is append-only within a phase; a later phase that revisits a row adds a new row that cites
the old one.

### Phase 0 — Baseline, build, tooling, CI and repository configuration

Pinned SHA: `9924e6a7faab7bb59748b59398f8f615eb43c72f`

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| P0-1 | Mechanical | `.github/workflows/e2e.yml:98-104` | The failure screenshot is a dotfile, which `upload-artifact` excludes by default, so the step goes green having uploaded nothing | confirmed | #720 | Both runs logged `No files were found`; `artifacts` returns `total_count: 0`. The screenshot is also taken at a fixed point, not at the failure |
| P0-2 | Functional | `.github/workflows/e2e.yml` | The nightly has failed on 100% of its runs, contradicting #600's closing claim | confirmed (narrowed) | #735 | The 11 step failures are CI-environmental — none reproduces locally. The 4 page errors do, on a machine where every step passes. Filed as the page-error defect only |
| P0-3 | Functional | `bridge/Dockerfile`, `.github/workflows/docker.yml:220-224` | No workflow builds the bridge image; `docker compose config` validates schema only | confirmed | #721 | Proved `docker compose config` passes with the Dockerfile deleted. Two commits touching `bridge/Dockerfile` triggered no `docker.yml` run |
| P0-4 | Functional | `.github/dependabot.yml` | No `docker` ecosystem, so three base images on mutable tags are never reviewed | confirmed | #723 | Filed `enhancement`: nothing claims the images are pinned. Zero docker-ecosystem Dependabot alerts exist |
| P0-5 | Mechanical | `.github/workflows/docker.yml:10-33` | The `paths:` filter omits files three of the workflow's own assertions depend on | confirmed (OCR leg only) | #722 | `index.html` leg is inside #599; `src/sw.ts` leg **rejected** — `vite.config.ts:205` fixes the emitted name and *is* in the filter |
| P0-6 | Prompt | `.github/workflows/e2e.yml:8` | The "~25 minutes" figure is ~2.5× the measured runner cost, and justifies not gating merges | rejected | — | Line 45 labels it "the ~25-minute **local** run", which is accurate. Not gating is documented as deliberate in #600, so this is a feature request (§1) |
| P0-7 | Mechanical | `.github/workflows/tests.yml:181-185`, `scripts/lockfile.mjs:43-44` | "Keep in step with X" comments with no test behind them | confirmed | #724 | Mutation: raising the bridge floor in both tested places leaves 1191 tests green while CI still boots 22.18.0. `e2e.yml`/`deploy.yml` leg is a duplicate of #262 |
| P0-8 | Mechanical | `.github/workflows/tests.yml:52-68` | Under `workflow_call` from Deploy the secret-scan base collapses to `HEAD~1` | confirmed | #725 | Real deploy log shows `EVENT: workflow_dispatch`, `PUSH_BEFORE:` empty. Deploying `main` is covered by accident (merge commits); an unmerged branch tip is not |
| P0-9 | Prompt | `.github/ISSUE_TEMPLATE/bug_report.yml:46` | The version placeholder shows a date-shaped format the app never used | rejected | — | Field is optional and its description already points at the About screen, which renders `0.32.0` literally. Below the consequence bar |
| P0-10 | Functional | `scripts/secret-detect.mjs:22,29-38` | The detector misses most shapes CLAUDE.md names, including the bridge's own documented `.env` syntax | confirmed | #733 | 26 of 36 probed shapes missed. Narrowed by GitHub push protection, but `secret_scanning_non_provider_patterns` is disabled |
| P0-11 | Functional | `scripts/secret-scan.mjs:57` | The CI scan diffs endpoints, so add-then-remove within one push is invisible | confirmed | #734 | Reproduced on a scratch branch: scan exits 0, blob still in history |
| P0-12 | Prompt | `.githooks/pre-commit:11-13` | The comment claims CI catches a `--no-verify` commit "before it lands"; `main` is unprotected | confirmed | #725 | Folded into P0-8's issue rather than filed alone — same region, same fix |
| P0-13 | Mechanical | `.githooks/pre-push:57` | An unresolvable `remote_oid` makes the hook run no checks and exit 0 silently | confirmed (narrowed) | #727 | Only reachable via `--force`: git rejects an ordinary push before the object can matter. Sub-claim about the `:40-42` comment **rejected** — it scopes itself correctly |
| P0-14 | Mechanical | `.githooks/pre-commit:43-61` | Prettier and ESLint read the working tree, not the index | confirmed | #726 | The candidate's own recipe was falsified (it goes red); the real false negative is the reverse direction, proved against the committed blob |
| P0-15 | Mechanical | `scripts/check-bundle-size.mjs:11,20` | The reporter counts a different file set from the precache it claims to mirror | confirmed | #719 | Found independently by the lead and a finder. 5 files / 108.32 KiB precached and uncounted; `sw.js` counted and not precached |
| P0-16 | Mechanical | `scripts/check-bundle-size.mjs:48-53` | A bare `catch` reports every failure as "dist/ not found" and exits 0 | duplicate #283 | — | #283 already names every exit path being `process.exit(0)` |
| P0-17 | Functional | `scripts/lockfile.mjs:147-156` | `lock:check` cannot detect the `libc` stripping its own docstring describes | confirmed | #728 | Mutation: stripping all 14 `libc` arrays still prints "Lockfile OK". Latent today because the wasm32 fault co-occurs and *is* caught |
| P0-18 | Prompt | `scripts/lockfile.mjs:148` | `stdio: 'ignore'` discards npm's diagnosis, and the failure branch asserts a cause it destroyed the evidence for | confirmed | #728 | Filed with P0-17: same file, same function, one fix |
| P0-19 | Mechanical | `scripts/browser-smoke.mjs:546-554` | The first-run-chooser step cannot fail | confirmed | #743 | The only one of 125 step bodies with no assertion. The helper is correct; the step's name is the defect |
| P0-20 | Mechanical | `scripts/browser-smoke.mjs:2262,2286-2288` | The QR decode assertion is silently skipped where `BarcodeDetector` is absent | confirmed | #743 | Absent on both local channels, headed and headless — it has never run anywhere. Not a coverage hole: `scanner.test.ts:482-525` round-trips the encoder through a real decoder |
| P0-21 | Functional | `scripts/wiki-check.mjs:91-100` | Images are matched by basename only, in both directions | confirmed | #744 | Three faces reproduced: false negative on a nested path, false positive on a correct one, and a directory reported as an orphaned image |
| P0-22 | Functional | `scripts/wiki-check.mjs` | Nothing checks a page is reachable from `_Sidebar.md` | rejected | — | The docstring's check 4 promises only that sidebar links *resolve*, which the code delivers. No claim to falsify. 98 pages / 96 sidebar targets / 0 unreachable. Belongs in the open wiki programme |
| P0-23 | Functional | `.github/workflows/tests.yml` | No push or PR check runs the production build | duplicate #599 | — | — |
| P0-24 | Functional | `scripts/setup-ocr-assets.mjs:74-77,198-201` | The models are fetched unpinned with no checksum, and `--require` accepts any non-empty file | confirmed (reframed) | #729 | 7 bytes of ASCII passes the gate. Reproducibility is fine in practice — upstream has one commit, 2017-09-14 — so filed as hardening, not a live break |
| P0-25 | Prompt | `scripts/wiki-screenshots.mjs:30` | The mandated screenshot script hard-codes Edge with no override | confirmed | #745 | Filed with P0-26. Its docstring declares the dependency and Playwright's error names its own remedy, so `cosmetic` |
| P0-26 | Mechanical | `scripts/generate-icons.mjs:95` | A literal `replace` silently emits cropped icons and reports the size it was asked for | confirmed | #745 | Mutation: reordering the SVG attributes yields a top-left crop at the right pixel dimensions, exit 0. Self-catching at review since the PNGs are tracked |
| P0-27 | Mechanical | `scripts/browser-smoke.mjs:4438` | The screenshot path is cwd-relative | confirmed | #720 | Folded into P0-1's issue |
| P0-28 | Functional | `scripts/browser-smoke.mjs:4617-4632` | The PWA block skips silently when `dist/` is absent and the run reports success | unverifiable | — | Not demonstrated this phase; `e2e.yml` builds first so CI is unaffected. See §11 |
| P0-29 | Mechanical | `tsconfig.node.json:25` | Only `vite.config.ts` of the four root config `.ts` files is in any TypeScript program | rejected | — | Fact true, harm limb disproved: both worktree configs use `as` casts, which erase the check anyway; a probe tsconfig including all four compiles clean. Residue folded into P0-31 |
| P0-30 | Mechanical | `.prettierignore` | `npm run format` rewrites files inside other agents' worktrees | confirmed | #740 | ESLint and Vitest both exclude the path deliberately, with comments. Measured: 54.6 s of 78.6 s spent on other trees |
| P0-31 | Prompt | `vitest.worktree.config.ts:5-9` | The docstring's reason for the file existing is no longer true | confirmed | #742 | Root config collects the same 800 files from inside a worktree; the two file lists `diff` empty. The claim is repeated in `CLAUDE.md`, `AGENTS.md` and the verify skill |
| P0-32 | Mechanical | `public/recovery.js` | The pre-mount escape hatch is covered by no tsconfig, no ESLint config and no test | confirmed | #741 | Mutation introducing a guaranteed `ReferenceError` leaves type-check and lint green. Its sibling `coi-bootstrap.js` *is* tested from disk |
| P0-33 | Mechanical | `eslint.config.js:54-57,227-233` | `no-undef` is off and no `.mjs` is in any TypeScript program | rejected | — | Forcing the rule on gives 94 errors, 100% false positives (browser globals inside `page.evaluate`), and zero real hits. The proposed sharpening onto `secret-scan.mjs` was disproved: it has no cold branches |
| P0-34 | Prompt | `eslint.config.js:29` | The ignore-list comment mis-describes `public/**` as generated | confirmed | #741 | Folded into P0-32's issue — same root cause, same fix |
| P0-35 | Mechanical | `.prettierignore:24-25` | `**/fixtures/**` excludes two ordinary modules and misses the byte-exact golden | unverifiable | — | Not verified this phase. See §11 |
| P0-36 | Mechanical | `bridge/Dockerfile:34-45` | The bridge image ships no `node_modules` but the bridge imports `zustand` | confirmed | #736 | Severity `unusable`. Reproduced by the lead independently. Built and run from three historical trees — it has never worked |
| P0-37 | Mechanical | `.dockerignore:83-104`, `src/lib/docker-context-ignore.test.ts` | SQLite sidecars reach the published image layer while the `.sqlite` is excluded | confirmed | #737 | `strings` recovered every row from a copied `-wal` while the excluded `.sqlite` held 4096 bytes of nothing. The guard test compares the two pattern lists, so a shape in neither is never sampled |
| P0-38 | Mechanical | `bridge/serve.mjs:24`, `bridge/mcp.mjs:27` | The documented quick start never loads `bridge/.env` | confirmed | #738 | Severity `unusable`. Run A (as documented) refuses to start; run B from `bridge/` reads both values from the same file |
| P0-39 | Mechanical | `docker/nginx.conf.in:64` | `always` puts `immutable` on a 404, so a missing asset is cached for a year | confirmed | #739 | A real browser honours it across reload and restart; only `cache: 'reload'` escapes. One poisoned URL fails the whole service-worker `addAll` |
| P0-40 | Functional | `docker/nginx.conf.in:91-97` | Under a sub-path the catch-all answers the whole origin | rejected | — | Documented intent contradicts it: `/healthz` sits at the origin root deliberately, and every deployment doc puts a reverse proxy in front. No doc invites sharing the origin |
| P0-41 | Prompt | `Run.ps1:204`, `index.html:459` | Both tell users to install Node 20 | confirmed | #746 | On Node 20 `npm ci` and `npm run dev` work; `npm run build` dies on `registerHooks` with an error naming no version. Not in #262's list |
| P0-42 | Mechanical | `Run.ps1:211` | The documented first-touch path runs bare `npm install` | confirmed | #747 | A real install strips all 14 `libc` arrays and drops `@emnapi/*`; `npm ci --dry-run` then refuses the result |
| P0-43 | Functional | `docker/nginx.conf.in:46-47` | The manifest is served as `application/octet-stream` and the `gzip_types` entry is dead | rejected | #748 | Confirmed factually; no consumer cares — Chromium parses it, `ERRORS: []`. The one-line `types` fix is noted as a rider on #748 |
| P0-44 | Prompt | `docker/nginx.conf.in:88-90,73` | The comment explaining the repeated `Cache-Control` describes a mechanism that does not exist | confirmed | #748 | Marker headers show a deep link is answered by the regex location. Line 94 *is* load-bearing — for `recovery.js`, `404.html`, `50x.html`, `icons/`, `ocr/` |
| P0-45 | Functional | `hacs.json`, `custom_components/gubbins/manifest.json` | Nothing runs `hacs/action` or `hassfest` | confirmed | #749 | Filed `enhancement`: the repo claims HACS compatibility, never that anything validates it. #674 is the precedent that already shipped |
| P0-46 | Functional | `Run.ps1:75` | `$BasePath` duplicates `DEFAULT_BASE_PATH` untested | rejected | — | Audiences are disjoint: every documented use of `GUBBINS_BASE_PATH` is a Docker build arg; `Run.ps1` is the double-click quick start. No parity comment either, so the "mirrors X" rule does not fire. See §11 |
| P0-47 | Mechanical | `package-lock.json:3` | The lockfile records `0.31.0` against `package.json`'s `0.32.0` | rejected | #728 | No consumer found: nothing in the repo reads it, and GitHub's SBOM names the root from the branch (`versionInfo: main`). Recorded as a rider comment on #728 |
| P0-48 | Functional | `package.json:89` | `typescript: "^6.0.3"` is wider than `typescript-eslint`'s `<6.1.0` peer cap | rejected | — | Premise dead: TypeScript's `latest` is 7.0.2 and the 6.x line ends at 6.0.3, so the caret cannot reach the cap. The live boundary is #186's. See §11 |
| P0-49 | Mechanical | `.gitignore` | `.claude/worktrees/`, `.claude/settings.local.json` and `.tanstack/` are ignored by nothing tracked | confirmed | #730 | Hidden only by `.git/info/exclude` and a per-user ignore, neither written by anything in the repo. A worktree stages as one gitlink with a warning, not a second tree — hence `cosmetic` |
| P0-50 | Mechanical | `.gitignore:77-91`, `.dockerignore:81-88` | The data-artefact rules miss every compressed or renamed dump | confirmed | #731 | A staged `.gz` produces zero added lines, so neither the hook nor CI can see inside it. `inventory.csv` and `backup.bak` dropped from the claim as wrong |
| P0-51 | Mechanical | `.gitignore:102-106` | `id_rsa` / `id_rsa.*` is narrower than the `id_rsa*` CLAUDE.md states | rejected | #731 | The detector flags a PEM/OpenSSH body regardless, and CI runs it. Folded into #731 as a one-line rider rather than filed |
| P0-52 | Functional | `.editorconfig:5-11` | 2-space indent applies to the 4-space Python integration | confirmed | #732 | The 2- and 6-space outliers in the histogram are all docstring prose, not code. `.editorconfig` is the only style declaration reaching those files |
| P0-53 | Prompt | `.env.example:3-4` | Claims to be the "single tracked template" when `bridge/.env.example` also exists and holds the credentials | unverifiable | — | Not verified this phase. See §11 |
| P0-54 | Mechanical | `scripts/lockfile.mjs:43`, `Dockerfile:35`, `bridge/Dockerfile:34` | Three more Node declarations #262 does not name | confirmed | #724 | The `lockfile.mjs` one carries a parity comment and is filed with P0-7; the two Dockerfiles are values, recorded for #262 |

### Phase 1 — Database engine, driver, migrations and shared repository seams

Pinned SHA: `16ef2e07edec6d7156ef600d0f8636a8d0079ec8`

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| P1-1 | Mechanical | `src/db/worker/database.worker.ts:36` | One rejected message wedges the FIFO chain, so every later request is dropped silently | rejected | — | No reachable trigger: only the driver posts to this worker, and it posts a typed envelope built in code. Every other path through `handle` was walked and none can reject. Hardening, not a defect |
| P1-2 | Mechanical | `src/db/client.ts:79-88`, `src/db/repositories/index.ts:140-319` | `disposeDatabase()` permanently poisons all 26 repository singletons, and a failed replace-restore never reloads | confirmed | #750 | Severity `unusable`. Drove the real `overwriteDatabaseFile` with the storage layer forced to fail; the stack lands on the real `client.ts:84` inside the real `safe-mode-actions.ts:63`. Split brain found beyond the claim: `getDatabaseDriver()` self-heals while repositories do not, so Merge succeeds and every screen still errors |
| P1-3 | Mechanical | `src/db/client.ts:73-88` | A concurrent `getDatabaseDriver()` during the restore write window opens a second worker over the file being overwritten | unverifiable | — | The absence of a quiescing state is proved; the consequence is not. The candidate's three named callers are all user-gesture only. See §11 |
| P1-4 | Prompt | `src/db/errors.ts:168` | The comment's arithmetic `19 | (9 << 8)` yields 2323, a different SQLite code | confirmed | #751 | Filed with P1-5. Verified against sqlite.org and against four real constraint violations. The existing test pins the value, so it cannot catch the derivation |
| P1-5 | Mechanical | `src/db/errors.ts:189-192` | The collapse rule is described generally and implemented for constraints only | confirmed (narrowed) | #751 | Every behavioural consequence **rejected**: the shipped VFSes have no shared memory, so WAL is impossible and the busy/read-only extended families cannot arise. Comment accuracy only |
| P1-6 | Performance | `src/db/rpc/worker-driver.ts:297`, `src/db/worker/database.worker.ts:220` | Whole-database payloads cross the worker boundary by copy, with no transfer list | confirmed | #752 | Measured in a real COI worker: copy 2.00× payload vs transfer 0.99×. Filed with P1-7. The candidate's remedy was corrected — `writeDatabaseFile` cannot transfer, because `BackupDialog` reads `parsed.sqlite.byteLength` in render |
| P1-7 | Prompt | `src/app/error/safe-mode-actions.ts:32-33`, `src/features/backup/build-backup.ts:143-145` | Two `.slice()` copies justified by a WASM-memory dependency this engine has never had | confirmed | #752 | Both sites hold a `WorkerDatabaseDriver`; the export arrives as a structured clone, and the engine's own export already slices. The module's memory is not shared (import table read) |
| P1-8 | Functional | `src/db/rpc/worker-driver.ts:372-374`, `src/app/error/safe-mode-actions.ts:62-73` | The plain-OPFS restore reports storage failure but never success, so a latched Hard Stop cannot clear | rejected | — | The tier store is **not persisted** (its own header says so) and every successful `opfs` overwrite reloads. On the crash screen the observer is not even installed — it is registered after a successful boot |
| P1-9 | Mechanical | `src/db/worker/database.worker.ts:166,187-196` | `runMerge`'s local driver closes over a connection `discard()` may close underneath it | rejected | — | Disproved by test, not by grep: a wrapper making the first `transaction` throw recorded **zero** driver calls afterwards in both merge modes. No catch-and-continue exists in the 13 modules `runSnapshotMerge` reaches |
| P1-10 | Mechanical | `src/db/rescue-driver.test.ts:56-63` | The non-leakage assertion cannot fail | rejected | — | Mutating `#teardown` to drop `terminate()` turns **three** other tests red. Mutating `disposeDatabase` to skip `close()` turns this one red, so it is not a no-op. Below #252's bar |
| P1-11 | Prompt | `src/db/worker/database.worker.ts:8-13` | The header attributes request serialisation to the synchronous VFS rather than the FIFO chain | rejected | — | The two comments do not disagree — the header's own first sentence already credits the FIFO chain. No consequence above the bar |
| P1-12 | Functional | `src/db/search/parseASTtoSQL.ts:648,:644` | The tag predicate folds ASCII only, contradicting the dictionary's own fold | confirmed | #753 | Severity `wrong-data`. Lead spot-checked: `Ölkanne`=['i1'], `ölkanne`=[], folds equal. **Not** a duplicate of #390, which names three sites and explicitly delegates tags to #342 (write side, shipped). The `CONTAINS` arm at :644 is a first-class second site — it is what `tag:` produces |
| P1-13 | Functional | `src/db/search/parseASTtoSQL.ts:280`, `src/db/repositories/item/sql.ts:114` | The ranking lower-cases in JS and compares in SQL, so a non-ASCII capability key always scores 0 | confirmed (broadened) | #754 | Broader than claimed: **no** spelling both finds and ranks. Reaches the default Inventory ordering and the bridge's `/search`, both of which pass no sort |
| P1-14 | Performance | `src/db/search/parseASTtoSQL.ts:635,:644,:648` | The tag predicate's correlated `EXISTS` should be the set-based `IN` the list filter uses | rejected | — | Premise false — the two surfaces test different things (name vs id). Counter-measured: the `IN` rewrite is 3–14× **slower** on any multi-condition tree, because `EXISTS` streams to the page LIMIT. #168 chose `EXISTS` deliberately and measured it |
| P1-15 | Functional | `src/db/search/fts.ts:39-47` | A separator-only term compiles to an empty FTS phrase: nothing alone, ignored beside a word | confirmed | #755 | Severity `wrong-data`. `"M3 -"` returns the same rows as `"M3"`, so adding a term narrows nothing. Reachable from every surface but the plain-English box. Filed with P1-18 |
| P1-16 | Mechanical | `src/db/search/parseASTtoSQL.ts:446-471` | The `EQUALS` kind chain falls through to text equality with no exhaustive guard | rejected | — | `field-registries.test.ts` (#247) goes red at runtime on both routes a new kind can arrive. All four bare `default:` legs throw a typed `SearchAstError`. No live wrong result |
| P1-17 | Functional | `src/db/search/parseASTtoSQL.ts:314-330` | A location term anywhere in the tree drops the sidebar's location scope | confirmed (narrowed) | #756 | Negated-location only, reachable via the plain-English box ("not in the attic"). The OR-arm leg is **rejected** — no user surface offers a location term. #626's rationale is stated in terms of unsatisfiability, which does not hold under negation |
| P1-18 | Prompt | `src/db/search/fts.ts:34-35` | The `null` sentinel means "match everything" in one caller and "match nothing" in two | rejected standalone | #755 | No consequence today — `core.ts`'s branch is unreachable, because only whitespace produces `null`. Folded into P1-15: fixing that would activate it and return the whole catalogue |
| P1-19 | Prompt | `src/db/search/parseASTtoSQL.ts:14-16`, `src/db/search/ast.ts:73-78` | The depth cap is presented as the guard against a runaway tree; node count is unbounded | confirmed (narrowed) | #757 | Mechanism corrected: the real limit is `SQLITE_MAX_EXPR_DEPTH` at **998 terms / ~4.9 KB**, not 32,767 parameters — ~33× more reachable. `astError` returns null, so it surfaces as "Your items couldn't be loaded" with a Retry that fails identically |
| P1-20 | Prompt | `src/db/search/parseASTtoSQL.ts:435-437` | The comment overstates what `unicode61` folds | rejected | — | Misread: the passage is about **case** folding, which `unicode61` does perform for accented letters in every script tested (`Ố`, `Ö`). The counter-examples test diacritic stripping, which the comment does not claim |
| P1-21 | Functional | `src/db/sqlite-header.ts:96-103` | The header gate accepts a WAL-format database the shipped build cannot open | confirmed (narrowed) | #758 | Severity `unusable`. Driven in a real COI browser worker: header gate `ok:true`, deep gate `SQLITE_CANTOPEN`, bytes written verbatim, next boot fails. VFS asymmetry confirmed — `importDb` rewrites bytes 18/19, `writePlainDatabaseFile` does not. The `data-loss` half is **disproved**: a restore point is captured and proven on every route. Provenance speculative — see §11 |
| P1-22 | Mechanical | `src/db/worker/db-file-store.ts:56-58` | The sahpool sidecar cleanup discards `unlink`'s result and lets a post-commit throw escape | confirmed (narrowed) | #759 | The return-value leg is **disproved** (false = absent = benign, and the comment is right). The throw leg is real: reported as "restore failed" after the bytes committed, skipping both `acknowledgeDbLoss()` and `disposeDatabase()`. Only `-journal` is reachable; `-wal`/`-shm` are impossible without shared memory |
| P1-23 | Functional | `src/features/backup/restore-backup.ts:203-231` | The backup Replace path overwrites the live database after a 16-byte magic check only | confirmed (narrowed) | #760 | Severity `unusable`. Three residues driven against real zips: a manifest-less backup, a malformed checksum block, and a checksum-correct copy of an already-corrupt database. **Not** a duplicate: #198 and #501 both hardened only the two *rescue* restores, and #501's body cites Replace as the exemplar |
| P1-24 | Mechanical | `src/features/backup/backup-format.ts:488-497` | `looksLikeSqlite` duplicates `isSqliteFile` byte for byte | rejected | — | Substitution proved safe (type-check clean, 256 tests green), but the magic string cannot change, so "only one would be updated" cannot occur. The real residue is gating strength, which is P1-23 |
| P1-25 | Mechanical | `src/db/worker/verify-binary.ts:118-125` | The temp-file cleanup calls `sqlite3.wasm.FS`, which the shipped build does not provide | confirmed (narrowed) | #761 | `typeof sqlite3.wasm.FS` is `undefined` in both builds; re-opening after "cleanup" succeeds. A working `sqlite3__wasm_vfs_unlink` **does** exist (return code 0). No memory consequence — the throwaway worker is terminated moments later. The comment's stated lifetime is wrong |
| P1-26 | Performance | `src/db/restore-candidate.ts:131`, `src/db/worker/verify-binary.ts:45` | Verifying a candidate holds several full copies of the database | confirmed | #762 | Measured in a real COI browser worker: **5.7× at 50.4 MiB (+285 MiB)** and 5.2× at 201.6 MiB (+1041 MiB), two runs each, <1% spread. **Four** live copies at peak, not three. The "MEMFS counts against WASM linear memory" leg is **disproved** — MEMFS is plain JS heap. Filed with P1-27 |
| P1-27 | Performance | `src/app/error/safe-mode-actions.ts:237-238` | The whole file is read into memory before the 16-byte check that would reject it | confirmed (narrowed) | #762 | +202.3 MiB in 120–160 ms before the check, measured. Narrowed: an `accept` filter exists, the read follows a pick and a save-destination choice, and the accept path needs the read anyway. Not a duplicate of #641, which is scoped to the image pickers |
| P1-28 | Mechanical | `src/lib/storage-keys.ts:366`, `src/db/tab-lock.ts:23` | The Web Locks name is a bare literal in two places | rejected | — | Claim collapses: `storage-keys.test.ts` scans the whole source tree for `gubbins:` literals and names the file and key. Renaming it turns the guard red. The drift is loud, not silent |
| P1-29 | Mechanical | `src/db/tab-lock.test.ts:88` | The only `release()` assertion cannot fail | rejected | — | Mutating `release` to **throw** turns it red, so it is not a no-op. `release()` has no production caller. Below #252's bar |
| P1-30 | Functional | `src/db/tab-lock.ts:9-11` | A bfcached holder never releases, so the waiting tab's automatic switch never fires | confirmed | #763 | Driven in real Chromium with bfcache enabled. A queued request does **not** evict the frozen holder (30 s+), so `whenReleased` never settles — but a *fresh* request does, so the button rescues it (`WebLocksContention`). The copy promises an automatic switch that silently stops. Chromium only — see §11 |
| P1-31 | Prompt | `src/app/boot/BootScreens.tsx:317-318` | "Use this tab" promises a takeover the code cannot perform | rejected | — | Disproved by P1-30's browser run: in the one scenario where the button is pressed, it **does** acquire the lock. Both catalogs carry the keys |
| P1-32 | Performance | `src/db/migrations/v1-initial.ts:747` | `idx_items_is_active` is preferred over all three purpose-built partial indexes, so every list page full-sorts | confirmed | #764 | **A regression against #164 and #172.** Across 54 `is_active` statements captured from 69 real read methods, zero plans use any of the three. Interleaved A/B at 50k: default list 4.49 → 0.24 ms (0.054×), ratio worsening with row count. `git log -S` shows the boolean index predates #164's. Prescription corrected: a bare drop makes ~25 of the 38 statements *slower* |
| P1-33 | Performance | `src/db/migrations/v1-initial.ts:1328` | `items_fts_au` has no `OF` list and the auto-stamp trigger makes it fire twice | confirmed | #765 | Control proves the mechanism (setting `updated_at` explicitly drops firings 2→1). Ratios 6.2–7.4× on single updates, 7.9× on a location delete, 12.1× on a category erase. The **space** claim is false — segment bytes are identical and `optimize` converges all variants. Biggest payer is stock movements via the three-deep recompute chain |
| P1-34 | Mechanical | `src/db/worker/sqlite-bootstrap.ts:60,:75` | A rejected module or pool load is memoised for the worker's life and never retried | confirmed | #766 | A rejected RPC response never sets `isUnavailable`, so the worker is not replaced. All three sahpool rescue actions stay dead. The library memoises its own rejection too, so the fix needs `forceReinitIfPreviouslyFailed` as well |
| P1-35 | Prompt | `src/db/worker/sqlite-bootstrap.ts:2-8,:108` | A wasm-instantiate failure is untyped, and `openConnection` maps every failure to `OPFS_UNAVAILABLE` | rejected | — | `UNKNOWN` and `INIT_FAILED` render the same screen, hint and actions. The second leg is **disproved**: `fromUnknown` prefers the extracted result code, so a disk-full is `SQLITE_FULL` and a corrupt file `SQLITE_ERROR` |
| P1-36 | Mechanical | `src/db/worker/sqlite-bootstrap.ts:111-117` | Only `foreign_keys` is set; no `busy_timeout`, `journal_mode` or `synchronous` | rejected | — | `SQLITE_BUSY` is unreachable: the tab lock fails closed, one connection, a FIFO chain, and no WAL. The residual busy comes from the OPFS proxy's own retry, which `busy_timeout` does not govern |
| P1-37 | Mechanical | `src/db/worker/sqlite-bootstrap.ts:188-196` | `probeFts5`'s bare catch reports any failure as "this build lacks FTS5" | confirmed | #767 | The boolean return destroys the result code, so this is the one leg P1-35's rebuttal does not also kill. #500 is the precedent for exactly this distinction |
| P1-38 | Functional | `src/db/migrations/__fixtures__/schema-snapshot.ts:105` | The golden fixture sorts by name, so it cannot pin trigger creation order | confirmed (reframed) | #775 | **The corruption invariant is not demonstrable** — a fresh build in either order is healthy across five configurations (`integrity_check` ok, FTS ok, correct results), and a drop/recreate on a populated database is too. What survives: moving the statement leaves the whole suite green, and no comment records the relation. Folded into the sweep |
| P1-39 | Prompt | `src/db/migrations/v1-initial.ts:2069-2070` | The comment claims parity with `checkouts.source_location_id`, which is `NO ACTION`, not `SET NULL` | confirmed | #775 | Both deletes driven: the location delete aborts, the supplier delete nulls. `fk-refs.ts` and `tombstone.ts` label it correctly, so the migration comment is the odd one out. Folded into the sweep |
| P1-40 | Prompt | `src/db/migrations/enum-checks.test.ts:97-103` | The `UNCONSTRAINED` registry claims to be one of two complete halves | confirmed (narrowed) | #775 | The "invisible to the guard" claim is **false** — adding a CHECK does trip it, though with the wrong diagnosis. Four vocabulary-bearing columns sit in neither map. Residue of #605, not a duplicate. Folded into the sweep |
| P1-41 | Performance | `src/db/migrations/v1-initial.ts:1653,:1659,:1521,:1294,:1006,:1032,:1063` | Seven indexes duplicate the leading columns of a UNIQUE index | confirmed | #768 | All seven pairs plan identically to their UNIQUE fallback (seek→seek, covering scan→covering scan). The **write-amplification** leg is **rejected**: no measurable difference with the real schema, and under 2% of an insert isolated — the six triggers dominate by ~16×. The real cost is storage: 867 pages, 11.5%. Filed with P1-48 |
| P1-42 | Performance | `src/db/migrations/v1-initial.ts:1770` | `idx_stock_deltas_placement` cannot order the delta replay | rejected | — | The claimed query does not exist. The replay reads the **whole** ledger once via `keysetPage` and partitions in JavaScript. The proposed index is a net loss (0.2632 vs 0.2251 ms). Separate observation in §11 |
| P1-43 | Functional | `src/db/migrations/migration.ts:48-78` | `baselineFingerprint` hashes comments, so a comment edit refuses every existing database | confirmed mechanically, rejected as a finding | — | Both halves reproduced, including the end-to-end `SCHEMA_STALE` on a one-word comment edit. **#274 chose this deliberately** — the derived fingerprint replaced a hand-maintained counter precisely because it cannot *miss* a change, and the project documents wipe-on-schema-change as the accepted workflow. The Prettier half is false: Prettier does not reformat template-literal contents |
| P1-44 | Mechanical | `src/db/migrations/migration.ts:67-74` | Positional params concatenate with no delimiter, so two arrays can collide | rejected | — | Lead spot-checked the collision (`79e59669` both ways). But every seeded param is a non-null string — fixed UUIDs, slugs, prose, a grant blob — and no realistic edit collides. Hardening |
| P1-45 | Mechanical | `src/db/migrations/v1-initial.ts:1593,1607,1621,1682,1700,1716` | The recompute switch has no `COALESCE`, so a missing row silently stops the projection | rejected | — | Mechanism demonstrated (both levels and the whole capture stop, no error). But no shipped code can delete the row: it is `NOT_SYNCED`, in no clone-wipe set, in none of the 20 erase statements, and the only statements touching it are six `UPDATE … WHERE id = 1`. Hardening |
| P1-46 | Prompt | `src/db/migrations/v1-initial.ts:2601-2608` | `settings` carries no length CHECK, though two docstrings say every user-editable column does | confirmed (narrowed) | #769 | `settings` only — `webhooks.secret` **rejected** (generated, never typed; `secret_ref` *is* capped). Every text column in the 56-table schema was enumerated; one table remains. #346 scoped itself to nothing and its closing note asserts completeness, so this is its named residue. #349 is the precedent |
| P1-47 | Mechanical | `src/db/worker/sqlite-bootstrap.test.ts` | The suite cannot observe the pragma, the FTS probe or either failure path | confirmed (narrowed) | #770 | Leg (a) only. Deleting `PRAGMA foreign_keys = ON` leaves all 22 worker tests green, and the ~18 repository tests that look like coverage each issue it themselves. `feeds.ts:517` drops a production JOIN naming this file |
| P1-48 | Performance | `src/db/migrations/v1-initial.ts:1662` | `idx_stock_batches_expiry` is not partial, where its siblings are | confirmed (understated) | #768 | Stronger than claimed: referenced by **zero** of 118 captured statements, so it is dead rather than over-broad. The one expiry read drives from `item_id`; FEFO ordering is done in TypeScript. Partial form saves 86% of it. Filed with P1-41 |
| P1-49 | Mechanical | `src/db/repositories/stock-batches.ts:56,:86` | The batch upsert targets `ON CONFLICT(id)` on a table that also has a UNIQUE natural key | confirmed (narrowed) | #771 | Severity `unusable`. Driven end to end through `restoreSnapshot` and the real repository methods. **Not** reachable from any in-repo write path — every id-originating write derives — but contagious once in, and repaired only for SERIALISED. Filed with P1-50 |
| P1-50 | Mechanical | `src/db/migrations/v1-initial.ts:1684-1691` | The `item_stock` recompute trigger has the same unnamed-constraint hole | confirmed | #771 | Same root cause, filed together. A **third** symptom was found: the decrement side addresses by derived id, so it silently no-ops — the user sees success, the ledger records −1, nothing changes. The "raw SQLite text reaches the user" leg is **disproved** |
| P1-51 | Functional | `src/features/inventory/batches.ts:137,:237` | The FEFO tie-break uses `localeCompare`, so two devices in different locales draw different lots | confirmed | #772 | Severity `wrong-data`. The ids do **not** converge, because the order decides *which lots enter the plan*, not just their sequence — 10−5 converges to 0. Reachable without non-ASCII: 0.38% of random UUID pairs reorder between da/nb and everything else. Root cause is a Phase-5 file; the consequence lands in `stock-batches.ts` |
| P1-52 | Prompt | `src/db/repositories/text-limits.ts:8-10` | The module asserts a schema backstop two columns do not have | confirmed | #769 | Merged with P1-46 — same root cause, one fix |
| P1-53 | Performance | `src/db/repositories/reservations.ts:78-101` | `readAvailability` binds one placeholder per id with no chunking | rejected | — | The limit is a fixed 32,766 on **both** shipped engines; `readAvailability` throws at N=32,765, which no caller can reach. `listRelationsForItems` breaks at *half* that N on the same id list, and 13 unchunked sites exist. #561 never mentions bind arity, so there is no policy to violate |
| P1-54 | Performance | `src/db/repositories/checkout-plan.ts:376-384` | `planCheckInAllForTarget` is an unbounded N+1 of awaited round-trips | rejected | — | `1 + 2N` confirmed exactly. But a real browser worker round-trip measures **0.0425 ms**: ~1.7 ms at N=20 on desktop, ~17 ms on a 10×-slower phone, behind a confirmation dialog with a spinner — and not the dominant term (100 statements vs 41 reads) |
| P1-55 | Functional | `src/db/repositories/mappers.ts:613-621` | `parseStringArray` coerces a non-string option to its string form | confirmed | #773 | Severity `wrong-data`. `'["A",null,3]'` reads back as `["A","null","3"]`, renders as pickable options, and a later save relaunders it into storage and syncs it. Reachable via restore, peer sync and bridge push. The same file already *filters* in two siblings, each with a comment saying why |
| P1-56 | Prompt | `src/db/repositories/like.ts:10-11` | "Shared rather than re-declared per repository" — it is re-declared in `parseASTtoSQL.ts:797-800` | confirmed | #775 | Substitution proved safe (type-check clean, 188 tests green), then reverted. No fourth special character is missed (20 probed against a real engine). Folded into the sweep |
| P1-57 | Mechanical | `src/db/repositories/tombstone.ts:380` | `record()` discards the builder's params and re-lists them by hand | rejected | — | Drift demonstrated (a transposed row, whole suite green). But `record()` has **no production caller** — only two throw/no-throw assertions. Below the bar |
| P1-58 | Prompt | `src/lib/text-limits.ts:110-131` | `truncateByCodePoints` claims to cut between whole characters and cuts between code points | rejected | — | In context the docstring means code points — its whole paragraph is about lone surrogates. A ZWJ or regional indicator is representable and round-trips, so the harm the function exists to prevent does not occur. A Phase-5 file |
| P1-59 | Functional | `src/db/repositories/types/history.ts:6-26`, `src/db/repositories/mappers.ts:481-492` | The item ledger's actor is written, indexed and FK-protected, and projected by no read | confirmed | #774 | Severity raised to `data-loss` by P1-60. Three wiki pages, closed #79's own requirement and a COMPLETE plan doc all claim the Activity Log answers *who*; `actorUserId` reaches zero `.tsx` files. The location ledger carries it, so one mapper fix unblocks all three symptoms |
| P1-60 | Functional | `src/features/storage/triage-actions.ts:61-76` | The cold-storage archive omits the actor, and the source rows are then deleted | confirmed | #774 | Drove the real `archiveAndPruneHistory`: archive keys carry no actor, post-prune count 0. **Folds into P1-59** — one root cause. Narrowed: the prune *is* gated on a proven save, and an ordinary backup preserves the column, so the loss bites a user who prunes without a backup predating it. The prune is deliberate and permission-gated |
| P1-61 | Mechanical | `src/db/repositories/types/history.ts:9,:20` | `HistoryAction` is a closed union over a deliberately unconstrained column | rejected | — | Preserving an unknown action is documented **three times** as the forward-compatibility contract (`activity-kind.ts:27`, `history-format.ts:55`, `event-types.ts:136`), and no exhaustive switch or unsound lookup exists. The four normalising siblings are mutable settings rows, not an append-only ledger |
| P1-62 | Prompt | `src/db/repositories/types/items.ts:45,:75,:87-92` | Three raw money columns are documented "in the base currency"; they hold micro-units | confirmed (narrowed) | #775 | Measured ratio raw/DTO = 1,000,000 for all three. #286's residue — that commit touched no file under `types/`. No live consumer is misled (the bridge uses DTOs; the one raw-SQL money site documents it correctly). The eight unit-less columns leg is **rejected** — a missing doc is not a wrong doc. Folded into the sweep |
| P1-63 | Prompt | `src/db/repositories/types.ts:4-6`, `src/db/repositories/types/categories.ts:303-307` | "Mirror the raw SQLite columns exactly" is false both ways, and the LEFT JOIN claim is wrong | confirmed (narrowed) | #775 | The carrying-non-columns direction is **rejected** — the #356 guard catches it at build time (demonstrated) and every such member is self-documenting. The missing-columns direction is real and the guard is blind to it. The join kind is harmless (NOT NULL FK with CASCADE). Folded into the sweep |
| P1-64 | Mechanical | `src/db/errors.ts:196-200` | `extractResultCode` reads only `resultCode`; `node:sqlite` sets `errcode` | confirmed (narrowed) | #776 | "Dead code in the bridge" **disproved** — the bridge never imports the humanising layer. Real costs: the unit suite cannot exercise the constraint path at all, and the bridge answers 500 where `write.ts:387` means 422. Two in-repo comments already name the gap |
| P1-65 | Mechanical | `src/test/drivers/memory-driver.ts:75`, `bridge/src/node-driver.ts:198` | Both Node drivers flatten every batch failure to `TRANSACTION_FAILED` | confirmed | #777 | Independent of P1-64: the fallback is hard-coded where the worker deliberately passes none. A disk-full would never raise the storage tier. `isQuantityFloorViolation`'s own docstring names the divergence |
| P1-66 | Mechanical | `src/test/drivers/memory-driver.ts:48,:65`, `bridge/src/node-driver.ts:168,:188` | `node:sqlite` silently keeps only the first statement of a multi-statement prepare | rejected | — | Instrumented `DatabaseSync.prepare` across **both** suites — 12,470 app tests / 811 files and 1,191 bridge tests / 79 files — with the detector proved live: zero multi-statement calls. A static literal sweep finds only SQL-injection fixtures. Folded into #782 as an axis |
| P1-67 | Mechanical | `src/test/drivers/crashed-driver.ts:29` | The file declares `IDatabaseDriver['exportBinary']`, which does not exist | confirmed (narrowed) | #783 | TS2339 demonstrated under a probe tsconfig, but inert — the cast erases and the object is laundered anyway. The interface leg is **rejected**: that member is one of nine worker-only members, a consistent split both production callers respect. #601 sanctions the test-tree exclusion |
| P1-68 | Performance | `src/db/rpc/worker-driver.ts:243-246` | `queryOne` materialises the whole result set on both real drivers | rejected | — | An independent re-sweep of all 134 non-test sites found every one bounded by a primary key, a unique index, an aggregate, a PRAGMA or an explicit LIMIT. The docstring makes no cost claim and has misled nobody |
| P1-69 | Mechanical | `src/test/drivers/memory-driver.ts:51`, `bridge/src/node-driver.ts:171` | `lastInsertRowId` is 0 where the interface documents null | rejected | — | Zero readers anywhere; every write path uses UUID text ids. Contract-only. Folded into #782 as an axis |
| P1-70 | Mechanical | `src/db/rpc/driver.ts:12` | An integer above 2^53 throws on `node:sqlite` and returns a bigint from sqlite-wasm | confirmed (reframed) | #778 | **Rejected as driver fidelity; real as an unbounded-money-write defect**, severity `wrong-data`. `toStoredMoney` has no exactness ceiling and the price input has no maximum, so a value ≥ ~9.007×10⁹ major units is written, then read back as `null` in the app and as a hard error in the bridge. #677 is the precedent |
| P1-71 | Mechanical | `src/test/drivers/memory-driver.ts:84-88` | A bound `undefined` is NULL in production and a throw in tests | rejected | — | Compile-blocked by `SqlValue` under `strict` + `noUncheckedIndexedAccess` — all three forms error, including the `.map()` case. Every `as SqlValue[]` cast is a variance cast. The 67 runtime hits all traced to another agent's probe file |
| P1-72 | Functional | `src/test/drivers/memory-driver.ts:70-74`, `bridge/src/node-driver.ts:193-197` | Both Node drivers swallow a failed ROLLBACK and keep the connection | confirmed (narrowed) | #779 | The wedge is real when forced (reads back its own uncommitted row). But no reachable path fails a `ROLLBACK` on `:memory:`, and all three bridge paths dispose per request or never run a batch. #555 deliberately scoped itself to the worker — its fix commit touched three files |
| P1-73 | Prompt | `src/db/query-row-shape.test.ts:94,:97,:99-106` | The verified floor carries ~42 sites of slack, though its comment says one widening cannot pass | confirmed | #780 | Measured live counts sites=323 verified=287. The smallest N that trips the guard is **43**; at N=42 the suite is fully green with 42 statements opted out. `git log -L` shows the floor was pinned once (4 sites of slack) and never re-pinned while the read layer grew ~15% |
| P1-74 | Mechanical | `src/test/drivers/keyset-page.ts:26-30` | `pageOf` sorts by ICU collation and seeks by code unit | rejected | — | Divergence demonstrated (row 'B' visited in neither page), but unreachable: every real id is a canonical lower-case UUID, for which all three orderings coincide (2,000-sample check), and both fixtures hold 1–3 rows |
| P1-75 | Prompt | `src/test/segment-layout.ts:2,:4,:85,:86-102` | The comments name jsdom, and `restoreSegmentLayout()` does not restore | confirmed (narrowed) | #781 | Line numbers corrected — the file is 103 lines. Restore leaves `getBoundingClientRect` an **own** property of `HTMLElement.prototype` returning a non-DOMRect. Two tests call restore mid-test to assert the fallback and are therefore testing a stub. The jsdom naming is a repo-wide ~30-file matter — see §11 |
| P1-76 | Mechanical | `bridge/src/node-driver.ts:1-23` | Three parity claims with the app's test driver, held up by no test | confirmed | #782 | `node-driver.test.ts` covers only the #174 statement cache. Rule 3 is feasible and was proved: the bridge **can** import the app test driver, and both agree with each other while disagreeing with the worker. P1-66 and P1-69 fold in as axes |
| P1-77 | Mechanical | `src/db/repositories/mappers.ts:220` | The tri-state thumbnail discriminates with `in`, which is prototype-sensitive | rejected | — | Cannot be made to fail: `Object.prototype` has no such member and no path builds an inherited row. The `errors.ts:138` comment guards the **opposite** direction (an arbitrary key against a fixed registry). An 8-site sweep of the same pattern is uniformly safe |

### Phase 2 — The item repository family

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 3 — Every other repository

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 4 — Data integrity

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 5 — App shell, platform and shared libraries

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 6 — Foundry primitives and shared components

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 7 — Inventory domain logic

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 8 — Inventory components

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 9 — Commerce, projects and reporting

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 10 — Capture and discovery

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 11 — People, time and configuration screens

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 12 — Bridge core and HTTP API

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 13 — Bridge integrations

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 14 — Satellites

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 15 — Prompt and guidance surface

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 16 — Wiki parity

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 17 — Cross-cutting static sweeps

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 18 — Runtime performance at scale

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

## 11. Carry-over: unverifiable candidates and out-of-scope observations

Candidates no phase could demonstrate here, with what would settle each; and observations that are
not defects but that the maintainer should see (a decision that looks worth revisiting, a
programme in §4.2 that a phase found to be under-scoped). Nothing here is filed as an issue by the
audit; Phase 19 puts the list to the maintainer.

| From | Where | Observation | What would settle it |
| --- | --- | --- | --- |
| Phase 0 | `scripts/browser-smoke.mjs:4617-4632` | When `dist/index.html` is absent the PWA update-handshake block skips, pushes no result, and the run still exits 0 reporting every step passed. `e2e.yml` builds first, so CI is unaffected; the documented local `npm run test:e2e` is not. | Run `npm run test:e2e` with no `dist/` present and read the summary line and exit code. |
| Phase 0 | `.prettierignore:24-25` | `**/fixtures/**` appears to protect the wrong files in both directions: it excludes `bridge/src/fixtures/{test-identity,virtual-snapshot}.ts`, which are ordinary hand-written modules, and does not match `src/db/migrations/__fixtures__/`, which holds the golden `scripts/regen-schema-snapshot.mjs` calls byte-for-byte. | `prettier --file-info` on both paths, then check whether `npm run format` rewrites the golden. |
| Phase 0 | `.env.example:3-4` | The header calls itself "the single tracked template" when `bridge/.env.example` is also tracked and is the one documenting the roughly 35 `GUBBINS_BRIDGE_*` variables, including the credentials. | Read the two files side by side and decide whether the root file's scope sentence should be narrowed. |
| Phase 0 | `Run.ps1:75` | `$BasePath = '/Gubbins/'` is an untested duplicate of `DEFAULT_BASE_PATH` (`src/base-path.ts:14`). Rejected as a finding because the audiences are disjoint and it carries no parity comment, so the "mirrors X" rule does not fire — but it is a literal that would need changing in two places. | A decision on whether the launcher should ever honour `GUBBINS_BASE_PATH`. |
| Phase 0 | `package.json:89` | When `typescript-eslint` widens its peer range for TypeScript 7, `package.json`'s `^6.0.3` must move to `^7` in the same change or resolution silently stays on 6.0.3. That is #186's work; worth a line in its body. | Nothing — it is a note for whoever actions #186. |
| Phase 0 | repository settings | `secret_scanning_non_provider_patterns` is **disabled**. Enabling it is a settings toggle that closes a good part of #733's residue (connection strings, generic auth headers, private keys) with no code change. The settings side belongs to #454. | The maintainer's decision. |
| Phase 0 | repository settings | `main` has no branch protection and the active ruleset carries no required status checks, so `tests.yml` is advisory on pushes and `deploy.yml`'s `ci` job is the only enforced gate. This is context for #725, #726 and #727 rather than a defect in a file; the settings side belongs to #454. | The maintainer's decision. |
| Phase 0 | `.github/workflows/e2e.yml` | The nightly's 11 step failures do not reproduce locally (125/125 steps pass on this machine), so they are specific to the hosted runner. Not filed — no defect was demonstrated in the app or the suite. | Re-running the suite on `ubuntu-latest` with a raised `SMOKE_TIMEOUT_SCALE`, or profiling the runner. |
| Phase 0 | `scripts/browser-smoke.mjs:2262` | Whether `BarcodeDetector` is absent in Playwright's bundled Chromium on `ubuntu-latest`. It is absent on both local channels, headed and headless, which is enough to confirm #743; the Linux answer is inference. | One `workflow_dispatch` step evaluating `'BarcodeDetector' in window` on the runner. |
| Phase 0 | `hacs.json`, `custom_components/gubbins/` | Three HACS checks could not be settled by reading: the `description` / `topics` / `issues` / `archived` checks (they read repository settings), whether hassfest's `translations` plugin accepts the 13 KB `strings.json`, and the precise per-category matrix `hacs/action` applies. | Running `hacs/action` and `hassfest` once — which is what #749 asks for. |
| Phase 1 | `src/db/client.ts:73-88` | `getDatabaseDriver()` has no closed or quiescing state, so a concurrent call between `disposeDatabase()` and the OPFS write could open a second worker over the file being overwritten. The absence of the guard is proved; whether the second worker's handle acquisition throws, blocks or succeeds — and so whether the consequence is a benign lock error or corruption — is not. | In Chrome on the primary `opfs` layout: hold open `writePlainDatabaseFile`'s writable on `gubbins.sqlite3`, then call `getDatabaseDriver().init()` from the main thread and observe whether the new worker's `createSyncAccessHandle()` throws, blocks or succeeds. |
| Phase 1 | `src/db/sqlite-header.ts:96-103` | No route was established by which a user obtains a WAL-format `.sqlite` without deliberately changing a setting in an external tool. Safe Mode's own archive README points users at DB Browser for SQLite, and the header survives a clean close, so the artefact is stable once made — but the app, the bridge and every common tool's defaults all produce the openable form. | A survey of what real tools do to the journal-mode bytes on save, or one report of a user hitting it. |
| Phase 1 | `src/db/tab-lock.ts` | #763 was confirmed in Chromium only. Playwright's Firefox and WebKit builds are not installed on this machine, and back-forward-cache behaviour differs between engines. | Running the same two-tab scenario under Gecko and WebKit. |
| Phase 1 | `src/app/error/safe-mode-actions.ts:237-238` | Whether picking a multi-gigabyte file on a low-memory device yields a catchable error or loses the renderer was not measured — no such device was available, and building a multi-gigabyte fixture was not safe on this host. | Picking a >2 GiB and a ~4 GiB file on a real low-RAM Android renderer, recording whether the read rejects or the tab dies. |
| Phase 1 | `src/db/restore-candidate.ts` | #762's 5.2–5.7× peak was measured on a 64 GiB desktop. Whether that multiple tips a phone into losing the renderer is unknown. | The same probe on a real low-RAM Android, or under memory-pressure emulation. |
| Phase 1 | `src/features/sync/snapshot.ts:365` | The delta replay's ledger read plans as `SCAN stock_deltas` + `USE TEMP B-TREE FOR ORDER BY` — there is no `(created_at, id)` index, so every snapshot build sorts the whole ledger, and the keyset continuation cannot seek either. Adjacent to #544, which bounded the ledger's size rather than its read. Not filed: it is a distinct candidate that arose while disproving P1-42 and has had no verification pass of its own. | A measurement at a realistic ledger size, and a decision on whether the index is worth its write cost. |
| Phase 1 | repository-wide | About 30 files name `jsdom` in comments. It is not a dependency — the suite runs on happy-dom. Filing it against one file would be filing a thirtieth of a convention. | A Phase 17 sweep. |
| Phase 1 | `src/features/sync/unique-key-coverage.test.ts` | The `EXEMPT` map records that `item_stock` and `stock_batches` need no natural-key collision rule because "id is derived from the key, so both devices mint the same id". True for rows the app mints, untrue for rows it applies — which is #771. The exemption is doing the opposite of its job. | Whether the exemption should be replaced by an assertion that a stored id matches its derived form. |

## 12. Baselines

Filled by Phase 0 (gates) and Phase 18 (performance). A later phase that re-runs a gate and gets a
different result records both, with the SHA.

### 12.1 Gates (Phase 0)

All run in the primary checkout, which was clean at the pinned SHA `9924e6a7`.

| Gate | Command | Result at SHA | Notes |
| --- | --- | --- | --- |
| Type-check | `npm run type-check` | pass | all three tsconfigs (app, bridge, extension) |
| Lint | `npm run lint` | pass | exit 0 with **38 warnings**; `eslint .` carries no `--max-warnings`, so the accepted baseline is unpinned. 37 are `react-refresh/only-export-components`; the 38th is an unused `eslint-disable` at `LookupMatchDialog.tsx:74` |
| Format | `npm run format:check` | pass | "All matched files use Prettier code style" |
| Unit suite | `npm run test:run` | pass | 800 files / 12448 tests / 82.34 s. One intermittent failure under full-suite load (`CategoryLookupPanel.test.tsx:429`) passed in isolation in 2.24 s and on a clean re-run |
| Bridge suite | `npm run test:bridge` | pass | 79 files / 1191 tests / 7.73 s |
| Bridge smoke | `npm run smoke:bridge` | pass | both `mcp.mjs` and `serve.mjs` boot; 6 tools; `/health` reports `itemCount=4` |
| Build | `npm run build` | pass | precache **209 entries (6197.30 KiB)**, of which 205 unique URLs — 4 icons are listed twice and `src/sw.ts` de-duplicates them deliberately. Two chunks exceed Vite's 500 kB warning |
| Bundle check | `npm run check:bundle` | pass | reports `6108.38 KiB across 201 precache files`, which is **wrong** — see #719 |
| Browser smoke | `npm run test:e2e` | **fail (exit 1)** | 125/125 steps passed, 0 console errors, **4 page errors** (`AbortError: Transition was skipped`, one per browser context). Driven against a dev server on port 5231. See #735 |
| Wiki check | `npm run wiki:check` | pass | 98 pages, 44 images |
| Lockfile | `npm run lock:check` | pass | "Lockfile OK — `npm ci` accepts it". **Needs no Docker** — `--check` only runs `npm ci --dry-run`; the "needs Docker" note above was wrong and is corrected here |
| Extension build | `npm run build:extension` | pass | built to `extension/dist` |
| `npm audit` | `npm audit` | pass | 0 vulnerabilities |
| `npm outdated` | `npm outdated` | 20 behind | none blocking; `typescript` 6.0.3 vs 7.0.2 and `eslint` are the #186 / #401 boundaries |

### 12.2 Performance (Phase 18)

| Surface | Seed | Throttle | Measurement | Plan / trace summary |
| --- | --- | --- | --- | --- |

## 13. Change log

| Date | Phase | Change |
| --- | --- | --- |
| 2026-08-30 | — | Plan written. Twenty phases (0–19) partition every tracked path; no phase started. |
| 2026-08-30 | 0 | Phase 0 run and landed at pinned SHA `9924e6a7`. 54 candidates: 38 confirmed, 11 rejected, 3 unverifiable, 2 duplicates of existing issues. The 38 confirmed became 31 issues (#719–#749) — seven were folded into a sibling issue rather than filed alone, because they shared a root cause and a fix. §12.1 baselines recorded — every gate passes except `npm run test:e2e`, which is itself finding #735. Coverage check run: four sub-top-level paths assigned (see §8), two deliberate overlaps left. Corrected §12's claim that `lock:check` needs Docker. |
| 2026-08-30 | 1 | Phase 1 run and landed at pinned SHA `16ef2e07`. 77 candidates: 46 confirmed, 30 rejected, 1 unverifiable, 0 duplicates of existing issues. The 46 confirmed became 34 issues (#750–#783) — twelve were folded into a sibling issue sharing a root cause, and six unguarded parity claims were filed as one sweep (#775) following #254's precedent. Six finder units and twenty-six verifier passes ran. Notable: #764 is a regression against #164 and #172 (the index those added has never been chosen); #774 rose to `data-loss` when a second symptom showed the archive discards the attribution before pruning; #778 was reframed from a driver-fidelity claim into an unbounded-money-write defect. Eight carry-over entries added to §11, including one candidate (the ledger's missing `(created_at, id)` index) that arose while disproving another and has had no verification pass of its own. |
