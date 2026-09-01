# Full codebase audit — phased plan and findings register

> **Status:** 🟢 ACTIVE — Phases 0–5 complete; Phase 6 (Foundry primitives and shared components) is next.

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
| 2 | The item repository family | `src/db/repositories/ItemRepository.ts`, `src/db/repositories/item/`, `ItemRepository.*.test.ts`, `serialised-placement.test.ts`, `batched-item-reads.test.ts`, `*-parity.test.ts` | complete | 56 | 33 | 10 | 1 |
| 3 | Every other repository | remaining `src/db/repositories/*Repository.ts` and their tests, `src/db/repositories/project/`, `permissions.enforcement.test.ts`, `wishlist.test.ts`, `revaluation.test.ts`, `item-relations.test.ts`, `tare-presets.test.ts`, `test-record.test.ts` | complete | 110 | 52 | 33 | 3 |
| 4 | Data integrity: sync, backup, archive, storage, danger zone | `src/features/sync/`, `backup/`, `archive/`, `storage/`, `danger-zone/`, `clock-skew/`, `events/`, `src/lib/{save-file,download,read-all-pages}.ts` | complete | 64 | 40 | 14 | 1 |
| 5 | App shell, platform and shared libraries | `src/{main,App,sw,csp,base-path}.ts(x)`, `src/app/`, `src/routes/`, `src/routeTree.gen.ts`, `src/state/`, `src/lib/` (all), `src/lib/env/`, `src/styles/index.css`, `src/features/{errors,hotkeys,modules,i18n,not-found,lab,about,achievements}/`, `src/components/{OfflineIndicator,PwaUpdatePrompt,useConfirmSaved}.tsx`, `public/recovery.js`, `public/coi-bootstrap.js` (runtime behaviour) | complete | 112 | 55 | 31 | 1 |
| 6 | Foundry primitives and shared components | `src/components/foundry/`, `src/components/background/`, `src/components/nav/`, `src/components/icons/`, `src/components/Brand*.tsx` | **in progress** | | | | |
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

