---
name: auto-review
description: >-
  Review the current working-tree diff (against main) for correctness bugs, CLAUDE.md
  violations, and the structural artefacts machine-written code characteristically leaves
  behind (phantom APIs, half-applied parallel edits, re-implemented seams, test theatre,
  suppressed errors, scope creep), reporting only high-signal findings. Model-invocable
  stand-in for the built-in /code-review, for use before merging or handing off issue work.
  Accepts an effort argument: low | medium | high (default medium).
argument-hint: "[low|medium|high]"
allowed-tools:
  - Bash(git diff:*)
  - Bash(git status:*)
  - Bash(git merge-base:*)
  - Bash(git log:*)
  - Bash(git rev-parse:*)
  - Bash(git show:*)
  - Agent
  - Task
  - ReportFindings
  - Read
  - Grep
  - Glob
---

# auto-review — agent-invocable working-diff review

This skill is a **model-invocable stand-in** for the bundled `/code-review`, which cannot be
called by the agent (it ships `disable-model-invocation: true` and is not on the Skill-tool
allowlist). It reproduces the bundled reviewer's **find → validate → high-signal-only** rubric,
adapted to review the **local working-tree diff** rather than a GitHub PR — the exact need in the
Gubbins issue workflow, where the change is reviewed in a worktree *before* it is merged or a PR
exists.

> **What it is not.** This is a faithful single-orchestration approximation, not the real
> `/code-review`. It does **not** run the bundled reviewer's cloud/`ultra` multi-agent machinery,
> and its depth depends on the effort you pass. When a maintainer-run `/code-review high` is
> available, that remains the stronger, authoritative pass. Use this to catch issues *before* that
> gate — not to replace it.

**Provenance / maintenance.** The rubric below is adapted from the public Anthropic source at
`github.com/anthropics/claude-code`, path `plugins/code-review/commands/code-review.md`
(the `code-review@claude-code-plugins` plugin). Drift from the bundled reviewer is expected and
acceptable. **Re-sync this file from that public source whenever the Claude Code VS Code extension
is updated** — fetch the latest `code-review.md`, diff it against this rubric, and fold in any
changes, keeping the working-tree adaptation below.

Two things here are **Gubbins-local additions with no upstream counterpart** — a re-sync must
preserve them rather than overwrite them: the working-tree (rather than PR) diff scope, and the
**machine-artefact lane** (step 4's third agent type, the A–H checklist, and its false-positive
list). The latter exists because the upstream bar — won't compile / definitely wrong / rule
violation — is tuned for human-authored code, and is close to orthogonal to how machine-authored
code fails. Machine-written code compiles; it goes wrong by referring to things that were never
written, changing one of six places that had to change together, re-solving a solved problem, and
asserting completion it hasn't reached. None of those trip the upstream bar.

## Agent assumptions (applies to all agents and subagents)

- All tools are functional and will work without error. Do not test tools or make exploratory
  calls. Make this clear to every subagent launched.
- Only call a tool if it is required to complete the task. Every tool call has a clear purpose.

## Effort

Read the argument (`low` | `medium` | `high`, default `medium`). It scales the review breadth:

- **low** — 2 review agents (1 CLAUDE.md compliance, 1 combined bug/logic + machine-artefact).
  Skip the summary agent; you summarise the diff yourself.
- **medium** (default) — a summary agent + 4 review agents (1 CLAUDE.md compliance, 2 bug/logic,
  1 machine-artefact).
- **high** — a summary agent + 6 review agents (2 CLAUDE.md compliance, 2 bug/logic,
  2 machine-artefact — one taking the *mechanical* checks A–D, one the *intent* checks E–H).

## Steps — follow precisely

1. **Establish the diff scope.** This reviews *local, uncommitted-and-committed* work against
   `main`, not a PR.
   - `BASE=$(git merge-base main HEAD)`.
   - The review target is everything from `BASE` to the working tree: `git diff BASE` (this
     includes committed *and* uncommitted changes — the full delta a merge into `main` would
     introduce). Use `git diff BASE --stat` for the file list and `git diff BASE` for the hunks.
   - If the diff is empty, stop and report: "No changes to review against main."

