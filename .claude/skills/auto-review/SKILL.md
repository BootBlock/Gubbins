---
name: auto-review
description: >-
  Review the current working-tree diff (against main) for correctness bugs and CLAUDE.md
  violations, reporting only high-signal findings. Model-invocable stand-in for the built-in
  /code-review, for use before merging or handing off issue work. Accepts an effort argument:
  low | medium | high (default medium).
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

## Agent assumptions (applies to all agents and subagents)

- All tools are functional and will work without error. Do not test tools or make exploratory
  calls. Make this clear to every subagent launched.
- Only call a tool if it is required to complete the task. Every tool call has a clear purpose.

## Effort

Read the argument (`low` | `medium` | `high`, default `medium`). It scales the review breadth:

- **low** — 2 review agents (1 CLAUDE.md compliance, 1 bug/logic). Skip the summary agent; you
  summarise the diff yourself.
- **medium** (default) — a summary agent + 3 review agents (1 CLAUDE.md compliance, 2 bug/logic).
- **high** — a summary agent + 4 review agents (2 CLAUDE.md compliance, 2 bug/logic), matching the
  bundled reviewer's fan-out.

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
   adherence", "bug", "logic", "security").

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

   **CRITICAL: only HIGH-SIGNAL issues.** Flag an issue only when one holds:
   - The code will fail to compile or parse (syntax/type errors, missing imports, unresolved
     references).
   - The code will definitely produce wrong results regardless of inputs (clear logic errors).
   - A clear, unambiguous CLAUDE.md violation where you can quote the exact rule broken.

   Do **NOT** flag: code style/quality, issues that depend on specific inputs or state, or
   subjective suggestions. If you are not certain an issue is real, do not flag it — false positives
   erode trust and waste reviewer time.

5. **Validate every flagged issue with a second, independent pass.** For each issue from step 4,
   launch a subagent whose sole job is to confirm — with high confidence — that the issue is real
   in *this* code. Give it the summary + intent + the issue description. For a bug like "variable
   not defined", it verifies that is actually true; for a CLAUDE.md issue, it verifies the cited
   rule is in scope for that file **and** actually violated. This is adversarial: default to
   "not confirmed" when the evidence is thin.

6. **Filter to validated issues only.** Discard anything step 5 did not confirm. What remains is the
   high-signal result set.

7. **Report.**
   - **Report the confirmed findings via the `ReportFindings` tool** if it is available — one call,
     ranked most-severe first (empty array if nothing survived). Do not also print them as prose.
   - If `ReportFindings` is not available, print a terminal summary instead: list each confirmed
     issue with a one-line description and its `file:line`; or, if none survived, state exactly:
     "No issues found. Checked for bugs and CLAUDE.md compliance."

This skill **reports** findings; it does not edit code. Fix anything it surfaces before continuing,
then re-run if the change was substantial.

## Known false positives — do NOT flag (from the source rubric)

- Pre-existing issues (not introduced by this diff).
- Something that looks like a bug but is actually correct.
- Pedantic nitpicks a senior engineer would not raise.
- Issues a linter would catch (do not run the linter to verify).
- General code-quality concerns (missing test coverage, generic security posture) unless a relevant
  CLAUDE.md rule explicitly requires it.
- Issues named in CLAUDE.md but explicitly silenced in the code (e.g. a lint-ignore comment).