Pinned SHA: `9072d22073d7821f9161292c4734ddb8e87054ab`

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| P2-1 | Mechanical | `src/db/repositories/item/core.ts:617-628` | The unlimited-supply guard tests the **pre-update** tracking mode, so a Bulk→Untracked conversion of an unlimited item hits the raw CHECK | confirmed | #798 | Severity corrected to `degraded` — the transaction rolls back atomically, so nothing is wrong-data. Reachability corrected the other way: `ItemDetailsEditor` carries **both** controls and reads the checkbox's applicability from the *saved* mode, so it is a two-click path, not the latent hole the finder claimed. The raw text never reaches the screen: a CHECK abort inside a transaction returns `TRANSACTION_FAILED` (`UNKNOWN` in the worker) and both fall through to call-site copy. The three sibling guards are safe by construction — CONSUMABLE_GAUGE is never convertible — which is why the defect is singular. Unit 7 found the same root cause independently, as a coverage hole in `tracking-mode.test.ts` |
| P2-2 | Performance | `src/db/repositories/item/core.ts:199-210` | `findByBarcode` never uses `idx_items_barcode`; the planner takes `idx_items_is_active` and scans | confirmed | #764 (comment) | **Not filed separately — root cause is #764's verbatim.** 82× on the shipped `sqlite-wasm` engine at 50k, ratio 140/1922/6729× at 5k/50k/200k, identical plan on a hit and a miss. Attribution corrected: the `is_active = 1` term alone causes it; removing the `ORDER BY` changes nothing. Four candidate resolutions were applied and measured — **V2 and V3, the composite shapes #764 steers toward, leave it unchanged or worse (6.37 ms)**; only dropping the boolean index or a partial index without a leading equality fixes it. That constraint and the false comment at `v1-initial.ts:1192-1194` were added to #764 |
| P2-3 | Performance | `src/db/repositories/item/core.ts:226-236` | `findByShortCode` matches with `id LIKE ? \|\| '-%'`, which SQLite can never index | confirmed | #800 | **Survives #764**: 0.87–1.15× under its lever, the plan merely degrading to `SCAN items USING INDEX idx_items_name`. Two independent blockers proved separately — the concatenation blocks indexing under any pragma, and the collation blocks it independently (`LIKE` is case-insensitive, `items.id` collates BINARY), so a JS-side concatenation alone would not fix it. `GLOB` and an explicit range both work. 22/321/1406× at 5k/50k/200k; 62× on the shipped engine. Caveat recorded in the issue: the range rewrite assumes lower-case ids, true of every id the app mints but unchecked |
| P2-4 | Functional | `src/db/repositories/item/create.ts:118-126`, `item/gauge.ts:150-153` | `unit_of_measure`'s length CHECK is mirrored by no guard | confirmed | #799 | `operational_metadata` folded in — same root cause, two columns, both bypassing `normaliseText`. Residue of **#346**, which added the CHECKs and wired the guard into the normaliser. Reachability confirmed rather than assumed: the Foundry `Input` deliberately sets no native `maxLength`, so 501 characters are enterable and are sent. Impact lower than claimed — the gauge editor warns inline first, then leaves Save enabled |
| P2-5 | Performance | `src/db/repositories/item/core.ts:344-345` | `createMany` fans out one `getById` per created item | confirmed | #801 | **Two of three limbs disproved.** The thumbnail is NULL on this path, and `getManyById` projects it too, so it is not a differentiator; and P1-54's 0.0425 ms round-trip figure is for a *sequential* loop — `Promise.all` pipelines at ~0.005 ms, 5× less. What survives is stronger than the batch-shape claim: **neither production caller uses the rows** (`LabScreen.tsx:373` does not even assign the return). ~40% on top of the whole operation at any N. `cycle-count.ts:32-46` already documents the chunking policy (#561) this asks for |
| P2-6 | Mechanical | `src/db/repositories/item/core.ts:344-345` | `createMany` promises input order but `.filter()`s absent reads out | confirmed (latent) | #801 | Filed with P2-5 — one fix removes both, and splitting them invites a batch-shape fix that leaves the filter in place. Mechanism proved (row B's tags land on item C, row C's are dropped, the run reports success). **No reachable trigger**: `getById` filters on nothing but the id, the insert has no `OR IGNORE`, no trigger deletes items, the bridge cannot reach the browser's file, the tab lock forbids a second writer. The present-tense consequence is that `catalog-import.ts:1852`'s missing-item branch is written against a shape the method never produces |
| P2-7 | Functional | `src/db/repositories/base.ts:173-176` | `hasMore` reports false truncation at an exact page boundary | rejected | — | The published integrator contract says `hasMore` is "True when a further page **may** exist", and `ReportRepository.test.ts:2487-2496` pins that with a comment reasoning about the exact-boundary case by name. Eight sites document it; consumers needing certainty pair it with a `COUNT` (#606). The picker's copy is literally true and asserts nothing about a remainder. The `limit + 1` fix is not simple — 40 `toPage` call sites plus the published OData paging semantics |
| P2-8 | Prompt | `src/db/repositories/item/core.ts:791-803` | `softDelete` bypasses the storage Hard Stop as a "deletion that frees space"; it frees none | confirmed | #802 | Measured: 200 removals grew `page_count` 324→339 (+61 KiB) with the free list unmoved and 200 permanent ledger rows added; 200 hard deletes released 89 pages. **`hardDelete` has zero production callers**, so this is the only per-item removal the app offers, and `Storage-Triage.md:61-62` promises it reclaims space. A 14-site sweep shows `softDelete` is the only method in the repository claiming the exemption while appending — nothing to hand Phase 3 |
| P2-9 | Functional | `src/db/repositories/item/stock.ts:349-369` | `adjustQuantity` validates against the grand total but draws from the home placement only | confirmed | #784 | The state is the **intended outcome of the shipped split-stock feature** — `transferStock` deliberately leaves `items.location_id` alone and nothing re-homes an emptied placement. Both ledgers disagree and both sync: `stock_deltas` nets to 5, `item_history` records −8. The UI snaps back with no toast. **No Prompt limb** — the MCP description does say "at its home location". `drawTooWideToLand` (from #592) already guards one of the three callers |
| P2-10 | Functional | `src/db/repositories/item/stock.ts:291` | `transferStock` discards an explicitly chosen untracked lot and draws FEFO instead | confirmed | #786 | Separate from P2-9 — no shortfall arises; it draws the *wrong units*. Reachability proved by driving the real control: it offers "Untracked (5)", caps the quantity at 5 and sends the key. Worse variant found: where the tracked lot is smaller, it is emptied outright. `sell` and `checkout` both honour the same key — driven. One line to fix |
| P2-11 | Performance | `src/db/repositories/item/cycle-count.ts:445-451` | `loadTouched` re-reads every touched item with the full projection | confirmed | #809 | **Severity corrected to `cosmetic`.** It is 2.2% of `authoriseCount` (15.9 ms of 721 ms), which is dominated 78:1 by its own write. Two framings corrected: the read issues once per non-empty list, not three times; and the list is bounded by *drift*, not sheet size, so a clean count reads nothing. A photo-less inventory pays literally nothing (0% coverage measured identical). Real: 12.4 MiB read, structure-cloned with no transfer list and retained by `rowToItem`, entirely unread. Residue of #529 |
| P2-12 | Mechanical | `src/db/repositories/project/assembly.ts:310`, `item/kits.ts:613` | The gauge floor is not recognised by the draw seam's message translation | confirmed | #813 | **The "raw DDL reaches the screen" limb is disproved** — the code is `TRANSACTION_FAILED`, `describeDbError` returns `undefined`, and the raw-text marker blocks it, so the user sees call-site copy either way. **Widened**: the finder said one unclamped gauge write; there are two, and the kit one is repeatable rather than one-shot. The race is a single-user double-tap, not the second device the finder posited. Root cause is Phase 1's `stock-batches.ts`; the two sites are Phase 3 and Phase 7 |
| P2-13 | Functional | `src/db/repositories/gauge.ts:171-183` | Attrition is applied only in the gauge adjust dialog | rejected | — | **#89's research comment scopes it by surface**, verbatim: "Resolve it in the React layer, not the repository… **It must not go into the batch-consumption layer**, which has no idea why stock is moving and would silently tax transfers and reconciles too." The divergence reproduces (dialog 390, bridge 400, BOM 400) but is the designed behaviour. The MCP tool describes a raw delta and claims no attrition, so no Prompt limb either |
| P2-14 | Prompt | `src/db/repositories/item/stock.ts:220-249` | `listSerialisedAtLocation`'s docstring claims a seek; the plan scans | duplicate #764 | — | Duplicate of **#764** — same mechanism, reproduced (21× on dropping the boolean index), and inside #764's stated 54-statement population. The docstring's "only the rows the sheet renders" is in strict parallel with "only the three columns it shows", so it is a claim about the **result set**, which is true and demonstrated. Unlike the two comments #764 already flags, it asserts nothing about a plan. The other four `stock.ts` location docstrings were swept: clean |
| P2-15 | Functional | `src/db/repositories/item/kits.ts` (whole file) | Kits treat an unlimited-supply component as finite stock | confirmed | #792 | `grep -c is_unlimited kits.ts` = 0. Both halves reachable: a fresh unlimited item has quantity 0, so the kit reads "0 buildable"; and an unlimited item **can** hold stock — a committed test asserts the toggle is lossless. The Phase 82 plan's own semantics table states the intended behaviour, and the word "kit" appears zero times in it — an omission, not a decision. `assertDiscreteKit`'s false docstring folded in. Finder's `∞` claim corrected: the kit editor shows the raw integer |
| P2-16 | Functional | `src/db/repositories/item/variants.ts:37-45` | Adding a variant to an item holding stock strands it | confirmed | #787 | #155 and #156 are both read-side; `ReportRepository.ts:211-216` justifies the **read** predicate and records nothing about the write. **There is no UI path to un-parent** — `useSetParent` and `hardDelete` have no callers outside tests, the Variants panel has no detach control, and P2-22 means archiving the last variant does not restore the parent. The three-level chain is reachable through `createVariant` alone, contrary to the finder's `setParent` attribution. No app string states the rule |
| P2-17 | Functional | `src/db/repositories/item/kits.ts:683-700` | `assemble` screens tracking mode over the whole graph, not the plan's draws | confirmed | #793 | The conservative-by-design defence **fails**: with `cascade: true` the plan still never draws the offending item. A DISCRETE control with 0 stock assembles fine, proving it is the mode not the stock. The two unguarded parity claims (`kits.ts:22-24`, `kit-availability.ts:55-61`) stay **in** this issue — C17 is the counter-example that makes them false, so the drift test the rule asks for is the same test. Neither is among #775's six |
| P2-18 | Performance | `src/db/repositories/item/kits.ts:409-423,585-604` | `readKitGraph` and `preload` are two N+1 loops | rejected | — | Counts reproduced exactly (42 reads to render a 40-component kit, 85 to assemble). Rejected on measured cost, on the precedent of **P1-54**, which rejected the identical shape at the identical magnitude: 1.79 ms desktop / 17.9 ms phone at 40 components. The wiki's own worked kit has **four** components (0.30 ms). Decisively, the finder's proposed fix is a wash — the CTE shape it names costs 1.85–1.90 ms of SQL against the 1.70 ms of round trips it removes, and gets worse as `kit_components` grows. #70 is not the precedent claimed (a feature request naming no performance concern) |
| P2-19 | Functional | `item/{relations,capabilities,kits}.ts` | Child-table edits record nothing in `item_history` | confirmed (narrowed) | #804 | **Narrowed from five families to three.** The alias limb is false — the method with no log entry has no caller; the path the app uses writes `SCRAPE_APPLIED`. The variant re-parent limb is latent — no caller outside tests. Two supporting limbs disproved: the wiki's exemption list is explicitly open ("and more", "A few things change quietly"), and where it *does* close a list it says so, as it does for locations; and #144 is `enhancement`-labelled and scoped to the `items` row. The real precedent is **#691**, the same shape accepted and fixed for locations |
| P2-20 | Functional | `src/db/repositories/item/relations.ts:145-146` | A relation's note is stored, never shown, and discarded on re-add | confirmed | #805 | Grep widened to exports, sync and the bridge: exactly one other reader exists, and it is the dedupe merge *preserving* it. Finder's success-toast claim corrected — there is no toast; both fields clear and the list refreshes, which reads as acceptance without claiming it. Filed as one issue: the discard only bites because nothing renders the note for the user to notice |
| P2-21 | Functional | `src/db/repositories/item/aliases.ts:190-203` | `findByMatchKey` matches archived items and picks arbitrarily among duplicate MPNs | confirmed (as two) | #790, #791 | Found independently by units 5 and 3. Filed as two: the archived scoping is two SQL strings with a precedent in the sibling lookups; the identity question needs the method's signature and both importers' UX to change. **A stronger finding emerged**: matching on the part number alone ignores the manufacturer, and fires with **no duplicate present at all** — the app's own dedupe tool keys the same identity by manufacturer *and* part number and says the two rows are different parts. #593 read `findByMatchKey` and left it alone on the *fold* axis only |
| P2-22 | Functional | `item/attention-sql.ts:44-46`, `item/variants.ts:20-28` | "Variant parent" counts archived children | confirmed (as two) | #788 | Filed as one issue with two named halves. Trigger pinned precisely: ALL children archived; one-of-two is correct. The restore-symmetry defence was **run**, not argued — A→B→C→D is exactly self-inverting and state D is byte-identical to state B, so no double count is possible. Under current behaviour case C values a family that holds stock at £0. `stock-attention-parity.test.ts` is structurally blind: both sides descend from the same definition, so they agree while both being wrong |
| P2-23 | Functional | `src/db/repositories/item/search.ts:180-184` | `searchByAst`'s offset path drops the favourites-first lead | confirmed | #797 | The second leg (missing id tiebreak) was **dropped as not demonstrated**: `itemOrderByClause` does append the tiebreak, and four attacks on the bare fall-through — 5k/20k rows fully tied on every term, eleven forced access paths, varied page depths — all produced a stable order. Marked in §11 as needing the real browser engine to settle. The finder's export-integrity hypothesis was **disproved** — the CSV export always seeks. A different inconsistency was found: three orderings across one bridge endpoint family |
| P2-24 | Prompt | `src/db/repositories/item/search.ts:127-140` | The relevance weights are positional against the FTS column order, with no drift test | confirmed | #816 | The finder's own escape hatch — that a column swap "IS caught by luck" at the relevance test — was **disproved**: 1829/1830 pass with `name` and `description` weights exchanged, and the one failure is the golden-schema gate that the change requires you to regenerate anyway. `bm25()` given fewer weights than columns raises no error and silently defaults the rest — proved standalone. Residue of #248, which locked the column *list* and left this fifth consumer of the order out. Carries **P2-56** |
| P2-25 | Mechanical | `src/db/repositories/item/search.ts:114,257,266` | `searchByRelevance` accepts an offset and ignores it | confirmed | #814 | `cosmetic`. No caller passes one, and neither the bridge nor the extension references the method or its type, so no integrator can reach it. Filed on the "future maintainer" limb: the type is public API, the method already reports how many matches sit behind the ones it returns, and the neighbouring method documents its own omissions where this one is silent |
| P2-26 | Performance | `item/search.ts:255-270`, `ItemPicker.tsx:97-102` | Relevance search scores the whole match set; the picker fires it per keystroke | confirmed (narrowed) | #808 | **One limb rejected**: scoring the whole match set is the documented point of the read (#629). Two survive. The *projection* over the whole match set is not required — deferring it past the limit is behaviour-identical and 1.5–2.1× faster. And the picker genuinely issues one search per keystroke: driven in the real component, "resistor" produced 8 searches, no gate, no debounce, no dedupe across prefixes — against the command palette's 200 ms debounce 30 lines away. Residue of #484 |
| P2-27 | Performance | `src/db/repositories/item/aliases.ts:196-203` | The alias arm scans all of `item_aliases` on every call | rejected | — | Measurement reproduced (22 ms at 100k rows, ~10,800× the indexable shape), but the premise fails: **there are exactly two writers, both per-item and dialog-gated**, and the scrape adds at most one alias per apply. No bulk path exists — not the catalogue importer, not the bridge, not a script. 100k rows needs 100k dialog confirmations. At a reachable 500–2,000 aliases a 200-line import costs 25–55 ms. Anti-correlated with its own worst case: the scan runs only when the MPN arm misses, which correlates with a small catalogue. §11 carries a note for whoever adds a bulk alias path |
| P2-28 | Functional | `src/db/repositories/item/dedupe.ts:286,290` | The duplicate-name advisory compares SQLite `LOWER()` against `foldName()` | confirmed | #794 | The docstring's "honest limit" concession is about *differing prefixes*; here the strings are identical and the first two characters ASCII, so it does not reach the case. **Threshold measured: 200 rows** sorting ahead within the two-character prefix — below that the prefix arm still returns the row, so the miss appears only as a catalogue grows. The docstring's parity claim at `:267` is directly falsified: the tool groups the pair, the advisory reports zero. Fresh site of the **#342** class. Fix needs no scan — the non-ASCII case belongs in the ranking key only |
| P2-29 | Performance | `src/db/repositories/item/feeds.ts:354-378` | `idx_items_warranty` is never chosen; the warranty feed and count scan | confirmed | #764 (comment) | **Not filed separately.** Applying #764's own prescription cures it outright — the index is already the right shape. It is a *fourth* affected index, conditional on the warranty date rather than the active flag, so outside #764's enumeration. Three of the finder's claims corrected: only the export walks page-by-page, not the alert centre; the agenda's since-bound cuts the walk to 6 pages at 50k, not 18; and the whole-walk ratio (4.1×) is half the single-page one (7.6×) because the indexed walk still pays the offset |
| P2-30 | Functional | `src/db/repositories/item/revaluations.ts:57` | `recordRevaluation` overwrites `current_value` unconditionally | confirmed | #795 | No upper bound on the date, no clamp, no schema between the control and the write — backdating is the field's purpose. Both figures appear in one panel. Driven through the real reports: the insurance schedule prices the item at the backdated figure. **Second reachability path with no backdating at all**: revaluations sync last-write-wins, so an out-of-order arrival does the same |
| P2-31 | Mechanical | `src/db/repositories/item/dedupe.ts:373-379,592-593` | `mergeItems` re-points loans and bookings plainly, breaking two cardinality rules | confirmed | #789 | Reachability is the *common* case, not an edge: the duplicate scan never reads the tracking mode, and two units of one model pair on name, barcode and MPN even with different serial numbers. The dialog collapses twelve reference kinds into one integer, so an open loan is indistinguishable from a PO line. **The sync repair makes it worse, and is not conditional on a peer conflict** — driven against an empty peer, it stamps a real loan as returned at the instant it was taken out and cancels a real booking. #193/#194/#542 all scope the cause to two devices; this is a fourth route needing one |
| P2-32 | Functional | `src/db/repositories/item/history.ts:99` | The clear-history delete is unbounded while the guard skips only strictly older rows | confirmed | #796 | Driven end to end through the real merge, not the arithmetic alone. Every premise attacked: timestamps are never frame-shifted (`item_history` is not even in the shifted section), nothing clamps an incoming stamp, and the only trigger on the table fires on UPDATE. The clock-skew feature corrects the evaluation clock only. Permanent, not transient — the peer never deletes its copy either. Window is the peer's lead: under 2 s ignored, under 5 min unwarned, under a year unrejected. The global prune pair agrees with itself, so this is not a `<`/`<=` mismatch — the delete simply has no time bound |
| P2-33 | Prompt | `src/db/repositories/item/feeds.ts:250-267,367-380` | The counts take no `since`; the named parity test never passes one | confirmed | #811 (comment) | Folded into P2-41's issue — same file, same cause (the suite does not drive what its description claims), one fix. The word does not appear in the file at all. Driven with the bound supplied, both lanes diverge 2 vs 1. No caller pairs them that way today, so nothing is wrong for a user; the docstring's "can **never** answer different questions" is false, and the Upcoming agenda is the screen that uses the bound |
| P2-34 | Functional | `src/db/repositories/item/revaluations.ts:76-85` | `listRevaluations` returns a bare array capped at 50 | confirmed | #815 | **Two of three symptoms false**: the editor's trend arrow and percentage come from the item's own current and purchase prices, not the series, and the reports' sparkline uses a different, uncapped read. What survives is one misstated accessible label plus a latent seam. Reach needs 51+ manual submissions — no bridge, import, script or backup path writes revaluations |
| P2-35 | Mechanical | `src/db/repositories/item/list-order.ts:133,148-154` | A backward seek renders NULLs at the wrong end | confirmed | #785 | Found independently by unit 2 and by the lead. Re-derived through the real repository rather than the finder's transcription, with the offset path as ground truth and both a not-null control and a default-order case. **Exactly four of eight combinations fail, all ascending**; the four descending ones and the default order are correct, and the mechanism explains why. The finder's `serialNo` case nearly passed vacuously — `serialNumber` and `serial_no` are different columns — and needed re-seeding. Every link of the reachability chain was verified separately. `searchByAst` and the bridge are forward-only and unaffected |
| P2-36 | Prompt | `src/db/repositories/item/attention-sql.ts:35` | The comment's "~4× faster" contradicts a recorded measurement saying the opposite | rejected | — | **The comment is defensible and the finder's counter-measurement was of the wrong shape.** Rebuilt the pre-#168 fragment from history: every *count* shape lands at 2.26–2.96×, reaching 3.97× at higher variant-parent density; #168's own commit records 66→15 ms for the low-stock count, the same family as my 58→20 ms. The finder's 1.28× is the *list page* shape. All the comment's other claims hold verbatim, including both plans and the NULL-semantics footgun. The disagreeing record is in the maintainer's private vault, outside the audit's scope — carried to §11 |
| P2-37 | Performance→Prompt | `src/db/repositories/item/status-filter.ts:76-87` | Since #684 added `expiring`, the split applicability query's cost premise is inverted | confirmed (reclassified) | #807 | **Reclassified by its own numbers**: the split still avoids 45% (50k) / 52% (200k) of a tap's work, so nothing is slow that would otherwise be fast — four comments are simply false. Measured before and after #684's change in isolation: the skipped half *was* 1.83× the recomputed one and is now 0.74×. A **fourth** false comment was found that the finder missed. Moving `expiring` to a third key is not the fix — it is correctly stock-dependent; the cost is the expression, which is #806 |
| P2-38 | Prompt | `src/db/repositories/item/list-order.ts:101,115-117` | The claimed parity with `itemOrderByClause` has no drift test | confirmed | #816 | The brief's rejection condition fired — `sql.test.ts` goes red — but that file is a **restatement of the implementation**, four hard-coded strings, not a comparison. With those four literals updated in the same breath, as any maintainer would: **798 files / 12410 tests green** with one builder placing NULLs first and the other last. `keyset-pagination.test.ts` compares the two walks as a *multiset*, so it cannot see an ordering difference. `itemOrderByClause` has exactly one production consumer, and `searchByAst` picks between the two builders inside one method — one of those paths is the bridge's CSV export |
| P2-39 | Prompt | `item/status-filter.ts:2-4`, `InventoryFilterBar.tsx:19-20`, `item/core.ts:113,962` | Three doc comments enumerate five status filters; there are eight | rejected | (folded into #807) | Staleness confirmed as fact, and git shows it *is* a maintained enumeration — #88 edited that exact clause to insert its own status, so the three from an earlier change were simply never added. Rejected on consequence: the authoritative list sits a few lines below in every case, nothing but a human reads it, and §3.1 rejects a defect with no consequence. Contrast **#559**, the same class *with* teeth. The two `core.ts` sites are glosses that defer to the SSOT and should not be touched. Folded into #807 as a free correction, on the verifier's own recommendation |
| P2-40 | Mechanical | `ItemRepository.history-feed.test.ts:207-214` | The index guard restates the SQL by hand, so it cannot fail | confirmed | #810 | The finder's mutation is caught **by accident and only sometimes** — 4 red in 10 runs, because a random tie-break column randomises order within a same-timestamp group. The decisive mutation is order-preserving (`+h.created_at`): 16/16 green three times, 86 files / 1582 tests green, while the plan degrades to a temp b-tree and the read goes 0.064 → 18.381 ms at 100k entries — **287×**, the #524 behaviour restored. No other test in the repository asserts a query plan |
| P2-41 | Mechanical | `attention-count-parity.test.ts:56,91,116` | Parity cases seed no removed item, so a count losing its active scope passes | confirmed (broadened) | #811 | **Three of five cases, not two** — the maintenance-due case was missed by the finder. Each mutation left the parity file *and* the whole 82-file suite green; the one case that does seed a removed row goes red under the identical edit. `softDelete` appears once in the whole 193-line file. Tests outside the file were run under the mutation and also passed. The fifth case needs nothing: neither its count nor its feed applies the scope, so they agree by construction |
| P2-42 | Prompt | `item/normalise-db-check.test.ts:43-53` | `PAIRINGS` covers 9 of ~16 CHECK-constrained columns; the gauge block and attrition are unguarded | rejected | — | **The load-bearing triage is false.** Deleting the gauge guards turns `ItemRepository.test.ts:482-497` red — it drives `reconfigureGauge` with a zero capacity, a negative tare and a whitespace unit and asserts the *friendly* refusal. Widening the attrition guard past the CHECK turns three tests red, one of them precisely because the raw text reached the caller. The CHECK side cannot drift silently either: the golden schema snapshot changes on any CHECK edit. "This test could cover more" does not clear the bar |
| P2-43 | Prompt | `src/db/repositories/ReportRepository.ts:1423-1435` | `outOfStockCount` restates the SSOT predicate inline | rejected | (rider on #816) | Neither limb of the rule fires: the duplicate carries **no parity comment**, and both sides are individually pinned (each mutation goes red). The one parity claim in play is on the SSOT, and it is true and held up by `stock-attention-parity.test.ts`, which drives both sides over a shared dataset rather than comparing text. The substitution was nonetheless verified — 280 files / 4766 tests green, type check clean — so the copy is provably redundant and is carried as a rider |
| P2-44 | Mechanical | `batched-item-reads.test.ts:126,155,196,236` | Tests named for a round trip they never assert | confirmed (narrowed) | #812 | **Four of five sites, not five.** The finder's premise about an empty `IN` list is wrong — SQLite permits it — so all four guards delete with the whole suite green. The fifth is **rejected**: removing it produces an empty select list, which *is* a syntax error, so that test does hold its property up indirectly and must not be "fixed" |
| P2-45 | Mechanical | `v1-initial.ts` `item_history.actor_user_id` | The DEFAULT names a `users` row that need not exist | rejected | — | A harness artefact. The sentinel is seeded by the same baseline migration that creates the table, on every path: fresh install, bridge hydration (which migrates before loading a snapshot), and restore (the two principals are declared always-present and deliberately excluded from snapshots). It cannot be deleted either — a trigger aborts a delete of the built-in users, proved at both the driver and the repository. The observation came from building the schema out of the DDL-only snapshot fixture, which carries no seed rows |
| P2-46 | Functional | `features/inventory/item-total-value.ts:34-42` | The card's value seam excludes unlimited items but not variant parents | duplicate #787 | — | Already covered by **#787**, which names this exact symptom in its body and takes the opposite remedy ("fix the write, not the read"). The Prompt limb is false: the docstring claims parity for the *unlimited* case only and the file header states it deliberately differs from the reports' seam. The proposed fix also does not compose — the same card renders quantity with no such gate, so it would read "Quantity 10 / Total value —". #156 aligned an attention *verdict*, not a fact about the row |
| P2-47 | Prompt | `src/db/repositories/item/stock.ts:512-513` | "(mirrors `CheckoutRepository.checkout`)" is untested, and the third copy has drifted | confirmed | #816 | The strongest of the three in the sweep. Driven over one dataset: `sell`, `writeOff` and `checkout` all honour an explicitly chosen untracked lot; `transferStock` does not (that drift is P2-10 / #786). Making `checkout` — the seam the comment names — collapse the same value leaves **10232/10232 green, zero red**. The value is a documented member of all three public input types with no test behind it anywhere. The test the comment asks for fails on the transfer path the day it is written, which is the rule's own justification demonstrated on live code |
| P2-48 | Functional | `item/core.ts:791` vs `:807` | At the paused storage tier, removal succeeds but its Undo is refused | confirmed | #803 | Found while verifying P2-8. The asymmetry is deliberate; the consequence is not. Driven in one repository with saving paused: the restore is refused and all 200 removals succeed, while the toast offers the action unconditionally. No storage-tier gate exists anywhere in the inventory feature |
| P2-49 | Functional | `item/test-records.ts:100-108` | `removeTestRecord` is gated on `items:write` where an audit trail arguably warrants `audit:delete` | rejected | — | Driven with a real Purchaser role, which is exactly the shape the concern needs: the record is removed but the ledger the `audit` subject is *defined over* keeps its `TESTED` entry, and `clearHistory` is genuinely refused to that role. Creating a test record is `items:write` too, so gating removal higher would let a role write a record it could never correct. `removeRelation` and `removeKitComponent` behave identically — the pattern, not a drift |
| P2-50 | Functional | `features/danger-zone/erase-targets.ts:308-313` | The Danger Zone history erase advances the watermark only to "now" | confirmed | #796 | Found while verifying P2-32; filed with it, since they share a root cause and a reader of one needs the other. Driven through the real erase target and the real merge. Note that `history-watermark-parity.test.ts:81-110` *demonstrates* the gap rather than catching it — it deliberately seeds two future-stamped rows, asserts the table is empty, and never checks the guard against the watermark it just wrote |
| P2-51 | Mechanical | `src/features/sync/reconcile.ts:772` | The post-merge serialised-loan repair is gated on the tracking mode, so a local merge of two single-unit DISCRETE duplicates leaves two open loans that neither the write path nor the repair touches | unverifiable | — | Raised while verifying P2-31 and never given a pass of its own. #542 raised the same filter as too tight for bookable single-unit DISCRETE assets and was closed by giving booking conversion a derived id rather than widening it — which addresses the two-device race but not a local merge, and unlike the serialised case a DISCRETE loan does move stock. What would settle it: a decision on whether two open loans on a single-unit DISCRETE item is an invariant violation at all, then the same merge reproduction P2-31 used |
| P2-52 | Performance | `src/db/migrations/v1-initial.ts:1441` | `idx_items_expiry` is used by no query | confirmed | #768 (comment) | **Not filed separately** — it belongs in #768's existing list, and is a different index from the `stock_batches` expiry index already named there. Stronger than "unused": since #684 the engine **refuses to be forced onto it**, because no expiry read mentions the column in an indexable position. The search layer's `expiry:` predicate never picks it either, before or after the boolean index is removed. Knock-on: `parseASTtoSQL.ts:139-142` names `expiry_date` as one of "the three that do carry an index" |
| P2-53 | Performance | `src/db/repositories/item/attention-sql.ts:122-128` | The effective-expiry expression makes *expiring* the most expensive item read | confirmed | #806 | Found while verifying P2-37. 6.7×/8.7× a plain list page at 50k/200k, and 2.5× the next-worst status; it is the whole of the 2.3× that *expiring* adds to the recomputed half of the filter-bar counts. Distinct from #764 (the count form has no `ORDER BY` at all and no temp b-tree; the cost is the per-row subquery) and from P2-52 |
| P2-54 | Mechanical | `item/create.ts:94-102`, `item/core.ts:618-625` | Both unlimited-supply guards delete with the suite green | confirmed | #812 | Found while verifying P2-42. The reason is the finding: `unlimited-integration.test.ts:48` asserts only that *some* database error is thrown, and the raw rule violation throws one too — so it cannot distinguish the guard from the constraint it claims to mirror, which is the one distinction the guard exists to make. The neighbouring gauge and attrition tests assert the *message* and do go red. `create.ts:94`'s stated justification also appears inaccurate |
| P2-55 | Mechanical | `item/gauge.ts:150-154`, `item/create.ts:120` | The gauge comment mis-describes the CHECK, and the two guards mirroring it disagree | confirmed | #812 | Found while verifying P2-42. The CHECK requires only that the unit is present, with no emptiness clause. Creating rejects an empty string but accepts whitespace and stores it untrimmed; reconfiguring rejects both — so a gauge can be created with a unit the reconfigure dialog would refuse to set. Three assertions, all passing |
| P2-56 | Mechanical | `ItemRepository.relevance-search.test.ts:36,51-54` | The only test guarding relevance ranking cannot fail for the thing it is named after | confirmed | #816 | Found while verifying P2-24, and the reason its demonstration is stronger than the finder's. The fixture puts the search term in **both** the 10.0-weighted name and the 1.0-weighted description, so it passes whatever the relative weights are — 6/6 green with the two exchanged. One word in the fixture makes it red |

### Phase 3 — Every other repository

Pinned SHA: `52fa966f97ed1a55d46cba47578e1e869f2d1aee`

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| L-1 | Mechanical | `LocationRepository.ts:201-208` | `PARENT_MOVE_CYCLE_GUARD` uses `UNION ALL`, the only recursive walk in the layer that does, so a pre-existing `locations` cycle makes every parent move never terminate | confirmed | #818 | Widened three ways. The ingress needs no hand-edited file: `conflict-restore.ts:34-71` ("restore my version" on the Sync screen) UPSERTs a captured row with no cycle check. The hang was driven on the real repository call and killed by an OS timeout; Vitest's own `testTimeout` never fires because `node:sqlite` is synchronous. Two corrections to the finder: substituting `UNION` does not throw, it *completes* the legitimate move in 0 ms while still vetoing a real self-descendant one; and the freeze lands on **correct** usage, because `EXISTS` short-circuits exactly when it should veto. `unusable`, not data-loss — the transaction never commits, but nothing cancels a running statement, so the 300 s budget expires and every later request queues behind it. #190 is the same defect on `items.parent_id`, and its body cites this guard as the good example |
| L-2 | Mechanical | `LocationRepository.ts:168-180` | `SELECT_WITH_COUNT` is unexported, so the row-shape guard cannot check the three location list reads | rejected | — | Premise false. `exportedConstantOf` is one of **three** resolution steps; step 1 is constant folding, and `LOCATION_COLUMNS` has a string-*literal* type, so the template folds and never consults the export list. Proved as prescribed: deleting `l.archived_at` turns the guard **red** naming all three sites. Enumerating the unverified population with `MAX_UNVERIFIED = 0` confirms `list`/`listAll`/`getTree` are not in it. `CategoryRepository.ts:105`/`:178` are the same shape and equally fine. Follow-up, not an issue: the memory note `Query row shape guard` omits the constant-folding step, which is what the finder generalised from |
| L-3 | Functional | `useLocationSidebar.ts:177-184`, `:240` | The delete confirmation is keyed on directly-homed items, so a location holding only sub-locations, photos, regions, tags and field values deletes on one click | confirmed | #823 | Sole gate on all three entry points; the mutation has no undo, no toast action and no rollback. Narrowed: only **four** of the seven consequences are loss (photos → regions → item placements, tags, field values). Stock re-home and forced check-ins are lossless; child promotion is already recorded behaviour. The counter is narrower in a second way — `location_item_counts` is maintained `WHERE is_active = 1`, so removed items still homed there also read as zero. #588 is the accepted precedent for the class |
| L-4 | Mechanical | `v1-initial.ts:1084-1090` | `item_field_effective_values` walks the location tree with an unbounded `UNION ALL`, so the same cycle hangs every read of it | confirmed | #819 | **This query is what crashed the host mid-phase.** Re-demonstrated safely under an explicit `LIMIT`: the cyclic closure fills any limit (100k → 100000, 1M → 1000000) where the acyclic one is 9. `UNION` would **not** save it — the incrementing `depth` makes every tuple distinct, confirmed by measurement. Precondition narrower (needs one `mode='inherit'` row), blast radius much wider: the second reader is `item/feeds.ts:440` → `useAlerts.ts:203` → `AppNav.tsx:49`, the global nav on every screen, so it fires on **load**. Phase 1's file, found by Phase 3 |
| L-5 | Mechanical | `LocationPhotoRepository.ts:79`, `:158-171` | Photo captions and region names skip `assertTextLimit`, so an over-long value fails with a message naming neither field nor limit | confirmed | #843 | Joined the sweep with `Attachment`/`Webhook`/`TarePreset`. Narrower on reach (only caption and region name are user-typed; geometry and colour are app-serialised), wider on the trim: `addRegion` trims its name and `addPhoto` does not trim its caption — two adjacent methods disagreeing |
| L-6 | Mechanical | `LocationPhotoRepository.ts:267-269` vs `:280-281` | A region Move half-lands at the storage Hard Stop, leaving the item placed nowhere | confirmed | #844 | Framing corrected: "unlink should assert writable too" is the **wrong** reading — `base.ts:153-155` states the deletions-free-space exemption and open #802 already counts `unlinkItem` among the thirteen that legitimately free space. The defect is the **caller**: `useSetItemPlacement` composes a Move from two independently gated awaited calls. The panel has no tier check; the tombstone is written before the refusal |
| L-7 | Performance | `LocationRepository.ts:624-644` | Deleting a location builds one history INSERT per orphaned item into one transaction array | rejected | — | The finder's named mechanism is measurably not the cost. Like-for-like against the same transaction with only the history INSERTs collapsed: **1.67x / 1.64x / 1.62x** at 2k / 8k / 32k items — flat, no cliff. Structured clone is **5%** of the cost (13.3 ms of 189.3 ms at 8k), not the payload the claim named. 0.8 s at 32k against a 300 s budget, behind a confirmation dialog with a spinner — P1-54's rejection ground. Unlike P2-5/#801 the rows are needed; only the shape is suboptimal. Second limb is P1-54 verbatim. §11 carry-over: one `INSERT … SELECT` removes a flat ~38% at any size |
| L-8 | Mechanical | `LocationRepository.ts:667`, `snapshot.ts:940` | The derived stock-lot id is rebuilt by hand in SQL with nothing holding the copies to the helper | confirmed | #868 | Narrowed from three copies to **two**: mutating `stock.ts:302` turns six tests red, so that one is incidentally pinned; mutating the other two leaves **5,328 tests green**. Mutating the helper's separator leaves the whole location suite green. The drift test drives both sides and reproduces the predicted failure — the upsert stops matching, the unique constraint aborts, and the location becomes undeletable with a message naming neither. Rule 1 is available: the separator is already a module constant, and `OPEN_PURCHASE_ORDER_WHERE` is the in-repo precedent. Adjacent to #771; not a #775 member (nothing claims parity) |
| L-9 | Functional | `LocationRepository.ts:903-912` | `createPath` reuses a level by SQL case-insensitive match, which folds ASCII only, so a non-ASCII path forks | confirmed | #845 | Wider than claimed — the **ancestor** forks too, so a whole branch duplicates. Severity does not rise: one production caller, and it is **not** on the import path (the catalogue importer resolves, never creates), so the "import creates duplicate shelves" scenario does not exist. #342/#343 are the precedents that fixed the identical class |
| L-10 | Mechanical | `LocationRepository.ts:369`, `:546`, `:594` | Non-null assertions on a row re-read across worker messages | rejected | — | Below the bar. §7's preamble forecloses it ("a hit is a candidate, never a finding"). The consequence if the interleave happens is smaller than assumed: `hasAuthoredMessage` returns false for a `TypeError` by explicit name test, so the user reads the ordinary fallback copy — no jargon leak, no crash, and the write already committed. Worth one line inside #826 if wanted |
| L-11 | Performance | `LocationPhotoRepository.ts:41-47` | The placements panel reads every photo of a location, blobs included, to find one; `getPhoto` is dead | rejected | — | Zero callers for `getPhoto` confirmed across all four trees. At the shipped thumbnail size the cost is **43-140 microseconds**, once per location, React-Query-cached and shared with the gallery — narrowing would *lose* that shared entry. The one durable widening was handed to #855 as a comment: `location_photos.thumbnail_blob` is a second unbounded column, where the same amplification gives 4-15 ms |
| C2-1 | Mechanical/Prompt | `CategoryRepository.ts:390-401` | Deleting a category strands its items' field values, and the docstring claims they cascade | confirmed | #825 | Widened by two symptoms the finder did not claim: the stranded row still satisfies a `field:` search via the inheritance view, and section presence reports custom fields the editor cannot render. "Permanently" corrected to "no targeted route exists" |
| C2-2 | Functional (ACL) | `TagRepository.ts:279-312`, `SupplierRepository.ts:211-232` | `merge` hard-deletes and tombstones while asserting only `<entity>:write` | confirmed | #821 | Widened to a second site. The "merging is editing child rows" counter-argument fails on the project's own precedent: `item/dedupe.ts:344-354` asserts **both** keys for a merge that only *soft*-deletes. No UI gate — the Tags screen has no permission check at all. Passes the ACL sweep because it **is** guarded, just mis-keyed |
| C2-3 | Functional/Prompt | `CategoryRepository.ts:881-901` | `updateField` narrows a shared definition's option list for every category using it | confirmed | #851 | One root cause with C2-4. The `updateField` arms are unreachable today (no caller passes those inputs), so the reachable arm is `addField` → `resolveFieldDef.applyOnReuse`, which writes unit, range, precision and prominence onto a shared definition with **no sharer check at all** — demonstrated retuning another category's kg/max-100 field to g/max-10, so a stored 50 reads 50 g. Not #715 (that is the preset library and options *discarded* on reuse; its reasoning corroborates this) |
| C2-4 | Functional | `CategoryRepository.ts:888-901` | The retype guard counts only category sharers, ignoring location offers and uncategorised items | confirmed | #851 | Same root cause as C2-3: the block asks the wrong question about who is bound by a definition. The unused-definition query next door already knows all three reference tables |
| C2-5 | Functional | `TagRepository.ts:45-49`, `:189-200` | Tag filter and autocomplete match with SQL `LIKE`, folding ASCII only | confirmed | #830 | ASCII control proves the intent. Second half driven: the app says the tag does not exist, then the save reuses exactly that tag. Sharper consequence than claimed — the merge-target picker leaves **Merge** disabled with no explanation. Not #753/#390/#577/#342, all of which name other files |
| C2-6 | Functional | `CategoryRepository.ts:493` vs `:1034` | At the Hard Stop, removing a field is permitted but pruning the definition it orphans is refused | confirmed | #860 | Rationale corrected, and the measurement **rejects the finder's framing**: none of the three actions frees a page (the tombstone outweighs the row), so the exemption's premise does not hold for this family — the same phenomenon #802 names, in a second repository. Corrected claim: the dialog offers a Delete at the paused tier that is always refused, telling the user to do what they just tried |
| C2-7 | Mechanical | `name-fold-coverage.test.ts:73-75` | The name-fold guard exercises one of the three writers that mint a tag row | rejected | — | The hole is real but harmless: reverting `create` to its pre-#342 shape turns `TagRepository.test.ts:64-70` red on the same pair, and `setForLocation` delegates to the same `applyTagSet` the guard drives. Shape already rejected as P2-42 |
| C2-8a | Mechanical | `TagRepository.ts:236-237` | `create` returns `updatedAt: 0` on the insert branch and the real stamp on the reuse branch | confirmed | #866 | Narrowed: the `applyTagSet` half is **not** a defect (local map, `.id` only), and no caller reads the field. What stands is one public method returning a value that is right or wrong depending on which branch ran |
| C2-8b | Mechanical | `TagRepository.ts:250-258` | `rename` of a missing id resolves silently | rejected | — | No caller relies on a throw; the docstring promises one for a name clash only. No demonstrated consequence |
| C2-8c | Mechanical | `TagRepository.ts:265-271` | `remove` of a missing id writes a tombstone | rejected | — | The decisive question — does it shadow a row another device is about to create? — is **no**: `reconcile.ts:579` deletes only where the tombstone beats the row, and `reconcile.test.ts:185-191` pins the converse. The shape is the layer's convention across four repositories |
| C2-9 | Prompt | `CategoryRepository.ts:111-126` | A parity docstring does not name the test that holds it up | confirmed | #863 | Marginal. The test **does** bite in both directions (both sides mutated). Only the third limb of the rule fails. Widened: the twin at `field-def-prominence.ts:155-157` has the same omission. Not a #775 member — that sweep collects claims that are *false* |
| C2-10 | Mechanical | `CategoryRepository.inheritance.test.ts:505` | An assertion that cannot fail | rejected | — | The test itself can fail — `:503` goes red when the clause it guards is removed. `:505` is a lint-appeasing dead line inside a sound test. Shape already rejected as P1-10 |
| C3-1 | Functional | `features/projects/assembly.ts:131` | A zero-quantity BOM line still consumes or relocates a whole-item part | confirmed | #827 | The `mode !== 'WHOLE'` term is load-bearing but over-broad. Four failures with a passing DISCRETE control — same line, opposite outcome, decided only by tracking mode. The fix leaves 310 committed tests across 17 files green, so nothing pins the current behaviour. Reachable only via the BOM importer, demonstrated end to end. Severity corrected **down**: an archived item is restorable; the immutable `CONSUMED` entry and the completed state are not |
| C3-2 | Mechanical | `project/assembly.ts:113` | The one-shot guard is keyed on an editable status, so re-finalising a re-opened project clashes | confirmed | #828 | Widened. Face 1 (same outcome) aborts on a duplicate id with untranslated copy; stock rolls back atomically, so **not** data-loss. Face 2, new: a **different** outcome *succeeds* — the derived ids are namespaced per artefact kind, so a second container is minted and the BOM applied again as a relocation. Full outcome matrix checked: no pairing double-consumes. Links #195, which introduced the guard |
| C3-3 | Performance | `project/budget.ts:104-131` | `listBudgetAlerts` is unbounded and scans every BOM line in the vault | confirmed | #852 | **Diagnosis corrected and the finder's fix would be harmful.** Row count is not the cost; the unscoped derived table is. A `LIMIT` would be a *defect* — `useNavCounts.ts:146` counts the whole result for the over-budget badge. Measured 4.53x / 4.20x / 5.08x against a project-scoped rewrite. The three consumers share one query key, so React Query dedupes to one execution per load |
| C3-4a | Performance | `project/procurement.ts:229-243` | `listInTransit` scans and sorts the whole table on every page | confirmed | #852 | Folded into C3-3's issue. Deep pages cost the same as page 1 (1.03x), which is the evidence the limit bounds rows and not work; an index flips it to a search, 2.14x / 2.86x |
| C3-4b | Mechanical | `project/procurement.ts:241` | The ordering has no id tiebreak, against the rule three siblings state | rejected | — | Rejected for a reason that is **not** the engine, so §11's `search.ts:184` question did not need settling: the sole consumer never asks for a second page, and #149's invariant is specifically about paging. §11 hardening — ties are very reachable, so the tiebreak must go on before anyone gives this feed a paged consumer |
| C3-5 | Functional | `project/bom-lines.ts:117` | Re-pointing a BOM line keeps the previous item's cost snapshot and part number | carry-over | — | Real, and a **second limb** the finder missed: `updateLine` leaks a raw engine error where `addLine` throws a named one. But the zero-consumer claim is verified across all three trees and no edit-BOM-line UI exists. §11, on the precedent of the Phase 2 `aliases.ts` row |
| C3-6 | Functional | `project/assembly.ts:198` +4 | A part archived after being added to a BOM is still drawn, costed and shopping-listed | confirmed | #829 | Widened 3 → 5 sites; the one the finder missed is `budget.ts:126`, the **dashboard** budget-alerts feed. Not a duplicate of #790: there the importer binds an already-archived item, here the binding was correct when made — disjoint fixes. `procurement.ts:239` excluded (label fallback only) |
| C3-7 | Performance/Money | `project/costing.ts:47`, `:170` | Published money figures bypass the rounding seam | confirmed | — | **Half disproved.** `totalCost` sums in SQL over integer micro-units; over **2,000,000** sums rounding changed the rendered string **0 times**. The `estimatedCost` limb survives: a 2,800,000-case sweep found 3,446 mismatches (0.12%), all exact half-penny ties and all requiring a sub-penny unit cost. The finder's own suggested case renders correctly. No export path. `cosmetic`; not filed alone |
| C3-8 | Functional | `project/procurement.ts:100-106` | The `PROCURED` entry logs the full requirement, not the outstanding remainder | confirmed | #867 | Reachability verified in the UI: the BOM table offers all four statuses unconditionally and a partially received line deliberately stays in transit, so re-selecting it is two clicks with no guard. Reports unaffected (the delta is correctly null per #652) — the damage is the human-readable ledger. Residue of #652's deliberate decision |
| C3-9 | Mechanical | `features/projects/assembly.ts:145-150` | `AssemblyDrawMode` is branched by if-chains with no exhaustiveness guard | rejected | — | No live defect: all four members check out against every consumer. One producer, no pending member, if-chains rather than switches. §11 hardening |
| C3-10 | Mechanical | `project/bom-lines.ts:81`, `:124` | A non-numeric quantity reaches SQL as a raw constraint failure | rejected | — | Not reachable. Both UI dialogs coerce, the importer's cell reader rejects non-numeric, negative, fractional and overflow values, `updateLine`'s only caller has zero consumers, and the bridge has no BOM write in its five-operation union and no BOM tool |
| C3-11 | Performance | `project/assembly.ts:138`, `:304` | One awaited batch read per matched part before the transaction opens | rejected | — | Identical shape at identical magnitude to P1-54 and P2-18, with the same mitigations (draws deduped per item, behind a one-shot confirm dialog). Honest residue for §11: an imported BOM can carry hundreds of lines where a kit cannot; ~500 parts would be ~21 ms desktop / ~210 ms phone, not measured and so not claimed |
| C4-1 | Functional | `PurchaseOrderRepository.ts:568-581` +3 | PO receipts commit stock writes with no derived operation key, so two offline devices land the delivery twice | confirmed | #817 | Widened to **data-loss**. Driven through the **real sync engine**, not a hand-rolled replay: shelf 10 where the order says 5, and the Activity Log shows the delivery twice. The **return** path destroys real stock — 15 on hand, one 5-unit refund each side, 5 left. Permanent, not self-healing. The bracketed loan return passes as a control, so the harness is not double-counting by construction. The wiki's "from two devices" promise is false. PO and project paths are one issue, four call sites |
| C4-2 | Functional | `lib/supplier-name.ts:34-43` | `supplierNameKey` bare-lowercases, so a case-expanding character mints two suppliers | confirmed | #831 | Widened — also reached from `nameFilter:280`, the Suppliers search box, which the finder missed, so `findByName('GROSSE BAUTEILE')` misses the stored name too. Does **not** self-heal over sync. The safe fix keeps the key's own shape and inserts the round trip: a control re-ran every committed expectation against it and passed, and the Greek final-sigma pair stays correct — recommending the shared helper alone would *regress* it |
| C4-3 | Performance | `PurchaseOrderRepository.ts:197`, `:831-839` | `list` fires one lines query per order, and the export walks every page through it | rejected | — | Count reproduced (101 reads per page; 10,100 for the export) — it fails on cost. `Promise.all` means these are **pipelined** ~0.005 ms round trips (P2-5's figure), not sequential: ~1.7 ms desktop / 17 ms phone per page, numerically identical to P1-54 and P2-18, both rejected. At the export cap the ratio *falls* (3.15x → 1.82x → **1.38x**) because both shapes pay the same OFFSET header walk, which is 435 ms of 599 ms. Same index both sides. §11: that OFFSET walk is the real cost, and is keyset-pagination territory |
| C4-4 | Functional | `docs/wiki/Purchase-Orders.md:18-20` | The page says raising an order puts stock in transit; a draft contributes nothing | confirmed | #581 (comment) | Narrowed to `documentation`, `cosmetic`. Quote verbatim and current; "Mark as ordered" appears **zero** times in `docs/wiki/`. The app is right and signposts it well (a Draft chip and a primary button on the same screen). Sits inside §4.2's wiki programme and adjacent to #581, so folded there as a comment rather than filed |
| C4-5 | Functional | `ReceiveLineDialog.tsx:67-70` | The per-line receive accepts any quantity and the repository silently clamps it | confirmed | #846 | The clamp is deliberate, documented in two seams and pinned by four tests, so the defect is the **missing upper bound** in this one dialog, not the clamp. Traced: nothing throws, nothing warns, and the only signal is a screen-reader-only region stating the new total. The sibling dialog already has the message, the variable and the translation key |
| C4-6 | Performance | `PurchaseOrderRepository.ts:122-136` | The open-order count runs a correlated aggregate per order row | rejected | — | Shape confirmed and linear, but the finder's **stated cause is disproved**: adding the missing status index gives 1.01-1.05x and an identical plan — the cost is the per-row `NOT EXISTS` (25x the status-only filter), which no status index touches. 5.6 ms desktop / ~56 ms phone at 10,000 orders, once per load, cached. The derived status is a documented trade (#573) and `open-count-parity.test.ts` holds both derivations together |
| C4-7 | Functional | `SupplierPartRepository.ts:347-359` | `listPriceHistory` caps at 50 and the sparkline's change is computed over the truncated window | confirmed | #832 | Wider than #815 on impact (a **visible** "+£49 (+445%)" where the truth is +£59 (+5900%)), narrower on reach — a row per genuine change, not per poll, and no bulk path, so 51 points needs 51 real movements |
| C4-8 | Mechanical | `PurchaseOrderRepository.delete:319-333` +3 | Deletes tombstone unconditionally, unlike `WishlistRepository.delete` | rejected | — | No reachable caller can name an id the device never held: the bridge write union has no delete of any kind, the MCP tool set has none, the four deletes have exactly four UI callers over already-loaded rows, and sync writes tombstones directly. (The finder's line numbers for the Wishlist guard were stale: it is `:146-159`) |
| C4-9 | Prompt | `PurchaseOrderRepository.ts:6-8`, `:421` | A "mirrors" comment with no drift test | rejected | — | The comment names the shared seams it reuses and claims no behavioural identity, so rule 1 is already applied to each. The two bodies differ in nine listed ways and the comment is still true. Not a #775 member — that sweep collects claims that are *false*. No test could fail for the stated reason |
| C5-1 | Functional | `AssetBookingRepository.ts:131`, `:394` | An unlimited-supply item is bookable but can never be checked out | confirmed | #840 | Two definitions of "bookable" disagree about the unlimited flag: the picker query and the pure gate both ignore it, the conversion checks it. A definition mismatch, not the concurrency window filed as #826 |
| C5-2 | Mechanical | `CheckoutRepository.ts:231-238` | The serialised-loan probe is not paired with its insert, so two overlapping lends both open | confirmed | #826 | New against #193, whose fix is a **sync-merge** repair that never runs on an unsynced device, so both loans persist indefinitely |
| C5-3 | Mechanical | `AssetBookingRepository.ts:140-152` | Two overlapping bookings both succeed | confirmed | #826 | Same post-merge-only caveat (#194). No shipped UI route found — the screen latches |
| C5-4 | Mechanical | `ContactRepository.ts:123-140` | `resolveOrCreate`'s docstring claims the unique index closes the race; it folds ASCII only | confirmed | — | **Both of the finder's extra claims are wrong.** It *does* need the concurrency (`findByName` uses the full Unicode fold, so sequential is clean), and the data-loss consequence is **refuted** — `unique-keys.ts:640-654` has handled the two-rows-one-key case explicitly since #679. What survives is `degraded` plus a **false, stale docstring** that the code two lines above already contradicts. Not filed separately; the docstring correction rides with #826 |
| C5-5 | Functional | `AssetBookingRepository.ts:394-405` | The booking picker is capped at 100 with no offset, search or truncation signal | confirmed | #841 | Demonstrated with 120 assets: limit 500 still returns 100, and offset is silently ignored. A hard reachability ceiling with no alternative route, not a deep-page cost. #573 is the same shape on the dashboard tiles |
| C5-6 | Mechanical/Functional | `AssetBookingRepository.ts:157-167`, `:251-299` | Concurrent cancel and convert leave the booking both cancelled and converted | confirmed | #826 | The sharpest of the four and **uniquely un-self-healing** — no repair pass exists for this shape, so the corrupt row survives every merge on every device. Sequential path correctly refused; stale-cache hypothesis closed off |
| C5-7 | Mechanical | `CheckoutRepository.ts:391-421` | `renew` writes without carrying `returned_at IS NULL` into its WHERE | confirmed | #826 | **The finder's demonstration was wrong** — their run showed the benign ordering, and the damaging one is structurally unreachable on the `:memory:` driver. Reachable under the shipped driver model: an offset sweep found 2 of 41 windows where both calls report success, the closed loan carries a due date 30 days out and the renewal is logged after the return. #296 **is** a partial fix that missed `renew` and does not say so |
| C5-8 | Mechanical | `AssetBookingRepository.ts:343`, `MaintenanceRepository.ts:154`, `:183` | Three `readAllPages` walks have non-total orderings | carry-over | — | The decisive question **is** settled and cuts the opposite way from C3-4b: all three genuinely OFFSET-walk, so the invariant is live here. But no duplicate or drop could be demonstrated, and Phase 2 failed four attacks on the identical question. Sharpened claim §11's `search.ts:184` row lacks: `AssetBookingRepository` carries **both** shapes — `list:331` has the tiebreak with a docstring arguing it is needed because the export offset-walks it, and `listUpcoming:343`, walked since #149/#606/#607, omits it |
| C5-9 | Functional | `AssetBookingRepository.ts:200-211` | A partial update naming only the end date can move the start | rejected | — | Real behaviour, no reachable caller: the edit dialog refuses a reversed range before calling update and the date round-trip on the untouched field is exact; the bridge has no booking write at all (its only booking surface is the read-only calendar feed). Even if reached, the swapped range is still overlap-checked. §11 note: live the moment a booking write is added |
| C5-10 | Mechanical | `checkout-plan.ts:86-88` | `borrowerColumn` is a ternary chain with no exhaustiveness guard | rejected | — | Mechanism real and **wider** than claimed: adding a fourth member and running `npm run type-check` across all three projects gives **zero** errors anywhere (with a control proving the run was live), so the union has no coverage at any site. But the consequence is narrower: `checkouts` has three FK columns under an XOR CHECK, so a fourth type needs a migration, a column, a CHECK, a mapper branch and a UI option. Consistent with the C3-9 rejection |
| C5-11 | Prompt/Mechanical | `MaintenanceRepository.ts:36-49` +2 | Three definitions of the maintenance due instant, with a "must agree" comment and no test | confirmed | #839 | Demonstrated across **two processes** (setting the timezone inside one Vitest worker is inert — proved with a control first): written under one zone, read under another, the delta is 3,600,000 ms and the SQL due count flips 1 → 0 while the pure seams still say due. So the badge and the agenda say due while the tile, the count and the filter say not — and the item is absent from the very list the badge points at. Related to #325 but not covered by it |
| C5-12 | Performance | `MaintenanceRepository.ts:65-94` | The maintenance-due filter nests a correlated aggregate per items row | duplicate #806 | #806 (comment) | Same seam and mechanism as #806/P2-53, already filed. Measured 6.8x the unfiltered page and **2.7x the already-filed `expiring` arm** at 20k, scaling linearly. 12 ms at 20k is imperceptible, so the measurement was added to #806 as a comment |
| C5-13 | Mechanical | `CheckoutRepository.test.ts:569-585` | The borrower-delete atomicity test cannot fail for the property it names | confirmed | #850 | Splitting the delete into two transactions — exactly the #301 regression — leaves 61 tests green, and 26 more elsewhere. The stub replaces the transaction function **wholesale**, so no transaction runs and neither implementation can write. The ~12-line poison-one-statement remedy works and was demonstrated both ways; the identical shape guards two more deletes |
| C5-14 | Mechanical | `CheckoutRepository.ts:391-392` | `renew` appends to the ledger without `assertWritable` | confirmed | #858 | Narrowed to `renew` alone — the class rule explicitly exempts check-ins, so `checkInAllForTarget` is consistent with what is written. Not a duplicate of #802 (which sweeps *delete*-permission sites). Note #802's own conclusion — correct the reasoning rather than add the gate — may govern here too |
| C5-15 | Mechanical | `item/maintenance-default.ts:48-49` | The category-default interval is neither validated nor truncated | rejected | — | The crux resolves against the finder: `v1-initial.ts:563` puts the guard on the **column**. Both named failure modes are blocked one layer up, and because it is a column CHECK on a STRICT table it also covers sync apply and backup restore |
| C6a-1 | Functional | `ReportRepository.ts:278` | The catalogue filter drops the unlimited-supply term, so those items are priced and counted | confirmed | #837 | Narrowed. The *inclusion* is a recorded decision (#410: "a catalogue is a list of what you have, not a valuation") — but the docstring convicts itself, since its own premise that the product is undefined is exactly what the catalogue computes, and #410 never mentions unlimited items. Corrected claim: it **prices and counts** one, and prints its placeholder count as a finite quantity. No unlimited flag anywhere in the reports feature |
| C6a-2 | Performance | `ReportRepository.ts:1139-1212`, `:908-999` | The paged document reads sort the whole scope with the full payload per page | confirmed | #853 | The crux was **tested, not reasoned**: both shipped engines have the sorter-reference optimisation compiled out. The photos-on ratio **grows with N** (1.89 → 2.21 at page 1; 4.30 → 9.67 late) — flat is what it would be if the blob were fetched per page. A two-step shape is cheaper than today's photos-off read and 3-44x cheaper than photos-on. Amplifier the finder missed: the print path pages the whole document at 100, so printing is quadratic. The docstring is simply false. #163/#410 are the incomplete predecessors |
| C6a-3 | Functional | `ReportRepository.ts:593-607` | The foreign-currency notice misses a fully-depreciated item whose only base price is zero | confirmed | #838 | Narrowed as anticipated: the zero is right, the silence is not. Nothing else tells the user — the unpriced count renders in only two places, neither on the schedule or the catalogue. Stronger argument than the finder's: the effective-value expression prefers the supplier cost **above** the book value, so the currency exclusion silently demotes the item to a lower-precedence source that happens to be zero. Arrives by the passage of time with no user action |
| C6a-4 | Functional | `CatalogueScreen.tsx` | The catalogue prints a base-currency total with neither exclusion notice | confirmed | #838 | Grepped: neither notice appears, and the printed document is the same DOM. The repository gives the screen nothing to render one from. Extra: the dash is itself misleading — the wiki says it means nothing prices the item, but something does |
| C6a-5 | Mechanical | `ReportRepository.ts:474-486` | `preferredSupplierNameSql` claims to mirror the cost lookup but omits its currency guard | confirmed | #838 | Half **disproved** then re-widened: the "two preferred rows" limb cannot happen (the partial unique index rejects it). The other half is real and user-visible — the line prints "Yen Co" with a blank price. Joined C6a-3/C6a-4 because the named supplier is the very evidence that makes the silent drop look like a bug |
| C6a-6 | Mechanical | `ReportRepository.ts:745-753` vs `:1272-1279` | A recursive location CTE duplicated with a mirroring comment and no drift test | confirmed | #818 (comment) | **And critically NOT a second cycle-hang instance** — both use `UNION`, neither has a depth column, and both were driven against a real 3-node cycle, returning in 0.04 ms. Byte-identical after whitespace. Worth flagging: the safe and unsafe spellings coexist with no shared definition, which is the drift the rule predicts. Folded into #818 as its derive-from-one-helper remedy |
| C6a-7 | Mechanical | `ReportRepository.ts:1281-1282` | The empty-subtree guard is unreachable | rejected | — | Mechanism right (the CTE base case yields the seed row unconditionally) but the reachable outcome is **identical** — the filter matches nothing either way |
| C6a-8 | Functional | `ReportRepository.ts:671`, `:780` | "Unpriced" counts a deliberate zero, so the copy explaining it is false | confirmed | #865 | The **count** is a recorded decision (a test pins it with its reasoning, and the helper that distinguishes the cases names exactly two surfaces that must — Reports and Location stats are deliberately not on the list, per #706). The **copy** is the defect, shown decisively by an item that depreciated out with no user action |
| C6a-9 | Mechanical/Performance | `ReportRepository.ts:754-760` | Unbounded `IN (…)` lists, bound twice in location stats | rejected | — | On scale, consistent with P1-53. There is **no select-all** (the toggle adds one id at a time), and the variable limit is 32,766 on **both** drivers. The double bind is real but puts the break at a 16,383-location subtree |
| C6a-10 | Performance | `ReportRepository.ts:1152` | The catalogue scope CTE is re-resolved per page | rejected | — | On scale, measured with a 401-location **chain** (the worst shape): a location-scoped page is **not slower** than an unscoped one (0.90-1.11x). No bulk location import exists |
| R-1 | Functional | `ReportRepository.ts:1568-1569` | `deadStock` skips the location tree unless some other item is on inherit, dropping an explicit opt-in's threshold | confirmed | #833 | Widened: **both** halves driven — the report contradicts the editor's note, and creating one unrelated inherit-mode item elsewhere flips the verdict, so the answer is non-deterministic across ordinary use rather than merely defaulting. Also reaches the CSV export. Existing tests never take the path |
| R-2 | Functional | `ReportRepository.ts:2080` | "Never counted" keys on a ledger row that a clean count never writes | confirmed | #834 | A well-run inventory produces **more** false flags than a badly-run one. No other signal clears it (the durable stamp is on locations only). #637 is the location-level sibling, and its own reasoning is the argument for fixing this |
| R-3 | Mechanical | `ReportRepository.ts:1651-1654` | A stored reorder quantity of zero removes a low item from the shopping list | confirmed | #835 | **Live, not latent** — reachability established through the shipped UI, which the finder had not done: the control declares a minimum of zero, the value converts to 0 rather than null, and the invalid check guards only the reorder *point*. One keystroke. The tab then says "No items below their reorder point" while the dashboard counts it low. Links #156, whose parity test covers the low-stock predicate but not the shortfall |
| R-4 | Functional | `ReportRepository.ts:1625`, `:1716` | The reorder tab and agenda lane ignore the user's low-stock threshold | confirmed | #836 | **Not** a documented decision: Phase 46 named no exclusion and the reorder list did not exist yet; every other in-app consumer passes the preferences, and the plan hook *accepts* thresholds while its only caller passes none. Proof it is wiring: passing the same preferences produces the row. #483 asserts the opposite of what this shows |
| R-5 | Mechanical | `ReportRepository.ts:1424-1433` | `outOfStockCount` restates the SSOT predicate outside its parity test | duplicate #816 | #816 (comment) | Duplicate of the **recorded rejection** P2-43, same location, carried as a rider on #816. One fact added as a comment: P2-43's reasoning does not cover a **deliberate** semantics change, where the editor updates the parity test's expectations and the tile silently keeps the old definition |
| R-6 | Performance | `ReportRepository.ts:1548-1574` | `deadStock` scans the whole inventory before applying the opt-in, eagerly | confirmed | #854 | Rejected **as framed** — #528 records the ungated headline cards as deliberate, and the finder is wrong twice (stock aging and data hygiene both cost more; the missing gate is intentional). What was filed is the residue #528's own closing note names and offers to track: pushing the policy filter into SQL. Nobody raised it and #528 is closed |
| R-7 | Performance/Prompt | `ReportRepository.ts:1748` +3, `:18` | Four reports return one row per item with no limit, against the file header's claim | confirmed | #863 | Rejected as a performance finding — restates #528, which pre-empts the framing. The claim is also **wider than the truth**: payload growth for 3x rows is 3.0x for two of them and **1.0x constant** for the other two, and all four are viewport-gated. The surviving piece is the false header claim, filed with R-11's comment |
| R-8 | Functional/Prompt | `DiagnosticsRepository.ts:61-64` | The item count includes removed items and abstract variant parents | confirmed | #864 | The **defect is the copy, not the count**: the count is documented as a row count, the panel groups it under "Size of your data", and the storage repository agrees with it. The wiki sentence and the bare "Items" label mislead, and the gap grows without bound |
| R-9 | Mechanical | `DiagnosticsRepository.test.ts:48-53` | A growth assertion that cannot fail | confirmed | #861 | Stubbing the size to a constant leaves all three tests green. Nuance for the fixer: `>` is **not** generally safe — page granularity means one insert moves nothing (measured delta 0); it is safe only at 200 rows. Clears §2.1 on the honest reading: it can fail if the size shrinks, but not for the reason its name states. The second sub-claim is **disproved** — the permission gate *is* asserted |
| R-10 | Mechanical | `ReportRepository.ts:2349-2363` | `parseSalesMetadata` swallows a parse error | rejected | — | Documented as tolerant, and **no figure is wrong** — the costed total correctly excludes the unreadable lines and the caveat string is shown precisely because they were. Only the cause is undiagnosable, which §1 excludes. Adjacent real gap for the test-quality phase: `salesAnalytics` has no repository-level test at all |
| R-11 | Mechanical/Prompt | `ReportRepository.ts:2080`, `:2288`; `consumption-actions.ts:84` | Untyped history-action literals, and a comment citing a precedent that does not exist | confirmed | #863 | Literals **rejected** — no live mismatch, and the action values are persisted, so a rename is a migration rather than a refactor. The **comment** is confirmed: it cites the typed constant as an inlining precedent when that code does the exact opposite, pushing a contributor the wrong way |
| R-12 | Performance | `supplier-cost-sql.ts:70` | A defensive tiebreak costs a per-row temp b-tree in six reports | rejected | — | **Do not remove the guard.** Re-measured at 1.48x / 1.46x, stable, plan confirmed — but a sync merge really can transiently leave two rows flagged, and without the tiebreak an item's cost and every valuation built on it become non-deterministic and can differ between devices. Recorded so a later phase does not re-find the ratio and reach for the obvious optimisation |
| R-13 | Functional | `locations.dead_stock_days` | An out-of-range value inverts the dead-stock report | carry-over | — | The finder's **premise was wrong** — the repository clamps too. Reachable only from a tampered snapshot or a hand-edited database. §11: it names the consumer the Phase 2 carry-over row said was missing (an invalid date makes every comparison false, so every opted-in item reports as dead). One-line tightening: the CHECK should match the clamp |
| U-1 | Mechanical | `permissions.enforcement.test.ts` | The ACL guard test exercises 12 of 157 gated writes | confirmed | #847 | Two mutations run twice over the **whole suite** (800 files / 12,448 tests): both lose their permission check with not one test red. Corrections: 12 gated *write* methods, not 14; and "nine or more repositories" understates it — **sixteen** whole repositories with gated writes are never constructed. U-5 folded in |
| U-2 | Functional/Prompt | `SettingsRepository.ts:11-14`, `:48` | `publish` writes the cross-device settings table with no permission, justified by a false claim | confirmed | #849 | Split. The Prompt half is unambiguous — the key it says does not exist is asserted in eight places. The functional half is real but bounded, settled by listing the fields: most shared settings are cosmetic, but four groups are not (base currency, which feeds money rounding into a **persisted** sale total; alert thresholds; retention windows; scanning network switches). Note the asymmetry — the consent-host list is deliberately device-local, yet the master switch travels |
| U-3 | Prompt | `base.ts:26-30`, `:57-61`; `permissions.enforcement.test.ts:5-8` | Three docstrings say the guards are inert until a phase that shipped | confirmed | #848 | `degraded`, not cosmetic: `index.ts:183-189` in the **same directory** already contradicts `base.ts` directly. Combined with U-1, a maintainer has two independent signals saying the guard does not matter and none saying it does. Cross-reference #775, do not merge — that sweep is unguarded *parity* claims; this is temporally stale guidance |
| U-4 | Mechanical | `UserRepository.ts:304-308` vs the kind-keyed triggers | Two definitions of "built-in account", and an import path that does not filter what the export withholds | confirmed | #822 | **Exploitable — §5.3 was honoured and the maintainer was asked before filing** ("This software hasn't been released yet - please go ahead and file a standard github issue"). Widened from "no reachable divergence" to demonstrably reachable, with four passing tests. The visible harm to lead with is an account the app can neither delete nor disable. The resolver's ordering is not the defect; the set of rows reaching it is larger than the schema comment claims |
| U-5 | Mechanical | `UserRepository.signin.test.ts:196-203` | A test asserts the plaintext password is absent, a value never stored | confirmed | #847 | Narrower than claimed: leaking the real triple through the mapper shows this file passes entirely while the sibling test goes red — so there is **no coverage hole** behind it. Test theatre, not a gap |
| U-6 | Functional | `item/core.ts:822` vs `:909` | `hardDelete` cascades the ledger on `items:delete` where `clearHistory` demands `audit:delete` | rejected | — | Zero callers confirmed across four trees, and §10's P2-8 **already records** that fact (filed as #802). A dead method names no consequence. §11: P2-8 argues `hardDelete` is the method that would reclaim space, so the gate is a trap in its path if it is ever wired up |
| U-7 | Prompt | `en.json` `users.subject.checkouts.help` | The Loans help claims Delete covers cascaded loans | rejected | — | Shares U-6's root cause. Both limbs check out for **live** behaviour — the shipped per-item removal is a soft delete, which erases no loans — so the sentence is imprecise rather than false |
| U-8 | Prompt | `features/users/permissions.ts:147-148` | `normaliseGrants` says registry order and sorts alphabetically | rejected | — | Nothing depends on registry order: three non-test callers, none reads position, and the fingerprint hashes the order actually produced. One word wrong, no one suffers. A line on #775 if recorded at all |
| C8-1 | Mechanical/Functional | `mappers.ts:376` | A webhook filter stored as an array, a scalar or malformed JSON reads back as no filter | confirmed | #842 | Widened. The delivery chain was re-verified line by line into the bridge. The **write path is correct and states the same invariant**, so it is honoured on one side only. Routes in: the sync merge writes peer values verbatim and `webhooks` is a synced table; a restored backup; a truncated write. The existing test **pins the defect** — git history shows it predates the parser being wired in — and must be corrected as part of the fix. The plan document states the invariant outright |
| C8-2 | Functional | `erase-actions.ts:207-209` | Erasing item photos removes the whole shared OPFS directory, destroying location photo originals | confirmed | #820 | Widened twice: the wiki has **no** Location photos row at all, and "All items" also clears images. The repo states the hazard in the sibling module — the maintenance sweep is careful, the Danger Zone is not. OPFS files are not in the sync artefact, so no peer can restore them. Root cause is Phase 4's area, filed by Phase 3 per §1 |
| C8-3 | Mechanical | `StorageRepository.ts:100-108` | The history prune writes its delete and its watermark outside a transaction | confirmed | #859 | Three corrections: the failure is **not** silent (the second call is awaited, so the user sees an error) — what is silent is the state left behind; the likelier route is the **first** statement, because a timed-out request is documented as not cancelled, so a large delete can commit in the worker and reject in the caller; and both alternative silent-failure theories are impossible. Not data-loss — the archive is written and confirmed first |
| C8-4 | Functional | `AttachmentRepository.ts:75-127` +2 | Three repositories write length-limited columns without checking first | confirmed | #843 | **The finder's claimed output was wrong** and the verifier nearly reproduced the error: the raw SQLite text does **not** reach the user. The defect is a field-less, limit-less sentence. The `maxLength` sub-claim was dropped as misleading (the primitive deliberately omits the native cap). One real sub-finding survives: the attachment inputs are not wrapped in the form-field primitive, so nothing warns inline either. L-5 joined the sweep |
| C8-5 | Performance/Functional | `ImageRepository.ts:66-70` | The stored thumbnail has no size cap on any write path | confirmed | #855 | The **measured** blast radius is what lifts it: one 8 MB row makes a 25-row page **94.9x slower and 110x larger**. Narrower in one respect — there is no *app* ingress, since compression caps every picked photo. Same reachability band as #769/#349, both accepted. #641 is not a duplicate (it caps the picked file; fixing it leaves the column and the sync decode unguarded). L-11 handed it a second unbounded column |
| C8-6 | Functional | `triage-actions.ts:94-115` | Downgrade images destroys the only local copy with no save seam | confirmed | #824 | Restated and sharpened to **data-loss**. The method has no save parameter at all. The backup zip **does** carry the originals, so a safety net exists — the defect is that nothing tells the user to take one and **two** documents say the opposite: the wiki's "each keeping a copy" and the dialog's "your cloud backup is left untouched", which names an artefact that never held the bytes. Separate from #820: different path, failure and fix |
| C8-7a | Performance | `SuggestionRepository.ts:42-53` | `distinctValues` is an unbounded unindexed full scan with two temp b-trees | confirmed | #856 | Severity narrowed by the cache the finder was asked to check: **not** every dialog open — a 60-second stale time and nothing invalidating it means at most one refetch per field per minute. Honest caveat carried into the issue: at 8k rows it is only 1.8x a bounded list page; the defect is that it is the one item-table read with no cap at all |
| C8-7b | Functional | `SuggestionRepository.ts:42-53` | The same read includes removed items | rejected | — | No consequence. The seam's own contract is "the distinct values the user has already entered" and "suggestions are a shortcut, never a constraint"; excluding archived items would make re-adding a part from a supplier you stopped stocking worse |
| C8-8 | Performance | `SettingsRepository.ts:29-31` | An unbounded `SELECT *` over a synced table | duplicate #769 | — | Restatement of #769/P1-46. The row **count** is bounded by construction (one row per registry field); the read is only expensive if the value is unbounded, which *is* #769 |
| C8-9 | Mechanical | `settings-sync-runtime.ts:197-208` | The adopt fallback bypasses the stores' normalisers | confirmed | #857 | The finder's **example is wrong**, the defect is real. The preferences-store case is unreachable (the sync toggle lives in that store, so enabling it writes the blob). The genuinely fresh-device route is a different store: the layout key is never written at boot, so a fresh device takes the fallback for **every** field and the density normaliser — whose comment says its table relies on being exhaustive — never runs. Phase 11's file, found by Phase 3 |
| C8-10 | Mechanical | `WebhookRepository.test.ts:200-204` | A dead assertion naming a literal that appears nowhere | rejected | — | Decisively. Two mutations: the schema's own CHECK stops the first; the second fails at `:190` and, with `:190`/`:191` removed, at `:196` itself. A redundant assertion inside a test that bites is not a §2.1 finding. Consistent with C2-10 |
| C9-1 | Mechanical | `item-relations.test.ts:124-132` | The relations parity test gives each item one relation, so both orderings coincide | confirmed | #862 | **Much narrower** than the finder claimed: the parity claim *is* false and the test *is* vacuous, but all five consumers funnel through a presentation helper that re-sorts totally, so nothing user-visible differs — which also makes **both** SQL orderings dead. Lead with the false claim, not the vacuous test |
| C9-2 | Mechanical | `item/revaluations.ts:63` +2 | Three mixins name atomicity as their central invariant and no test holds them to it | confirmed | #850 | The gap is **cheaply closable**, which the finder had not established: the crashed-driver helper cannot test it (it rejects the precondition read too), but a ~12-line poison-one-statement decorator does, proved red on the mutation and green on real code. Failure modes are a wrong insurance valuation and a resurrected relation. C5-13 joined it |
| C9-3 | Mechanical | `item/revaluations.ts:76-79`, `item/test-records.ts:82-84` | No test passes page parameters, so the pagination limb is unasserted | confirmed | #861 | Not a duplicate of #815 — **complementary**. #815's fix *changes* this code and would ship the new envelope with the same zero coverage, and the test-records half is outside #815 entirely |
| C9-4 | Mechanical | `revaluation.test.ts:76-85` | The rowid tie-break is never exercised, though ties are the ordinary case | confirmed | #861 | Day-resolution claim verified — the date helper parses to midnight UTC and says so — and the editor is the only write path, so two revaluations on one day tie exactly |
| C9-5 | Mechanical | `item-relations.test.ts:55-63` | A test named for two behaviours asserts one | confirmed | #861 | #805 cites the early return, never the normalisation. Note for its fixer: if #805 makes the note renderable, the current coalescing would start rendering an empty note row |
| C9-6 | Prompt/Mechanical | `revaluation.test.ts:62-73` | A test title asserts the invariant #795 disproves | confirmed | #795 (comment) | Same root cause as an open wrong-data issue, so a separate ticket would be actioned into a duplicate. Filed as a comment naming the file, the line, the title and the failing fixture |
| C9-7 | Mechanical | `test-record.test.ts:88-94` | The ordering tie-break limbs are timing-dependent | confirmed | #861 | **The finder's measurement was wrong.** Over 20 runs the id limb went undetected 5 times (25%), not "3 of 3 solid". Corrected claim is better: **both** limbs are timing-dependent and mutually exclusive, so on any run at least one is unheld. A test that misses a regression 25% of the time is absent, not flaky |
| C9-8a | Mechanical | `revaluation.test.ts` | Fractional and zero values are never recorded | rejected | — | Rejected as a defect — both round-trip exactly. Confirmed as a coverage gap only, carried into the sweep |
| C9-8b | Functional | `item/relations.ts:46` | A soft-deleted counterpart still appears in the Related list | rejected | — | A **recorded decision**: the checkout dialog disables the checkbox and labels it "removed from inventory", citing #661, and its comment states that one with nothing on hand is shown but not selectable "so the gap is visible rather than silently omitted". Filtering in SQL would hide a gap the code deliberately shows |
| C9-8c | Mechanical | `test-record.test.ts:105-109` | The activity-log note wording is never checked | confirmed | #861 | Wider than the finder claimed — it applies to the revaluation file too. Both templates can be replaced with a placeholder and 21 tests stay green. These are user-visible strings |

### Phase 4 — Data integrity

Pinned SHA: `983986fd425a6f0c6a538470a41aa7ec5dbb5aa7`

Six finder units (U1 snapshot and trust boundary; U2 reconcile and merge; U3 providers, engine and
clock skew; U4 backup and restore; U5 archive and storage triage; U6 danger zone, events and the
save-file seam) produced 63 candidates; a 64th (U2-3b) was found by a verifier while disproving
U2-3. Nineteen verifier passes ran. Four candidates were reported independently by two finders and
are recorded once, with both IDs.

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| U1-1 | Mechanical | `sync/snapshot.ts:1111-1117`, `reconcile.ts:2059-2103` | The gauge correction re-stamps `items.updated_at` on every sync for every gauge item, so a no-op beats a peer's real edit | confirmed | #869 | `data-loss`. Trigger fires on an identical-value UPDATE — settled against `node:sqlite` first. Converged pair still emits a resolution while `upsertWouldNoOp` correctly suppresses the LWW upsert, so this is #161's uncovered residue, not a duplicate. Edit loss driven end to end with `conflicts: []`. Verifier corrected the finder's `withRecomputeDeferred` aside as a red herring, and narrowed the population to gauges whose ledger reconstructs on both sides |
| U1-2 ≡ U4-4 | Functional | `sync/backup.ts:238-241`, `types.ts:15`, `backup/restore-backup.ts:218-225` | A newer build's backup restores partially and silently on the Merge and clone paths, and the wiki promises the opposite | confirmed | #870 | `data-loss`. Found independently by U1 and U4. `SYNC_FORMAT_VERSION` has one line in its entire git history against 103 commits editing the baseline. Decisive evidence: the same table name is REFUSED in the tombstone section and ACCEPTED in `tables`. Not #501's residue — a sibling gap it never examined |
| U1-3 | Mechanical | `sync/backup.ts:54` | A tombstone's `deletedAt` is checked for finiteness but not range, so an absurd value is never pruned and wins LWW for ever | confirmed | #876 | `data-loss` + `unusable` for a bridge host. Verifier found a limb the finder missed: the bridge's driver **throws** on the oversized integer, so that host can no longer build a snapshot at all. The un-crafted (fast-clock) route is real but cannot compound, so it does not raise severity. Residue of #351, whose own exclusion list does not mention this clock |
| U1-4 | Mechanical | `snapshot-integrity.ts:87-98`, `fk-refs.test.ts:73-89` | Four FK exemptions defer to a private registry no test reads | confirmed (widened) | #901 | Filed as a five-item sweep with U2-6, per #254's precedent. Widened from one repair to three: `location_history.actor_user_id`, `locations.parent_id` (the twin of #602, asymmetry reversed) and the whole stock-delta registry can each be deleted with **12448/12448 green**. Instrumenting every repair showed which fire at all |
| U1-5 ≡ U2-7 | Mechanical | `conflict-restore.ts:37-38,56` | An unvalidated persisted `tableName` reaches an interpolated SQL identifier; the column fallback beside it is dead code | rejected | — | Both limbs factually true and demonstrated (the fallback is unreachable because the dictionary yields `[]`, not `undefined`). **Threat model empty**: the key is `backupIncluded: false` and outside the settings groups, so no backup can seed it; shared settings live in a DB table. Sole writer is same-origin script, which already holds the driver. Genuine residue of #176's stated intent — two lines of hardening if that is revisited |
| U1-6 | Prompt | `sync/snapshot.ts:3-6` | The module docstring claims ≤100 paging for reads that are single unbounded SELECTs | rejected | — | Premise fails on the sentence's own grammar: the parenthetical follows the first list item and does not distribute over the rest. The three membership joins are documented as **not** syncable tables, so the claim never covered them. No data loss; a single statement is strictly more atomic than a paged walk, which is #204's own reasoning. The only reachable consequence of acting on the misreading is a regression |
| U1-7 | Mechanical | `snapshot.test.ts:10-21` and two siblings | No tsconfig covers `src/**/*.test.ts`, so three fixtures omit required fields and leave two loops untested | rejected | — | The type-lies are real (proved under a probe tsconfig) but the causal chain is broken: **13 tests** enter the clone's stockDeltas loop and **46** enter the repair loop, from end-to-end tests rather than these fixtures. Only the repair's *drop branch* is uncovered, which is U1-4's territory. Root cause already recorded in #601's closing comment; re-filing would duplicate it |
| U2-1 | Mechanical | `sync/merge.ts:479-525` | The TTL clone's salvage re-union has no survival filter, so a parent the remote dropped aborts the whole clone | confirmed | #875 | `unusable`. Filed as ONE issue with U2-4 on the verifier's recommendation — same loop, same fix. Widened: a **tag edge alone** aborts it, not only ledger rows. "Can never complete" proved by running the same merge twice. Control with the item present clones cleanly |
| U2-2 | Performance | `reconcile.ts:1948` | Every surviving region edge is passed as `reinsertKeys` and re-upserted on every sync | confirmed | #890 | `degraded`. Two identical snapshots still produce **403 statements where 3 would do**. The tag join on the same fixture emits 0, which is the control. **Correctness limb disproved**: row count unchanged, nothing re-stamped, so unlike U1-1 it cannot feed #161's ping-pong |
| U2-3 | Functional | `reconcile.ts:771` | The open-loan collapse is gated on SERIALISED, so a single-unit DISCRETE asset ends a merge on two loans | rejected | — | **This is the register's P2-51, now given its pass.** Deliberately rejected in #542's closing comment, asserted by `reconcile.test.ts:288`, and justified at `reconcile.ts:752` (serialised loans move no stock, so closing one needs no restore). The proposed widening also fails to cover the multi-unit case, demonstrated as CONTROL E. **P2-51's `unverifiable` verdict should be read as `rejected` from here** |
| U2-3b | Functional | `delta-crdt.ts:169`, `reconcile.ts:2171-2172` | The over-consumption clamp is written back, breaking the completeness invariant, so returning both loans invents units | confirmed | #877 | `wrong-data`. **Found by the verifier while disproving U2-3** — no finder proposed it. A one-unit item ends at 2, a three-unit item at 6, on both devices, permanently. Four controls isolate it. Contradicts the design record, which chose this clamp precisely because it was believed self-correcting |
| U2-4 | Mechanical + Prompt | `merge.ts:474-488` | The clone's salvage applies the user rekey but not the System fallback, while its comment claims parity | confirmed | #875 | `unusable`. Folded into U2-1. `ON DELETE SET DEFAULT` verified not to rescue an INSERT. The delta path re-attributes correctly on the identical fixture — the asymmetry is the finding. The comment "exactly as `reconcile` does it" is false as written |
| U2-5 | Mechanical | `snapshot.ts:107-111` | `WIPE_FILTER` is interpolated into the clone DELETE with no schema check, so a renamed column breaks it silently | rejected | — | The mutation produced **28 failures across 11 files** with an error naming the column. "Silently" was the whole finding and it did not survive; the finder predicted 1–2 integration tests. Surviving but inert: it is genuinely absent from the guard test its neighbour is exported for — a one-line tidy, not an issue |
| U2-6 | Prompt | `loan-split-stock.ts:114-129,143-179` | Two comparators promised "kept in step by hand" with the replay engine, with no test | confirmed | #901 | Filed in the sweep with U1-4. Both pairs verified to currently agree, tier by tier. Each inverted separately: **12448/12448 green** both times. Consequence named by the code itself — rank the movement ahead of the assertion and #711's loss returns |
| U2-8 | Mechanical | `reconcile.ts:208-210` | `num()` asserts rather than converts, so a string timestamp concatenates and stamps the row centuries ahead | confirmed | #878 | `wrong-data`. Crux settled first: a STRICT INTEGER column **does** accept a well-formed integer string losslessly, so `backup.ts`'s documented bind-time defence fails. Two limbs disproved — the plain LWW path stores correctly, and the skip comparison folds a string and its numeric twin together. Reachability capped: no first-party writer can emit it |
| U2-9 | Performance | `reconcile.ts:219-223` | The tombstone list is rescanned once per table per side, ~88 times per merge | rejected | — | Arithmetic correct (41 tables × 2 + 6 = 88). Measured: at a realistic 10,000 tombstones the whole thing costs **2.4 ms** and the best possible fix saves **1.5 ms**, in the worker. The ratio *falls* with size, because the per-entry `Map.set` is the cost and both shapes pay it. Below the threshold for recording as a defect |
| U2-10 | Mechanical | `reconcile.ts:201-206` | `upsertWouldNoOp` folds `null` and `''` together, suppressing a real write on an exact tie | rejected | — | The fold is real and permanent, but the state is unreachable: **no schema default is `''`**, every repository normalises `'' → null` before writing, and no merge repair writes one. The looseness is also partly load-bearing — it is what makes a `bigint` and a `number` compare equal, so a strict comparison would break #161's fix |
| U2-11 | Mechanical | `reconcile.ts:272-284`, `:2015` | The surviving-item set is derived before the cycle guard splices rows out | confirmed (widened) | #889 | `unusable`. **Finder rated it LOW and could not reach it; the verifier confirmed it, found the route via #818, and widened it to three limbs** — the locations set has the identical fault, and the third is not an ordering bug at all but a survivor left pointing at a removed row. A first-time device pairing is the reliable trigger. Note the fix for limbs 1–2 does not address limb 3 |
| U3-1 | Mechanical | `sync-engine.ts:352-355` | The tombstone prune's cutoff is server-frame while `deleted_at` is local-frame | confirmed | #871 | `data-loss`. Controls at 0 days and 100 days pass; 200 days fails — isolating the frame rather than "any skew". Consequence worse than claimed: the device drops the marker from the snapshot it publishes, so the whole vault forgets the deletion. The adjacent sweep in the same pass converts correctly, with a comment saying why |
| U3-2 | Functional + Performance | `providers/google-drive-api.ts:107-136` | The Drive push is non-resumable, unbounded, and the create path builds a second full copy | confirmed (split) | #907 | `degraded`. Memory limb measured at exactly **1.00× extra on create, 0.00× on update** — and **narrowed to the first push per connection**, since the file id is cached. New limb found: above 512 MiB the concatenation throws where the update path would have succeeded. **The size-ceiling limb is UNVERIFIABLE — see §11** |
| U3-3 | Mechanical | `sync-engine.ts:226-231`, `clock.ts:17-20` | The sync offset has no plausibility check, while the skew feature refuses the same reading | confirmed | #872 | `data-loss`. Both paths verified to share one measurement. A peer's genuinely newer edit destroyed with `conflicts: 0`. **The implied fix was disproved**: a ceiling alone would break the genuine-slow-clock case, and a four-hour bogus header does the same damage as a 400-day one. Converse of the reasoning recorded when #326 and #393 closed |
| U3-4 | Mechanical | `sync-engine.ts:231` | `??` does not catch `NaN`, so `effectiveNow` is unguarded where the offset is guarded | confirmed (folded) | #872 | Folded into U3-3 as a limb rather than filed alone. Latent — no shipped provider can emit it, and it fails loudly (a NOT NULL abort) rather than silently. Residue worth carrying: the throw is a bare `DbError`, so the screen discards the merge's conflict records |
| U3-5 | Functional | `SyncScreen.tsx:513-516,277-289` | Disconnect is the only control not gated on `busy`, and using it mid-sync reports an expired sign-in | confirmed | #896 | `degraded`. The 401 is not a stub — the real transport path was driven. Wider than claimed: the token is consulted on every request, not only the upload. Second limb (a stale stamp landing on a newly connected remote) narrowed but real |
| U3-6 | Prompt | `providers/file-system-provider.ts:89-90` | The zero-byte guard's stated reason contradicts its own file 13 lines later | rejected | — | The inaccuracy is real and quotable. But deleting the guard is behaviourally a no-op — the next line throws the same class with the same message — so the worst outcome of acting on the wrong comment is removing two unobservable lines. The comment's *conclusion* also survives by a mechanism it does not name (the handle is created before the write) |
| U3-7 ≡ U4-7 | Functional | `sync-status-format.ts:5-129`, `SyncScreen.tsx`, `BackupDialog.tsx` | Both screens nest fully translated sections inside untranslated ones, and the sync outcome is English-only | confirmed (reframed) | #906 | `degraded`. Found independently by U3 and U4; filed once, since it is one shape and the same picker is used by both. **The "convert these screens" limb is rejected as #60's.** What survives: the i18n programme's screen-by-screen breakdown (#230–#244) has no ticket for Sync, Backup, Archive, Storage or Danger Zone, and #233 records that it came from a walk of every source file — so it is a gap, not a deferral |
| U3-8 | Functional | `SyncScreen.tsx:342-353` | The missing-remote guard is disarmed for any newly connected remote | rejected | — | A recorded decision whose stated rationale covers this exact trigger, and the harm does not reach the guard's purpose — publishing into an empty folder discards nothing. The finder's basename argument runs the wrong way: two folders sharing a basename **keep** the watermark, so the guard stays armed for the most confusable case. Residue recorded in §11 |
| U4-1 | Mechanical | `restore-backup.ts:52-55`, `backup-format.ts:737` | The chosen zip is inflated whole, synchronously, on the main thread, with no size cap | confirmed (reframed) | #883 | `degraded`. A 0.50 MiB file allocating **512 MiB** and blocking 1936 ms, measured. **The SECURITY framing was deflated**: no automatic or remote ingress, one caller behind a file picker and a permission check, consequence confined to the tab. Project precedent (#641, #762) is not security-framed either. Verifier also found the identical shape at `restore-archive.ts:128-136` |
| U4-2 | Mechanical + Prompt | `restore-backup.ts:152` | `applySettings` runs past the commit unguarded, so a refused storage write fails a landed restore | confirmed | #880 | `unusable`. **Limb disproved**: the user does not see "The restore failed." — `useErrorMessage` passes the raw `DOMException` through, which is worse. Two limbs found beyond the claim: the write is partial, and the count of what landed is lost. Every other storage write in the app is guarded, with comments naming this failure |
| U4-3 | Mechanical + Prompt | `settings-groups.ts:448-453` | The merged preferences keep the backup's envelope, so store migrations re-run over un-restored local fields | confirmed | #881 | `wrong-data`. **The verifier found the reachable instance the finder missed** (a v0 backup silently zeroing low-stock thresholds) and showed the finder's own example needs a same-day window in July 2026. `git log -S` proves the docstring's premise died in the same commit that wrote it |
| U4-5 | Mechanical | `backup-format.ts:619-644,690-713` | The manifest is an allow-list in one direction only, so an undeclared entry is used unverified | rejected | — | Mechanically true and demonstrated. Consequence-free: no non-adversarial route (the manifest is derived from the entries written), and it grants an adversary nothing, because the digests are unkeyed and live inside the file — squarely inside `checksum.ts`'s stated scope. The images half **is** bidirectional. The one real consequence is #760's |
| U4-6 | Mechanical | `safe-mode-actions.ts:61-76` | The database is disposed before it is written, so a failed write destroys data and reads as "nothing happened" | duplicate #750 | — | Same mechanism, same four locations, same severity as #750. **"Partly overwritten" is false**: the writable is aborted and the original keeps its contents (#203). The genuine third corner — a failure that *had* touched the data — is U4-2, which is outside both #750 and #759 |
| U4-8 | Mechanical | `backup-format.ts:738-740` | A memory failure while unzipping is reported as "not a Gubbins backup" | confirmed (folded) | #883 | Folded into U4-1 on the verifier's recommendation — a cap removes most of the failures that produce the wrong sentence, and the fix is one line in the same function. Cause discarded, nothing logged; the sibling zip worker deliberately keeps its cause |
| U4-9 | Functional | `BackupDialog.tsx:606-616` | The settings-group picker is the one control not held while a restore runs | confirmed | #900 | `cosmetic`. Filed with U4-11 as one small change to one file. **Widened slightly**: the control does not merely do nothing, it contradicts what is happening — the boxes read unticked while those groups are being restored. Wiki limb disproved: its "stays put" promise is about dismissal |
| U4-10 | Functional | `snapshot.ts:1206-1232` | A wipe-and-clone Replace resets every photo's downgrade marker | rejected | — | Mechanism confirmed and demonstrated, with a merge-mode contrast proving the test falsifiable. But the resulting state is **indistinguishable from the ordinary post-sync state** — full-resolution bytes never travel, so every peer already holds that combination, and every consumer is written for it and says so. All three asserted harms disproved. Residue in §11 |
| U4-11 | Mechanical | `BackupDialog.tsx:397` | Nothing pins #654's wiring at this call site | confirmed (folded) | #900 | Test-suite limb true — **887 tests stay green** after deleting the line. But **"nothing pins it" is disproved**: `npm run type-check` fails on that exact mutation, because the flag becomes unread. A narrower rewiring would still slip through, so the gap is real and smaller. Folded rather than filed alone |
| U4-12 | Prompt | `BackupDialog.tsx:100` | "Guaranteed recovery" describes a copy the app refuses after any schema change | confirmed (narrowed) | #887 | `cosmetic`. Filed with U4-13. Fingerprint shown to move on a one-column edit, against 103 commits touching the baseline. **Narrowed**: the exact copy is not wholly dead — it survives via the recovery screen's archive route, which is undiscoverable but real |
| U4-13 | Prompt | `docs/wiki/Backup-and-Restore.md:221-236` | The wiki's override paragraph covers a restore that offers no override | confirmed (one limb disproved) | #887 | `cosmetic`. The function's arity is the proof — there is no force parameter to call. **Limb disproved**: the same sentence's claim that a restore point is saved first **is** true for this dialog; only the override half is wrong. The page contradicts itself four lines apart |
| U5-1 | Mechanical | `images/full-res-policy.ts:43-52` | A photo added at the critical tier writes a global fact into a per-device column | rejected | — | Every mechanical premise true and demonstrated. Failed on two axes: it is a **recorded decision** (`full-res-policy.ts:9-12` states the conflation as the design; `opfs-images.ts:62-68` mandates the pairing), and the consequence is not distinctive — a control row proved the peer counts **2 of 2**, because it holds the same belief about every synced photo |
| U5-2 | Mechanical | `triage-actions.ts:109-113`, `opfs-images.ts:323-332` | A failed image delete still stamps the row downgraded | confirmed (narrowed) | #885 | `wrong-data`, low frequency. **Narrowed on three limbs**: the space IS reclaimable by deleting the photo or item (demonstrated); the toast reports a count, not bytes; and no access is lost, since no read path consults the marker. Field frequency could not be established and is not claimed |
| U5-3 | Mechanical | `opfs-images.ts:101-121` | A partial image read is archived and described as complete | confirmed (widened) | #884 | `data-loss`. **Widened** — the finder missed `build-backup.ts:147`, the portable backup path, which matters because that zip is the only other carrier of full-resolution bytes. The container ends self-consistent, so no reader can detect it. Three-way contrast in one file: two siblings make the opposite, correct choice |
| U5-4 | Functional | `StorageRepository.ts:39-48,100-108` | Triage measures and prunes only the Items half of the activity log | confirmed (narrowed) | #886 | `cosmetic`→`degraded`. Demonstrated at 1,000 rows reporting 0. **Narrowed hard**: "no route to reclaim" is FALSE — a dedicated Danger Zone target exists — and growth is bounded by hierarchy edits, so this is not a plausible cause of exhaustion. The defect is the mislabelling; #690 is the precedent on the neighbouring screen |
| U5-5 ≡ U6-9 | Functional | `StorageTriageDialog.tsx:271-299`, `EraseDataDialog.tsx:505-513` | Arming a destructive confirmation drops focus to `<body>` and the alert is never announced | confirmed | #897 | `degraded`. Found independently by U5 and U6; filed once, since `EraseConfirmRow`'s docstring says it mirrors `ConfirmRow`. Trap-escape limb **rejected** and independently re-confirmed. Distance measured: 3 tabs in one dialog, 6–8 in the other. The row is a `<span>` with no `tabindex`, so a naive `.focus()` fix would be a silent no-op |
| U5-6 | Functional | `auto-archive.ts:156-161` | The weekly archive stamps itself done on a save it never observed | confirmed (re-footed) | #905 | `degraded`. **The save-before-destroying rule was attacked and does NOT carry this** — it governs paths that *destroy*, and `download.ts` scopes itself the same way. What survives is narrower and does clear the bar: an unverified save writing a durable fact that retires the prompt for seven days. Corroborated in a real browser with downloads denied |
| U5-7 | Prompt | `StorageTriageDialog.test.tsx:3-5` | The test file asserts a permission rule its component rejects, and cannot fail if the keys are collapsed | confirmed | #899 | `cosmetic`. Mutation is the evidence: collapsing the two keys leaves **3/3 green**. The missing case written and shown to discriminate. Finder's line numbers were wrong (the file is 82 lines) |
| U5-8 | Functional | `StorageTriageDialog.tsx:271-292,331-352` | A failed candidate count renders "0 entries affected" beside a permanently dead button | confirmed | #898 | `wrong-data`. Driven through the real hooks with only the repository boundary stubbed. Widened: the failure is entirely silent and the healthy sibling section stays enabled, so nothing signals that half the dialog is broken rather than empty. The breakdown directly above does consult its state |
| U5-9 | Prompt | `StorageRepository.ts:12-15` | The docstring says `item_images` is not a synced table, when it is | confirmed | #888 | `cosmetic`. Asserted rather than eyeballed. Conclusion true, stated reason false; the same file states it correctly 80 lines below. Earns its place only because the wrong reason invites omitting the next per-device column from the exclusion list |
| U5-10 | Performance | `triage-actions.ts:62-77`, `triage.ts:145-158` | The history archive materialises everything and pretty-prints it, on a device short of space | confirmed (widened) | #902 | `degraded`. **Widened to the larger defect beside it**: the paged read is quadratic — 226× a single statement at 100k rows, ~30 s behind an un-dismissable modal — because each page re-scans and re-sorts. **Limb disproved**: indent 2 costs **1.48×**, not "roughly double". Memory measured at 2.78× the payload |
| U5-11 | Performance | `triage-actions.ts:108-113` | The image downgrade is two sequential awaits per image with no batching | confirmed (reason corrected) | #903 | `degraded`. 2,000 images cost **13.1 s** against **37 ms** batched, on real OPFS in a real browser. **The stated reason is wrong by two orders of magnitude**: the worker round trip is 34 µs/call, 68 ms of 13,098. The cost is the per-row autocommit. The proposed remedy survives, but the issue had to say "transaction boundary" or it would be fixed in the wrong place |
| U5-12 | Prompt | `tiers.ts:53-61`, `StorageBanners.tsx:272-273` | A parity claim between a predicate and the critical banner's English, with no drift test | confirmed (re-aimed) | #908 | `degraded`, latent. **The finder's own mutation disproved its framing** — changing the predicate fails 3 tests, so that side is well guarded. Inverting it onto the copy shows the banner can be made to say the opposite with **12448/12448 green**. The docstring was authored by #199's fix, which was this drift live. Critical and warning banners are rendered by no test |
| U5-13 | Performance | `useStorageStore.ts:41-46,293-317` | The quota poll runs for the tab's life with no visibility gating | rejected | — | Mechanical premises all true, including that `stopMonitoring` is called nowhere in app code. Measured on a populated origin: one tick is **0.071 ms**, so the worst cadence costs **0.41 s of main-thread work per day**. No leak either — start is idempotent and the timer is cleared before re-arming. Contradicts the recorded decisions at `:8-18` (#200, #504) |
| U5-14 | Performance | `auto-archive.ts:119-149`, `zip-in-worker.ts:117-119` | The archive holds every image plus two database copies in main-thread memory | confirmed (narrowed) | #904 | `degraded`. **611 MiB peak for a 260 MiB vault**, measured. #752's boundary read line by line: it owns the export copy and names the redundant slice at two sites, not this third one, and never mentions images. Decisively, #752 **asserts the opposite** of what is true here — the vault worker transfers on its *return* leg only — so folding would have buried it |
| U6-1 | Mechanical | `erase-targets.ts:189-194,543-545` | "Empty custom locations" ignores surviving children, so the whole erase aborts at COMMIT | confirmed | #873 | `unusable`. Verifier re-ran with the **complete** predicate (the finder had narrowed it) and read the FK actions from the built schema rather than the migration source. Control with parent links removed erases cleanly. Found an escape hatch the finder missed: selecting items and locations together succeeds |
| U6-2 | Functional | `erase-targets.ts:189-194,498-548` | The predicate omits the borrower column, so a lending location is deleted and its stock never returned | confirmed (widened) | #874 | `data-loss`. Mirror test shows the ordinary delete path restores the stock and writes a ledger row; this one does not. **Widened**: no tombstone is written for the destroyed checkouts either. Permission limb confirmed — `locations:delete` alone destroys checkouts. **Copy limb partially disproved**: "holding" is defensible; the omission is the defect |
| U6-3 | Functional | `erase-targets.ts:729`, `erase-actions.ts:190-195` | Clearing sync links in the same erase destroys the markers that erase just wrote | confirmed | #879 | `wrong-data`. Statement-index check first, then the merge driven with an items-only control that survives. **Limb disproved**: the zeroed cursor does **not** force a full re-pull — resurrection is the missing markers alone. Second effect observed but not driven: conflict detection appears disabled for the following pass |
| U6-4 | Functional | `local-store-resets.ts:76-78`, `useSessionStore.ts:46` | "Cloud sign-in" also signs the user out of Gubbins, skipping every safeguard | confirmed | #882 | `degraded`. **The escalation limb was REJECTED — not exploitable.** Reads are not enforced at the data layer by decision (#522), so there is nothing in the window to bypass; only already-active queries refetch; nothing writes; and the window self-closes in one macrotask, measured. Bridge-token residue of #521 survives as a limb |
| U6-5 | Functional + Prompt | `EraseDataDialog.tsx:265-270` | The failure toast claims nothing was removed and points at an empty console | confirmed (narrowed) | #893 | `degraded`. The console half is wrong **100% of the time** — zero logging in the feature, verified. **Narrowed**: most post-commit steps *cannot* throw (two swallow internally, the invalidations are internally caught), so the "no data removed" half needs a storage failure. Consequence found beyond the claim: the store reset is skipped, so a local target un-erases itself |
| U6-6 | Prompt + Functional | `erase-targets.ts:651-660` | "App preferences" silently destroys the bridge token and address | confirmed | #892 | `degraded`. Demonstrated, including that the narrow target keeps the address as its copy promises. Recovery cost is load-bearing: the token cannot be looked up, only replaced. **A permission-escalation angle was tested and does not exist** — the same two roles may erase both |
| U6-7 | Mechanical + Prompt | `lib/save-file.ts:150-172` | The save seam aborts a failed write but not a failed close | confirmed (narrowed) | #895 | `cosmetic`. Controls prove the abort path works and the failure propagates, so nothing is destroyed. **Three narrowings**: the comment sits inside the write branch and claims nothing about close; half the sibling's rationale does not transfer; and the harm itself is **unverified** — see §11. Ceiling set by #650, which calls the same shape "a papercut" |
| U6-8 | Functional | `EraseDataDialog.tsx:517`, `erase-targets.ts:245` | "Sync deletion: off" does not keep the erase local, and the next sync restores the data | confirmed (widened) | #891 | `wrong-data`. **Widened to the irreversible half the finder missed**: the items return but their history cannot, because the erase advances a device-local watermark regardless of the toggle. Not a two-device edge case — every push is a full snapshot, so one device syncing to a folder undoes its own erase. The wiki actively recommends the broken setting |
| U6-9 | — | — | — | see U5-5 | #897 | Reported independently by U6; recorded on the U5-5 row |
| U6-10 | Prompt | `erase-targets.ts:13-20` | The catalogue claims to list every cascaded child table and omits seven | confirmed | #894 | `cosmetic`. 19 tables cascade from `items`; 12 are listed. The rescue was driven and holds, with a control proving the fixture live. **Two parts of the claim disproved**: not all seven are in the synced set, and the FK registry does **not** carry an entry for three of them — they are rescued by different mechanisms, which is itself an argument the header misleads |

### Phase 5 — App shell, platform and shared libraries

Pinned SHA: `97a7e06c93ddd1629069103a8ec455867ccac478`

Twelve finder units (U1 boot and rescue, U2 router and base path, U3 service worker and CSP,
U4 stores and query client, U5–U7 the shared libraries in three parts plus the `src/lib` guard
tests, U8 `lib/env`, U9 design tokens, U10 the i18n seam, U11 hotkeys and modules, U12 errors and
the small screens). Roughly thirty verifier passes. Four candidates were reported independently by
two units and are recorded once, on the row named in the Notes.

| ID | Class | Where | Claim | Verdict | Issue | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| U1-1 | Mechanical | `SafeMode.tsx:40`, `useDatabaseBoot.ts:77-89,207` | The tab lock is never released, so Safe Mode's "Try again" shows "Already open elsewhere" for a single tab | confirmed | #929 | `degraded`. Settled in **three** real browsers before the app: a document queues behind its own lock, `held` and `pending` sharing one `clientId`. Driven to a screenshot. `whenReleased` is unsatisfiable by construction, so the promised auto-takeover cannot fire. #763 is a genuine two-tab bfcache case, not this |
| U1-2 | Functional | `en.json:191`, `BootScreens.tsx:243` | "Start without it" never says the fallback store is permanent for the origin | confirmed (narrowed + widened) | #942 | `degraded`. Pinning proven in the browser; a seeded fallback origin opens the fallback on every later boot **while isolated**, with the control picking the primary store. Narrowed: the gate already waits 20 s, so "a slow first install" overstates the trigger. Widened, and this is the stronger half: "everything works the same" is also untrue — the Safe Mode rescues cannot reach the database from the main thread there, and #766 exists only on that layout |
| U1-3 | Functional | `RescueActions.tsx:242-245`, `useConfirmSaved.tsx:12-16` | The boot/rescue family is half-translated, and the comment justifying the untranslated half is false | duplicate #243 | — | Both mechanical limbs true and demonstrated, including a German card with English buttons. **Both novelty limbs fail**: the partial split *predates* #243, and #243 pre-emptively refuses the justification (*"This ticket needs to confirm `useT()` is safe pre-hydration"*). The four-state disproof was posted as a comment there, since it answers that ticket's own blocking caveat |
| U1-4 | Mechanical | `SafeMode.tsx:14` | Reads the thrown value directly instead of going through `useErrorMessage` | rejected | — | Recorded decision. `error-copy-idiom.test.ts` excludes `src/db` and `src/app/error` **wholesale**, with the reason in its docblock and in the memory vault. `RouteErrorScreen` carries the same reason as an explicit `ALLOWED` entry. The finder's "the reason is spent because `RescueActions` uses the hook" fails — `RescueActions` does not match the idiom at all |
| U1-5 | Functional | `safe-mode-actions.ts:405-408`, `app-shell-reset.ts:17-28` | "Reinstall app files" cannot report having done nothing | confirmed (narrowed) | #963 | `cosmetic`, marginal. The alarming half **dies**: every surface rendering `RescueActions` sits downstream of a passed OPFS check, so both APIs exist and the escalation-to-purge chain is unreachable. What survives is a result type and a docstring promise no caller can keep |
| U1-6 | Mechanical | `safe-mode-actions.ts:441-445` | `indexedDB.deleteDatabase` is not awaited before `location.reload()` | rejected | — | Ordering reproduces; consequence **measured at zero**. 60/60 deletes completed across Chromium, Firefox and WebKit. The only shape that loses is a second tab holding a live connection, which `fs-handle-store`'s close-after-every-operation and the single-tab guard prevent. The `sessionStorage` limb is documented scope (`storage-keys.ts:14-17`) |
| U1-7 | Functional | `index.html:402-427`, `:85-88` | The `file://` guide reveals for **any** pre-mount failure and states one cause as fact | confirmed (narrowed) | #912 | `unusable`. Screenshotted on a COOP/COEP origin with a corrupt entry chunk; `?recover=1` proven to work on the same broken build. The `main.tsx` limb **dies** — three hostile-input probes (invalid JSON, hostile types, malformed OAuth fragment) all mounted normally — so the path narrows to bundle delivery. Not #741, which is the hatch's test coverage |
| U1-8(a) | Mechanical | `coi-bootstrap.js:48` | The reload counter uses `gubbins-`, so the storage-key registry cannot see it | rejected | — | The registry documents itself as covering `gubbins:` keys. Demonstrated that the scanner is blind to `public/` **regardless of namespace**, using a correctly-namespaced probe. Six registered `sessionStorage` keys are equally unsweepable by design. `coi-bootstrap.test.ts:104` makes a rename loud, so P1-28's reasoning applies |
| U1-8(b) | Mechanical | `coi-bootstrap.js:48-55` | The budget is never reset on success | confirmed (narrowed, re-framed) | #943 | `degraded`. Re-framed: an exhausted budget **manufactures a false `settled` verdict**. #260 decided the cap and the fallback boot, not the reset. On `layout === 'none'` the gate falls through with **no screen and no waiver** — proven by the repository's own passing test. Reachable in two clicks in the order `RescueActions` presents them. Narrow fix at `coi-bootstrap.js:28` |
| U1-9 | Functional | `RescueActions.tsx:229-232` | A landed restore is presented as a red failure | confirmed (widened) | #930 | `degraded`. Premise verified: `StaleJournalError` is only reachable after the bytes commit, on both paths. **Widened beyond tone**: the generic tail leaves three buttons live that re-open the database beside the hot journal, which the error class's own doc forbids. Limb 2 (the lost image shortfall) **rejected** as documented, tested precedence. #759 is the same symptom one layer down; this is the residue its fix would leave |
| U1-10 | Mechanical | `safe-mode-actions.ts:442`, `erase-targets.ts:724`, `fs-handle-store.ts:14` | `'gubbins-fs'` is a triplicated literal with no exported owner | confirmed | #931 | `degraded`, latent. Renaming `DB_NAME` left **zero new test failures** (1200 passed either way) while both erase paths silently no-op. No comment claims parity, so the rule does not fire on its face — but L-8/#868 and U1-4/#901 are the governing precedent for an unstated-parity case with a demonstrated consequence, and a live File System Access grant survives both erases |
| U1-11 | Performance | `safe-mode-actions.ts:330-351,454-458` | The JSON rescue dump materialises the database twice in memory | confirmed (narrowed) | #911 | `unusable`. **The mechanism is not the one claimed.** Not memory pressure: a hard V8 string-length ceiling of 536,870,888 chars, verified identical in Chromium, failing on a 64 GiB desktop. Reachable at ~7,000 photographed items with a cover field. Three limbs disproved — pretty-printing is only 10.8%, it is not a phone problem, and the failure *is* reported, as the bare string "Invalid string length". `uint8ToBase64` measured at 69–70% of stringify time |
| U1-12 | Functional | `RescueActions.tsx:335-339` | "This overwrites all local data" is not what a `.sqlite` restore does | rejected | — | Consequence **disproved**: the thumbnail lives in the database and travels with the `.sqlite`, and the app is written for "database present, full-res absent" because that is the ordinary state on every synced peer. A cross-device restore yields thumbnails, not blanks. The copy is an **over**-promise, the safe direction. Fold the one-line tweak into #395 if wanted |
| U1-13 | Mechanical | `recovery.js:84-95` | `clearShell()`'s ordering guarantee races the app bundle | rejected | — | **Two independent runs, reconciled.** Run 1 served assets `no-cache` and saw 0/3; run 2 served them `immutable`, as a static host does, and saw 5/8 — the race *is* reproducible on a **healthy** bundle. Both agree the dead-bundle case, the only one `recovery.js` exists for, holds 3/3. Limb 2 also rejected: `showMessage` does remove `#root`, but `main.tsx` is a deferred module whose null check has already passed, and nothing throws in ~20 loads |
| U2-1 | Functional | `NotFoundScreen.tsx:38-42,80-90` | Hovering a 404 suggestion opens the Settings dialog with no click | confirmed (widened) | #915 | `degraded`. Router source read: `onFocus`, `onMouseEnter` **and** `onTouchStart` all enqueue a preload at a 50 ms delay, and `preloadClientRoute` runs `beforeLoad` even for a redirecting route. Driven in a browser to a screenshot, plus a component test with a preload-off control. **Two verifier runs disagreed on dismissal; the lead settled it** — `[SPOTCHECK] reopened after a second focus: true`. Sweep: this is the only unguarded `<Link>` |
| U2-2 | Mechanical | `Dockerfile:95-96` vs `base-path.ts:31` | The two normalisations disagree on the empty string | confirmed (narrowed) | #913 | `unusable`. Built and run: the image builds, `nginx -t` passes, `HEALTHCHECK` reports healthy, `curl /` returns 200 — and 86 `.js` requests answer `200 text/html`. The browser shows the `file://` fallback, which blames the user. **Whitespace limb rejected** — it fails `nginx -t`, so that image never builds. CI covers only `/` and `/gubbins/` |
| U2-3 | Functional | `DeepLinkScreen.tsx:32-36` | An errored item lookup leaves a permanent spinner | confirmed (widened) | #938 | `unusable`. Three green controls; premise verified against the real `useItem` and a real query client (`isError` latches in ~1.0 s after one retry). Reachability is named by `worker-driver.ts:9-19` itself — `WORKER_TIMEOUT` and a latching `WORKER_UNAVAILABLE`. **Rose from `degraded` once U4-C1 was confirmed**: a paused query is a third uncovered state and needs only `navigator.onLine === false`. #306 fixed the same habit on four other screens |
| U2-4 | Mechanical | `ShareTargetScreen.tsx:34-36` | The stash is cleared before the `cancelled` check | confirmed (narrowed) | #910 | `data-loss`. The finder's StrictMode probe is **refuted**: under StrictMode the draft is seeded with no name and no `sourceUrl`, so a **dev build always produces an empty draft**. Production limb is latent — no routine unmount named; the strongest candidate is a Back press during a multi-megabyte photo read. `pruneStaleShares` proven unable to restore a cleared share |
| U2-5 | Performance | `__root.tsx:6` | `CommandPalette` is eagerly imported into the entry chunk | rejected | — | Measured: entry chunk −10.48 KiB raw / −2.88 KiB gzipped, eager graph −0.89% gzipped, and the precache **grows** by 5 entries. Three of the five claimed payloads (inventory queries, mutations, `lib/fuzzy`) never leave the eager graph. Ctrl+K would not break — the hotkey lives in the store — so the rejection is on magnitude alone. Incidental lead recorded in §11 |
| U2-6 | Prompt | `browser-smoke.mjs:180-186` | The comment describes `index.html` code that no longer exists | confirmed (narrowed) | #961 | `cosmetic`. False in the present tense and contradicts `index.html:11-16`; git history dates the drift to two efforts a week apart. **The "masks a genuine 404" limb dies** — nothing but re-introducing the exact bug can emit that URL, and the sibling `recovery.js` would fail correctly. Phase 0 territory; no Phase 0 row covers it. `PHASE_HANDOVER.md` is a dated record and was left alone |
| U2-7 | Mechanical | `Run.ps1:75` | The hard-coded base path hangs the readiness probe | rejected (duplicate of the Phase 0 §11 carry-over) | — | The **new** behavioural limb is false: the probe returns 200 (Vite's history fallback plus dev isolation headers), so the launcher opens immediately and the user gets a recoverable in-app not-found screen. Stripped of it, this is P0-46 restated |
| U2-8 | Mechanical | `route-suggestions.ts:47-58,88-91` | The `basepath` parameter is unreachable and its docstring describes an impossible case | rejected | — | Premise true — the router strips the basepath, verified over six real pathnames. **The trap is disproved**: passing a basepath changes the segment list in 3 of 6 cases and the suggestions in **none**, because `gubbins` scores below the threshold. Below §1's consequence bar. Belongs to Phase 17's dead-code sweep (precedent #377) |
| U3-1 | Mechanical | `sw.ts:257-259` | `activate` deletes every Cache Storage entry on the origin | confirmed | #925 | `degraded`. Control passes, case fails with foreign names taken from the neighbours' live `sw.js`. **Two other offline-capable apps share the origin today**, both with the same bug — so the harm is bidirectional, and opening one of them deletes all five Gubbins caches. Filed as one issue with U3-8 |
| U3-2(a) | Mechanical | `sw.ts:151-158`, `:316-331` | The superseded-precache prune runs after `addAll` | confirmed (narrowed) | #935 | `degraded`. Placement is **not forced** — the prune reads only `SW_STATE_CACHE`, `caches.keys()` and the module constant. Peak is ~6.1 MiB above the comment's claim. Sharper harm: the prune is also the recovery, gated behind the write that needs recovering |
| U3-2(b) | Mechanical | `sw.ts:154` | No `catch` around `cache.addAll` | confirmed (narrowed) | #935 | `degraded`. Missing catch real; **stated consequence disproved** — Docker sends real COOP/COEP so the chain breaks there, and on Pages the boot gate waits 20 s then offers the waiver, so the database does open. What survives: no offline capability, silent failure, possible permanent fallback pinning. **Partial overlap with open #739**, which already names this line and the 404 trigger; scoped to the missing catch |
| U3-3 | Mechanical | `sw.ts:55-59`, `:274-277` | The manifest dedupe keys on the raw URL, `addAll` on the resolved Request | rejected | — | Latent only. The real manifest at **both** bases has 209 entries, 205 unique raw **and** 205 unique resolved. Identical by construction — vite-plugin-pwa emits icon entries from the glob match, not the configured `src`. The secondary cache-mode-flip claim is false today: all four duplicate pairs share a revision |
| U3-4 | Functional | `PwaUpdatePrompt.tsx:95-97` | "Skip this version" permanently suppresses newer data-resetting builds | confirmed (narrowed) | #936 | `degraded`. **Shared premise refuted for the hosted app** — `deploy.yml` has carried a version-uniqueness gate since #276, and one run failed on it. Survives for self-hosting (measured: two `0.32.0` builds, different `baselineRevision`) and for a documented rollback, which needs no premise. The update still lands silently; what is lost is the advance warning |
| U3-5 | Mechanical | `stale-chunk-reload.ts:62,69` | The recovery marker is keyed on `APP_VERSION`, so a tab can recover only once per release | rejected | — | Mechanism reproduces, but the docstring's premise is **upheld by the same deploy gate**; the existing test is a faithful model of the post-recovery state rather than theatre; a second stranding needs three builds under one version; and the cost is a browser refresh |
| U3-6 | Mechanical | `OfflineIndicator.tsx:26,29,40` | Three hard-coded English strings in already-converted global chrome | duplicate #224 | — | The novelty premise is **false**: the converted "global chrome" is `AppNav` and the nav labels only. #224 covers the two live-region strings, #60 the visible pill. Register note: the #230–#244 breakdown enumerates `features/*` only, so `src/components/` shared chrome has no owning ticket — a line for #224, not a new issue |
| U3-7 | Functional | `OfflineIndicator.tsx:26` | The offline announcement promises a sync the user may not have configured | confirmed (widened) | #937 | `degraded`. **Wider than claimed**: untrue for *every* user, because `runSync` has one caller (the Sync screen button) and `getActiveProvider()` is module-level state that is `null` on every page load. No connectivity-driven trigger exists anywhere. #73 is an open request to *make* it true |
| U3-8 | Functional | `recovery.js:118-131` | `?recover=1` empties Cache Storage wholesale | confirmed (narrowed) | #925 | `degraded`. Same root cause as U3-1, and worse — it is unfiltered on **both** sweeps, so it also unregisters the neighbours' service workers. **The bridge-outage limb is rejected**: `BridgeReloadNotice` re-registers the origin on every mount before its early return, and those three screens are the only places the app talks to the bridge |
| U3-9 | Mechanical | `useConfirmSaved.tsx:58-64` | A re-entrant call strands the first caller's promise | rejected | — | Unreachable at four independent points: a single-shot call graph (one `confirmUnverified` call site, three non-looping callers), the modal's own backdrop, an independent busy guard at each call site, and no keyboard or palette route. Both documented exits settle. Recorded: `useConfirmSaved` does not prove a save landed and does not claim to |
| U3-10 | Performance | `sw.ts:373,381` | `ignoreSearch` forces a scan of the whole precache on every GET | confirmed (narrowed) | #944 | `degraded`. Measured in-worker on a real activated registration: 0.43 ms vs 0.17 ms median, ~24 ms per warm load, **0 disagreements over 352 real requests**. Cross-origin limb **dies** (0 cross-origin GETs on a warm load); `caches.open` limb dies (0.09 ms); the low-end-phone multiplier is **not established** — CDP throttling does not reach off-main-thread work. Applies to both call sites, including the one the finder defended |
| U4-C1 | Mechanical | `queryClient.ts:12-23` | `networkMode` is left at TanStack's `'online'` default | confirmed (widened) | #909 | `data-loss`, and the phase's most serious finding. Driven in a real browser with the app's **own** bundled react-query singleton read in-page. Three limbs: writes hang on a spinner indefinitely (427 ms online); closing the tab **discards** the paused write, with no mutation persister anywhere; and reads return **wrong** answers rather than blanks, because `keepPreviousData` keeps the previous result set. The pill promises "changes are saved locally" throughout. Narrowing that also explains why it went unnoticed: `onlineManager` never reads `navigator.onLine`, so a cold offline launch is unaffected and any reload clears it |
| U4-C2 | Mechanical | `useSavedSearchesStore.ts:29-34` | No custom `merge`, while two seams document one | confirmed (widened) | #922 | `wrong-data`. Both remote paths driven end to end through the **real** `applySharedSettings` and `applySettings`. `sameSettingShape` returns true for **any** array when the reference is the shipped empty default. The only one of the group with `backupIncluded` **and** `liveSyncable` — the only remote input. Complement of open #857, whose premise is false for this store |
| U4-C3 | Mechanical | `useModulesStore.ts:88-93` | A corrupt `intent` reaches `resolveEnabled` unreconciled | confirmed | #918 | `unusable`. Also reported independently by U11-C3. `null` throws from 46 call sites including `AppNav` and every gated screen. Fixture correction for whoever re-runs it: the stringy-`"false"` case reproduces only against a **real** registry id |
| U4-C4 | Mechanical | `useLabStore.ts:72-79` | The `merge` spreads the persisted blob after guarding one field | confirmed (widened) | #918 | `unusable`. Also reported independently by U12-C5. The **only** store whose merge spreads the persisted object; `git log -S` puts that merge in a **feature** commit (#455), not the #376 reconcile pass. `eraseGroup: null`, so the Danger Zone cannot clear it and `/lab` is behind the router — the only escape is the full purge. Lead demonstration for the issue |
| U4-C5 | Mechanical | `useAchievementsStore.ts:62-86` | `migrate` ignores the stored version and wipes a later blob | confirmed (narrowed) | #918 | `wrong-data`, latent. The **only** one of 17 stores that discards the other direction, against a posture two siblings state explicitly. Widened: the empty map is re-persisted at version 2, so rolling forward does not recover it. Not reachable today — version 2 is the highest ever declared |
| U4-C6 | Mechanical | `main.tsx:46,52`, `clock.ts:135` | `startLabClock` runs before `startClockSkew`, double-counting the device error | confirmed | #927 | `wrong-data`, developer-facing. Reported independently by U12-C6. The decisive evidence neither finder cited: `clock.test.ts:103-113`, the #326 regression test, sets the skew **first** — the reverse of `main.tsx` — so the fix is green in CI and absent at runtime. Skew ceiling is a **full year**, and measurement is unconditional |
| U4-C7 | Functional | `SettingsDialog.tsx:1405-1413`, `ReminderNotifications.tsx:31,63` | Reminders and their settings are not gated on the `alerts` module | confirmed (widened) | #939 | `degraded`. **Widened** with a surface the finder missed: `AppNav` renders an alert-count badge on the menu trigger while filtering the Alerts row out of the menu, plus a dashboard live region announcing that badge's count. The registry defines `alerts` as a page, and that settles it **against** the code — those surfaces exist solely to point at that page. #636 is the identical shape, actioned as a bug |
| U4-C8 | Mechanical | six `*.test.ts` files | Guards sweep `process.cwd()` rather than their own checkout | confirmed | #940 | `degraded`. Demonstrated in **both** cwds with one probe: red from the worktree, green from the primary checkout, and the probe was never seen (18 tests, not 19). Two aggravating facts: all six carry a stale comment blaming the test environment, which `repo-path.ts:15-21` explicitly corrects, and CLAUDE.md **mandates** worktrees |
| U4-C9 | Mechanical | `useAuthStore.ts:53-58`, `useLocationExpansionStore.ts:54-59`, `usePwaUpdateSnoozeStore.ts:48-53` | Three more stores on the default merge | confirmed | #918 | `degraded` / `unusable`. The snooze store **widened**: a numeric `skippedVersion` makes `compareVersions` call `.split` on a number, from a component at the composition root — app-wide Safe Mode. `useLocationExpansionStore` takes out the Inventory screen. **A vector cited by the existing record is disproved**: a truncated blob fails `JSON.parse` and falls back to the defaults |
| U4-C10 | Mechanical | `persisted-store-versions.test.ts:30,54-69` | The version/migrate guard is per-file, and its floor is loose | confirmed (narrowed); floor limb rejected | #948 | `cosmetic`. Per-store limb survives, but the guard's own header **already documents** the precondition ("Every such file holds exactly one store today") — the residue is that nothing enforces it. Floor limb **rejected**: 17 files against a floor of 14 discharges its stated anti-empty-sweep purpose. Folded into the storage-key issue; same function, same fix |
| U5-1 | Functional | `calendar-days.ts:104`, `agenda.ts:452` | `addCalendarDays` overshoots a non-existent local midnight | confirmed (widened, then narrowed) | #919 | `wrong-data`. Reproduced with an **independent** control. Widened: **all three** forward bucket edges shift, in **five** zones (Cairo ~110M, Havana, Santiago, Beirut, Azores), one day per year each. Narrowed on blast radius: only the field-due and maintenance lanes are attributable — #495 already dominates the other three. `localDayWindowCutoff` and `fieldDueStatus` measured **immune**. The docstring, the module header **and** the memory note are all wrong |
| U5-2 | Functional | `bridge-url.ts:18-30` | A base URL with a query or fragment routes every call to `/` | confirmed (widened) | #941 | `degraded`. **Four** join sites, not two. Ingress proven live: the address field is not inside a `<form>`, so `type="url"` validation never runs, and rehydration checks only `typeof`. **The #385 framing is rejected** — CORS is per-request, so the app reads the error body and produces a *confident wrong* diagnosis, which is arguably worse but is a different failure mode |
| U5-3(a) | Mechanical | `date-input.ts:20-23` | `toDateInputValue` throws on an out-of-range instant | confirmed | #924 | `degraded`. Same root cause as U6-3 and filed with it. Adds five unguarded call sites and the blast radius: no error boundary, so the whole screen dies and a booking becomes permanently un-openable. `export-data.ts:314` guards the **unreachable** `NaN` case and misses the reachable band |
| U5-3(b) | Functional | `date-input.ts:20-23` | `.slice(0,10)` truncates an expanded ISO year | confirmed | #923 | `wrong-data`, and **distinct** — it is silent. `Date.parse('+010000-01')` is **not** `NaN`; it snaps the day to the 1st, so the round trip drifts by up to 14 days with no error. The corrupt band is ~34× wider than the throwing band, and breaks the module's headline "It round-trips exactly" |
| U5-4 | Mechanical | `date-input.ts:26-31` | `fromDateInputValue` delegates to a lax `Date.parse` | rejected | — | Non-UTC probe run: the non-ISO forms do resolve at local midnight. But `history-change-format.ts:60-64` records the split as deliberate in prose, `catalog-import.ts`'s guard is a shape check **plus** a rollover check that cannot move into the seam, and every remaining caller is a native date input whose value the HTML sanitiser guarantees. Noted as a secondary bullet on #923 |
| U5-5 | Mechanical | `clock.ts:135-142` | A shape-valid, calendar-invalid date rolls over instead of returning 0 | confirmed (narrowed) | #952 | `degraded`, developer-facing. `'2026-13-45'` gives +395 days. Ingress is exactly the case the docstring names — a malformed **stored** value, reachable through `useLabStore`'s unreconciled merge. The interface control cannot produce it |
| U5-6 | Mechanical | `derived-uuid.ts:21-28` | An unvalidated namespace collapses two different inputs to one id | rejected | — | Collapse reproduces, but the **name** argument — which the finder did not check — is clean at all nine call sites: 48/48 distinct on the free-text `batchKey`, safe by construction because the UUID fields pin the separators. Determinism holds. All five namespaces are literal constants, so §1's style-preference exclusion applies. `contacts.ts:221`'s prose rule is true **by construction** |
| U5-7 | Mechanical | `date-input.ts:42-46,75-80` | The year is not zero-padded | rejected | — | Real, and one half reaches an input (`RenewLoanDialog` seeds from `toDueDateInputValue`, and the asymmetric round trip would make a loan open-ended). Requires a loan due in years 1–999. Noted as a secondary bullet on #923 |
| U6-1 | Mechanical | `fuzzy.ts:55,61,64`, `CommandPalette.tsx:745` | Code-unit indices are rendered as code points | confirmed | #955 | `cosmetic`. One issue, two limbs, one root cause. Driven in the browser with screenshots. Limb 2 **narrowed**: FTS5 discards the emoji, so rows are **not** dropped — the loss is the highlight and the fuzzy re-rank. Scoring limb **rejected** (it never inverts an order). Screen-jump mode unaffected: no shipped label has an astral char or a length-changing fold |
| U6-2 | Functional | `highlight.ts:108`, `HomeAssistantSetupScreen.tsx:46` | `behavior: 'smooth'` overrides the reduced-motion catch-all | confirmed (widened) | #932 | `degraded`. Also reported independently by U9-C4. Settled in **three engines** with five controls, including the pair that proves the catch-all works when CSS is the mechanism. Widened to two sites. A side finding: **both** `scroll-behavior: auto !important` lines are inert, since nothing in the app ever sets `smooth` in CSS — which is what produced the two false comments. Not in the accessibility sweep, which names no motion issue |
| U6-3 | Mechanical | `format.ts:370-378` | Three date formatters throw where their siblings return a placeholder | confirmed (narrowed) | #924 | `degraded`. **`NaN` limb rejected as unreachable** — a `STRICT INTEGER` column coerces a `NaN` bind to `NULL`, and every `Date.parse` is guarded. The **surviving** limb is new: finite values in `(8.64e15, 2^53)` are legal `STRICT INTEGER`s that pass every `isFinite` guard and then throw. No ingest path range-checks a date column, though `backup.ts:87` already owns the predicate |
| U6-4 | Functional | `format.ts:341-346` | `bytes()` picks the unit before rounding the mantissa | confirmed (narrowed) | #956 | `cosmetic`. The band is exactly 0.0501% of every decade, computed. **Sub-1-byte limb rejected as unreachable** — every caller supplies an integer. The `ImportFileBanner` scenario does not arise at the 16 MB cap |
| U6-5 | Functional | `format.ts:379-390` | `relativeTime` compares unrounded and formats rounded | confirmed (narrowed) | #956 | `cosmetic`. `Intl` does **not** normalise it (checked). "Every rung" is wrong — the week rung is immune, its band empty. Real surfaces are the inventory cards, not the activity feed |
| U6-6 | Performance | `format.ts:251-261` | A rejected currency code is never negatively cached | rejected | — | Mechanism real, and a malformed code **is** storable — no `CHECK`, no normaliser. But measured: ~1.06 ms at the 100-row page cap, ~4.8 ms scaled to 4×, which is the band this phase rejected twice. The naive fix is not free either — caching `null` would key the map on unvalidated strings from a 64-char column, losing the bounded-cache property `moneyDecimals` guards for explicitly |
| U6-7 | Mechanical | `money.ts:193` | `apportionMoney`'s clamp silently mis-apportions | rejected | — | Arithmetic true, and an **OVER** case the finder missed (there is only a carry-up path). But all **ten** call sites — not four — partition by construction. 1,800 adversarial report builds: every live column re-adds to its headline. The only red was forced with a cast. Both breakdowns already ship a top-N cut and do it the safe way, folding the tail rather than dropping it |
| U7-GUARD-1 | Mechanical | `storage-keys.test.ts:28`, `persisted-store-versions.test.ts:136` | A camelCase key is invisible to both guards at once | confirmed | #948 | `degraded`. **Widened**: underscore and dot escape too, not just casing. Nothing enforces kebab-case — contrast `permission-registry.test.ts:32`, which does exactly that for another registry. `extension/src/background.ts:319` proves the spelling occurs. **P1-28 does not reject it** — that row turned on the scan catching the spelling |
| U7-GUARD-2 | Mechanical | the same two files | A key built by concatenation is invisible | confirmed | #948 | Same predicate, same fix; filed with GUARD-1 |
| U7-GUARD-3 | Mechanical | `foundry-native-inputs.test.ts:252` | `<select>` and `<textarea>` are not guarded | confirmed | #957 | `cosmetic`. The docstring's stated exclusion argues the **opposite** way — `Select` and `Textarea` supersede rather than delegate, and CLAUDE.md names all three controls. Structural note the finder missed: `GUARDED_CONTROLS` keys on a `type=` attribute, which neither element has, so the fix needs a second pattern shape. Computed-type limb **rejected** as documented |
| U7-GUARD-4 | Mechanical | `hover-reveal-touch.test.ts:35` | Display and width reveals are not matched | confirmed (narrowed) | #957 | `cosmetic`. **The headline limb is false and must not be filed**: #258's own controls used `opacity-0` and `max-w-0`, both inside the guard's list. No live offender — all seven reveal sites use opacity or max-width and are correctly paired |
| U7-GUARD-5 | Mechanical | `dialog-scroll-bleed.test.ts:386-391` | The sweep is line-scoped, so a wrapped `cn()` defeats it | confirmed | #957 | `degraded`, latent. Stronger than the finder had it: a **live shipped call site** (`rail-modal.tsx:289-291`) already has the vulnerable shape, and adding one argument re-adds the #417 bleed while prettier and the guard both stay green. Measured: any *conditional* bleed passes 110 columns and wraps |
| U7-GUARD-6 | Mechanical | `query-key-factories.test.ts:30,37` | Hoisting the key to a const defeats the guard | confirmed (narrowed) | #926 | `wrong-data`. **The finder's `agenda` limb is refuted** — `agenda-invalidation.test.tsx:145-152` catches it. What survives is wider: `agenda` is the only prefix with its own literal sweep, so a hoisted const or an unnamed factory claiming the `reports` prefix walks past everything. Type-annotation limb confirmed but latent |
| U7-GUARD-7 | Mechanical | `docs-todo-status.test.ts:239-247` | The walk is non-recursive and `\b` accepts a malformed status | confirmed (narrowed) | #957 | `cosmetic`. Both limbs confirmed, including the `done/`-side variant the finder only reasoned about — a malformed banner **inside `done/`** passes outright. Limb 3 (the `m` flag) is a **duplicate of open #584**. Governs this audit's own plan document: splitting it into `docs/todo/audit/` would take every phase record out of the guard's sight |
| U7-GUARD-8 | Mechanical | `safe-area-token.test.ts:201-211` | The raw-`env()` sweep cannot see CSS or HTML | rejected | — | Ran live and the hole is real, but scanning `index.html` would produce a **false positive** — its inline `<style>` is a documented tokens-only exception — and including `.css` would report the definition file as its own first offender. No consequence under §2 |
| U7-CAND-1 | Functional | `volume.ts:187` | A fixed volume unit renders ordinary containers as `0` | confirmed (widened) | #921 | `wrong-data`. Screenshotted: "Volume ≈ 0 m³" beside 150×100×50 mm. **Widened** — `volumetric-fullness-text.ts`'s own mitigation comment describes this failure and its fallback is a no-op under a fixed preference, so a 46%-full location is **announced** as "0 m³ of 0.01 m³". The finder's #416/#457 ordering is **backwards**: `aa8910b9` (#416) edited `volume.ts` in the same commit and skipped its formatter — a half-applied parallel edit, one decimal worse than the state #416 called broken |
| U7-CAND-2 | Prompt + Functional | `name-fold.ts:48-51` | `namesMatch`'s docstring claims spacing is folded and it is not | confirmed (narrowed) | #920 | `wrong-data`. Forks reproduced end to end against the real migrations and repositories. Reachability unguarded — `validateFieldInput` trims only. **Prompt limb rejected**: "spacing" is imprecise, not false, and the module's own test names the trim. Filed with CAND-3 |
| U7-CAND-3 | Functional | `name-fold.ts:45` | Invisible format characters and NBSP survive the fold | confirmed (narrowed) | #920 | `wrong-data`. Same root cause and one added step closes both. `name-lookup.ts:74`'s claim verified and **half-corrected**: the GLOB arm hands the stored side to JS, but the needle side is excluded before JS sees it — folding fixes both. Ingress documented by the repository itself (`label-template.ts:752-754`) plus a mechanical route through numeric HTML entities. **Full-width Latin dropped** — it needs `NFKC`, a much larger decision. The fix is not a one-liner: it falsifies `name-lookup`'s printable-ASCII invariant and changes sync unique keys |
| U7-CAND-4 | Functional | `name-fold.ts:45` | Turkish `İ` does not fold to `i` | rejected | — | Standards-correct (Unicode default full case folding), NFC cannot compose it, and the docstring never claims this direction — it records the **opposite** Turkish trade-off as an accepted cost. "Fixing" it needs locale-aware folding, which the module's step 3 explicitly rejects |
| U7-CAND-5 | Mechanical | `utils.ts:31` | Four spacing token families are not declared to tailwind-merge | rejected | — | Line numbers wrong (the file is 42 lines). **Two of the four families are vacuous** — never spelled as spacing utilities anywhere. Complete census: six dynamic candidates, all six fail. The false-contract premise fails; the JSDoc is written entirely about the safe-area family. Two by-products in §11 |
| U7-CAND-6 | Functional | `DashboardNav.tsx:326` | A converted screen builds a screen-reader string by concatenation | confirmed (narrowed) | #953 | `degraded`. A **third** limb the finder missed and the strongest: the count bypasses the seam's locale grouping, so a German user hears "100000" on one tile and "100.000" on the one beside it — and `DashboardNav.test.tsx:150` **pins** the ungrouped form. The `alertsAria` sibling one line away proves the catalog can express the whole sentence. Plural limb belongs to #225; the noun is comment-covered and #682-shaped |
| U7-CAND-7 | Functional | `useFullscreen.ts:26` | `supported` ignores `document.fullscreenEnabled` | rejected | — | The JSDoc measures exactly what it claims. The iframe limb is closed, and **not for the finder's reason** — a same-origin iframe reports `fullscreenEnabled: true` with or without `allow`. The policy limb is a deliberate opt-out. And the proposed fix would not close the stated symptom |
| U7-CAND-8 | Functional | `text-terms.ts:11` vs `autocomplete-filter.ts:42` | Two picker-search folds disagree | rejected | — | Mechanism **disproved**: `autocomplete-filter.ts:42` is `indexOfValue`, not a filter. The real type-ahead is `filterSuggestions`, which folds with `toLowerCase` — identical to `text-terms`. The stated symptom does not exist. The "single home" comment claims the AND-substring model, which holds across eight consumers |
| U8-C1 | Mechanical | `device-id.ts:36-46` | `getDeviceId` throws when `setItem` is refused | confirmed (narrowed) | #914 | `unusable`. **The boot gate does not catch it** — proven by driving `useDatabaseBoot` with a write-throwing `localStorage`: status reached `ready`, diagnosis never called. The finder's Safari-private-mode browser is **refuted** (WebKit bug 157010, fixed 2017). A real shape exists instead: genuine quota exhaustion within ~40 bytes of the cap, reproduced in Firefox and Chromium. This is the **only** unguarded `localStorage.setItem` in `src/`; four siblings guard theirs |
| U8-C2 | Mechanical | `feature-detection.ts:26-32`, `useDatabaseBoot.ts:101` | `hasOpfs()` is a presence check, so the actionable diagnosis is unreachable | confirmed (narrowed) | #949 | `degraded`. **The finder's headline example does not reproduce**: on the hosted deployment blocked site data also blocks the worker, so isolation fails first and the correct `site-data-blocked` screen renders. Reachable only where the origin is isolated **without** the worker — self-hosted nginx and the HA add-on. `feature-detection.ts` still has **no test file** |
| U8-C3 | Functional | `useInstallPrompt.ts:42-57,72-106` | The install event is captured per hook instance | confirmed (narrowed) | #950 | `unusable`. **Phase 6 file.** Second-instance limb demonstrated with the real seam and a control; `SettingsDialog` unmounts when closed, so its hook is always created after the event fired. New finding: `browser-smoke.mjs:4126-4153` opens Settings **first** then dispatches synthetically — the one ordering production cannot produce, so the end-to-end step passes on an affordance that never works. Timing limb **unverifiable** — see §11 |
| U8-C4 | Mechanical | `device-id.ts:24,36-45` | The memoised id can diverge and is stamped into a permanent column | confirmed (narrowed to path b) | #914 | `wrong-data`. **Path (a) rejected** — the tab lock denies the second tab and `BootGate` never renders children, so no consumer mounts. **Path (b) confirmed with the browser the finder could not name**: Firefox with `dom.storage.enabled=false` has `localStorage` undefined while OPFS opens fine. Harm demonstrated end to end — after a reload the attachment renders "Unlinked Local File" for a file linked on this very device, in a column that syncs |
| U8-C5 | Mechanical | `device.ts:43,59` | `COMPACT_LAYOUT_QUERY` claims parity with `md:` and has no drift test | confirmed (narrowed) | #961 | `cosmetic`. Demonstration holds (12,448 tests green with the breakpoint patched). **The claimed harm is rejected and must not be asserted**: `src/` has exactly one genuine `md:` variant, and both master-detail screens swap on a JavaScript ternary, so exactly one branch renders by construction |
| U8-C6 | Prompt | `decoration-motion.ts:7-8` | The docstring names an animation-level scale that no longer exists | confirmed (widened) | #961 | `cosmetic`. **Phase 6 file.** Root cause is the v3 remap the memory note records. **Widened** with two further false claims in the same docstring: it says "two thresholds" where there are three, and claims every JS-driven effect routes through the gate when `BackgroundEffects.tsx:67` reads a threshold directly |
| U9-C1 | Functional | `index.css:96`, `modal.tsx:230-232` | Light-mode dialogs composite `bg-card` over their own scrim | confirmed (narrowed + widened) | #933 | `degraded`. #209's **twelve published figures reproduced exactly**, then the composition measured in a browser: the panel is `#DFDFE0`. **Narrowed** — `muted-foreground` passes at 4.52 on the default dialog and fails only under a background effect or Soft/Sheer. Confirmed for `destructive` (3.60, every Foundry field's validation error) and `primary` (3.89). **Widened** to `Drawer`, and: `setAnimationLevel('headache')` switches Snow on, so the 70% column is reached by default. The token's own comment claims modals stay opaque |
| U9-C2 | Functional | `money.tsx:192` | `opacity-80` takes the currency symbol below AA | confirmed | #934 | `degraded`. Measured live: `#6C8FBC` on `#FEFEFF` = 3.31:1. #209 omits the token because the raw value passes. The comment reasons about 1.4.1 and never 1.4.3. Not redundant — per-record currency overrides ship, so in a supplier-parts or PO table the symbol is the only per-row discriminator. One `text-2xl` instance is exempt |
| U9-C3 | Functional | `index.css:2463-2467`, `RarityBadge.tsx:30-42` | The tier word is 2.13–4.37:1 against its own pill | confirmed (narrowed) | #934 | `cosmetic`. Measured live: Legendary 2.13:1. **A narrowing that cuts the other way** — it is *not* doubly opt-in: `gamifyCards` defaults **true**, so the only gate is the animation level, and choosing that gate also turns Snow on, making the default surface the 70% panel (1.83:1). `data-contrast=high` does **not** rescue it. Capped at cosmetic because the tier is worthless by the feature's own design |
| U9-C4 | Mechanical | `highlight.ts:108` | `behavior: 'smooth'` overrides the reduced-motion catch-all | see U6-2 | #932 | Reported independently by U9; recorded on the U6-2 row |
| U9-C5 | Functional | `ItemRow.tsx:135-136`, `AppNav.tsx:75` | Content hides on a bare `sm:` breakpoint rather than `handset:` | duplicate #546 | — | #546 names these sites **verbatim**, including the same code block, and had already adjudicated and excluded the `AppNav` limb. A comment was posted there with four sites its sweep missed, plus a correction: at exactly 1280 px / 200% the content survives by one pixel, and the unconditional failure is WCAG 1.4.10 at 320 px |
| U10-C1 | Mechanical | `messages.ts:38-55`, `SettingsDialog.tsx:151-156` | Adding a language per the documented recipe leaves it unreachable | duplicate #575 + #227 | — | Facts all true, but the **seam works** — `prefs.locale` is deliberately an open BCP-47 set, so a restored or synced blob can reach a language the picker does not list. Only the picker is narrow, which is #575; the unguarded third catalog is #227(b). Residue posted as a comment on #575: two false docstrings, and deriving the list rather than widening it |
| U10-C2 | Functional | `index.html:2`, `useApplyLanguage.ts:14-32` | `<html lang>` is never updated | confirmed | #945 | `degraded`. Demonstrated with a **green control** — the sibling `useApplyTheme` does write to `documentElement`. WCAG 3.1.1 Level A: ~593 keys of German announced by a document declaring `en-GB`. #229 covers `dir` and explicitly not `lang`. Gets sharply worse if #575 lands |
| U10-C3 | Mechanical | `useApplyLanguage.ts:26` | A failed catalog import is an unhandled rejection | confirmed (narrowed) | #962 | `cosmetic`. Also raised by U4 and U12. **The build settles the open limb**: `de.json` **is** emitted as `.js` and **is** precached, so "every offline German session hits it" is false. The reload limb is real but is the **designed cure** for #279. What survives is a third instance of the class #315 accepted and closed, at a site that issue does not cover |
| U10-C4 | Performance | `i18n.ts:72-83` | `Intl.PluralRules` is rebuilt on every pluralised call | rejected | — | Measured in **Chromium**, not Node. The 45× ratio holds, but a realistic render costs 2–3 ms, ≤7.5% of the mount, and ~2 ms of a 16.7 ms frame. Two of the five named call sites are not row renders. Also established: **CDP 4× throttling over-applies ~6× to `Intl` construction**, so throttled figures here are an instrument artefact |
| U10-C5 | Mechanical | `i18n.test.ts:74-76` | The "malformed locale" test cannot fail | confirmed | #958 | `cosmetic`. The fixture is a **valid** BCP-47 tag resolving to the host default, which is also `DEFAULT_LOCALE`, so the assertion cannot distinguish the two paths even in principle. Deleting the guard leaves 25 tests green |
| U10-C6 | Mechanical | `catalogs.test.ts:2-3,22-43` | The catalog guards are written against `de` by name | duplicate #227(b) | — | Already filed verbatim as limb (b). The demonstration was posted there, since #227 carried none: an `es.json` probe with an orphan key, 2,459 missing keys and a renamed placeholder shipped 56/56 green, with a control proving the `de` guards do work |
| U10-C7 | Mechanical | `db-error-message.test.ts:132-149` | The "resolves every emittable key" fixture is hand-typed | confirmed | #958 | `cosmetic`. Adding an entry under any of five unlisted codes leaves 44 tests green. `permission-labels.test.ts` is a genuine in-repo model 40 lines away, and its docstring names this exact failure (#429) |
| U10-C8 | Mechanical | `messages.ts:30-33` | `MessageKey` admits `import.problem`, a key no catalog defines | confirmed (narrowed) | #959 | `cosmetic`. Enumeration re-run: 91 bases, exactly one lacking `.other`. Type-checks, with a control proving the harness rejects a genuinely absent key — and **TS2820 offers the broken key as its quick-fix**. Second limb found: under a locale with a CLDR `zero` category it would render the reason-code sentence as a plural variant |
| U10-C9 | Mechanical | `i18n.ts:112-114,132-136` | Catalog lookup walks `Object.prototype` | rejected | — | Four independent sweeps: all twelve `as MessageKey` casts build prefixed dotted keys, every template-literal `t()` is prefixed, every identifier argument is a catalog literal, and the untyped seam is not exported. The catalog route is shut too — `en.json` has zero single-segment keys. Folded into #959 as a hardening bullet |
| U10-C10 | Functional | `SettingsDialog.tsx:151-156` | The language picker's own labels are untranslated literals | duplicate #232 | — | #232 names the screen **and** this control, counting label string-literal props. A comment was posted there with the important qualification: the fix is to render **endonyms**, not to add four catalog keys — a language's own name is never translated |
| U10-C11 | Mechanical | `receipts.test.ts:135-142` | The parity test skips the arm that has no tracking mode | confirmed | #958 | `cosmetic`. 429 tests green with the two Englishes visibly disagreeing. The comment says "per arm"; the test iterates modes, and one arm has no mode. The surrounding docstring explicitly advertises the out-of-band case, which makes it a documented promise |
| U11-C1 | Mechanical | `HotkeySettings.tsx:283,316` | The recorder omits the Mac flag, so a Command chord is stored dead | confirmed (widened) | #917 | `unusable`, Mac-only. Not a mismatch but a **permanently dead string**: `chordFromEvent` sets `meta = metaKey && !commandIsPrimary`, so on a Mac no key press can produce any `Meta+` binding. Line `:316` has it too, so a sequence's second chord is dead the same way. `hotkeys.ts:20-24` and the wiki both document the intent |
| U11-C2 | Functional | `useGlobalHotkeys.ts:166-167`, `hotkeys.ts:849-850` | A global hotkey fires while a Foundry `Menu` owns the keyboard | confirmed (widened) | #916 | `unusable`. **Widened past the Menu case to a much sharper limb**, driven in a browser: `nav.dashboard` defaults to **F2**, and the location tree's F2 inline rename is its only affordance — so with shipped bindings a keyboard user cannot rename a location. Control: clearing the binding makes the rename box appear. Menu limb also confirmed (`degraded`), with focus dropped to `<body>`. **The four other roles the finder listed are all rejected as unreachable.** The IME gap is already open #582 |
| U11-C3 | Mechanical | `useModulesStore.ts:88-93` | A corrupt persisted `intent` white-screens the app | see U4-C3 | #918 | Reported independently by U11; recorded on the U4-C3 row |
| U11-C4 | Functional | `hotkeys.ts:689-711`, `ShortcutsOverlay.tsx:73-87` | A bare prefix binding kills its sequences, unflagged and unreflected | confirmed (narrowed) | #951 | `degraded`. All four halves demonstrated, including the live dispatcher confirming the sequences are dead. **The overlay limb is the defect** — its docstring says "or it is misinformation" and it already implements four cannot-fire filters, so this is a missed fifth. The Settings-conflict limb is weaker and is explicitly not filed alone. Six `G` sequences in the default preset, **seventeen** in the vim preset |
| U11-C5 | Functional | `hotkeys.ts:545-579`, `useGlobalHotkeys.ts:185` | `rejectBinding` accepts `Tab`, `Enter`, `Space` and the arrows | confirmed (narrowed) | #951 | `degraded`. The recorder **does** produce it, by an accidental route: activating "Change" with Enter and then tabbing away binds `Tab`, and the app announces it. **Recovery is not mouse-only** — the modal stand-aside means `Ctrl+,` and `?` still work. `EXTEND_EXEMPT_KEYS` one function away is the evidence of oversight |
| U11-C6 | Mechanical | `useHotkeyScope.ts:242-247` | `register` appends rather than replacing in place | confirmed (narrowed) | #962 | `cosmetic`. Reproduced, plus a narrowing that matters to the fixer: splicing in place would **not** fix the hook, because the effect cleanup calls `unregister` first, so the filter is unreachable through the only consumer. The comment is wrong twice over. The covering test cannot fail — mutation-proved at 155 passed |
| U11-C7 | Functional | `useGlobalHotkeys.ts:166`, `ShortcutsOverlay.tsx:90` | `?` cannot close the cheat sheet it opened | rejected | — | Mechanical fact reproduces, but nothing user-facing claims it closes: the catalog says "Show keyboard shortcuts" and the wiki says "see" and "Show". Escape and the close button both dismiss it. An internal name/behaviour mismatch with no consequence — §1's style-preference exclusion |
| U12-C1 | Mechanical | `db/errors.ts:175-194` | Extended result codes outside the constraint family degrade to `SQLITE_ERROR` | duplicate #751 | — | Already filed as register row P1-5. Premise **re-confirmed** against the real engine, but the consequences are not reachable: no shipped VFS implements shared memory (no `xShm*` anywhere), so WAL is impossible, cross-tab contention returns **primary** `SQLITE_BUSY`, and the reachable `IOERR` family has no case at all so the collapse changes nothing |
| U12-C2 | Mechanical | `error-copy-idiom.test.ts:42` | The guard matches only the ternary, so five bypasses pass | confirmed (narrowed + widened) | #946 | `degraded`. **The finder's five shapes have zero live offenders** — that limb is rejected. But a hole they did not look for has one: the regex hard-codes the class name `Error`, so `e instanceof DbError ? e.message` at `StockBreakdown.tsx:136` slips through — and `DbError` is the worst subclass to narrow on. Reachable via `assertWritable`'s `WRITE_SUSPENDED`, `WORKER_TIMEOUT` and `MULTI_TAB_LOCKED` |
| U12-C3 | Functional | `CommandPalette.tsx:503-516`, `mutations.ts:411-431` | A third live mixed-hook double-report | confirmed | #962 | `cosmetic`. Real hook, real toast provider, three tests plus a control. The finder's control verified: `useCheckoutItem` has no `onError`, so it does **not** widen to check-out. A sweep of all fifteen `mutateAsync` callers found the palette is the only unmanaged one. Drifted because #308 added the inline catch before the #307/#389 seam wired `onError` app-wide, and the palette's own test mocks the hook |
| U12-C4 | Functional | `db-error-message.ts:40-54`, `assert-permission.ts:25` | `PERMISSION_DENIED` has no catalog sentence | confirmed | #947 | `degraded`. Exactly one wording, one producer, reached from every gated repository mutation plus ten bulk sites. **Strengthened**: `PermissionGuard.tsx:106-108` already renders a translated, humanised permission ("Stock · Change"), so the seam is inconsistent with itself and the machinery exists. Not #224 (toasts and live regions) and not #243 (boot and error screens) |
| U12-C5 | Mechanical | `useLabStore.ts:72-79` | The merge reconciles one field of four | see U4-C4 | #918 | Reported independently by U12; recorded on the U4-C4 row. This unit added the escape analysis: `AppErrorBoundary` **does** catch it, capping it at `unusable`, but Try again, "Reinstall app files" and the Danger Zone are all no-ops, so only the purge works |
| U12-C6 | Mechanical | `main.tsx:46,52` | The lab clock is installed before the skew | see U4-C6 | #927 | Reported independently by U12; recorded on the U4-C6 row |
| U12-C7 | Functional | `lab-flags.ts:11-14`, `lww-tie-override.ts:32` | `sync-lww-tie` overwrites a newer local edit while three docblocks say it cannot | confirmed (narrowed) | #928 | `wrong-data`. Demonstrated with a control and a **survival** case: after `resetLab()` and `localStorage.clear()` the row still holds the remote value, so the header's contract is false rather than imprecise. **Narrowed** — a `SyncConflict` record *is* raised carrying the losing row, so there is a recovery path. Two caveats keep it real: it fires only under `localEditedSinceSync`, and the conflict store is itself `localStorage`, so the offered reset deletes the only copy. **Not a privilege finding** — `/lab` is already permission-gated |
| U12-C8 | Functional | `db-error-message.ts:56-72` | `FIELD_KEYS` claims seven single-column UNIQUE indexes | confirmed (narrowed) | #960 | `cosmetic`. Re-enumerated: 12 UNIQUE indexes, 11 single-column, 7 mapped — the comment is false. **The copy limb is rejected**: all four unmapped indexes are unreachable in normal use, and adding field labels would produce *worse* copy ("That default location is already in use"). The finding is the drifted comment |
| U12-C9 | Functional | `db-error-message.ts:80-102` | `isRawSqliteMessage`'s markers match user-supplied text | confirmed | #960 | `cosmetic`. Reproduced, and the anchoring premise checks out against **real SQLite** for all seven markers. Exposure **narrowed**: "~40 repositories" is overstated — nearly all interpolate an opaque id; under a constraint code only `assembly.ts:114` interpolates user free text |
| U12-C10 | Mechanical | `useDismissedAlertsStore.ts:80,118` | `nowMs()` stamps a persisted record against the clock module's rule | confirmed (narrowed hard) | #928 | `cosmetic`, and folded into the lab-flag issue's sibling work. "Outlives it permanently" is **false** — survival is exactly the override distance plus 30 days (measured: 517). `pruneDismissals` has a second exit the finder missed. Almost nothing is user-visible. The real finding is the **missing guard**: the invariant is prose in four files, honoured across all 62 call sites, and held by no test |
| U12-C11 | Mechanical | `AboutScreen.tsx:19-27`, `DashboardVersion.tsx:13-18` | A "mirrors X" comment on a duplicated formatter with no test | confirmed | #962 | `cosmetic`. No test exists for either surface; drift demonstrated and reverted while 266 tests stayed green. **Limb 2 is new and belongs on #228**: both use `Intl.DateTimeFormat(undefined)` at module scope, so they use the browser locale and can never react to the preference — a third and fourth site that issue's sweep missed, and its "everything else formats correctly" claim is false. **Limb 3 rejected** — `Intl` with no `timeZone` preserves the calendar day by construction |
| U12 negatives | — | `diagnostics.ts`, `Starfield.tsx`, achievements | Three finder verdicts of "checked and clean" | agreed, with three corrections | — | Diagnostics carries no personal data (21 keys re-enumerated; the redaction split is deliberate and test-pinned). `Starfield` is CSS rather than canvas — but renders **56** spans, not 52. Achievements are idempotent at two layers, both load-bearing — but the watcher's monotonic-ref comment **overstates** what the ref does: it only decides the `celebrate` flag, and clearing the record then remounting does re-award |
| U12 seed data | — | `seed-data.ts` | The seeded sample data is synthetic and removable | verified clean | — | All 104 lines read. Every generator input is a fixed literal list, the maker names are invented, `SEED_PREFIX` is applied to both name and MPN, the PRNG is deterministic, the count is clamped to 10,000, and `createMany` is all-or-nothing. The removal gap is real but is already #145 (no bulk delete) and #130 (no select-all). Residue: the confirmation copy promises the items are "easy to spot and delete afterwards" — spot yes, delete one at a time |
| U12 lab seed error | Functional | `LabScreen.tsx:375-380` | `catch {}` discards a nameable failure | confirmed (narrowed) | #954 | `degraded`. The comment's premise is **false**: it names the environmental class and calls it unactionable, but the seam has an authored instruction for each of `WRITE_SUSPENDED`, `SQLITE_FULL` and `MULTI_TAB_LOCKED`. Also reachable via a permission mismatch — the section is gated on `storage:write` while `createMany` asserts `items:write`. Closed precedent #309 and #311 |
| U12 diagnostics timer | Mechanical | `DiagnosticsCard.tsx:76` | An uncleared timer cuts the "Copied" state short | confirmed (narrowed) | #963 | `cosmetic`. Early-reset limb confirmed with a control. **Unmount limb refuted** — React 19 removed the warning, and unmounting inside the window produced zero console output |

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

| Phase 2 | `src/db/repositories/item/aliases.ts:196-203` | The alias lookup scans the whole `item_aliases` table and sorts it on every call. Rejected today because there are exactly two writers, both per-item and dialog-gated, so the table is bounded by human interactions — but the growth is linear and reaches ~10,800x the indexable shape at 100k rows. The day a bulk alias path is added (a CSV alias column, a batch scrape, a write API), this is the first seam to break. | Nothing now. It is a note for whoever adds such a feature; `suppliers.name_key` is the working precedent for the fix. |
| Phase 2 | `src/db/repositories/item/search.ts:184` | The structured search's paged ordering is the only item read whose order is not total — no unique tiebreak. Four attacks failed to produce a page-boundary duplicate or drop: 5,000 and 20,000 rows tied on every term, eleven forced access paths, several page depths, and a sorter forced to spill. The engine's sorter was stable in every case. | Driving the same paged walk on **wa-sqlite** in a real browser over a large fully-tied dataset, or on a build whose sorter genuinely spills to multiple runs. The fix comes free with #797, so this only decides whether it is a defect or an unproven risk. |
| Phase 2 | `P:\Source\!Memories` (outside the repository) | The durable note *Inventory attention scaling ceiling* records "**Dead end — do not retry:** rewriting the thrice-repeated `NOT IN` as a correlated `NOT EXISTS` is slower (23.5 ms vs 17.2 ms)". Measured at 50k and 200k with no statistics, every **count** shape is 2.26–2.96x *faster* under `EXISTS`, reaching 3.97x at higher variant-parent density; #168 shipped that rewrite the same day on the strength of the count shape and it is still in the code. The note's own figures come from its `applicableStatuses` benchmark at 20k items, where the two forms tie within noise (1.09x measured). So the two measured different things — but the note's direction and its standing "do not retry" instruction would send a future session back to the slower shape. | The maintainer's decision. Re-scoping that paragraph to the shape it actually measured would settle it. Nothing in the repository is wrong; the code comment at `attention-sql.ts:35` was checked and is defensible. |
| Phase 2 | `npx vitest run --reporter=basic` | Fails under Vitest 4 with `Failed to load custom Reporter from basic` **and still exits 0**, so a CI step written that way would go green having run nothing. Noticed while running the item suite; Phase 0's territory, and no such step exists today. | Grepping `.github/workflows` and `package.json` for a `--reporter` argument, and pinning the reporter names Vitest 4 accepts. |
| Phase 2 | `items` columns `reorder_point`, `reorder_gauge_percent`, `expiry_date`, `acquired_at`, `warranty_expires_at` | Each has a TypeScript guard and **no** column CHECK, so a synced peer or a restored backup can write an unbounded or malformed value that no local write path would accept. The reverse of #769/P1-46, which set the policy for missing CHECKs. | Whether the policy #769 settles for `settings` extends to these five, and whether any consumer actually breaks on a bad value — none was named. |
| Phase 2 | `src/db/repositories/item/aliases.ts`, `items_fts` | Item aliases are searchable from nowhere: the search index covers `items` columns only, so a supplier part number mapped as an alias cannot be found from the search box, the palette or any picker. The wiki lists exactly the seven indexed columns and claims nothing more, so this is a feature gap rather than a contradiction. | Whether alias text should join the search index. |
| Phase 3 | `src/db/repositories/project/bom-lines.ts:117` | Re-pointing a BOM line at a different item keeps the previous item's cost snapshot, part number, manufacturer and description, so a point-in-time project costs the wrong part at the wrong price; and `updateLine` leaks a raw engine error where `addLine` throws a named one. Verified real, and verified unreachable: `useUpdateBomLine` has zero consumers across `src/`, `bridge/` and `extension/`, and no edit-BOM-line surface exists. | Whether an edit-line surface is ever built. Same shape as the Phase 2 `aliases.ts` row — a note for whoever adds the feature, not a defect today. |
| Phase 3 | `src/db/repositories/AssetBookingRepository.ts:343`, `MaintenanceRepository.ts:154-155`, `:183-185` | Three reads walked by `readAllPages` order on a non-total key, and unlike the `project/procurement.ts` case rejected this phase, all three **genuinely OFFSET-walk** — so #149's invariant is live here. No duplicate or drop could be produced; Phase 2 failed four attacks on the identical question at `search.ts:184`. What this row has that `search.ts:184` lacks: `AssetBookingRepository` carries **both** shapes, and `list:331`'s docstring argues the tiebreak is needed *because* the export offset-walks it, while `listUpcoming:343` — walked since #149/#606/#607 — omits it. | The same wa-sqlite browser walk §11's `search.ts:184` row already names. The tiebreak is free, so it is worth adding before anyone gives one of these feeds a deeper consumer. |
| Phase 3 | `locations.dead_stock_days` | The column's only guard is `> 0`, while the UI and the repository both clamp to the preference bounds — so a value from a tampered snapshot or a hand-edited database reaches `addCalendarDays`, overflows to an invalid date, and makes every comparison false, reporting **every** opted-in item as dead. This names the consumer the Phase 2 carry-over row said was missing for its five `items` columns. | Whether the CHECK should match the clamp (a one-line tightening), and whether the same applies to the five `items` columns the Phase 2 row lists. |
| Phase 3 | `src/db/repositories/LocationRepository.ts:624-644` | Collapsing the per-item history fan-out on a location delete into one `INSERT … SELECT` removes a stable **~38%** of the delete's cost at every size measured (1.67x / 1.64x / 1.62x at 2k / 8k / 32k items), and was verified to write all 32,000 rows correctly. Rejected as a finding because the ratio is flat, the structured clone is only 5% of the cost, and the gesture sits behind a confirmation dialog — but the improvement is real and cheap. | Nothing. A note for whoever is already editing that method. |
| Phase 3 | `src/db/repositories/PurchaseOrderRepository.ts:197` | While disproving the N+1 claim, the real cost at the export cap turned out to be the `LIMIT ? OFFSET ?` header walk — **435 ms of 599 ms at 10,000 orders, even with the lines batched**. That is keyset-pagination territory and a distinct candidate from the one rejected, with no verification pass of its own. | A measurement against a keyset shape, and a decision on whether the export path should seek rather than offset. |
| Phase 3 | `src/db/repositories/checkout-plan.ts:86-88`, `features/projects/assembly.ts:145-150` | Two domain unions are branched by if-chains and ternaries rather than switches, so the exhaustiveness protection the memory note relies on cannot fire. Adding a fourth borrower type and running `npm run type-check` across all three projects produces **zero** errors anywhere — the union has no coverage at any site, including a mapper that falls back silently and an unchecked cast in the checkout dialog. Both rejected because each union has one producer and a new member would need a migration, a column and a CHECK before it could compile. | Whether the project wants exhaustive switches on unions that are currently extended only by migration. Cheap hardening, no consequence today. |
| Phase 3 | `P:\Source\!Memories` (outside the repository) | The note `Query row shape guard` describes the guard as resolving "a template whose `${…}` spans are exported module-scope consts", omitting the **constant-folding** step that actually carries the location and category list reads. That omission is what produced candidate L-2, which was disproved. The code is correct; the note is incomplete. | Adding the folding step to the note. |
| Phase 3 | `src/db/repositories/ReportRepository.salesAnalytics` | The method has **no repository-level test at all** — the only coverage is of the pure report builder and of the hook wiring. Nothing exercises the SQL-to-seam mapping: the metadata parse, the quantity fallback, the rounding, the action filter or the category join. A hand-computed check confirmed the mapping is currently correct, so this is a coverage gap rather than a defect. | Whether the test-suite quality phase (17) picks it up, alongside the six-test sweep filed as #861. |
| Phase 4 | `src/features/sync/providers/google-drive-api.ts:107-136` | Whether Google refuses a large non-resumable Drive upload, with what status, and whether the app surfaces it usefully. The endpoints used, the absence of any resumable path, the absence of a size check, and the one extra full copy on the create path are all verified; the ceiling itself cannot be settled with a stubbed `fetch`, because a stub only replays what it was told. Filed as #907 on the memory limb alone. | A real Google account with Drive API access and a live token, pushing snapshots above the documented simple-upload guidance (say 8 MB, 64 MB and 256 MB), recording each HTTP status and body, then checking how `authedFetch` classifies it and what the Sync screen shows. |
| Phase 4 | `src/lib/save-file.ts:150-172` | Whether Chromium's `showSaveFilePicker` leaves a zero-byte file at the chosen path when `close()` rejects. If it purges the target instead, the missing `abort()` buys nothing for the stated harm and #895 reduces to its parity limb alone. The picker creates the target file at pick time, so an `abort()` may leave the same empty file regardless. | A real browser session with a genuine disk-full or quarantine failure at `close()` on a picker handle, inspecting the chosen path afterwards. A native save dialog cannot be driven by Playwright, which is why `browser-smoke.mjs` deletes the API outright before its triage steps. |
| Phase 4 | `src/features/sync/SyncScreen.tsx:342-353` | The comment justifying the missing-remote override states that `lastSyncedAt` is "cleared when a different remote is connected". After a Disconnect it is cleared even when the **same** account is reconnected, because `disconnect()` nulls `providerId` and the identity comparison can then never match. So the first sync after any disconnect-and-reconnect bypasses #196's guard, including when the shared snapshot genuinely has gone missing. U3-8 was rejected on the claim actually made; this is a different, real hole in the same decision's reasoning. | A decision on whether the override should key off something that survives a disconnect, and whether losing that warning for one pass matters given peers re-push their rows on the next delta merge. |
| Phase 4 | `src/features/sync/snapshot.ts:1206-1232` | For a **solo, never-synced** user who downgrades images and then restores a JSON Replace backup, the missing-file report's explanatory copy is wrong: it says the photos "may be photos added on another device that this one has not downloaded yet — a sync brings them back", and no sync will, because the bytes were deliberately deleted. U4-10 was rejected because the post-clone state is indistinguishable from the ordinary post-sync state for a synced user; this residue applies only to the user who has no peers. Self-healing after one triage run. | Whether the maintenance report's copy should distinguish "not downloaded yet" from "downgraded here", which needs the marker it currently cannot see after a clone. |
| Phase 4 | `src/features/danger-zone/EraseDataDialog.tsx` | The dialog is 756 lines and has **no test of any kind**, and there is no Danger Zone step in `scripts/browser-smoke.mjs`. Six of this phase's confirmed findings live in or behind that file (#879, #882, #891, #893, #894, #897) and none of them was visible to CI. Recorded as a coverage observation rather than filed, since a coverage gap on correct behaviour is not itself a defect. | Whether Phase 17's test-suite quality sweep picks it up, alongside the sweep already filed as #861. |
| Phase 4 | `src/features/sync/reconcile.ts:272-284` | #889's fix for the first two limbs (deriving the surviving sets after the cycle guard runs) does **not** address the third: `rejectParentCycles` leaves the surviving row's `parent_id` pointing at a row it has declined to write, which aborts the apply on its own with no child rows involved. Recorded here because a partial fix would look complete and leave the abort in place. | Nothing — it is a note for whoever actions #889. |
| Phase 5 | `src/components/foundry/useInstallPrompt.ts:42-57` | The hook's *timing* limb could not be settled here: whether a browser that has already fired `beforeinstallprompt` before the first hook instance mounts ever re-fires it for a later listener. The second-instance limb was demonstrated and is filed; this one needs a real install-eligible session, which Playwright cannot produce — its Chromium never fires the event, so every automated run is synthetic. | A human-driven Chrome and Edge session on the hosted deployment, opening Settings > App after the browser's own install affordance appears, and recording whether the in-app button becomes live. |
| Phase 5 | `src/features/command-palette/CommandPalette.tsx` | While disproving the eager-import claim, the eager graph turned out to carry `CreateItemDialog` at **83,557 B** through `ActiveTabScrapeListener`. That is a larger payload than the candidate that was rejected, and it had no verification pass of its own. | A measurement of what the entry chunk loses if the scrape listener defers the dialog, and whether the listener needs it before a scrape starts. |
| Phase 5 | Chrome DevTools Protocol CPU throttling | CDP's 4x throttle **over-applies to `Intl` constructor calls specifically**, measured at roughly 6x. Any throttled figure for `Intl.PluralRules` / `NumberFormat` / `DateTimeFormat` construction is therefore an instrument artefact, not a device measurement. Recorded because a later phase measuring formatter cost on a simulated low-end device would otherwise repeat the error. | Nothing. It is a note for whoever next throttles a formatter benchmark. |
| Phase 5 | `src/lib/utils.ts`, `src/styles/index.css` | Two by-products of a rejected candidate. `ring-bleed-x` is classified by tailwind-merge as a **ring colour** rather than a spacing utility, and it is deleted rather than merged. And `safe-area-token.test.ts`'s parity claim is one-directional: it checks that every declared group exists, never that every group in use is declared. | Whether either is worth a line of hardening. Neither has a live offender today. |
| Phase 5 | `src/db/errors.ts:175-194` | #751 / P1-5's premise was re-confirmed against the real engine, but its consequences are **not reachable**: no shipped VFS implements shared memory, so WAL is impossible; cross-tab contention returns a *primary* `SQLITE_BUSY`; and the reachable `IOERR` family has no case at all, so the collapse changes nothing. Recorded so whoever actions #751 knows the severity is lower than the body implies. | Nothing — it is a note for whoever actions #751. |
| Phase 5 | `docs/todo/` | `docs-todo-status.test.ts`'s walk is non-recursive, so this audit's own plan document is only guarded while it stays at the top level. Splitting it into `docs/todo/audit/` would take every phase record out of the guard's sight silently. Filed as part of #957; recorded here because it governs this document. | Nothing. A note for whoever reorganises `docs/todo/`. |

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
| 2026-08-30 | 2 | Phase 2 run and landed at pinned SHA `9072d220`. 56 candidates: 43 confirmed, 10 rejected, 2 duplicates of existing issues, 1 unverifiable. The 43 confirmed became 33 issues (#784–#816) — three were folded into existing issues as measured comments (#764 twice, #768) and seven into a sibling issue sharing a root cause and a fix. Seven finder units and eighteen verifier passes ran, on a seeded 50k-row database with no statistics. Notable: the verifiers overturned the finders on ten points, including a claimed doc-comment contradiction that proved defensible once the right query shape was measured (P2-36), a proposed batching fix that measured as a wash against the round trips it removed (P2-18), and three severity claims that the measurement did not support (P2-11, P2-12, P2-1). Two findings were widened by verification rather than narrowed: P2-21 grew from "picks arbitrarily among duplicates" to "the match key is not an identity key", and P2-41 from two parity cases to three. A second, detached worktree was used for verification so that the test unit's deliberate mutations could not corrupt a concurrent verifier's run. Six carry-over entries added to §11, one of them a correction to a durable note outside the repository. |
| 2026-08-31 | 3 | Phase 3 run and landed at pinned SHA `52fa966f`. 110 candidates: 74 confirmed, 33 rejected, 3 carry-over. The 74 confirmed became **52 issues (#817–#868)** plus 6 comments on existing issues — the rest were folded into a sibling issue sharing a root cause. Ten finder units and nineteen verifier passes ran. **The headline question of the phase — "find a repository write the ACL does not check" — was answered: there is none.** Two independent enumerations agree on 157 permission-gated mutating methods, of which exactly three assert nothing and all three are documented; no method touches the driver before its guard; all four internal repository-to-repository constructions pass the collaborator seam. The claim must be worded *no **unguarded** write*, though: the tag and supplier merges are guarded with the **wrong key** (#821), which a denied-authority sweep cannot see. Notable corrections by verifiers: two candidates were **disproved outright** on their premise (L-2's row-shape claim missed the guard's constant-folding step; C5-15's guard is on the column, not the repository), one finder's *fix* would have broken a dashboard badge (C3-3 needs a predicate, not a `LIMIT`), one finder's demonstration showed the **benign** ordering and the real one had to be found under a driver model (C5-7), one finder's measurement was wrong by a factor of five (C9-7, 25% undetected over 20 runs, not "solid"), and half of C3-7 was disproved over two million samples. Three candidates were **widened into more serious findings**: C4-1 from differing ids to a demonstrated double-landing *and* stock destroyed on the return path, U-4 from "no reachable divergence" to an account the app can neither delete nor disable, and C8-6 from a missing seam to a `data-loss` action that two documents describe as safe. **The audit's own tooling caused a real incident**: an unbounded recursive walk over a cyclic `locations` table (#819) exhausted the host and crashed it mid-phase, which is itself the demonstration for that issue; the phase was resumed from saved agent transcripts with no loss of work, and later interrupted twice more by session limits and resumed the same way. §5.3 was honoured for the one exploitable finding: the maintainer was asked before filing and chose a standard public issue. Eight carry-over entries added to §11. |
| 2026-08-31 | 4 | Phase 4 run and landed at pinned SHA `983986fd`. **64 candidates: 49 confirmed, 14 rejected, 1 duplicate of an existing issue (#750).** The 49 confirmed became **40 issues (#869–#908)** — nine were merged into a sibling sharing a root cause and a fix, including one five-item parity sweep (#901) following #254's precedent. Six finder units and twenty verifier passes ran. **Four candidates were reported independently by two finders** (U1-2≡U4-4, U1-5≡U2-7, U3-7≡U4-7, U5-5≡U6-9) and are recorded once. Seven findings are `data-loss` and four `unusable`. **The verifiers overturned or reshaped the finders on fourteen points.** Two candidates were rejected because their own mutation disproved them: U2-5 predicted a silent failure that produced 28 failures across 11 files, and U1-7's claim that two loops were untested was disproved by 13 and 46 tests entering them. Two security framings were deflated after investigation — U4-1 to robustness (no remote ingress; the project's own precedent in #641/#762 is not security-framed), and U6-4's privilege-escalation limb rejected outright, because read enforcement lives at the screen boundary by the decision recorded in #522, so the momentary unrestricted window has nothing to bypass. Three performance candidates were rejected **on measurement**: U5-13's poll costs 0.41 s of main-thread work per day, and U2-9's 88 rescans cost 2.4 ms with a best-case saving of 1.5 ms. Conversely U2-11 was rated LOW and unreachable by its finder, and the verifier confirmed it, found the route via #818 and widened it to three limbs; U5-12's finder proposed a mutation that proved the opposite of its claim, and inverting it exposed the real one-sided gap; and **U2-3b was found by a verifier while disproving U2-3**, which is now the settled answer to the register's carry-over P2-51 (`unverifiable` → `rejected`, on #542's own closing comment). Six carry-over entries added to §11, including two limbs that genuinely need hardware this session did not have. Every scratch test and every mutation was reverted before landing; the worktree carried no change outside this document. |
| 2026-08-31 | 5 | Phase 5 run and landed at pinned SHA `97a7e06c`. **112 candidates: 81 confirmed, 23 rejected, 8 duplicates of existing issues.** The 81 confirmed became **55 issues (#909–#963)** plus **8 comments** on existing issues (#243, #546, #209, #227, #228, #575, #232, #112) — the rest were folded into a sibling sharing a root cause and a fix, including three sweeps (#918 six persisted stores, #957 four guard holes, #961 four stale comments). Twelve finder units and roughly thirty verifier passes ran. **Four candidates were reported independently by two finders** (U9-C4≡U6-2, U11-C3≡U4-C3, U12-C5≡U4-C4, U12-C6≡U4-C6) and are recorded once. One finding is `data-loss` (#909), six are `unusable`. **The headline finding is #909**: the query client is left on TanStack's `'online'` default, so a write attempted on a flaky connection hangs on a spinner, is **discarded** if the tab closes, and reads return the *previous* result set rather than a blank — all while the pill promises "changes are saved locally". It went unnoticed because `onlineManager` never reads `navigator.onLine`, so a cold offline launch is unaffected. **The verifiers overturned or reshaped the finders on more than twenty points.** Six candidates were disproved outright on their premise (`useFullscreen`, `text-terms`, `derived-uuid`, `route-suggestions`, `apportionMoney`, `useConfirmSaved` re-entrancy). Four performance candidates were rejected **on measurement**, one of them (`Intl.PluralRules`) after establishing that CDP throttling over-applies ~6x to `Intl` construction — an instrument artefact now recorded in §11. Several headline limbs died while a sharper one survived: U7-GUARD-4's claimed #258 regression is false, but U7-GUARD-5 has a **live shipped call site** already in the vulnerable shape; U12-C2's five bypass shapes have no offender, but the guard's hard-coded class name lets `DbError` through. Conversely U11-C2 widened from a menu-focus case to "with the shipped bindings a keyboard user cannot rename a location", and U4-C1 from a config default to three demonstrated limbs. **Two verifier contradictions were settled by the lead** with its own component test (the 404 dialog does reopen on a second focus) and by reconciling two recovery-race runs whose asset cache headers differed. Findings were driven in three real browser engines, two static production builds, a Docker image at a non-root base path, and a deliberately corrupted database file. Six carry-over entries added to §11, including one limb that needs a human-driven install-eligible session. Every scratch test was removed before landing; the worktree carried no change outside this document. |
