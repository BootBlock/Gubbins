# Full codebase audit — phased plan and findings register

> **Status:** 🟢 ACTIVE — Phase 0 (baseline and tooling) in progress.

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
| 0 | Baseline, build, tooling, CI and repository configuration | `package.json`, `package-lock.json`, `tsconfig*.json`, `vite*.config.ts`, `vitest.*.ts`, `eslint.config.js`, `prettier.config.js`, `components.json`, `index.html`, `public/`, `scripts/`, `.githooks/`, `.github/`, `Dockerfile`, `docker/`, `docker-compose.yml`, `Run.bat`, `Run.ps1`, `hacs.json`, `.gitignore`, `.gitattributes`, `.dockerignore`, `.editorconfig`, `.env.example`, `.git-blame-ignore-revs`, `.nvmrc`, `.prettierignore`, `vitest.timeouts.ts`, `LICENSE`, `bridge/{package.json,Dockerfile,tsconfig.json,vitest.config.ts,*.mjs}`, `extension/{build.mjs,tsconfig.json,manifest.json}` | **in progress** | | | | |
| 1 | Database engine, driver, migrations and shared repository seams | `src/db/*.ts`, `src/db/worker/`, `src/db/rpc/`, `src/db/migrations/`, `src/db/search/`, `src/db/repositories/{base,mappers,constants,like,tombstone,text-limits,name-lookup,location-count,receipt-guard,reservations,stock,stock-batches,supplier-cost-sql,checkout-plan,gauge,location-history,index}.ts`, `src/db/repositories/types/`, `src/test/` | not started | | | | |
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

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

### Phase 1 — Database engine, driver, migrations and shared repository seams

Pinned SHA: _not started_

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |

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

## 12. Baselines

Filled by Phase 0 (gates) and Phase 18 (performance). A later phase that re-runs a gate and gets a
different result records both, with the SHA.

### 12.1 Gates (Phase 0)

| Gate | Command | Result at SHA | Notes |
| --- | --- | --- | --- |
| Type-check | `npm run type-check` | | |
| Lint | `npm run lint` | | |
| Format | `npm run format:check` | | |
| Unit suite | `npm run test:run` | | files / tests / duration |
| Bridge suite | `npm run test:bridge` | | |
| Bridge smoke | `npm run smoke:bridge` | | |
| Build | `npm run build` | | precache entries / KiB |
| Bundle check | `npm run check:bundle` | | |
| Browser smoke | `npm run test:e2e` | | steps / console errors |
| Wiki check | `npm run wiki:check` | | |
| Lockfile | `npm run lock:check` | | needs Docker |
| Extension build | `npm run build:extension` | | |
| `npm audit` | `npm audit` | | |
| `npm outdated` | `npm outdated` | | |

### 12.2 Performance (Phase 18)

| Surface | Seed | Throttle | Measurement | Plan / trace summary |
| --- | --- | --- | --- | --- |

## 13. Change log

| Date | Phase | Change |
| --- | --- | --- |
| 2026-08-30 | — | Plan written. Twenty phases (0–19) partition every tracked path; no phase started. |
