# Gubbins — working conventions

These rules apply to every agent and every change. Where a rule names a *memory note*, open that
note before you do that kind of work: it holds the detail this file leaves out.

## Work in a git worktree (mandatory)

Other agents edit this repository at the same time. **Before your first edit**, create a new
worktree under `.claude/worktrees/` and do the whole task there. Only a task that changes no
repository file (a question, a review, a pure `gh` operation) is exempt.

- Edit through absolute paths inside your own worktree. Never touch another agent's worktree.
  Expect `main` to have moved on while you worked.
- Run tests with `vitest.worktree.config.ts` and the dev server with `vite.worktree.config.ts`.
- Merge back with `--no-ff`. Remove the `node_modules` junction **before** `git worktree remove`,
  or the removal deletes the primary checkout's `node_modules`.
- Split independent pieces of work across sub-agents that run in parallel.

Memory notes: *Gubbins concurrent agents worktrees*, *Worktree run app and tests*, *Worktree
junction cleanup*.

## No secrets or personal data (mandatory)

This repository is **public**, and a pushed commit is permanent.

- **Never** commit a credential (API key, token, password, private key, certificate, client
  secret, session cookie, connection string) in a file or a commit message. Use a placeholder
  (`<YOUR_API_KEY>`). Secrets go in git-ignored `.env`; `.env.example` holds placeholders only.
- **Never** commit real personal data. Use `BootBlock@users.noreply.github.com`, `example.com` /
  `*.test`, `localhost` and invented names in fixtures and screenshots.
- **Never** commit data artefacts: `*.sqlite`, `*.db`, dumps, archives, `.pem`, `.key`, `.pfx`,
  `.p12`, keystores or `id_rsa*`. Add a new generated file type to `.gitignore`.
- **Before every commit**, read `git diff --cached` for anything credential-shaped or personal.
  If in doubt, leave it out and ask.
- **If a secret is committed, stop and report it.** It must be revoked and scrubbed from history;
  a later commit that deletes it is not enough.

## Public-repository hygiene (mandatory)

Code, comments, commit messages, branch names, docs and history are world-readable.

- Stay professional and neutral. No TODO names or blames a person.
- No internal references: private ticket IDs, internal hosts, infrastructure, or the agent's own
  process. Describe what changed and why.
- The licence is **MIT**. Copy no code of unknown or incompatible licence. Vet a new dependency's
  licence and maintenance, and keep dependencies few.
- Pass multi-line commit messages and GitHub bodies through a file (`git commit -F`,
  `gh … --body-file`), never through inline shell quoting.

## Attribution on GitHub content (mandatory)

Every issue or pull-request body or comment you write or edit ends with this:

```markdown
---
This issue was actioned by an agent on behalf of @BootBlock.
```

Match the verb to what you did (`actioned` / `opened` / `updated`), and write `pull request` for
a PR. Omit it only where GitHub has no body to sign. Commit messages carry a `Co-Authored-By`
trailer instead.

## UI: design tokens and Foundry primitives (mandatory)

- **Every colour and motion value is a token** from [src/styles/index.css](src/styles/index.css):
  no hex / `rgb()` / `oklch()` literal, palette class (`text-red-500`), inline `cubic-bezier(...)`
  or `@keyframes`. A new semantic role gets a new token in both the light and dark blocks.
- **Use a [Foundry](src/components/foundry) primitive** and its variants (`Button`, `FormField`,
  `Input`, `Select`, `Modal`, `Menu`, `PageHeader`) before styling a bare element.
- **Label-to-control spacing** is `mb-field-gap` (`mb-field-gap-compact` for `text-xs` labels).
  Never `mb-1`, `gap-1` or `space-y-1`.
- **Keep accessibility:** roles and keyboard handlers, `aria-label` on icon-only buttons,
  `role="alert"` on errors, `LiveRegion` for status, and each screen's `<main id="main-content">`.

Memory notes: *Pick a Gubbins design token by semantic role*, *No UI bodges*.

## User-facing strings go through `t()` (mandatory)

Every user-facing string, including `aria-label`, `title`, `alt`, `placeholder`, tooltip and
live-region text, is a key in [en.json](src/features/i18n/catalogs/en.json) rendered with
`const t = useT()`. Add a real translation of each new key to every other catalog (`de.json`) in
the same change. Plurals and spliced values go through `t()` vars, never concatenation or
`n === 1 ? …`. Memory note: *I18n typed catalog seam*.

## The wiki reflects user-facing changes (mandatory)

A change that adds, alters or removes anything a user sees or configures updates its page under
[docs/wiki](docs/wiki) in the same change, with its sidebar entry and any stale screenshot. Never
edit the GitHub wiki directly: a workflow publishes it from `main`. A purely internal change needs
no wiki update. Memory notes: *Wiki staged in repo*, *Wiki screenshot regeneration*.

## A "mirrors X" comment is a request for a test

A comment that says one definition mirrors or must stay in sync with another is a promise nothing
checks. Derive one from the other. Where they cannot share one, write a test that drives both and
fails on drift, prove it by mutating one side, and name it in the comment. Memory note: *A
mirrors-X comment in Gubbins needs a drift test*.

## Plan docs carry a status (`docs/todo/`)

Every `.md` under [docs/todo](docs/todo) opens with a `> **Status:**` banner, and a finished one
moves to `docs/todo/done/` in the same change. [docs/todo/README.md](docs/todo/README.md) defines
both, and a test enforces them. Memory note: *Docs todo status convention*.

## Dependency changes go through `npm run lock`

After any change to `package.json` dependencies, run `npm run lock` (Docker must be running) and
commit the lockfile it writes. Never hand-edit the lockfile or commit one from a Windows
`npm install`. Memory note: *The Gubbins lockfile must be resolved on Linux*.

## Verify before you land

- Type-check with `npm run type-check`, not `npx tsc -b`, which skips the bridge and the browser
  extension.
- Run the tests the change touches. Where the change has a runtime surface, drive it with the
  `verify` skill.
- If the change reaches anything the bridge imports (`bridge/**`, much of `src/db`, search,
  backup), run `npm run smoke:bridge`. Only it exercises Node's strip-only loader.
- Format the changed files with Prettier before committing, or the pre-commit hook rejects them.

## Actioning a GitHub issue

A Gubbins issue URL, `#<id>` or "issue <id>" with no other instruction asks you to action that
issue end to end, landing and closing it with no pause for approval. Read the memory note
*Actioning a Gubbins issue end to end* first. If the message only asks for discussion, answer.

## Keep this file small (mandatory)

This file is loaded into every session. It holds only rules that apply to every change, each in a
few lines. Put detail for one kind of change (a recipe, a cause, a table, an incident, examples)
in a memory note that a short rule names. Shorten or replace a rule before you add one, and never
append an explanation. `AGENTS.md` stays a pointer to this file. `src/lib/agent-guide.test.ts`
fails when this file passes 8,000 characters, a section passes 1,200, or `AGENTS.md` passes 600.
Never raise a budget without asking the maintainer.
