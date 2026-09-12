# Gubbins — working conventions

These rules apply to every agent and every change. Where a rule names a *memory note*, open that
note before you do that kind of work: it holds the detail this file leaves out.

## Work in a git worktree (mandatory)

Other agents edit this repository at the same time, and editing the primary checkout can destroy
their in-flight work. **Before your first edit**, create a new worktree under `.claude/worktrees/`
(a sibling directory breaks the test and dev-server configs) and do the whole task there.

- The only exception is a task that changes no repository file: answering a question, reviewing,
  filing an issue, or a pure `gh` operation.
- Edit through absolute paths inside your own worktree. Never touch another agent's worktree.
  Expect `main` to have moved on while you worked.
- Run tests with `vitest.worktree.config.ts` and the dev server with `vite.worktree.config.ts`.
- Merge back with `--no-ff`. Remove the `node_modules` junction **before** `git worktree remove`,
  or the removal follows it and deletes the primary checkout's `node_modules`.
- Split independent pieces of work across sub-agents that run in parallel.

Memory notes: *Gubbins concurrent agents worktrees*, *Worktree run app and tests*, *Worktree
junction cleanup*.

## No secrets or personal data (mandatory)

This repository is **public**. A pushed commit is permanent and can be scraped within seconds.

- **Never** put an API key, token, password, private key, certificate, OAuth client secret,
  session cookie or connection string in a tracked file or a commit message. Use a placeholder
  (`<YOUR_API_KEY>`). Secrets go in `.env` (git-ignored); `.env.example` holds placeholders only.
- **Never** commit real personal data about anyone. Use `BootBlock@users.noreply.github.com`,
  `example.com` / `*.test` domains, `localhost`, and invented names in fixtures and screenshots.
- **Never** commit data artefacts: `*.sqlite` / `*.db`, dumps, exported archives,
  `.pem` / `.key` / `.pfx` / `.p12`, keystores or `id_rsa*`. Add a new local or generated file
  type to `.gitignore`.
- **Before every commit**, read `git diff --cached` for anything credential-shaped or personal.
  If in doubt, leave it out and ask.
- **If a secret is committed, stop and report it.** It must be revoked at the source and scrubbed
  from history; a later commit that deletes it is not enough.

## Public-repository hygiene (mandatory)

Code, comments, commit messages, branch names, docs and history are world-readable.

- Stay professional and neutral. No TODO names or blames a person.
- No internal references: private ticket IDs, internal URLs or hostnames, infrastructure, or the
  agent's own process. Describe what changed and why.
- The licence is **MIT**. Copy no code of unknown or incompatible licence. Vet a new dependency's
  maintenance and licence, and keep the dependency surface minimal.
- Pass multi-line commit messages and GitHub bodies through a file (`git commit -F`,
  `gh … --body-file`), never through inline shell quoting.

## Attribution on GitHub content (mandatory)

Every issue or pull-request body or comment you write or edit ends with this:

```markdown
---
This issue was actioned by an agent on behalf of @BootBlock.
```

Match the verb to what you did (`actioned` / `opened` / `updated`), and write `pull request` for
a PR. Omit it only where GitHub has no body to sign, such as a label change. Commit messages carry
a `Co-Authored-By` trailer instead.

## UI: design tokens and Foundry primitives (mandatory)

- **Every colour and motion value is a token** from [src/styles/index.css](src/styles/index.css):
  no hex / `rgb()` / `oklch()` literal, no palette class (`text-red-500`), no inline
  `cubic-bezier(...)` or `@keyframes`. If no token fits a new semantic role, add one to both the
  light and dark blocks.
- **Use a Foundry primitive** from [src/components/foundry](src/components/foundry) and its
  variants before styling a bare element: `Button` (`variant="destructive"`), `FormField`,
  `Input`, `Select`, `Textarea`, `Modal`, `Menu`, `PageHeader`. Add a missing primitive there.
- **Label-to-control spacing** is `mb-field-gap`, or `mb-field-gap-compact` for `text-xs` labels
  (the `gap-` / `space-y-` forms for stacks). Never `mb-1`, `gap-1` or `space-y-1`.
- **Keep accessibility.** An interactive `<div>` needs a role and a keyboard handler, an icon-only
  button an `aria-label`, error text `role="alert"`, live status `LiveRegion`, a decorative icon
  `aria-hidden`. Every screen keeps `<main id="main-content">` and its skip link.
- **An unknown Tailwind utility emits no CSS and no error.** Build the CSS and grep the output
  before you trust a new token-based utility.

Memory notes: *Pick a Gubbins design token by semantic role*, *No UI bodges*, *Ease emphasized
motion token*.

## User-facing strings go through `t()` (mandatory)

Every user-facing string is a key in
[src/features/i18n/catalogs/en.json](src/features/i18n/catalogs/en.json), rendered with
`const t = useT()`. That includes `aria-label`, `title`, `alt`, `placeholder`, tooltip text and
live-region announcements. Add a real translation of each new key to **every** other catalog
(`de.json`) in the same change. Plurals use `key.one` / `key.other` through
`t('key', { vars: { count } })` and spliced values use `{placeholder}` vars — never concatenate or
hand-roll `n === 1 ? …`. Memory note: *I18n typed catalog seam*.

## The wiki reflects user-facing changes (mandatory)

A change that adds, alters or removes anything a user sees or configures updates the matching page
under [docs/wiki](docs/wiki) in the same change, including its sidebar entry and any stale
screenshot. The page map and house style are in
[docs/todo/wiki_2026-07-11.md](docs/todo/wiki_2026-07-11.md). A workflow publishes `docs/wiki/`
from `main`, so never edit the GitHub wiki directly. Generate screenshots with
`node scripts/wiki-screenshots.mjs`, and run `npm run wiki:check` before pushing. A purely internal
change needs no wiki update. Memory notes: *Wiki staged in repo*, *Wiki screenshot regeneration*.

## A "mirrors X" comment is a request for a test

A comment claiming that a definition mirrors, matches or must stay in sync with another is a
promise nothing checks. Derive one definition from the other. Where they cannot share one, write a
test that drives both and fails on drift, prove it fails by mutating one side, and name it in the
comment. Memory note: *A mirrors-X comment in Gubbins needs a drift test*.

## Plan docs carry a status (`docs/todo/`)

Every `.md` under [docs/todo](docs/todo) opens with a `> **Status:**` banner directly after its
heading, as [docs/todo/README.md](docs/todo/README.md) defines. When an effort finishes, flip the
banner to `✅ COMPLETE` and `git mv` the doc into `docs/todo/done/` in the same change, after you
update its inbound links. Never rewrite a past-tense record to match current practice.
`src/lib/docs-todo-status.test.ts` enforces the banner and the placement.

## Dependency changes go through `npm run lock`

After any change to `package.json` dependencies, run `npm run lock` (Docker must be running) and
commit the lockfile it writes. A Windows `npm install` writes a lockfile that CI's `npm ci`
rejects. Never hand-edit the lockfile. Memory note: *The Gubbins lockfile must be resolved on
Linux*.

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
issue end to end: implement, review with `/auto-review high`, land, comment and close, with no
pause for approval. Read the memory note *Actioning a Gubbins issue end to end* first. If the
message only asks for discussion, answer instead.