2. **Collect relevant CLAUDE.md files** (paths only, not contents): the root `CLAUDE.md`, plus any
   `CLAUDE.md` in a directory containing a file the diff modifies. When judging a file's compliance,
   only consider CLAUDE.md files that share its path or a parent of it.

3. **Summarise the changes** (skip the dedicated agent at `low` effort — do it inline). Capture the
   author's intent: infer it from the branch name, commit messages (`git log BASE..HEAD`), and the
   diff. This intent is context every review agent receives.

4. **Launch the review agents in parallel** (count per effort above). Give every agent the change
   summary + inferred intent, the diff, and the relevant CLAUDE.md paths. Each returns a list of
   issues; each issue has a **description** and the **reason** it was flagged (e.g. "CLAUDE.md
   adherence", "bug", "logic", "security", or the machine-artefact check letter it matched).

   - **CLAUDE.md-compliance agent(s):** audit the changed code against the applicable CLAUDE.md
     rules. Only consider CLAUDE.md files sharing the file's path or a parent. Quote the exact rule
     broken. Gubbins rules most worth checking: design tokens (no raw colour/spacing literals),
     i18n `t()` for user-facing strings (+ `de.json` parity), Foundry primitives over hand-rolled
     controls, accessibility wiring, the no-secrets / public-hygiene rules, and the wiki-update
     rule when a user-facing surface changed.
   - **Bug/logic agent(s):** scan for obvious bugs **visible from the diff itself**, without reading
     wide context. Flag only significant, valid-in-the-hunk problems — inverted conditions, wrong
     operators, off-by-one, missing await, unhandled null, security issues, incorrect logic. Do not
     flag issues you cannot validate without context outside the diff.
   - **Machine-artefact agent(s):** work the **Machine-artefact checks (A–H)** checklist below,
     reproduced in full in the agent's brief. Unlike the bug/logic lane, this
     one **must read the repo** — `Grep`/`Glob`/`Read` are the whole point, because every check here
     is confirmed or killed by evidence outside the hunk.

   **CRITICAL: only HIGH-SIGNAL issues.** Flag an issue only when one holds:
   - The code will fail to compile or parse (syntax/type errors, missing imports, unresolved
     references).
   - The code will definitely produce wrong results regardless of inputs (clear logic errors).
   - A clear, unambiguous CLAUDE.md violation where you can quote the exact rule broken.
   - A machine-artefact check A–H matches **and** you can cite the concrete counter-evidence it
     demands — a `file:line` for the thing that doesn't exist, the sibling site left un-updated, the
     existing seam that was re-implemented, the assertion that cannot fail. No citation, no finding.

   Do **NOT** flag: code style/quality, issues that depend on specific inputs or state, or
   subjective suggestions. If you are not certain an issue is real, do not flag it — false positives
   erode trust and waste reviewer time.

5. **Validate every flagged issue with a second, independent pass.** For each issue from step 4,
   launch a subagent whose sole job is to confirm — with high confidence — that the issue is real
   in *this* code. Give it the summary + intent + the issue description. For a bug like "variable
   not defined", it verifies that is actually true; for a CLAUDE.md issue, it verifies the cited
   rule is in scope for that file **and** actually violated. This is adversarial: default to
   "not confirmed" when the evidence is thin.

   For a **machine-artefact** finding the validator must *independently re-derive* the cited
   evidence, not take it on trust — re-run the search for the "missing" symbol (including
   re-exports, barrel files and generated files such as `routeTree.gen.ts`), open the sibling site
   claimed to be un-updated, read the seam claimed to be re-implemented and confirm it actually
   covers this case. These findings assert *absence*, and absence is the easiest thing to get wrong
   from a partial grep. Confirm only if the evidence reproduces exactly.

6. **Filter to validated issues only, then de-duplicate.** Discard anything step 5 did not confirm.
   The lanes overlap by design (a missing `de.json` key is both a CLAUDE.md violation and a
   half-applied parallel edit) — collapse findings that share a root cause into one, keeping the
   phrasing that names the rule or evidence most precisely. What remains is the high-signal
   result set.

7. **Report.**
   - **Report the confirmed findings via the `ReportFindings` tool** if it is available — one call,
     ranked most-severe first (empty array if nothing survived). Do not also print them as prose.
   - If `ReportFindings` is not available, print a terminal summary instead: list each confirmed
     issue with a one-line description and its `file:line`; or, if none survived, state exactly:
     "No issues found. Checked for bugs, CLAUDE.md compliance, and machine-artefact checks A–H."

This skill **reports** findings; it does not edit code. Fix anything it surfaces before continuing,
then re-run if the change was substantial.

## Machine-artefact checks (A–H)

Code written by a model fails differently from code written by a tired human. It compiles, it reads
fluently, it is plausibly shaped — and the bug/logic lane above, which deliberately looks only at the
hunk, is blind to most of it. These failures are **structural**: something the diff asserts exists
doesn't, something that had to change in six places changed in one, something already solved got
solved again slightly differently. Each check below therefore names the **evidence required** to flag
it; that requirement is what keeps this lane high-signal rather than a code-quality free-for-all.

**Mechanical checks (A–D) — verified by searching the repo.**

- **A. Phantom surface.** The diff references something that does not exist: a function, method,
  prop, hook, type, exported const, i18n key, storage key, config field, npm script, CLI flag,
  dependency version, environment variable, route, or file path. Fluent invention is this failure
  mode's signature — the call reads perfectly and the callee was never written. Gubbins-specific:
  an unknown **Tailwind utility emits no CSS and no error** (CLAUDE.md says so explicitly), a
  `t('some.key')` absent from `en.json`, a `gubbins:` key not in `lib/storage-keys.ts`, a Lucide
  glyph name that isn't exported.
  *Evidence:* a search for the symbol that returns nothing (having also checked barrels,
  re-exports, and generated files) — quote the search and the referencing `file:line`.

- **B. Half-applied parallel edit.** This codebase is full of lists that must change together; a
  model reliably updates the one it was looking at. A key added to `en.json` but not `de.json`;
  an accent added to `ACCENTS` (`src/features/settings/theme-registry.ts`) without both the light
  **and** dark CSS block; a new `FieldType`
  wired into some of its ~6 touch-point lists; a new `CREATE TABLE` not classified in
  `src/db/repositories/tombstone.ts`; an enum arm added without its parallel label/icon/order map;
  a renamed symbol updated at the definition but not every call site.
  *Evidence:* the sibling site, by `file:line`, that still reflects the old shape.

- **C. Re-implemented seam.** The diff hand-rolls something the repo already owns a canonical seam
  for — day arithmetic outside `src/lib/calendar-days.ts`, rounding or summing money outside
  `src/lib/money.ts`, date-picker conversions outside `src/lib/date-input.ts`, raw
  `e instanceof Error ? e.message : …` instead of the resolver from
  `src/features/errors/useErrorMessage.ts`, `file.text()` instead of `readImportFile`
  (`src/features/import/file-source.ts`), a bare styled `<button>`/`<input>` instead of a Foundry
  primitive, a bespoke list→file exporter instead of `src/features/export/tabular-export.ts`. The
  give-away is a *second*, subtly different implementation of a solved problem.
  *Evidence:* the existing seam's path, plus a one-line statement that it genuinely covers this
  case. If the seam does **not** fit, that is not a finding.

- **D. Dead on arrival.** Code added in this diff that nothing reaches: an exported helper, prop,
  option, branch or parameter with no caller; a flag that is only ever passed one value; a
  superseded implementation left beside its replacement (`fooV2` next to `foo`); an unreachable
  branch after an early return; an import used nowhere.
  *Evidence:* a repo-wide search for the identifier showing the definition is its only mention.

**Intent checks (E–H) — verified against the change summary and inferred intent from step 3.**

- **E. Test theatre.** A test that cannot fail: asserting on the mock rather than the subject,
  a mocked-out unit under test, `expect(true).toBe(true)`, an `await` with no assertion after it, a
  fresh snapshot accepted as the assertion. Also **assertions weakened or deleted** to get green —
  a specific expectation loosened to `expect.any(…)`, a case rewritten to match the new (possibly
  wrong) output rather than the intended behaviour, `it.skip` / `.only` / a commented-out case left
  behind.
  *Evidence:* quote the assertion and say why no realistic breakage would trip it.

- **F. Suppression instead of fix.** A type or lint error silenced rather than resolved:
  `@ts-ignore` / `@ts-expect-error`, a widened `any` or `as unknown as`, a non-null `!` on something
  that can genuinely be null, a new `eslint-disable`, or a `try`/`catch` that swallows the error
  (empty block, bare `console.error`, `catch { return null }`) so a real failure now passes
  silently. A `?? fallback` that papers over a value which should never have been missing counts.
  *Evidence:* the suppression's `file:line` and what it is hiding. A suppression with a comment
  explaining a genuine, specific reason is **not** a finding.

- **G. Scope creep.** Changes outside what the stated intent asked for: drive-by renames or
  refactors of untouched code, reformatting whole files around a two-line fix, speculative
  configuration knobs or abstraction layers nobody requested, backwards-compatibility shims for a
  version that never shipped, an unrelated dependency added.
  *Evidence:* the hunk, plus why the intent from step 3 doesn't cover it. Genuinely required
  incidental changes (a call site that *had* to move) are not scope creep.

- **H. Unbacked claim / leftover placeholder.** Prose in the change asserting something the code
  doesn't do — a comment, doc, wiki page, plan-doc `✅ COMPLETE` banner or commit message claiming
  behaviour, coverage or completion the diff does not deliver. Plus the artefacts of an unfinished
  pass: `TODO` / `FIXME` / "implement later", a stub returning empty, hard-coded sample data on a
  real path, `console.log` / `debugger`, a commented-out block. Also **change-narrating comments** —
  `// now uses X instead of Y`, `// Added for the new flow` — which describe the *edit* rather than
  the code, and read as stale noise the moment they land (and, per public-repo hygiene, must never
  reference the agent or the process that produced them).
  *Evidence:* the claim and the code that contradicts it, or the placeholder's `file:line`.

When reporting via `ReportFindings`, use a `category` slug that names the check — `phantom-api`,
`parallel-edit-drift`, `reimplemented-seam`, `dead-code`, `test-theatre`, `suppressed-error`,
`scope-creep`, `unbacked-claim` — so the class of problem is visible at a glance.

## Known false positives — do NOT flag (from the source rubric)

- Pre-existing issues (not introduced by this diff).
- Something that looks like a bug but is actually correct.
- Pedantic nitpicks a senior engineer would not raise.
- Issues a linter would catch (do not run the linter to verify).
- General code-quality concerns (missing test coverage, generic security posture) unless a relevant
  CLAUDE.md rule explicitly requires it.
- Issues named in CLAUDE.md but explicitly silenced in the code (e.g. a lint-ignore comment).

## Known false positives — machine-artefact lane specifically

This lane asserts *absence* — "that doesn't exist", "that wasn't updated", "that's already solved" —
and absence is the easiest claim to get wrong from an incomplete search. Do **not** flag:

- A symbol you failed to find because you searched too narrowly. Re-export barrels, generated files
  (`routeTree.gen.ts`), `*.d.ts`, string-keyed lookups and dynamic imports all hide definitions from
  a naive grep. Search the whole repo before claiming something is phantom.
- Code that is unreferenced *within the diff* but reached from elsewhere — a route component, a
  registry entry consumed by iteration, a test helper, a public export, a props field spread into a
  child. "No caller in the hunk" is not "no caller".
- Deliberate divergence from a seam where the seam genuinely doesn't apply. The finding is a
  *duplicate* implementation, not any implementation you'd have written differently.
- A pre-existing `TODO`, suppression, `any`, or narrating comment the diff merely moved, reindented,
  or left untouched nearby. The trigger is introduction, not existence.
- Type suppressions and loose types in test files, mocks and fixtures where they are idiomatic.
- Missing tests, thin tests, or tests you would have written differently — only tests that
  **cannot fail** or whose assertions this diff **weakened** are in scope.
- Ordinary explanatory comments. Only comments describing the *edit itself* ("now uses…", "changed
  to…", "added for…") are findings; a comment explaining *why* the code is the way it is is good.
- A scope judgement you are inferring rather than reading. If the intent from step 3 is vague, the
  benefit of the doubt goes to the author — flag scope creep only when the extra change is clearly
  unrelated to a clearly stated intent.
- Anything you would phrase as "consider", "might be cleaner", or "could be simplified". That is the
  `/simplify` skill's job, not this one.
